import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 熔断器状态迁移事件。
 *
 * BreakerService 只保内存态，进程重启即丢失；本表解决「上周这条上游熔了几次 /
 * 恢复用了多久 / 什么触发」这类只能事后回看的问题。与 audit_logs 是两种查询模式
 * （audit 面向单次调用，本表面向上游健康度趋势），独立存储便于按月归档。
 */
export type BreakerEventKind = 'opened' | 'recovered';
export type BreakerStateName = 'closed' | 'open' | 'half-open';

@Entity('circuit_breaker_events')
@Index('idx_brk_ts', ['ts'])
@Index('idx_brk_up_ts', ['upstream', 'ts'])
@Index('idx_brk_event_ts', ['event', 'ts'])
export class CircuitBreakerEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer' })
  ts: number;

  @Column({ type: 'text' })
  upstream: string;

  /** opened = closed→open 或 half-open→open；recovered = open/half-open→closed */
  @Column({ type: 'text' })
  event: BreakerEventKind;

  @Column({ type: 'text', name: 'from_state' })
  fromState: BreakerStateName;

  @Column({ type: 'text', name: 'to_state' })
  toState: BreakerStateName;

  /** 迁移发生时的窗口内累计失败数（opened 时有意义，recovered 记 0） */
  @Column({ type: 'integer', name: 'fails_in_window', default: 0 })
  failsInWindow: number;

  /** 熔断冷却时长快照（ms），便于事后复盘「这次熔了多久」 */
  @Column({ type: 'integer', name: 'open_ms', default: 0 })
  openMs: number;

  /** 可选补充：首个触发错误码 / health-check 恢复 / manual-reset 等 */
  @Column({ type: 'text', nullable: true })
  reason: string | null;
}
