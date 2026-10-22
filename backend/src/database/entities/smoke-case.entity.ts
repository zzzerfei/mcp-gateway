import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 冒烟用例：把一次可用的工具调用固化下来，支持一键回归。
 * 执行时复用 GatewayRouter 的完整治理链，因此回归结果与真实客户端一致。
 */
@Entity('smoke_cases')
export class SmokeCase {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text' })
  name: string;

  @Index()
  @Column({ type: 'text', name: 'tool_full_name' })
  toolFullName: string;

  /** 原样保存的调用参数 JSON 文本 */
  @Column({ type: 'text', name: 'args_json', default: '{}' })
  argsJson: string;

  /** 以哪个角色身份执行（用于权限回归） */
  @Column({ type: 'text', default: 'admin' })
  role: string;

  @Column({ type: 'integer', default: 1 })
  enabled: number;

  @Column({ type: 'text', name: 'created_by', default: '' })
  createdBy: string;

  @Column({ type: 'integer', name: 'created_at' })
  createdAt: number;

  @Column({ type: 'integer', name: 'updated_at' })
  updatedAt: number;

  @Column({ type: 'integer', name: 'last_run_at', nullable: true })
  lastRunAt: number | null;

  /** 1=通过 0=失败 null=未运行 */
  @Column({ type: 'integer', name: 'last_ok', nullable: true })
  lastOk: number | null;

  @Column({ type: 'integer', name: 'last_duration_ms', nullable: true })
  lastDurationMs: number | null;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError: string | null;
}
