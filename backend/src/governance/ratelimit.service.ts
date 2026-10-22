import { Injectable } from '@nestjs/common';

interface Bucket {
  tokens: number;
  last: number;
  retryAfterMs?: number;
}

/**
 * 令牌桶限流（key × tool 维度）。
 * 选令牌桶而非固定窗口：允许短时突发，又限制平均速率，贴合 Agent「一阵一阵」的调用模式。
 *
 * ⚠️ 多实例语义：内存桶速率是「每进程」的，起 N 实例 = 放行 N×rate。
 * 一期只允许单实例；扩展时换 SqliteRateLimiter 或 Redis Lua。
 */
@Injectable()
export class RateLimitService {
  private readonly buckets = new Map<string, Bucket>();
  private defaultQpm = 30;
  private burst = 30;
  private lastSweep = Date.now();

  setDefaults(qpm: number, burst: number): void {
    this.defaultQpm = qpm;
    this.burst = burst;
  }

  /**
   * 取一个令牌。返回 true 放行；false 拒绝并附 retryAfterMs。
   */
  take(
    keyId: number,
    tool: string,
    rate = this.defaultQpm,
    capacity = this.burst,
  ): { ok: true } | { ok: false; retryAfterMs: number } {
    const k = `${keyId}|${tool}`;
    const now = Date.now();
    let b = this.buckets.get(k);
    if (!b) {
      b = { tokens: capacity, last: now };
      this.buckets.set(k, b);
    }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 60_000) * rate);
    b.last = now;
    if (b.tokens < 1) {
      const retryAfterMs = Math.ceil(((1 - b.tokens) / rate) * 60_000);
      return { ok: false, retryAfterMs };
    }
    b.tokens -= 1;
    return { ok: true };
  }

  /**
   * 内存回收：桶数 = Key × 工具，500 × 600 会到 30 万，必须清陈旧桶。
   * 每 60s 最多执行一次。
   */
  sweep(idleMs = 600_000): number {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return 0;
    this.lastSweep = now;
    let removed = 0;
    for (const [k, b] of this.buckets) {
      if (now - b.last > idleMs) {
        this.buckets.delete(k);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }
}
