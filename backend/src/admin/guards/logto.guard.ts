import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { ConfigService } from "../../config/config.service";

/** 方法/控制器级附加 scope 要求，与默认的 read/write 规则叠加 */
export const REQUIRED_SCOPES = "requiredScopes";
export const RequireScopes = (...scopes: string[]) =>
  SetMetadata(REQUIRED_SCOPES, scopes);

/** 通过 Logto 校验后的调用者身份 */
export interface LogtoPrincipal {
  sub: string;
  username?: string;
  name?: string;
  scopes: string[];
  claims: JWTPayload;
}

export type AuthedRequest = Request & { auth?: LogtoPrincipal };

/**
 * Admin 通道鉴权：校验 Logto 签发的 access token（RS256/ES384，issuer + audience）。
 *
 * 与旧 AdminTokenGuard 的差别：
 * - 身份来自签名 token，`x-admin-user` 头不再可信，审计 actor 无法伪造
 * - 权限来自 token 里的 scope：读接口要 gateway:read，写接口要 gateway:write
 * - 公钥由 jose 缓存（JWKS），每个请求不在网络上打 Logto
 *
 * MCP 通道（Bearer API Key）不受影响，两套凭据依旧隔离。
 */
@Injectable()
export class LogtoGuard implements CanActivate {
  private jwks?: JWTVerifyGetKey;

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException("缺少访问令牌");

    const { logtoIssuer, logtoAudience } = this.config.get();

    try {
      this.jwks ??= createRemoteJWKSet(
        new URL(`${logtoIssuer.replace(/\/$/, "")}/jwks`),
        {
          timeoutDuration: 5_000,
          cooldownDuration: 30_000,
          cacheMaxAge: 10 * 60_000,
        },
      );

      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: logtoIssuer,
        audience: logtoAudience,
        clockTolerance: 30,
        algorithms: ["RS256", "PS256", "ES256", "ES384"],
      });

      req.auth = {
        sub: payload.sub ?? "",
        username:
          typeof payload.username === "string" ? payload.username : undefined,
        name: typeof payload.name === "string" ? payload.name : undefined,
        scopes:
          typeof payload.scope === "string"
            ? payload.scope.split(/\s+/).filter(Boolean)
            : [],
        claims: payload,
      };
    } catch (err) {
      // 认证 fail-closed：验签失败一律 401，不退化为匿名访问
      throw new UnauthorizedException(
        `访问令牌无效：${(err as Error).message}`,
      );
    }

    // 基础规则：读接口要 gateway:read，写接口要 gateway:write
    const required = new Set<string>([
      req.method === "GET" || req.method === "HEAD"
        ? "gateway:read"
        : "gateway:write",
    ]);
    // 附加规则：敏感读接口额外声明 gateway:sensitive
    const extra =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    for (const s of extra) required.add(s);

    const missing = [...required].filter((s) => !req.auth!.scopes.includes(s));
    if (missing.length) {
      throw new ForbiddenException({
        code: "MISSING_SCOPE",
        missing,
        required: missing[0],
        message: `缺少权限 ${missing.join(", ")}`,
      });
    }

    return true;
  }

  /**
   * 取 token：优先 Authorization 头。
   * SSE 回退：浏览器原生 EventSource 无法设自定义 header，仅对 `/stream` 结尾的路径
   * 允许 `?token=` query（窄路径 + 不开全局，需在网关层屏蔽 access_log 中的 query）。
   */
  private extractToken(req: Request): string {
    const header = req.headers.authorization ?? "";
    let token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token && req.path.endsWith("/stream")) {
      const q = req.query?.token;
      if (typeof q === "string") token = q.trim();
    }
    return token;
  }
}
