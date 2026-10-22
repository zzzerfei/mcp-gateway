import { Injectable } from "@nestjs/common";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * 三级配置加载：默认值 < config/gateway.json < 环境变量
 * 保持轻量化：不引第三方配置库，只做确定性的合并。
 */
export interface GatewayConfig {
  port: number;
  host: string;
  dataDir: string;
  publicOrigin: string;
  allowedOrigins: string[];
  secret: string; // AES-256-GCM 主密钥（64 hex）
  logtoIssuer: string; // Logto OIDC issuer，例如 http://localhost:3001/oidc
  logtoAudience: string; // 管理 API 的 Resource indicator
  outboundAllowedCidrs: string[];
  maxSessions: number;
  sessionIdleTimeoutS: number;
  stdioMax: number;
  imWebhook: string;
  auditFlushMs: number;
  auditFlushSize: number;
  registryRefreshIntervalS: number;
  env: "development" | "production" | "test";
}

function readFileSecret(
  envVal: string | undefined,
  fileEnv: string | undefined,
): string {
  // 优先 _FILE
  if (fileEnv && process.env[fileEnv] && existsSync(process.env[fileEnv]!)) {
    return readFileSync(process.env[fileEnv]!, "utf8").trim();
  }
  return (envVal ?? "").trim();
}

/** 读取 config/gateway.json（中间层）。不存在或解析失败则返回空对象，不阻断启动。 */
function readJsonConfig(): Record<string, any> {
  const p = resolve(process.env.MGW_CONFIG ?? "./config/gateway.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
  } catch {
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        msg: `gateway.json 解析失败，已忽略: ${p}`,
      }) + "\n",
    );
    return {};
  }
}

@Injectable()
export class ConfigService {
  private readonly config: GatewayConfig;

  constructor() {
    const file = readJsonConfig();
    // 三级取值：环境变量 > gateway.json > 内置默认
    const str = (env: string | undefined, jsonVal: any, def: string): string =>
      env ?? (jsonVal != null ? String(jsonVal) : def);
    const num = (env: string | undefined, jsonVal: any, def: number): number =>
      Number(env ?? jsonVal ?? def);
    const list = (
      env: string | undefined,
      jsonVal: any,
      def: string[],
    ): string[] => {
      if (env != null && env.trim() !== "")
        return env
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      if (Array.isArray(jsonVal))
        return jsonVal.map((s) => String(s).trim()).filter(Boolean);
      return def;
    };

    const dataDir = resolve(
      process.env.MGW_DATA_DIR ?? file.dataDir ?? "./data",
    );
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    if (!existsSync(join(dataDir, "backup")))
      mkdirSync(join(dataDir, "backup"), { recursive: true });

    const env = (process.env.NODE_ENV as GatewayConfig["env"]) ?? "development";
    const secret = readFileSecret(process.env.MGW_SECRET, "MGW_SECRET_FILE");
    // 生产 fail-closed：缺主密钥时上游凭据会用公开的兜底密钥加密，等于明文
    if (!secret && env === "production") {
      throw new Error(
        "MGW_SECRET 未设置：生产环境拒绝启动（上游 headers/token 将无法安全加密）",
      );
    }

    this.config = {
      port: num(process.env.MGW_PORT, file.port, 8080),
      host: str(process.env.MGW_HOST, file.host, "127.0.0.1"),
      dataDir,
      publicOrigin: str(
        process.env.MGW_PUBLIC_ORIGIN,
        file.publicOrigin,
        "http://127.0.0.1:8080",
      ),
      allowedOrigins: list(
        process.env.MGW_ALLOWED_ORIGINS,
        file.allowedOrigins,
        [],
      ),
      secret: secret || this.devFallbackSecret(),
      logtoIssuer: str(
        process.env.LOGTO_ISSUER,
        file.logtoIssuer,
        "http://localhost:3001/oidc",
      ),
      logtoAudience: str(
        process.env.LOGTO_AUDIENCE,
        file.logtoAudience,
        "https://api.gateway.local",
      ),
      outboundAllowedCidrs: list(
        process.env.MGW_OUTBOUND_ALLOWED_CIDRS,
        file.outboundAllowedCidrs,
        ["10.0.0.0/8", "127.0.0.1/32", "192.168.0.0/16"],
      ),
      maxSessions: num(process.env.MGW_MAX_SESSIONS, file.maxSessions, 300),
      sessionIdleTimeoutS: num(
        process.env.MGW_SESSION_IDLE_TIMEOUT_S,
        file.sessionIdleTimeoutS,
        1800,
      ),
      stdioMax: num(process.env.MGW_STDIO_MAX, file.stdioMax, 8),
      imWebhook: str(process.env.MGW_IM_WEBHOOK, file.imWebhook, ""),
      auditFlushMs: num(
        process.env.MGW_AUDIT_FLUSH_MS,
        file.auditFlushMs,
        1000,
      ),
      auditFlushSize: num(
        process.env.MGW_AUDIT_FLUSH_SIZE,
        file.auditFlushSize,
        100,
      ),
      registryRefreshIntervalS: num(
        process.env.MGW_REGISTRY_REFRESH_INTERVAL_S,
        file.registryRefreshIntervalS,
        300,
      ),
      env,
    };
  }

  /**
   * 开发兜底主密钥：仅当未配置 MGW_SECRET 时使用，且强制打警告。
   * 生产必须由环境变量/secrets 文件提供，否则上游凭据加密形同虚设。
   */
  private devFallbackSecret(): string {
    const fixed = "a".repeat(64);
    // eslint-disable-next-line no-console
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        msg: "MGW_SECRET 未设置，使用开发兜底主密钥，禁止用于生产",
      }) + "\n",
    );
    return fixed;
  }

  get(): GatewayConfig {
    return this.config;
  }

  get dbPath(): string {
    return join(this.config.dataDir, "gateway.db");
  }

  get auditFallbackPath(): string {
    return join(this.config.dataDir, "audit-fallback.jsonl");
  }
}
