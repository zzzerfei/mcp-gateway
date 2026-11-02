import { Body, Controller, Get, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { AdminTokenGuard } from './guards/admin-token.guard';
import { Setting, DEFAULT_SETTINGS } from '../database/entities/setting.entity';
import { ToolRegistryService } from '../gateway/registry.service';
import { UpstreamManagerService } from '../gateway/upstream-manager.service';
import { SessionManager } from '../transport/session.manager';
import { RateLimitService } from '../governance/ratelimit.service';
import { AuditService } from '../governance/audit.service';
import { ChangeLogService } from './change-log.service';
import { RbacService } from '../auth/rbac.service';
import { BackupService } from '../governance/backup.service';
import { MetricsService } from '../governance/metrics.service';
import { BreakerService } from '../governance/breaker.service';
import { getEventLoopPercentiles } from '../common/event-loop-monitor';

const SETTINGS_WHITELIST = new Set(Object.keys(DEFAULT_SETTINGS));

@Controller()
export class SystemController {
  constructor(
    @InjectRepository(Setting)
    private readonly settingRepo: Repository<Setting>,
    private readonly registry: ToolRegistryService,
    private readonly upstream: UpstreamManagerService,
    private readonly sessions: SessionManager,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
    private readonly changes: ChangeLogService,
    private readonly rbac: RbacService,
    private readonly backup: BackupService,
    private readonly metricsSvc: MetricsService,
    private readonly breaker: BreakerService,
  ) {}

  /** 无鉴权探活：进程 + 库可写 + 上游概览，不探测上游（O(1)） */
  @Get('healthz')
  async healthz(): Promise<any> {
    const el = getEventLoopPercentiles();
    return {
      status: 'ok',
      uptime_s: Math.round(process.uptime()),
      registryVersion: this.registry.version,
      tools: this.registry.size(),
      sessions: this.sessions.active,
      upstreamsConnected: this.upstream.connectedCount(),
      auditQueueDepth: this.audit.depth,
      el_p99_ms: el.p99,
      ts: Date.now(),
    };
  }

  /** 无鉴权指标（生产由 Nginx 限 127.0.0.1） */
  @Get('metrics')
  async metrics(): Promise<any> {
    const mem = process.memoryUsage();
    const el = getEventLoopPercentiles();
    return {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      uptime_s: Math.round(process.uptime()),
      registry_version: this.registry.version,
      tools_total: this.registry.size(),
      sessions_active: this.sessions.active,
      upstreams_connected: this.upstream.connectedCount(),
      ratelimit_buckets: this.rateLimit.size,
      audit_queue_depth: this.audit.depth,
      // 旧字段保留兼容（setTimeout 瞬时采样，无历史分位）
      event_loop_lag_ms: await this.measureLoopLag(),
      // PRD 8.1 硬指标：monitorEventLoopDelay histogram 5s 采样分位数
      el_p50_ms: el.p50,
      el_p95_ms: el.p95,
      el_p99_ms: el.p99,
      el_max_ms: el.max,
      el_mean_ms: el.mean,
    };
  }

  private measureLoopLag(): Promise<number> {
    return new Promise((resolve) => {
      const start = process.hrtime.bigint();
      setTimeout(() => {
        const end = process.hrtime.bigint();
        resolve(Number(end - start) / 1e6 - 20);
      }, 20);
    });
  }

  /**
   * P1-B・Prometheus 文本格式拉取端点（无鉴权，生产 Nginx 限内网）。
   * 与 /metrics JSON 共存：老 smoke/面板代码依赖 JSON 字段，保留即可；
   * Prometheus server  scrape_config 指到 /metrics.prom 就行。
   */
  @Get('metrics.prom')
  async metricsProm(@Res() res: Response): Promise<void> {
    this.metricsSvc.refreshRuntime({
      registryTools: this.registry.size(),
      registryVersion: this.registry.version,
      sessionsActive: this.sessions.active,
      upstreamsConnected: this.upstream.connectedCount(),
      auditQueueDepth: this.audit.depth,
      ratelimitBuckets: this.rateLimit.size,
      breakerStates: this.breaker.snapshotAll().map((s) => ({ upstream: s.upstream, state: s.state })),
    });
    const { contentType, body } = await this.metricsSvc.expose();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(body);
  }

  @Get('admin/api/system/registry')
  @UseGuards(AdminTokenGuard)
  async registryStatus(): Promise<any> {
    return {
      version: this.registry.version,
      toolCount: this.registry.size(),
      sessions: this.sessions.active,
      upstreamsConnected: this.upstream.connectedCount(),
      auditQueueDepth: this.audit.depth,
      ratelimitBuckets: this.rateLimit.size,
    };
  }

  @Post('admin/api/system/registry/refresh')
  @UseGuards(AdminTokenGuard)
  async refreshRegistry(@Req() req: Request): Promise<any> {
    await this.rbac.loadAllRules();
    this.sessions.broadcastListChanged();
    return { ok: true, version: this.registry.version };
  }

  @Get('admin/api/settings')
  @UseGuards(AdminTokenGuard)
  async getSettings(): Promise<Record<string, string>> {
    const rows = await this.settingRepo.find();
    const out: Record<string, string> = { ...DEFAULT_SETTINGS };
    for (const r of rows) out[r.key] = r.value;
    // 确保前端看到的与内存内实时一致（避免 update 失败时显示误导）
    out['rbac.mode'] = this.rbac.getMode();
    return out;
  }

  @Put('admin/api/settings')
  @UseGuards(AdminTokenGuard)
  async updateSettings(@Body() body: unknown, @Req() req: Request): Promise<any> {
    const schema = z.record(z.string());
    const patch = schema.parse(body);
    const actor = (req.headers['x-admin-user'] as string) || 'admin';
    const before: Record<string, string> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!SETTINGS_WHITELIST.has(key)) continue; // key 白名单校验
      const cur = await this.settingRepo.findOne({ where: { key } });
      before[key] = cur?.value ?? DEFAULT_SETTINGS[key] ?? '';
      const entity = cur ?? this.settingRepo.create({ key } as Partial<Setting>);
      entity.value = value;
      entity.updatedBy = actor;
      entity.updatedAt = Date.now();
      await this.settingRepo.save(entity);
    }
    // 应用即时生效项
    if (patch['ratelimit.default_qpm'] || patch['ratelimit.burst']) {
      const all = await this.settingRepo.find();
      const map: Record<string, string> = { ...DEFAULT_SETTINGS };
      for (const r of all) map[r.key] = r.value;
      this.rateLimit.setDefaults(Number(map['ratelimit.default_qpm']), Number(map['ratelimit.burst']));
    }
    if (patch['audit.enabled'] != null) this.audit.setEnabled(patch['audit.enabled'] === '1');
    // F1 影子模式即时生效（无需重启）
    if (patch['rbac.mode'] != null) {
      const mode = patch['rbac.mode'] === 'observe' ? 'observe' : 'enforce';
      this.rbac.setMode(mode);
    }
    // P1-A・备份相关配置变更 → 重新挂载 cron（无需重启）
    if (Object.keys(patch).some((k) => k.startsWith('backup.'))) {
      await this.backup.reloadCron();
    }
    await this.changes.record({
      actor,
      actorIp: req.ip,
      targetType: 'settings',
      targetId: Object.keys(patch).join(','),
      action: 'update',
      before,
      after: patch,
      diffSummary: `更新设置：${Object.keys(patch).join(', ')}`,
    });
    return { ok: true };
  }
}
