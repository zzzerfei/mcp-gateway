import { Injectable } from '@nestjs/common';

interface Semaphore {
  limit: number;
  maxQueue: number;
  active: number;
  waiters: Array<() => void>;
}

/**
 * 上游并发信号量：防止慢上游耗尽网关连接与内存。
 * 每个上游一个实例（≤ 30 个，内存可忽略）。queue_ms 记入审计识别慢上游排队。
 */
@Injectable()
export class ConcurrencyService {
  private readonly sems = new Map<string, Semaphore>();

  private get(upstream: string, limit: number, maxQueue: number): Semaphore {
    let s = this.sems.get(upstream);
    if (!s) {
      s = { limit, maxQueue, active: 0, waiters: [] };
      this.sems.set(upstream, s);
    } else {
      s.limit = limit;
      s.maxQueue = maxQueue;
    }
    return s;
  }

  /**
   * 获取并发槽。立即返回 {ok:true} 或排队 Promise；队列满返回 {ok:false}。
   * 返回值携带 waitStartedAt 供计算 queue_ms。
   */
  acquire(
    upstream: string,
    limit = 20,
    maxQueue = 50,
  ): Promise<{ ok: true; queueMs: number } | { ok: false; reason: 'QUEUE_FULL' }> {
    const s = this.get(upstream, limit, maxQueue);
    const start = Date.now();
    if (s.active < s.limit) {
      s.active++;
      return Promise.resolve({ ok: true, queueMs: 0 });
    }
    if (s.waiters.length >= s.maxQueue) {
      return Promise.resolve({ ok: false, reason: 'QUEUE_FULL' });
    }
    return new Promise((resolve) => {
      s.waiters.push(() => {
        s.active++;
        resolve({ ok: true, queueMs: Date.now() - start });
      });
    });
  }

  release(upstream: string): void {
    const s = this.sems.get(upstream);
    if (!s) return;
    // 修正：无论有无 waiter，先归还一个 slot；如果有 waiter，next() 内部会再 +1（next 中 s.active++）
    // 旧实现“有 waiter 时不先 --”会导致 active 无上限累加（slot 泄漏），一旦上游卡一下后面就永远 UPSTREAM_BUSY
    s.active = Math.max(0, s.active - 1);
    const next = s.waiters.shift();
    if (next) next();
  }

  /** 上游下线时清理 */
  remove(upstream: string): void {
    this.sems.delete(upstream);
  }

  stats(upstream: string): { active: number; waiting: number } {
    const s = this.sems.get(upstream);
    return { active: s?.active ?? 0, waiting: s?.waiters.length ?? 0 };
  }
}
