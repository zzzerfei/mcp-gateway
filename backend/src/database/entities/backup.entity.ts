import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * P1-A・数据库备份记录。
 *
 * 每次 cron 或手动触发生成一行留痕（含失败）。与 change_logs 分离原因：
 * - 备份失败时 change_logs 需要 actor/reqId 但此处仅有 system/cron，语义不匹配
 * - 面板要按时间倒序快速展示"最近备份是否成功"，独立表更快
 *
 * 文件名默认：gateway-YYYYMMDD-HHmmss-<trigger>.db（trigger=cron|manual）
 */
@Entity('backups')
@Index('idx_backup_ts', ['ts'])
@Index('idx_backup_status_ts', ['status', 'ts'])
export class Backup {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer' })
  ts: number;

  @Column({ type: 'text', name: 'filename' })
  filename: string;

  @Column({ type: 'text', name: 'abs_path' })
  absPath: string;

  @Column({ type: 'integer', name: 'bytes', default: 0 })
  bytes: number;

  @Column({ type: 'integer', name: 'duration_ms', default: 0 })
  durationMs: number;

  @Column({ type: 'text', name: 'trigger' })
  trigger: 'cron' | 'manual';

  @Column({ type: 'text', default: 'ok' })
  status: 'ok' | 'failed';

  @Column({ type: 'text', name: 'error_msg', nullable: true })
  errorMsg: string | null;

  /** 手动触发时的操作者（x-admin-user）；cron 为 'system' */
  @Column({ type: 'text', name: 'actor', default: 'system' })
  actor: string;
}
