import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { appendFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AuditLog, AuditEvent } from '../database/entities/audit.entity';
import { ConfigService } from '../config/config.service';
import { RedactService } from './redact.service';
import { CryptoService } from '../auth/crypto.service';
import { logger } from '../common/logger';

export interface AuditEntry {
  event: AuditEvent;
  channel?: 'mcp' | 'admin' | 'health';
  requestId?: string;
  keyId?: number | null;
  userName?: string | null;
  team?: string | null;
  role?: string | null;
  sessionId?: string | null;
  tool?: string | null;
  upstream?: string | null;
  args?: unknown;
  sensitive?: boolean;
  resultBytes?: number | null;
  resultOk?: boolean;
  errorCode?: string | null;
  errorMsg?: string | null;
  durationMs?: number | null;
  queueMs?: number | null;
  callerIp?: string | null;
  clientInfo?: string | null;
}

/**
 * 审计服务：异步攒批落库。
 * - 请求主链路只 push 内存数组（0 阻塞）
 * - setInterval(flushMs) 或队列满 flushSize 触发单事务批量 insert
 * - SIGTERM/SIGINT 先 flush 再关库
 * - flush 失败 append 到 data/audit-fallback.jsonl，启动时回放
 */
@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private queue: AuditEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private enabled = true;
  private flushing = false;

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    private readonly config: ConfigService,
    private readonly redact: RedactService,
    private readonly crypto: CryptoService,
  ) {}

  onModuleInit(): void {
    const { auditFlushMs } = this.config.get();
    this.timer = setInterval(() => void this.flush(), auditFlushMs);
    this.replayFallback();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush(); // 退出强制 flush
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  get depth(): number {
    return this.queue.length;
  }

  /** 入队（纯内存，不阻塞主链路） */
  log(entry: AuditEntry): void {
    if (!this.enabled && entry.event === 'tool_call') return;
    this.queue.push(entry);
    if (this.queue.length >= this.config.get().auditFlushSize) {
      void this.flush();
    }
  }

  newRequestId(): string {
    return randomUUID();
  }

  private toEntity(e: AuditEntry): AuditLog {
    const argsText = e.args == null ? '' : JSON.stringify(e.args);
    const redactedArgs = this.redact.redactDeep(e.args ?? null);
    const argsJson = redactedArgs.value == null ? '' : JSON.stringify(redactedArgs.value);
    const digest = this.crypto.sha256(argsText).slice(0, 16);
    const sensitive = e.sensitive ? 1 : 0;

    const entity = new AuditLog();
    entity.ts = Date.now();
    entity.requestId = e.requestId ?? this.newRequestId();
    entity.event = e.event;
    entity.channel = e.channel ?? 'mcp';
    entity.keyId = e.keyId ?? null;
    entity.userName = e.userName ?? null;
    entity.team = e.team ?? null;
    entity.role = e.role ?? null;
    entity.sessionId = e.sessionId ?? null;
    entity.tool = e.tool ?? null;
    entity.upstream = e.upstream ?? null;
    entity.argsDigest = digest;
    // 敏感上游记全量（脱敏后），其余仅摘要
    entity.argsFull = sensitive ? argsJson : null;
    entity.resultBytes = e.resultBytes ?? null;
    entity.resultOk = e.resultOk === false ? 0 : 1;
    entity.errorCode = e.errorCode ?? null;
    entity.errorMsg = e.errorMsg ? this.redact.redactString(e.errorMsg).value : null;
    entity.durationMs = e.durationMs ?? null;
    entity.queueMs = e.queueMs ?? null;
    entity.sensitive = sensitive;
    entity.redacted = redactedArgs.redacted ? 1 : 0;
    entity.callerIp = e.callerIp ?? null;
    entity.clientInfo = e.clientInfo ?? null;
    return entity;
  }

  /** 攒批 flush：单事务批量 insert；失败落 fallback jsonl */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue;
    this.queue = [];
    try {
      const entities = batch.map((e) => this.toEntity(e));
      await this.auditRepo.manager.transaction(async (m) => {
        await m.save(AuditLog, entities);
      });
    } catch (err) {
      logger.error('审计落库失败，写入 fallback jsonl', { count: batch.length, err: String(err) });
      this.writeFallback(batch);
    } finally {
      this.flushing = false;
    }
  }

  private writeFallback(batch: AuditEntry[]): void {
    try {
      const path = this.config.auditFallbackPath;
      const lines = batch.map((e) => JSON.stringify(e)).join('\n') + '\n';
      appendFileSync(path, lines, 'utf8');
    } catch (err) {
      logger.error('fallback 写入也失败，审计丢失', { err: String(err) });
    }
  }

  /** 启动回放 fallback：成功后改名归档，避免重复回放 */
  private replayFallback(): void {
    const path = this.config.auditFallbackPath;
    if (!existsSync(path)) return;
    try {
      const content = readFileSync(path, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length === 0) return;
      for (const line of lines) {
        try {
          this.queue.push(JSON.parse(line) as AuditEntry);
        } catch {
          /* 跳过损坏行 */
        }
      }
      renameSync(path, path + '.replayed.' + Date.now());
      logger.info('回放 fallback 审计', { count: lines.length });
      void this.flush();
    } catch (err) {
      logger.warn('回放 fallback 失败', { err: String(err) });
    }
  }
}
