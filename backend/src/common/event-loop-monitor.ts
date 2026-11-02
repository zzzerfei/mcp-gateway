import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { logger } from './logger';

/**
 * 事件循环延迟监控（PRD 8.1 硬指标：P99 < 100ms，> 200ms 告警）。
 *
 * 设计取舍：
 * - 使用 Node 内置 `perf_hooks.monitorEventLoopDelay`，零外部依赖。
 * - histogram 每 `sampleIntervalMs` 读一次分位数并 reset，避免长期累积导致 p99 钝化。
 * - 采样本身在 interval 回调里，成本极低（读几个数字）；主链路 0 开销。
 * - 超阈值不直接调 NotifyService（避免与 Nest DI 循环），改为**注册回调**模式，
 *   由 `bootstrap.service.ts` 在 OnModuleInit 阶段注入实际告警实现。
 *
 * 使用：
 *   startEventLoopMonitor();          // main.ts bootstrap 后调用一次
 *   const q = getEventLoopPercentiles(); // metrics controller 里读
 *   registerEventLoopAlert(fn);      // bootstrap 时接入 IM webhook
 */

const RESOLUTION_MS = 20;
const SAMPLE_INTERVAL_MS = 5_000;
const ALERT_P99_MS = 200;
const ALERT_COOLDOWN_MS = 5 * 60_000; // 5 分钟同类抑制，避免告警风暴

let histogram: IntervalHistogram | null = null;
let sampler: NodeJS.Timeout | null = null;
let latest = { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
let alertCb: ((info: { p99Ms: number; maxMs: number }) => void | Promise<void>) | null = null;
let lastAlertAt = 0;

export function startEventLoopMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  sampler = setInterval(sample, SAMPLE_INTERVAL_MS);
  // 不阻止进程退出
  sampler.unref?.();
  logger.info('事件循环延迟监控已启动', {
    resolution_ms: RESOLUTION_MS,
    sample_interval_ms: SAMPLE_INTERVAL_MS,
    alert_p99_ms: ALERT_P99_MS,
  });
}

export function stopEventLoopMonitor(): void {
  if (histogram) {
    histogram.disable();
    histogram.reset();
    histogram = null;
  }
  if (sampler) {
    clearInterval(sampler);
    sampler = null;
  }
}

function sample(): void {
  if (!histogram) return;
  const toMs = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
  latest = {
    p50: toMs(histogram.percentile(50)),
    p95: toMs(histogram.percentile(95)),
    p99: toMs(histogram.percentile(99)),
    max: toMs(histogram.max),
    mean: toMs(histogram.mean),
  };
  histogram.reset();
  // 阈值告警：5 分钟冷却，避免风暴
  if (latest.p99 > ALERT_P99_MS && Date.now() - lastAlertAt > ALERT_COOLDOWN_MS) {
    lastAlertAt = Date.now();
    try {
      const maybe = alertCb?.({ p99Ms: latest.p99, maxMs: latest.max });
      if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
        (maybe as Promise<void>).catch((e) => logger.warn('EL 告警回调失败', { err: String(e?.message ?? e) }));
      }
    } catch (e) {
      logger.warn('EL 告警回调异常', { err: String((e as Error)?.message ?? e) });
    }
  }
}

export function getEventLoopPercentiles(): { p50: number; p95: number; p99: number; max: number; mean: number } {
  return { ...latest };
}

export function registerEventLoopAlert(
  cb: (info: { p99Ms: number; maxMs: number }) => void | Promise<void>,
): void {
  alertCb = cb;
}

/** 便于单测/演示：手动注入一个 p99 值触发告警分支 */
export function __triggerAlertForTest(info: { p99Ms: number; maxMs: number }): void {
  lastAlertAt = 0;
  alertCb?.(info);
}
