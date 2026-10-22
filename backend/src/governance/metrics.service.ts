import { Injectable } from '@nestjs/common';
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * P1-B・Prometheus 标准指标服务。
 *
 * 设计决策：
 * - 独立 Registry（不用默认全局），避免其他库/中间件污染抓取输出。
 * - 前缀 mgw_，命名与 Prometheus 官方约定一致（_total 表 counter、_seconds/_ms 表 histogram）。
 * - collectDefaultMetrics 提供 process_cpu_user_seconds_total / nodejs_eventloop_lag_seconds /
 *   nodejs_heap_size_bytes 等十余项运行时指标，零成本满足 PRD 8.1 生产可观测硬指标。
 * - Gauge 采用「拉取前刷新」模式：Controller 输出前调用 refreshRuntime()，从各服务现场取值 set，
 *   避免每个业务链路都记得 set（易漏）；scrape 间隔默认 15s，量级完全够。
 * - Counter / Histogram 走 push 模式（tool_call 结束时 .inc() / .observe()），
 *   与审计、熔断同位。
 *
 * 与旧 /metrics JSON 端点并存不冲突：本 service 只服务 /metrics.prom，
 * 老 smoke 依赖 JSON 字段，保留即可。
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  // 业务自定义指标
  private readonly toolCalls: Counter<'upstream' | 'status'>;
  private readonly toolCallDuration: Histogram<'upstream'>;
  private readonly breakerState: Gauge<'upstream'>;
  private readonly registryTools: Gauge<string>;
  private readonly registryVersion: Gauge<string>;
  private readonly sessionsActive: Gauge<string>;
  private readonly upstreamsConnected: Gauge<string>;
  private readonly auditQueueDepth: Gauge<string>;
  private readonly ratelimitBuckets: Gauge<string>;
  // P1-E・HTTP 入口埋点
  private readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  private readonly httpRequestDuration: Histogram<'method' | 'route'>;

  constructor() {
    collectDefaultMetrics({
      register: this.registry,
      prefix: 'mgw_',
      // 事件循环延迟 histogram buckets：与 PRD 8.1 p99 目标对齐
      eventLoopMonitoringPrecision: 10,
    });

    this.toolCalls = new Counter({
      name: 'mgw_tool_calls_total',
      help: 'Total MCP tool calls labeled by upstream and status (ok|err)',
      labelNames: ['upstream', 'status'] as const,
      registers: [this.registry],
    });

    this.toolCallDuration = new Histogram({
      name: 'mgw_tool_call_duration_ms',
      help: 'MCP tool call latency distribution (ms) labeled by upstream',
      labelNames: ['upstream'] as const,
      buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 30000],
      registers: [this.registry],
    });

    this.breakerState = new Gauge({
      name: 'mgw_upstream_breaker_state',
      help: 'Circuit breaker state per upstream: 0=closed, 1=half-open, 2=open',
      labelNames: ['upstream'] as const,
      registers: [this.registry],
    });

    this.registryTools = new Gauge({
      name: 'mgw_registry_tools_total',
      help: 'Number of tools currently exposed in the registry',
      registers: [this.registry],
    });
    this.registryVersion = new Gauge({
      name: 'mgw_registry_version',
      help: 'Current tool registry version (monotonic)',
      registers: [this.registry],
    });
    this.sessionsActive = new Gauge({
      name: 'mgw_sessions_active',
      help: 'Currently active MCP client sessions',
      registers: [this.registry],
    });
    this.upstreamsConnected = new Gauge({
      name: 'mgw_upstreams_connected',
      help: 'Currently connected upstream servers',
      registers: [this.registry],
    });
    this.auditQueueDepth = new Gauge({
      name: 'mgw_audit_queue_depth',
      help: 'Depth of the async audit writer queue (pending rows)',
      registers: [this.registry],
    });
    this.ratelimitBuckets = new Gauge({
      name: 'mgw_ratelimit_buckets',
      help: 'Number of live rate limiter token buckets (key × tool)',
      registers: [this.registry],
    });

    // P1-E・HTTP 入口埋点：route 已在 middleware 归一化（:id 模板 + __unmatched__），不会标签爆炸
    this.httpRequests = new Counter({
      name: 'mgw_http_requests_total',
      help: 'Total HTTP requests entering the gateway, labeled by method/route template/status class',
      labelNames: ['method', 'route', 'status'] as const,
      registers: [this.registry],
    });
    this.httpRequestDuration = new Histogram({
      name: 'mgw_http_request_duration_ms',
      help: 'HTTP request latency distribution (ms) labeled by method/route template',
      labelNames: ['method', 'route'] as const,
      // 1ms → 30s，覆盖 admin 写操作、MCP tools/call 上游回源两个量级
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 30000],
      registers: [this.registry],
    });
  }

  // ── 业务链路调用点 ─────────────────────────────────
  /** Router 主链每次 tool_call 完成后调用（含 fail 快速失败） */
  recordToolCall(upstream: string, ok: boolean, durationMs: number): void {
    this.toolCalls.inc({ upstream, status: ok ? 'ok' : 'err' });
    this.toolCallDuration.observe({ upstream }, Math.max(0, durationMs));
  }

  /** P1-E・Middleware 埋点：一个 HTTP 请求完整处理结束时调用 */
  recordHttpRequest(method: string, route: string, status: number, durationMs: number): void {
    const statusClass = `${Math.floor(status / 100) * 100}`; // 2xx/4xx/5xx 归类，防 status 标签爆炸
    this.httpRequests.inc({ method, route, status: statusClass });
    this.httpRequestDuration.observe({ method, route }, Math.max(0, durationMs));
  }

  // ── 拉取前刷新（Controller 输出前调用）──────────
  refreshRuntime(snapshot: {
    registryTools: number;
    registryVersion: number;
    sessionsActive: number;
    upstreamsConnected: number;
    auditQueueDepth: number;
    ratelimitBuckets: number;
    breakerStates: Array<{ upstream: string; state: 'closed' | 'half-open' | 'open' }>;
  }): void {
    this.registryTools.set(snapshot.registryTools);
    this.registryVersion.set(snapshot.registryVersion);
    this.sessionsActive.set(snapshot.sessionsActive);
    this.upstreamsConnected.set(snapshot.upstreamsConnected);
    this.auditQueueDepth.set(snapshot.auditQueueDepth);
    this.ratelimitBuckets.set(snapshot.ratelimitBuckets);
    // 每次刷新前重置 breaker 标签集合，避免已消失的上游残留
    this.breakerState.reset();
    for (const b of snapshot.breakerStates) {
      const v = b.state === 'open' ? 2 : b.state === 'half-open' ? 1 : 0;
      this.breakerState.set({ upstream: b.upstream }, v);
    }
  }

  /** 输出 Prometheus text 格式（Content-Type 与 body 一起返回） */
  async expose(): Promise<{ contentType: string; body: string }> {
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }
}
