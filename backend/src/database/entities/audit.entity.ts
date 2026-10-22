import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type AuditEvent =
  | 'tool_call'
  | 'tools_list'
  | 'initialize'
  | 'auth_fail'
  | 'rate_limit'
  | 'circuit_open'
  | 'circuit_close'
  | 'upstream_down'
  | 'upstream_up'
  | 'rbac_would_forbid'
  | 'admin_op';

/**
 * 审计日志（调用台账）。只增不改：代码层不提供 UPDATE/DELETE 业务路径。
 * 索引以「安全部门的问题」为设计输入，每条问句对应一条索引。
 */
@Entity('audit_logs')
@Index('idx_audit_ts', ['ts'])
@Index('idx_audit_user_ts', ['userName', 'ts'])
@Index('idx_audit_tool_ts', ['tool', 'ts'])
@Index('idx_audit_up_ts', ['upstream', 'ts'])
@Index('idx_audit_sensitive', ['sensitive', 'ts'])
@Index('idx_audit_key_ts', ['keyId', 'ts'])
@Index('idx_audit_req', ['requestId'])
export class AuditLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer' })
  ts: number;

  /** 单次调用唯一 id，串联日志与工单 */
  @Column({ type: 'text', name: 'request_id' })
  requestId: string;

  @Column({ type: 'text' })
  event: AuditEvent;

  @Column({ type: 'text', default: 'mcp' })
  channel: 'mcp' | 'admin' | 'health';

  @Column({ type: 'integer', name: 'key_id', nullable: true })
  keyId: number | null;

  @Column({ type: 'text', name: 'user_name', nullable: true })
  userName: string | null;

  @Column({ type: 'text', nullable: true })
  team: string | null;

  @Column({ type: 'text', nullable: true })
  role: string | null;

  @Column({ type: 'text', name: 'session_id', nullable: true })
  sessionId: string | null;

  @Column({ type: 'text', nullable: true })
  tool: string | null;

  @Column({ type: 'text', nullable: true })
  upstream: string | null;

  /** 普通工具：SHA-256 前 16 位 + 脱敏摘要 */
  @Column({ type: 'text', name: 'args_digest', nullable: true })
  argsDigest: string | null;

  /** 敏感工具：脱敏后全量 JSON */
  @Column({ type: 'text', name: 'args_full', nullable: true })
  argsFull: string | null;

  @Column({ type: 'integer', name: 'result_bytes', nullable: true })
  resultBytes: number | null;

  @Column({ type: 'integer', name: 'result_ok', default: 1 })
  resultOk: number;

  @Column({ type: 'text', name: 'error_code', nullable: true })
  errorCode: string | null;

  /** 原始错误（含堆栈），仅内部可见 */
  @Column({ type: 'text', name: 'error_msg', nullable: true })
  errorMsg: string | null;

  @Column({ type: 'integer', name: 'duration_ms', nullable: true })
  durationMs: number | null;

  /** 在上游并发队列中的等待时间 */
  @Column({ type: 'integer', name: 'queue_ms', nullable: true })
  queueMs: number | null;

  @Column({ type: 'integer', default: 0 })
  sensitive: number;

  /** 是否做过 PII 脱敏 */
  @Column({ type: 'integer', default: 0 })
  redacted: number;

  @Column({ type: 'text', name: 'caller_ip', nullable: true })
  callerIp: string | null;

  @Column({ type: 'text', name: 'client_info', nullable: true })
  clientInfo: string | null;
}

/**
 * 配置变更留痕。审计员关心「谁改了什么规则」，与调用台账是两种查询模式。
 * 治理系统自身可信度的底线：管理员的每次写操作都进这里。
 */
@Entity('change_logs')
@Index('idx_change_ts', ['ts'])
@Index('idx_change_target', ['targetType', 'targetId'])
export class ChangeLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer' })
  ts: number;

  /** 管理员标识 / 'system' */
  @Column({ type: 'text' })
  actor: string;

  @Column({ type: 'text', name: 'actor_ip', default: '' })
  actorIp: string;

  @Column({ type: 'text', name: 'target_type' })
  targetType: 'upstream' | 'role' | 'role_rules' | 'api_key' | 'tool_override' | 'settings' | 'backup' | 'smoke_case';

  @Column({ type: 'text', name: 'target_id' })
  targetId: string;

  @Column({ type: 'text' })
  action: 'create' | 'update' | 'delete' | 'revoke' | 'enable' | 'disable' | 'rollback' | 'auto-disable';

  /** 变更前完整对象（脱敏后） */
  @Column({ type: 'text', name: 'before_json', nullable: true })
  beforeJson: string | null;

  @Column({ type: 'text', name: 'after_json', nullable: true })
  afterJson: string | null;

  /** 人类可读：'support 角色新增 deny crm__delete_record' */
  @Column({ type: 'text', name: 'diff_summary', default: '' })
  diffSummary: string;
}
