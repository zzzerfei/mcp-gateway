import { Injectable } from '@nestjs/common';

type BreakerState = 'closed' | 'open' | 'half-open';

interface State {
  state: BreakerState;
  fails: number;
  openedAt: number;
  windowStart: number;
  probing: boolean;
}

/**
 * P1-C・熔断器一次状态迁移的完整快照。
 * 旧语义下 onSuccess/onFailure 只返 'opened'|'recovered'|null（字符串），调用方无法得知迁移前后状态；
 * 改为结构化对象后，主链可以直接将其落库，无需额外一次 snapshot() 。
 */
export interface BreakerTransition {
  kind: 'opened' | 'recovered';
  from: BreakerState;
  to: BreakerState;
  fails: number;
}

export type BreakerEvent = BreakerTransition | null;

/**
 * 三态熔断器：closed →（窗口内连续失败 ≥ threshold）→ open（快速失败）
 * →（冷却 openMs）→ half-open（放 1 个探针）→ 成功回 closed / 失败立即回 open。
 *
 * ⚠️ 两个易漏语义：
 * 1. 错误分类：BAD_ARGS/FORBIDDEN 属客户端问题，不计入熔断（否则传错参即可熔掉上游）。
 * 2. 探针只放一个：half-open 期用 probing 布尔位独占。
 */
@Injectable()
export class BreakerService {
  private readonly states = new Map<string, State>();
  private failThreshold = 5;
  private openMs = 60_000;
  private windowMs = 60_000;

  configure(opts: { failThreshold?: number; openMs?: number; windowMs?: number }): void {
    this.failThreshold = opts.failThreshold ?? this.failThreshold;
    this.openMs = opts.openMs ?? this.openMs;
    this.windowMs = opts.windowMs ?? this.windowMs;
  }

  /** P1-C：供面板展示当前熔断阈值，方便与历史事件时长上下文对齐 */
  getConfig(): { failThreshold: number; openMs: number; windowMs: number } {
    return { failThreshold: this.failThreshold, openMs: this.openMs, windowMs: this.windowMs };
  }

  private get(upstream: string): State {
    let s = this.states.get(upstream);
    if (!s) {
      s = { state: 'closed', fails: 0, openedAt: 0, windowStart: Date.now(), probing: false };
      this.states.set(upstream, s);
    }
    return s;
  }

  /** 是否应快速失败。half-open 时仅放行第一个探针。 */
  isOpen(upstream: string): boolean {
    const s = this.get(upstream);
    if (s.state === 'closed') return false;
    if (s.state === 'open') {
      if (Date.now() - s.openedAt > this.openMs) {
        s.state = 'half-open';
        s.probing = false;
      } else {
        return true;
      }
    }
    // half-open：独占探针
    if (s.state === 'half-open') {
      if (s.probing) return true; // 已有探针在途，其余快速失败
      s.probing = true;
      return false;
    }
    return false;
  }

  onSuccess(upstream: string): BreakerEvent {
    const s = this.get(upstream);
    const prev = s.state;
    const prevFails = s.fails;
    if (prev === 'closed') return null; // 无迁移，不算事件
    s.state = 'closed';
    s.fails = 0;
    s.probing = false;
    s.windowStart = Date.now();
    return { kind: 'recovered', from: prev, to: 'closed', fails: prevFails };
  }

  /**
   * @param kind 'client-error' 不计入熔断
   */
  onFailure(upstream: string, kind: 'client-error' | 'upstream-error' = 'upstream-error'): BreakerEvent {
    if (kind === 'client-error') return null;
    const s = this.get(upstream);
    if (Date.now() - s.windowStart > this.windowMs) {
      s.windowStart = Date.now();
      s.fails = 0;
    }
    const prev = s.state;
    s.fails += 1;
    if (s.state === 'half-open' || s.fails >= this.failThreshold) {
      const firstOpen = s.state !== 'open';
      s.state = 'open';
      s.openedAt = Date.now();
      s.probing = false;
      if (!firstOpen) return null;
      return { kind: 'opened', from: prev, to: 'open', fails: s.fails };
    }
    return null;
  }

  snapshot(upstream: string): { state: BreakerState; fails: number } {
    const s = this.get(upstream);
    return { state: s.state, fails: s.fails };
  }

  /** P1-C：供实时面板一次性拿到全部已知上游的当前态（仅已创建过 state 的） */
  snapshotAll(): Array<{ upstream: string; state: BreakerState; fails: number; openedAt: number }> {
    const out: Array<{ upstream: string; state: BreakerState; fails: number; openedAt: number }> = [];
    for (const [name, s] of this.states.entries()) {
      out.push({ upstream: name, state: s.state, fails: s.fails, openedAt: s.openedAt });
    }
    return out;
  }

  /** 强制重置（上游探活成功后调用） */
  reset(upstream: string): void {
    this.states.delete(upstream);
  }
}
