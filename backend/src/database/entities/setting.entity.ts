import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * 全局设置（限流默认值、超时、审计开关等），避免为几个常量建新表。
 * 首次启动写入内置初值，之后由后台维护，全量进 change_logs。
 */
@Entity('settings')
export class Setting {
  @PrimaryColumn({ type: 'text' })
  key: string;

  @Column({ type: 'text' })
  value: string;

  @Column({ type: 'text', name: 'updated_by', default: '' })
  updatedBy: string;

  @Column({ type: 'integer', name: 'updated_at' })
  updatedAt: number;
}

/** settings 内置初值 */
export const DEFAULT_SETTINGS: Record<string, string> = {
  'ratelimit.default_qpm': '30',
  'ratelimit.burst': '30',
  'upstream.timeout_ms': '20000',
  'upstream.concurrency': '20',
  'audit.enabled': '1',
  'audit.args_full_threshold': '4096',
  'registry.refresh_interval_s': '300',
  'session.idle_timeout_s': '1800',
  // F1 影子模式：enforce=默认拒绝（现有行为）· observe=无权限时放行但写 rbac_would_forbid 审计
  'rbac.mode': 'enforce',
  // P1-A 数据库自动备份：默认每天 03:00 Asia/Shanghai 开启一份，滚动保留 7 份
  'backup.enabled': '1',
  'backup.cron': '0 3 * * *',
  'backup.tz': 'Asia/Shanghai',
  'backup.keep': '7',
};
