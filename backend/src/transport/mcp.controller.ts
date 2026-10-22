import { Controller, Post, Get, Delete, Req, Res, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiKeyService } from '../auth/apikey.service';
import { RbacService } from '../auth/rbac.service';
import { ToolRegistryService } from '../gateway/registry.service';
import { GatewayRouterService } from '../gateway/router.service';
import { SessionManager, Session } from './session.manager';
import { AuditService } from '../governance/audit.service';
import { ConfigService } from '../config/config.service';
import { logger } from '../common/logger';

const PROTOCOL_VERSION = '2025-06-18';
const FALLBACK_PROTOCOL = '2025-03-26';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

/**
 * MCP 通道（对客户端）。与 Admin 通道代码路径完全隔离。
 * 直接用 Express req/res：SSE 流与 Mcp-Session-Id 头需要底层控制。
 */
@Controller('mcp')
export class McpController {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly rbac: RbacService,
    private readonly registry: ToolRegistryService,
    private readonly router: GatewayRouterService,
    private readonly sessions: SessionManager,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private bearer(req: Request): string {
    const h = req.headers.authorization ?? '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  }

  /**
   * 401 响应。
   *
   * 本网关**不做 OAuth 发现**（只有静态 API Key），因此不能带
   * `resource_metadata="..."` 指向 `/.well-known/oauth-protected-resource`——该路由不存在，
   * 标准 MCP 客户端会按 RFC 9728 去拉取并拿到 404，反而把“Key 无效”误报成“授权服务器不可用”。
   * 只保留 RFC 6750 的最小语义：realm + error。
   */
  private unauthorized(res: Response): void {
    res
      .status(HttpStatus.UNAUTHORIZED)
      .set('WWW-Authenticate', 'Bearer realm="mcp-gateway", error="invalid_token"')
      .json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      });
  }

  /** Origin/Host 校验，防 DNS rebinding */
  private validateOrigin(req: Request): boolean {
    const cfg = this.config.get();
    const origin = req.headers.origin;
    if (!origin) return true; // 非浏览器客户端通常不带 Origin
    const allowed = [new URL(cfg.publicOrigin).origin, ...cfg.allowedOrigins];
    return allowed.includes(origin);
  }

  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!this.validateOrigin(req)) {
      res.status(HttpStatus.FORBIDDEN).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Origin not allowed' }, id: null });
      return;
    }
    const rawKey = this.bearer(req);
    const caller = await this.apiKeys.verify(rawKey);
    if (!caller) {
      this.audit.log({ event: 'auth_fail', channel: 'mcp', callerIp: req.ip ?? null, resultOk: false });
      return this.unauthorized(res);
    }

    const body = req.body as JsonRpcRequest | JsonRpcRequest[];
    const requests = Array.isArray(body) ? body : [body];
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // 已存在会话则复用其 caller（随会话固定，避免中途换 Key 权限漂移）
    let session: Session | undefined = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId && !session) {
      res.status(HttpStatus.NOT_FOUND).json({ jsonrpc: '2.0', error: { code: -32002, message: 'Session not found' }, id: null });
      return;
    }

    const responses: unknown[] = [];
    for (const r of requests) {
      const out = await this.dispatch(r, caller, session, req);
      if (out === null) continue; // 通知无需响应
      responses.push(out);
      if (out && typeof out === 'object' && 'newSession' in (out as any)) {
        session = (out as any).newSession;
        delete (out as any).newSession;
      }
    }

    if (session) res.set('Mcp-Session-Id', session.id);
    res.set('MCP-Protocol-Version', session?.protocolVersion ?? PROTOCOL_VERSION);

    if (Array.isArray(body)) {
      res.status(HttpStatus.OK).type('application/json').send(JSON.stringify(responses));
    } else if (responses.length === 0) {
      res.status(HttpStatus.ACCEPTED).end();
    } else {
      res.status(HttpStatus.OK).type('application/json').send(JSON.stringify(responses[0]));
    }
  }

  private async dispatch(
    req: JsonRpcRequest,
    caller: ReturnType<ApiKeyService['verify']> extends Promise<infer T> ? NonNullable<T> : never,
    session: Session | undefined,
    httpReq: Request,
  ): Promise<any> {
    const id = req.id ?? null;
    switch (req.method) {
      case 'initialize': {
        const pv = req.params?.protocolVersion ?? FALLBACK_PROTOCOL;
        const clientInfo = JSON.stringify(req.params?.clientInfo ?? {});
        const newSession = this.sessions.create(caller, pv, clientInfo);
        if (!newSession) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: '[UPSTREAM_BUSY] 会话数达上限，请稍后重试' },
          };
        }
        this.audit.log({
          event: 'initialize',
          channel: 'mcp',
          keyId: caller.keyId,
          userName: caller.userName,
          team: caller.team,
          role: caller.role,
          sessionId: newSession.id,
          clientInfo,
          callerIp: httpReq.ip ?? null,
        });
        const resp: any = {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: pv,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'mcp-gateway', version: '2.0.0' },
          },
        };
        resp.newSession = newSession;
        return resp;
      }
      case 'notifications/initialized':
      case 'initialized':
        return null; // 通知无需响应
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list': {
        if (!session) return { jsonrpc: '2.0', id, error: { code: -32002, message: 'Session required' } };
        await this.rbac.loadRules(caller.role);
        const all = this.registry.allToolNames();
        const allowed = this.rbac.buildAllowedSet(caller.role, all, this.registry.version);
        const tools = this.registry.listFor(allowed);
        return { jsonrpc: '2.0', id, result: { tools } };
      }
      case 'tools/call': {
        if (!session) return { jsonrpc: '2.0', id, error: { code: -32002, message: 'Session required' } };
        await this.rbac.loadRules(caller.role);
        const name = req.params?.name as string;
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const result = await this.router.routeCall(name, args, caller, {
          sessionId: session.id,
          callerIp: httpReq.ip ?? undefined,
          clientInfo: session.clientInfo,
        });
        return { jsonrpc: '2.0', id, result: { content: result.content ?? [], isError: result.isError ?? false } };
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
  }

  /** GET /mcp：server→client SSE 通知流 */
  @Get()
  handleGet(@Req() req: Request, @Res() res: Response): void {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(HttpStatus.NOT_FOUND).end();
      return;
    }
    res.writeHead(HttpStatus.OK, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Mcp-Session-Id': session.id,
    });
    res.flushHeaders?.();
    const write = (event: string, data: unknown): boolean => {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch {
        return false;
      }
    };
    session.sse = { write, close: () => res.end() };
    // 心跳保活（防反代切断）
    const heartbeat = setInterval(() => write('ping', {}), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      session.sse = null;
    });
  }

  /** DELETE /mcp：客户端主动终止会话 */
  @Delete()
  handleDelete(@Req() req: Request, @Res() res: Response): void {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      res.status(HttpStatus.OK).end();
    } else {
      res.status(HttpStatus.NOT_FOUND).end();
    }
  }
}
