import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * 工具快照：注册表的持久化视图，供权限矩阵在「工具尚未被任何调用触及」时也能渲染。
 * 每次刷新被上游数据覆盖，因此管理员覆写必须分离到 tool_overrides。
 */
@Entity('tools_snapshot')
export class ToolSnapshot {
  /** wiki__search */
  @PrimaryColumn({ type: 'text', name: 'full_name' })
  fullName: string;

  @Index()
  @Column({ type: 'text' })
  upstream: string;

  @Column({ type: 'text', name: 'original_name' })
  originalName: string;

  @Column({ type: 'text', default: '' })
  title: string;

  /** 上游原始描述（不含覆写） */
  @Column({ type: 'text', default: '' })
  description: string;

  /** 原样 JSON 文本，网关绝不篡改 */
  @Column({ type: 'text', name: 'input_schema', default: '{}' })
  inputSchema: string;

  @Column({ type: 'integer', name: 'first_seen_at' })
  firstSeenAt: number;

  @Column({ type: 'integer', name: 'last_seen_at' })
  lastSeenAt: number;
}

/**
 * 管理员覆写（描述、下线、限流、缓存）。
 * 与快照分离：快照刷新即被上游覆盖，覆写必须独立存储否则刷新丢失。
 */
@Entity('tool_overrides')
export class ToolOverride {
  @PrimaryColumn({ type: 'text', name: 'full_name' })
  fullName: string;

  /** NULL 表示不覆写 */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 0 = 单个工具下线 */
  @Column({ type: 'integer', default: 1 })
  enabled: number;

  @Column({ type: 'integer', name: 'rate_qpm', nullable: true })
  rateQpm: number | null;

  @Column({ type: 'integer', name: 'cache_ttl_s', default: 0 })
  cacheTtlS: number;

  @Column({ type: 'text', default: '' })
  note: string;

  @Column({ type: 'text', name: 'updated_by', default: '' })
  updatedBy: string;

  @Column({ type: 'integer', name: 'updated_at' })
  updatedAt: number;
}
