import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Upstream } from "../database/entities/upstream.entity";
import { ChangeLog } from "../database/entities/audit.entity";
import { CryptoService } from "../auth/crypto.service";
import { ConfigService } from "../config/config.service";
import { ToolRegistryService, ToolDef } from "./registry.service";
import { BreakerService } from "../governance/breaker.service";
import { BreakerEventsService } from "../governance/breaker-events.service";
import { AuditService } from "../governance/audit.service";
import { NotifyService } from "../notify/im.service";
import { logger } from "../common/logger";
import { safeMessage, rawErrorMessage } from "../common/safe-message";
import { checkUpstreamUrl } from "./ssrf";

/** 单上游连接超时：避免一个不可达的上游拖住网关启动 */
const CONNECT_TIMEOUT_MS = 8_000;

/**
 * SDK 默认请求超时是 60s（initialize / tools/list 同样走这个值）。
 * 上游配置的 timeoutMs 更大时按配置放宽，否则慢启动的上游会被 SDK 提前掐断报 -32001。
 */
const SDK_MIN_REQUEST_TIMEOUT_MS = 60_000;

/**
 * 上游连接句柄。SDK 是 ESM-only，NestJS 是 CJS，故 SDK 类型用 any，通过动态 import 引入。
 */
interface UpstreamHandle {
  name: string;
  client: any; // SDK Client
  transport: any;
  connected: boolean;
  restarts: number;
  lastBackoff: number;
}

/**
 * stdio 子进程环境变量白名单。
 *
 * 安全默认：网关自身进程的全部 env（MGW_SECRET、LOGTO_*、MGW_M2M_CLIENT_SECRET、DEEPSEEK_API_KEY 等）
 * **不会**自动注入到 stdio 子进程，否则任意一个第三方 stdio 上游都能读到主密钥
 * 与其他上游的凭据，隔离彻底破防。业务侧凭据必须在上游记录的 `env` 字段中显式声明
 * （写入时 AES-256-GCM 加密，运行时解密后仅注入到对应子进程）。
 *
 * 仅保留一小给子进程运行必需的通用环境（PATH/HOME/LANG…），屏蔽：
 *   • MGW_* 网关配置　• LOGTO_*　• 任意 *_FILE　• NODE_OPTIONS（防供应链注入）　• 已知敏感前缀
 */
const STDIO_ENV_ALLOW_KEYS = new Set<string>([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TMPDIR",
  "PWD",
  "TZ",
  "NODE_ENV",
]);
const STDIO_ENV_ALLOW_PREFIXES = ["LC_"];

function isStdioEnvAllowed(key: string): boolean {
  if (STDIO_ENV_ALLOW_KEYS.has(key)) return true;
  return STDIO_ENV_ALLOW_PREFIXES.some((p) => key.startsWith(p));
}

function buildStdioChildEnv(
  userEnv: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && isStdioEnvAllowed(k)) base[k] = v;
  }
  // 用户显式声明的上游 env 优先覆盖（它们已从 DB 中 AES 解密出来）
  return { ...base, ...userEnv };
}

/**
 * UpstreamManager：MCP Client 池 + 健康检查 + 自动重连（指数退避）+ stdio 子进程托管。
 * 一个上游 = 一个 Client，被所有下游会话共享。
 */
@Injectable()
export class UpstreamManagerService implements OnModuleDestroy {
  private readonly handles = new Map<string, UpstreamHandle>();
  private healthTimer: NodeJS.Timeout | null = null;
  private sdkClient: any = null;
  private sdkHttpTransport: any = null;
  private sdkStdioTransport: any = null;
  /** F9・stdio crash loop 滑窗（名称 → 失败时间戳数组，单位 ms） */
  private readonly crashWindow = new Map<string, number[]>();
  private static readonly CRASH_WINDOW_MS = 5 * 60_000;
  private static readonly CRASH_THRESHOLD = 5;

  constructor(
    @InjectRepository(Upstream)
    private readonly upstreamRepo: Repository<Upstream>,
    @InjectRepository(ChangeLog)
    private readonly changeRepo: Repository<ChangeLog>,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly registry: ToolRegistryService,
    private readonly breaker: BreakerService,
    private readonly breakerEvents: BreakerEventsService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  /** 动态加载 ESM-only 的 MCP SDK（CJS 侧只能 await import） */
  private async ensureSdk(): Promise<void> {
    if (this.sdkClient) return;
    try {
      const clientMod =
        await import("@modelcontextprotocol/sdk/client/index.js");
      const httpMod =
        await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const stdioMod =
        await import("@modelcontextprotocol/sdk/client/stdio.js");
      this.sdkClient = clientMod.Client;
      this.sdkHttpTransport = httpMod.StreamableHTTPClientTransport;
      this.sdkStdioTransport = stdioMod.StdioClientTransport;
    } catch (err) {
      logger.warn("MCP SDK 加载失败，上游连接将不可用（管理面仍可运行）", {
        err: String(err),
      });
    }
  }

  /** 启动时连接所有 enabled 上游 */
  async connectAll(): Promise<void> {
    await this.ensureSdk();
    await this.registry.loadFromSnapshot();
    const rows = await this.upstreamRepo.find({ where: { enabled: 1 } });
    // 并发连接 + 单上游超时：任一上游不可达不应拖慢网关启动（串行实现最坏为 N×超时）
    await Promise.all(
      rows.map(async (u) => {
        try {
          const r = await Promise.race([
            this.connect(u),
            new Promise<{ ok: false; error: string }>((resolve) => {
              setTimeout(
                () =>
                  resolve({
                    ok: false,
                    error: `连接超时（${CONNECT_TIMEOUT_MS}ms）`,
                  }),
                CONNECT_TIMEOUT_MS,
              ).unref();
            }),
          ]);
          if (!r.ok)
            logger.warn("上游连接失败", { name: u.name, err: r.error });
        } catch (e) {
          logger.warn("上游连接失败", { name: u.name, err: safeMessage(e) });
        }
      }),
    );
    // 健康检查周期
    this.healthTimer = setInterval(() => void this.healthCheckAll(), 30_000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const name of [...this.handles.keys()]) await this.disconnect(name);
  }

  /** 注册前校验 URL（SSRF），失败直接返回原因不落库 */
  validateUrl(url: string): { ok: boolean; reason?: string } {
    const res = checkUpstreamUrl(url, this.config.get().outboundAllowedCidrs);
    return { ok: res.ok, reason: res.reason };
  }

  private buildHeaders(u: Upstream): Record<string, string> {
    const headers = this.crypto.decryptJson<Record<string, string>>(
      u.headersEnc,
    );
    return headers ?? {};
  }

  /** 连接单个上游并拉取工具列表 */
  async connect(
    u: Upstream,
  ): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
    await this.ensureSdk();
    if (!this.sdkClient) return { ok: false, error: "MCP SDK 不可用" };
    try {
      let client: any;
      let transport: any;
      if (u.transport === "stdio") {
        const env =
          this.crypto.decryptJson<Record<string, string>>(u.envEnc) ?? {};
        const args = u.argsJson ? (JSON.parse(u.argsJson) as string[]) : [];
        transport = new this.sdkStdioTransport({
          command: u.command,
          args,
          cwd: u.cwd || undefined,
          env: buildStdioChildEnv(env),
        });
      } else {
        transport = new this.sdkHttpTransport(new URL(u.url!), {
          requestInit: { headers: this.buildHeaders(u), redirect: "manual" },
        });
      }
      client = new this.sdkClient(
        { name: "mcp-gateway", version: "2.0.0" },
        { capabilities: {} },
      );
      const reqOpts = {
        timeout: Math.max(u.timeoutMs || 20_000, SDK_MIN_REQUEST_TIMEOUT_MS),
      };
      await client.connect(transport, reqOpts);
      const listRes = await client.listTools(undefined, reqOpts);
      const tools: ToolDef[] = (listRes.tools ?? []).map((t: any) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      this.handles.set(u.name, {
        name: u.name,
        client,
        transport,
        connected: true,
        restarts: 0,
        lastBackoff: 1000,
      });
      await this.registry.refreshUpstream(u.name, tools, u.sensitivity);
      await this.markStatus(u.name, "up", "");
      this.breaker.reset(u.name);
      logger.info("上游已连接", { name: u.name, tools: tools.length });
      return { ok: true, toolCount: tools.length };
    } catch (err) {
      const msg = rawErrorMessage(err);
      await this.markStatus(u.name, "down", safeMessage(err));
      logger.warn("上游连接失败", { name: u.name, err: safeMessage(err) });
      return { ok: false, error: safeMessage(err) };
    }
  }

  private async markStatus(
    name: string,
    status: "up" | "down",
    error: string,
  ): Promise<void> {
    await this.upstreamRepo.update(
      { name },
      { lastStatus: status, lastError: error, lastCheckedAt: Date.now() },
    );
  }

  async disconnect(name: string): Promise<void> {
    const h = this.handles.get(name);
    if (!h) return;
    try {
      await h.client?.close?.();
    } catch {
      /* ignore */
    }
    this.handles.delete(name);
    await this.registry.removeUpstream(name);
  }

  /** 调用上游工具（带超时）。供 router 使用。 */
  async callTool(
    upstream: string,
    originalName: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<any> {
    const h = this.handles.get(upstream);
    if (!h || !h.connected) throw new Error("UPSTREAM_NOT_CONNECTED");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await h.client.callTool(
        { name: originalName, arguments: args as any },
        undefined,
        {
          signal: controller.signal,
          timeout: timeoutMs,
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** 手动探活：返回耗时与工具数 */
  async probe(
    name: string,
  ): Promise<{ ok: boolean; ms: number; toolCount?: number; error?: string }> {
    const u = await this.upstreamRepo.findOne({ where: { name } });
    if (!u) return { ok: false, ms: 0, error: "上游不存在" };
    const start = Date.now();
    await this.disconnect(name).catch(() => {});
    const res = await this.connect(u);
    return {
      ok: res.ok,
      ms: Date.now() - start,
      toolCount: res.toolCount,
      error: res.error,
    };
  }

  /** 强制刷新某上游工具列表 */
  async refresh(
    name: string,
  ): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
    const u = await this.upstreamRepo.findOne({ where: { name } });
    if (!u) return { ok: false, error: "上游不存在" };
    const h = this.handles.get(name);
    if (!h?.connected) return this.connect(u);
    try {
      const listRes = await h.client.listTools();
      const tools: ToolDef[] = (listRes.tools ?? []).map((t: any) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      await this.registry.refreshUpstream(name, tools, u.sensitivity);
      return { ok: true, toolCount: tools.length };
    } catch (err) {
      return { ok: false, error: safeMessage(err) };
    }
  }

  /** 周期健康检查：断开的上游尝试重连（指数退避，上限 5min，连续失败标记 down） */
  private async healthCheckAll(): Promise<void> {
    const rows = await this.upstreamRepo.find({ where: { enabled: 1 } });
    for (const u of rows) {
      const h = this.handles.get(u.name);
      if (h?.connected) continue;
      // 指数退避：距上次尝试不足 backoff 则跳过
      const now = Date.now();
      if (u.lastCheckedAt && now - u.lastCheckedAt < (h?.lastBackoff ?? 5000))
        continue;
      // P1-C：在 connect() 内部会 breaker.reset 之前拿一下前态，以便确认本次恢复是否从 open/half-open 回到 closed
      const prevState = this.breaker.snapshot(u.name).state;
      const res = await this.connect(u);
      if (!res.ok) {
        const hh = this.handles.get(u.name);
        const backoff = Math.min((hh?.lastBackoff ?? 1000) * 2, 300_000);
        if (hh) hh.lastBackoff = backoff;
        // F9・stdio crash loop 计数与自动下线
        if (u.transport === "stdio") await this.recordCrashAndMaybeDisable(u);
      } else {
        // 重连成功 → 滑窗归零，避免历史上“多时不同崩”累计误伤
        if (u.transport === "stdio") this.crashWindow.delete(u.name);
        // P1-C：从非 closed 恢复，补记 recovered（主链无在途调用时不会有 onSuccess 事件）
        if (prevState !== "closed") {
          this.breakerEvents.record(
            u.name,
            { kind: "recovered", from: prevState, to: "closed", fails: 0 },
            "health_check_ok",
          );
        }
        this.audit.log({
          event: "upstream_up",
          upstream: u.name,
          channel: "health",
        });
        await this.notify.upstreamRecovered(u.name, u.owner);
      }
    }
  }

  /**
   * F9・stdio crash loop 自动熔断。
   * 5min 滑窗内失败 ≥ 5 次 → 自动 enabled=0，避免无限重启耗尽 PID/日志。
   * 同时写 audit(event=upstream_down)、change_logs(action=auto-disable)、IM 告警。
   */
  private async recordCrashAndMaybeDisable(u: Upstream): Promise<void> {
    const now = Date.now();
    const arr = this.crashWindow.get(u.name) ?? [];
    arr.push(now);
    while (
      arr.length > 0 &&
      now - arr[0] > UpstreamManagerService.CRASH_WINDOW_MS
    )
      arr.shift();
    this.crashWindow.set(u.name, arr);
    if (arr.length < UpstreamManagerService.CRASH_THRESHOLD) return;
    // 命中阈值 → 自动下线
    await this.upstreamRepo.update(
      { name: u.name },
      {
        enabled: 0,
        lastStatus: "down",
        lastError: "crash_loop",
        lastCheckedAt: now,
        updatedAt: now,
      },
    );
    await this.disconnect(u.name).catch(() => {});
    this.crashWindow.delete(u.name);
    this.audit.log({
      event: "upstream_down",
      upstream: u.name,
      channel: "health",
      resultOk: false,
      errorCode: "CRASH_LOOP" as any,
      errorMsg: `stdio 上游 ${u.name} 在 ${UpstreamManagerService.CRASH_WINDOW_MS / 1000}s 内重启 ${arr.length} 次，自动下线`,
    });
    const log = new ChangeLog();
    log.ts = now;
    log.actor = "system";
    log.actorIp = "";
    log.targetType = "upstream";
    log.targetId = u.name;
    log.action = "auto-disable";
    log.beforeJson = JSON.stringify({ enabled: 1 });
    log.afterJson = JSON.stringify({ enabled: 0, lastError: "crash_loop" });
    log.diffSummary = `stdio 上游 ${u.name} crash loop 自动下线（${UpstreamManagerService.CRASH_WINDOW_MS / 1000}s 内 ${arr.length} 次重启）`;
    await this.changeRepo.save(log);
    await this.notify.stdioCrashLoop(
      u.name,
      arr.length,
      UpstreamManagerService.CRASH_WINDOW_MS / 1000,
    );
    logger.warn("stdio 上游 crash loop 自动下线", {
      name: u.name,
      restarts: arr.length,
    });
  }

  /** 熔断打开时通知（由 router 调用） */
  async onBreakerOpened(upstream: string): Promise<void> {
    const u = await this.upstreamRepo.findOne({ where: { name: upstream } });
    if (!u) return;
    await this.markStatus(upstream, "down", "circuit open");
    this.audit.log({
      event: "circuit_open",
      upstream,
      channel: "health",
      resultOk: false,
    });
    await this.notify.circuitOpened(upstream, u.owner);
  }

  async onBreakerRecovered(upstream: string): Promise<void> {
    const u = await this.upstreamRepo.findOne({ where: { name: upstream } });
    if (!u) return;
    await this.markStatus(upstream, "up", "");
    this.audit.log({ event: "circuit_close", upstream, channel: "health" });
    await this.notify.circuitClosed(upstream, u.owner);
  }

  connectedCount(): number {
    let n = 0;
    for (const h of this.handles.values()) if (h.connected) n++;
    return n;
  }
}
