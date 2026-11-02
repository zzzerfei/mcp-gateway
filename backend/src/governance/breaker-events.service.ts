import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Observable, Subject } from 'rxjs';
import { CircuitBreakerEvent } from '../database/entities/breaker-event.entity';
import { BreakerService, BreakerTransition } from './breaker.service';
import { logger } from '../common/logger';

/**
 * P1-C・熔断事件落库服务。
 *
 * 与 BreakerService（纯内存）分工：BreakerService 只做决策，BreakerEventsService 只做留痕。
 * Router 主链在 onSuccess/onFailure 返值非空时 fire-and-forget 调用 record，不阻塞返回。
 *
 * 之所以不走 AuditService 攒批：审计表事件语义面向"单次调用"（tool_call/auth_fail/rbac_would_forbid），
 * 熔断迁移是"上游健康度趋势"，两种查询模式独立建表更利于按月归档与运维面板快速过滤。
 */
@Injectable()
export class BreakerEventsService {
  /** P1-F・SSE 推流广播频道：新迁移写入时向订阅者广播一条（仅当前实例内、不跨进程） */
  private readonly stream$ = new Subject<{ type: 'breaker'; data: CircuitBreakerEvent }>();

  constructor(
    @InjectRepository(CircuitBreakerEvent)
    private readonly repo: Repository<CircuitBreakerEvent>,
    private readonly breaker: BreakerService,
  ) {}

  /** 记录一次迁移。fire-and-forget，写库失败仅告警不影响主链。 */
  record(upstream: string, transition: BreakerTransition, reason?: string): void {
    if (!transition) return;
    const cfg = this.breaker.getConfig();
    const row = this.repo.create({
      ts: Date.now(),
      upstream,
      event: transition.kind,
      fromState: transition.from,
      toState: transition.to,
      failsInWindow: transition.fails,
      openMs: cfg.openMs,
      reason: reason ?? null,
    });
    this.repo
      .save(row)
      .then((saved) => {
        // P1-F・保存成功后广播（无订阅者时为 no-op）
        this.stream$.next({ type: 'breaker', data: saved });
      })
      .catch((e) => logger.warn('熔断事件写库失败', { upstream, err: String(e) }));
  }
  
  /** P1-F・SSE 订阅入口：controller 直接 return 给 @Sse()，Nest 会写 text/event-stream */
  subscribe(): Observable<{ type: 'breaker'; data: CircuitBreakerEvent }> {
    return this.stream$.asObservable();
  }

  /** 分页查询：面板与 API 共用。 */
  async query(filter: {
    upstream?: string;
    event?: 'opened' | 'recovered';
    from?: number;
    to?: number;
    page?: number;
    size?: number;
  }): Promise<{ total: number; page: number; size: number; rows: CircuitBreakerEvent[] }> {
    const qb = this.repo.createQueryBuilder('e');
    if (filter.upstream) qb.andWhere('e.upstream = :up', { up: filter.upstream });
    if (filter.event) qb.andWhere('e.event = :ev', { ev: filter.event });
    if (filter.from) qb.andWhere('e.ts >= :from', { from: filter.from });
    if (filter.to) qb.andWhere('e.ts <= :to', { to: filter.to });
    const total = await qb.getCount();
    const p = Math.max(1, filter.page ?? 1);
    const s = Math.min(200, Math.max(1, filter.size ?? 20));
    const rows = await qb.orderBy('e.ts', 'DESC').skip((p - 1) * s).take(s).getMany();
    return { total, page: p, size: s, rows };
  }

  /** 概览：近 N 天每个上游的开合次数，用于面板顶部统计卡 */
  async summary(days = 7): Promise<Array<{ upstream: string; opened: number; recovered: number; lastEventTs: number }>> {
    const since = Date.now() - days * 86_400_000;
    const raw = await this.repo
      .createQueryBuilder('e')
      .select('e.upstream', 'upstream')
      .addSelect("SUM(CASE WHEN e.event = 'opened' THEN 1 ELSE 0 END)", 'opened')
      .addSelect("SUM(CASE WHEN e.event = 'recovered' THEN 1 ELSE 0 END)", 'recovered')
      .addSelect('MAX(e.ts)', 'lastEventTs')
      .where('e.ts >= :since', { since })
      .groupBy('e.upstream')
      .orderBy('opened', 'DESC')
      .getRawMany<{ upstream: string; opened: string; recovered: string; lastEventTs: string }>();
    return raw.map((r) => ({
      upstream: r.upstream,
      opened: Number(r.opened),
      recovered: Number(r.recovered),
      lastEventTs: Number(r.lastEventTs),
    }));
  }
}
