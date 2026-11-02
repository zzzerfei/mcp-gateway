import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';
import { Backup } from '../database/entities/backup.entity';
import { Setting, DEFAULT_SETTINGS } from '../database/entities/setting.entity';
import { ConfigService } from '../config/config.service';
import { NotifyService } from '../notify/im.service';
import { logger } from '../common/logger';
import { join } from 'node:path';
import { existsSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import cron, { ScheduledTask } from 'node-cron';

/**
 * P1-A・数据库自动备份服务。
 *
 * 实现要点：
 * - 使用 better-sqlite3 官方 `db.backup(dest)` API（在线安全，WAL 下不丢数据）
 *   比 fs.copy 更可靠：拷贝瞬间 WAL 尚未 checkpoint，直接 cp .db 会得到"缺少最后一段事务"的库。
 * - Cron 表达式来自 settings，改后调 reloadCron() 立即生效
 * - 滚动保留 keep 份：备份成功后按 ts DESC 保留最新 keep 个 status=ok 记录，
 *   其余删文件 + 删行；失败行永不自动删（保留可诊断线索）
 * - 单实例锁：`running` 标志避免 cron + manual 并发把主库压坏
 * - 备份文件命名：gateway-YYYYMMDD-HHmmss-{trigger}.db
 */
@Injectable()
export class BackupService implements OnModuleInit, OnModuleDestroy {
  private task: ScheduledTask | null = null;
  private running = false;
  private cfg = {
    enabled: true,
    cron: DEFAULT_SETTINGS['backup.cron'],
    tz: DEFAULT_SETTINGS['backup.tz'],
    keep: Number(DEFAULT_SETTINGS['backup.keep']),
  };

  constructor(
    @InjectRepository(Backup)
    private readonly repo: Repository<Backup>,
    @InjectRepository(Setting)
    private readonly settingRepo: Repository<Setting>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly notify: NotifyService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadSettings();
    this.applyCron();
  }

  onModuleDestroy(): void {
    this.stopCron();
  }

  private async loadSettings(): Promise<void> {
    const rows = await this.settingRepo.find();
    const map: Record<string, string> = { ...DEFAULT_SETTINGS };
    for (const r of rows) map[r.key] = r.value;
    this.cfg = {
      enabled: map['backup.enabled'] === '1',
      cron: map['backup.cron'] || DEFAULT_SETTINGS['backup.cron'],
      tz: map['backup.tz'] || DEFAULT_SETTINGS['backup.tz'],
      keep: Math.max(1, Math.min(60, Number(map['backup.keep']) || 7)),
    };
  }

  private applyCron(): void {
    this.stopCron();
    if (!this.cfg.enabled) {
      logger.info('自动备份已禁用（settings.backup.enabled=0）');
      return;
    }
    if (!cron.validate(this.cfg.cron)) {
      logger.warn('backup.cron 表达式非法，已跳过调度', { expr: this.cfg.cron });
      return;
    }
    this.task = cron.schedule(
      this.cfg.cron,
      () => {
        this.run('cron', 'system').catch((e) =>
          logger.error('定时备份异常', { err: (e as Error).message }),
        );
      },
      { timezone: this.cfg.tz },
    );
    logger.info('自动备份已调度', { cron: this.cfg.cron, tz: this.cfg.tz, keep: this.cfg.keep });
  }

  private stopCron(): void {
    if (this.task) {
      try {
        this.task.stop();
      } catch {
        /* ignore */
      }
      this.task = null;
    }
  }

  /** Settings 变更后外部调用（system.controller.updateSettings 里） */
  async reloadCron(): Promise<void> {
    await this.loadSettings();
    this.applyCron();
  }

  /** 备份目录：<dataDir>/backup */
  private backupDir(): string {
    const dir = join(this.config.get().dataDir, 'backup');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 主库文件绝对路径 */
  dbPath(): string {
    return this.config.dbPath;
  }

  /** 执行一次备份。trigger=cron|manual */
  async run(trigger: 'cron' | 'manual', actor = 'system'): Promise<Backup> {
    if (this.running) {
      throw new Error('已有备份任务在执行，请稍后再试');
    }
    this.running = true;
    const t0 = Date.now();
    const filename = `gateway-${stamp()}-${trigger}.db`;
    const dest = join(this.backupDir(), filename);
    const row = this.repo.create({
      ts: t0,
      filename,
      absPath: dest,
      bytes: 0,
      durationMs: 0,
      trigger,
      status: 'ok',
      errorMsg: null,
      actor,
    });
    try {
      const db = this.rawSqlite();
      await db.backup(dest);
      const size = existsSync(dest) ? statSync(dest).size : 0;
      row.bytes = size;
      row.durationMs = Date.now() - t0;
      await this.repo.save(row);
      logger.info('备份完成', { file: filename, bytes: size, ms: row.durationMs, trigger });
      await this.prune();
      return row;
    } catch (e) {
      row.status = 'failed';
      row.errorMsg = (e as Error).message;
      row.durationMs = Date.now() - t0;
      await this.repo.save(row).catch(() => {
        /* 失败行写入也失败：至少日志留痕 */
      });
      logger.error('备份失败', { file: filename, err: (e as Error).message, trigger });
      // P1-D・IM 告警（fire-and-forget · 告警失败不阻主链）
      void this.notify.backupFailed(trigger, (e as Error).message, actor);
      throw e;
    } finally {
      this.running = false;
    }
  }

  /** 拿到底层 better-sqlite3 Database 实例 */
  private rawSqlite(): { backup: (dest: string) => Promise<unknown> } {
    const conn = (this.dataSource.driver as unknown as { databaseConnection: unknown }).databaseConnection;
    if (!conn || typeof (conn as { backup?: unknown }).backup !== 'function') {
      throw new Error('当前数据库驱动不支持在线备份');
    }
    return conn as { backup: (dest: string) => Promise<unknown> };
  }

  /** 滚动保留：只清理 status=ok 的旧份，失败行永不删。 */
  private async prune(): Promise<void> {
    const keep = this.cfg.keep;
    const ok = await this.repo.find({
      where: { status: 'ok' },
      order: { ts: 'DESC' },
      skip: keep,
      take: 500,
    });
    if (!ok.length) return;
    for (const b of ok) {
      try {
        if (existsSync(b.absPath)) unlinkSync(b.absPath);
      } catch (e) {
        logger.warn('旧备份文件删除失败', { path: b.absPath, err: (e as Error).message });
        // P1-D・unlink 失败仅告警一次，不抛（行已不存在，行删与否已无意义）
        void this.notify.backupPruneFailed(`${b.filename}: ${(e as Error).message}`);
      }
      await this.repo.delete({ id: b.id });
    }
    logger.info('滚动清理旧备份', { removed: ok.length, keep });
  }

  /** 分页列表（面板 + API） */
  async query(filter: {
    status?: 'ok' | 'failed';
    page?: number;
    size?: number;
  }): Promise<{ total: number; page: number; size: number; rows: Backup[] }> {
    const qb = this.repo.createQueryBuilder('b');
    if (filter.status) qb.andWhere('b.status = :st', { st: filter.status });
    const total = await qb.getCount();
    const p = Math.max(1, filter.page ?? 1);
    const s = Math.min(200, Math.max(1, filter.size ?? 20));
    const rows = await qb.orderBy('b.ts', 'DESC').skip((p - 1) * s).take(s).getMany();
    return { total, page: p, size: s, rows };
  }

  /** 最近一次成功备份（Dashboard 卡用） */
  async latest(): Promise<Backup | null> {
    const r = await this.repo.findOne({ where: { status: 'ok' }, order: { ts: 'DESC' } });
    return r ?? null;
  }

  /** 概览：给 Dashboard 展示"最近备份 · 大小 · 计划" */
  async summary(): Promise<{
    enabled: boolean;
    cron: string;
    tz: string;
    keep: number;
    latest: { ts: number; filename: string; bytes: number; durationMs: number; trigger: string } | null;
    lastFailed: { ts: number; filename: string; errorMsg: string | null } | null;
    totalCount: number;
    totalBytes: number;
  }> {
    const [latest, lastFailed, agg] = await Promise.all([
      this.latest(),
      this.repo.findOne({ where: { status: 'failed', ts: LessThan(Date.now() + 1) }, order: { ts: 'DESC' } }),
      this.repo
        .createQueryBuilder('b')
        .select('COUNT(b.id)', 'n')
        .addSelect('COALESCE(SUM(b.bytes), 0)', 'bytes')
        .where('b.status = :st', { st: 'ok' })
        .getRawOne<{ n: string; bytes: string }>(),
    ]);
    return {
      enabled: this.cfg.enabled,
      cron: this.cfg.cron,
      tz: this.cfg.tz,
      keep: this.cfg.keep,
      latest: latest
        ? { ts: latest.ts, filename: latest.filename, bytes: latest.bytes, durationMs: latest.durationMs, trigger: latest.trigger }
        : null,
      lastFailed: lastFailed
        ? { ts: lastFailed.ts, filename: lastFailed.filename, errorMsg: lastFailed.errorMsg }
        : null,
      totalCount: Number(agg?.n ?? 0),
      totalBytes: Number(agg?.bytes ?? 0),
    };
  }

  /** 下载前安全校验：id 必须存在于表内且文件在磁盘上，返回绝对路径 */
  async resolvePath(id: number): Promise<{ absPath: string; filename: string } | null> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row || row.status !== 'ok') return null;
    if (!existsSync(row.absPath)) return null;
    return { absPath: row.absPath, filename: row.filename };
  }
}

/** YYYYMMDD-HHmmss（本地时间，非 UTC，方便肉眼对时区） */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
