import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

/** 角色：intern / support / admin */
@Entity('roles')
export class Role {
  @PrimaryColumn({ type: 'text' })
  name: string;

  @Column({ type: 'text', default: '' })
  description: string;

  /** 内置角色不可删（admin 尤其） */
  @Column({ type: 'integer', name: 'is_builtin', default: 0 })
  isBuiltin: number;

  @Column({ type: 'integer', name: 'created_at' })
  createdAt: number;
}

/**
 * 规则：按 sort 升序匹配，首条命中即决定；无命中 = 默认拒绝。
 * deny 组应排在 allow 组前（保存时按语义自动重排 sort）。
 */
@Entity('role_rules')
@Index('idx_rules_role', ['role', 'sort'])
export class RoleRule {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text' })
  role: string;

  @Column({ type: 'text' })
  effect: 'allow' | 'deny';

  /** 'wiki__*' | '*__delete_*' | '*' */
  @Column({ type: 'text' })
  pattern: string;

  @Column({ type: 'integer', default: 0 })
  sort: number;

  /** 为什么加这条规则（半年后救命的字段） */
  @Column({ type: 'text', default: '' })
  memo: string;
}

/** API Key：明文只在签发响应出现一次，库中只存 SHA-256 哈希 */
@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn()
  id: number;

  /** SHA-256(rawKey) hex */
  @Index({ unique: true })
  @Column({ type: 'text', name: 'key_hash' })
  keyHash: string;

  /** 'mgw_live_ab12c3' 前缀，供后台识别 */
  @Index()
  @Column({ type: 'text', name: 'key_prefix' })
  keyPrefix: string;

  /** 用途命名：'张三-工作电脑' */
  @Column({ type: 'text' })
  name: string;

  @Index()
  @Column({ type: 'text', name: 'user_name' })
  userName: string;

  @Column({ type: 'text', default: '' })
  team: string;

  @Column({ type: 'text' })
  role: string;

  /** 工具 Profile 名（P1），空=不按 profile 裁剪 */
  @Column({ type: 'text', default: '' })
  profile: string;

  @Column({ type: 'integer', name: 'expires_at', nullable: true })
  expiresAt: number | null;

  @Column({ type: 'integer', default: 0 })
  revoked: number;

  @Column({ type: 'integer', name: 'revoked_at', nullable: true })
  revokedAt: number | null;

  @Column({ type: 'text', name: 'revoke_reason', default: '' })
  revokeReason: string;

  @Column({ type: 'integer', name: 'last_used_at', nullable: true })
  lastUsedAt: number | null;

  @Column({ type: 'text', name: 'created_by', default: '' })
  createdBy: string;

  @Column({ type: 'integer', name: 'created_at' })
  createdAt: number;
}
