import { Global, Module } from '@nestjs/common';
import { RedactService } from './redact.service';
import { AuditService } from './audit.service';
import { RateLimitService } from './ratelimit.service';
import { BreakerService } from './breaker.service';
import { BreakerEventsService } from './breaker-events.service';
import { ConcurrencyService } from './concurrency.service';
import { BackupService } from './backup.service';
import { MetricsService } from './metrics.service';

/**
 * 治理模块（全局）：网关「十字路口」的五道闸。
 * - RedactService：PII 脱敏（入库前）
 * - AuditService：审计攒批异步落库 + fallback jsonl（OnModuleInit 回放，OnModuleDestroy flush）
 * - RateLimitService：令牌桶（key×tool）
 * - BreakerService：三态熔断
 * - BreakerEventsService：P1-C・熔断事件落库（与 BreakerService 分工，一个决策一个留痕）
 * - ConcurrencyService：上游并发信号量
 * - BackupService：P1-A・数据库自动备份（node-cron + better-sqlite3 backup）
 * RouterService 顺序编排这五者，故全部 @Global 导出。
 */
@Global()
@Module({
  providers: [RedactService, AuditService, RateLimitService, BreakerService, BreakerEventsService, ConcurrencyService, BackupService, MetricsService],
  exports: [RedactService, AuditService, RateLimitService, BreakerService, BreakerEventsService, ConcurrencyService, BackupService, MetricsService],
})
export class GovernanceModule {}
