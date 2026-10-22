/**
 * 实体统一出口。TypeORM 的 entities 数组、data-source、seed 都从这里取，
 * 避免各处散落 import 路径导致漏注册（漏注册 = synchronize 不建表 = 运行期才炸）。
 */
export { Upstream } from './upstream.entity';
export { ToolSnapshot, ToolOverride } from './tool.entity';
export { Role, RoleRule, ApiKey } from './identity.entity';
export { AuditLog, ChangeLog } from './audit.entity';
export { Setting, DEFAULT_SETTINGS } from './setting.entity';
export { CircuitBreakerEvent } from './breaker-event.entity';
export { Backup } from './backup.entity';
export { SmokeCase } from './smoke-case.entity';

import { Upstream } from './upstream.entity';
import { ToolSnapshot, ToolOverride } from './tool.entity';
import { Role, RoleRule, ApiKey } from './identity.entity';
import { AuditLog, ChangeLog } from './audit.entity';
import { Setting } from './setting.entity';
import { CircuitBreakerEvent } from './breaker-event.entity';
import { Backup } from './backup.entity';
import { SmokeCase } from './smoke-case.entity';

/** 全部 12 张表，供 TypeOrmModule.forFeature / DataSource.entities 使用 */
export const ALL_ENTITIES = [
  Upstream,
  ToolSnapshot,
  ToolOverride,
  Role,
  RoleRule,
  ApiKey,
  AuditLog,
  ChangeLog,
  Setting,
  CircuitBreakerEvent,
  Backup,
  SmokeCase,
];
