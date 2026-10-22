import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type Transport = 'http' | 'stdio';
export type Sensitivity = 'normal' | 'high';
export type UpstreamStatus = 'up' | 'down' | 'unknown';

/**
 * 上游 MCP Server。配置字段（url/凭据/治理属性）由管理员维护，
 * 运行态字段（last_status/last_error/last_checked_at）由网关回写。
 */
@Entity('upstreams')
export class Upstream {
  @PrimaryGeneratedColumn()
  id: number;

  /** 命名空间前缀：wiki / crm（^[a-z][a-z0-9_-]{1,31}$） */
  @Index({ unique: true })
  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', name: 'display_name', default: '' })
  displayName: string;

  @Column({ type: 'text', default: 'http' })
  transport: Transport;

  // ── http 传输 ──
  @Column({ type: 'text', nullable: true })
  url: string | null;

  /** 认证头等，AES-GCM 密文（base64） */
  @Column({ type: 'text', name: 'headers_enc', nullable: true })
  headersEnc: string | null;

  // ── stdio 传输 ──
  @Column({ type: 'text', nullable: true })
  command: string | null;

  @Column({ type: 'text', name: 'args_json', nullable: true })
  argsJson: string | null;

  @Column({ type: 'text', nullable: true })
  cwd: string | null;

  @Column({ type: 'text', name: 'env_enc', nullable: true })
  envEnc: string | null;

  // ── 治理属性 ──
  @Column({ type: 'text', default: 'normal' })
  sensitivity: Sensitivity;

  @Column({ type: 'integer', default: 1 })
  enabled: number;

  /** 负责人，熔断告警路由对象 */
  @Column({ type: 'text', default: '' })
  owner: string;

  @Column({ type: 'integer', name: 'timeout_ms', default: 20000 })
  timeoutMs: number;

  @Column({ type: 'integer', default: 20 })
  concurrency: number;

  @Column({ type: 'text', default: '' })
  remark: string;

  // ── 运行态（网关回写，非配置）──
  @Column({ type: 'text', name: 'last_status', default: 'unknown' })
  lastStatus: UpstreamStatus;

  @Column({ type: 'text', name: 'last_error', default: '' })
  lastError: string;

  @Column({ type: 'integer', name: 'last_checked_at', nullable: true })
  lastCheckedAt: number | null;

  @Column({ type: 'integer', name: 'created_at' })
  createdAt: number;

  @Column({ type: 'integer', name: 'updated_at' })
  updatedAt: number;
}
