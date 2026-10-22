import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ToolRegistryService } from "./registry.service";
import { UpstreamManagerService } from "./upstream-manager.service";
import { RbacService } from "../auth/rbac.service";
import { Caller } from "../auth/apikey.service";
import { RateLimitService } from "../governance/ratelimit.service";
import { BreakerService } from "../governance/breaker.service";
import { BreakerEventsService } from "../governance/breaker-events.service";
import { ConcurrencyService } from "../governance/concurrency.service";
import { AuditService } from "../governance/audit.service";
import { MetricsService } from "../governance/metrics.service";
import { Upstream } from "../database/entities/upstream.entity";
import { ToolOverride } from "../database/entities/tool.entity";
import { ErrorCode, ErrorCodeType } from "../common/errors";
import { safeMessage, rawErrorMessage } from "../common/safe-message";
import { logger } from "../common/logger";

export interface RouteResult {
  content?: unknown;
  isError?: boolean;
  errorCode?: ErrorCodeType;
  /** 本次调用链路 ID，可用于回查审计 */
  requestId?: string;
}

/** 调用上下文。channel 用于区分流量来源：mcp=真实客户端，admin=管理后台试调用 */
export interface RouteCtx {
  sessionId?: string;
  callerIp?: string;
  clientInfo?: string;
  channel?: "mcp" | "admin" | "health";
}

/**
 * GatewayRouter：整个系统的十字路口。
 * 治理链顺序不可调换：权限在限流前（无权限不该消耗令牌），限流在熔断前（被限流不该污染熔断统计），
 * 熔断在获取并发槽前（熔断态不该排队）。
 */
@Injectable()
export class GatewayRouterService {
  constructor(
    private readonly registry: ToolRegistryService,
    private readonly upstream: UpstreamManagerService,
    private readonly rbac: RbacService,
    private readonly rateLimit: RateLimitService,
    private readonly breaker: BreakerService,
    private readonly breakerEvents: BreakerEventsService,
    private readonly concurrency: ConcurrencyService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    @InjectRepository(Upstream)
    private readonly upstreamRepo: Repository<Upstream>,
    @InjectRepository(ToolOverride)
    private readonly overrideRepo: Repository<ToolOverride>,
  ) {}

  async routeCall(
    fullName: string,
    args: Record<string, unknown>,
    caller: Caller,
    ctx: RouteCtx = {},
  ): Promise<RouteResult> {
    const requestId = this.audit.newRequestId();
    const start = Date.now();

    // 1. 注册表查找
    const entry = this.registry.get(fullName);
    if (!entry || !entry.enabled) {
      return this.fail(
        requestId,
        caller,
        fullName,
        null,
        ErrorCode.TOOL_NOT_FOUND,
        "工具不存在或已下线",
        start,
        ctx,
      );
    }

    // 2. 权限（共用 allowedSet，可见即可调）
    const allNames = this.registry.allToolNames();
    const allowed = this.rbac.buildAllowedSet(
      caller.role,
      allNames,
      this.registry.version,
    );
    if (!allowed.has(fullName)) {
      // F1 影子模式：observe 下不拦截，仅写 rbac_would_forbid 审计后继续往下走（限流/熔断/并发/上游）
      if (this.rbac.getMode() === "observe") {
        this.audit.log({
          event: "rbac_would_forbid",
          channel: ctx.channel ?? "mcp",
          requestId,
          keyId: caller.keyId,
          userName: caller.userName,
          team: caller.team,
          role: caller.role,
          sessionId: ctx.sessionId ?? null,
          tool: fullName,
          upstream: entry.upstream,
          args,
          sensitive: entry.sensitivity === "high",
          resultOk: true,
          errorCode: ErrorCode.WOULD_FORBID,
          durationMs: Date.now() - start,
          callerIp: ctx.callerIp ?? null,
        });
        logger.info("影子模式放行越权调用", {
          role: caller.role,
          tool: fullName,
          upstream: entry.upstream,
        });
        // 不 return，往下走后面的限流/熔断/转发
      } else {
        return this.fail(
          requestId,
          caller,
          fullName,
          entry.upstream,
          ErrorCode.FORBIDDEN,
          "无权调用该工具",
          start,
          ctx,
          {
            args,
            sensitive: entry.sensitivity === "high",
          },
        );
      }
    }

    // 3. 限流（工具级覆写 QPM 优先）
    const ov = await this.overrideRepo.findOne({ where: { fullName } });
    const rate = ov?.rateQpm ?? undefined;
    const rl = this.rateLimit.take(caller.keyId, fullName, rate, rate);
    if (!rl.ok) {
      this.audit.log({
        event: "rate_limit",
        channel: ctx.channel ?? "mcp",
        requestId,
        keyId: caller.keyId,
        userName: caller.userName,
        team: caller.team,
        role: caller.role,
        tool: fullName,
        upstream: entry.upstream,
        resultOk: false,
        errorCode: ErrorCode.RATE_LIMITED,
        callerIp: ctx.callerIp ?? null,
      });
      return {
        isError: true,
        errorCode: ErrorCode.RATE_LIMITED,
        requestId,
        content: text(
          `[RATE_LIMITED] 调用过于频繁，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后重试`,
        ),
      };
    }

    // 4. 熔断（快速失败，不等超时）
    if (this.breaker.isOpen(entry.upstream)) {
      return this.fail(
        requestId,
        caller,
        fullName,
        entry.upstream,
        ErrorCode.UPSTREAM_DOWN,
        "上游服务暂不可用",
        start,
        ctx,
        {
          args,
          sensitive: entry.sensitivity === "high",
        },
      );
    }

    // 5. 并发信号量（stdio 上游强制串行）
    const u = await this.upstreamRepo.findOne({
      where: { name: entry.upstream },
    });
    const limit = u?.concurrency ?? 20;
    const effLimit = u?.transport === "stdio" ? Math.min(limit, 2) : limit;
    const acq = await this.concurrency.acquire(entry.upstream, effLimit, 50);
    if (!acq.ok) {
      return {
        isError: true,
        errorCode: ErrorCode.UPSTREAM_BUSY,
        requestId,
        content: text("[UPSTREAM_BUSY] 上游繁忙，请稍后重试"),
      };
    }
    const queueMs = acq.queueMs;

    // 6. 超时转发
    const timeoutMs = u?.timeoutMs ?? 20000;
    try {
      const result = await this.upstream.callTool(
        entry.upstream,
        entry.originalName,
        args,
        timeoutMs,
      );
      const recovered = this.breaker.onSuccess(entry.upstream);
      if (recovered) {
        // P1-C・熔断事件落库（异步，不阻主链）
        this.breakerEvents.record(entry.upstream, recovered, "tool_call_ok");
        await this.upstream.onBreakerRecovered(entry.upstream);
      }
      const resultBytes = JSON.stringify(result ?? "").length;
      // P1-B・Prometheus：先埋点，与审计同位。ok 判取 result.isError。
      this.metrics.recordToolCall(
        entry.upstream,
        !result?.isError,
        Date.now() - start,
      );
      this.audit.log({
        event: "tool_call",
        channel: ctx.channel ?? "mcp",
        requestId,
        keyId: caller.keyId,
        userName: caller.userName,
        team: caller.team,
        role: caller.role,
        sessionId: ctx.sessionId ?? null,
        tool: fullName,
        upstream: entry.upstream,
        args,
        sensitive: entry.sensitivity === "high",
        resultBytes,
        resultOk: !result?.isError,
        durationMs: Date.now() - start,
        queueMs,
        callerIp: ctx.callerIp ?? null,
        clientInfo: ctx.clientInfo ?? null,
      });
      // 上游返回的 isError 原样透传，不篡改 content
      return {
        content: result?.content ?? result,
        isError: result?.isError ?? false,
        requestId,
      };
    } catch (err) {
      const isAbort =
        (err as any)?.name === "AbortError" || String(err).includes("aborted");
      const code = isAbort
        ? ErrorCode.UPSTREAM_TIMEOUT
        : ErrorCode.UPSTREAM_ERROR;
      const opened = this.breaker.onFailure(entry.upstream, "upstream-error");
      if (opened) {
        // P1-C・熔断开启落库，reason 存首个触发错误码便于事后回溯
        this.breakerEvents.record(entry.upstream, opened, code);
        await this.upstream.onBreakerOpened(entry.upstream);
      }
      // P1-B・Prometheus：失败埋点
      this.metrics.recordToolCall(entry.upstream, false, Date.now() - start);
      this.audit.log({
        event: "tool_call",
        channel: ctx.channel ?? "mcp",
        requestId,
        keyId: caller.keyId,
        userName: caller.userName,
        team: caller.team,
        role: caller.role,
        sessionId: ctx.sessionId ?? null,
        tool: fullName,
        upstream: entry.upstream,
        args,
        sensitive: entry.sensitivity === "high",
        resultOk: false,
        errorCode: code,
        errorMsg: rawErrorMessage(err),
        durationMs: Date.now() - start,
        queueMs,
        callerIp: ctx.callerIp ?? null,
      });
      const msg = isAbort
        ? "上游响应超时"
        : `工具执行失败：${safeMessage(err)}`;
      logger.warn("上游调用失败", {
        upstream: entry.upstream,
        tool: fullName,
        code,
        err: safeMessage(err),
      });
      return {
        isError: true,
        errorCode: code,
        requestId,
        content: text(`[${code}] ${msg}`),
      };
    } finally {
      this.concurrency.release(entry.upstream);
    }
  }

  private fail(
    requestId: string,
    caller: Caller,
    fullName: string,
    upstream: string | null,
    code: ErrorCodeType,
    msg: string,
    start: number,
    ctx: RouteCtx,
    extra: { args?: unknown; sensitive?: boolean } = {},
  ): RouteResult {
    this.audit.log({
      event: "tool_call",
      channel: ctx.channel ?? "mcp",
      requestId,
      keyId: caller.keyId,
      userName: caller.userName,
      team: caller.team,
      role: caller.role,
      sessionId: ctx.sessionId ?? null,
      tool: fullName,
      upstream,
      args: extra.args ?? null,
      sensitive: extra.sensitive ?? false,
      resultOk: false,
      errorCode: code,
      durationMs: Date.now() - start,
      callerIp: ctx.callerIp ?? null,
    });
    // P1-B・Prometheus：快速失败埋点（upstream 尚未知时不记，避免无意义标签）
    if (upstream)
      this.metrics.recordToolCall(upstream, false, Date.now() - start);
    return {
      isError: true,
      errorCode: code,
      requestId,
      content: text(`[${code}] ${msg}`),
    };
  }
}

function text(s: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: s }];
}
