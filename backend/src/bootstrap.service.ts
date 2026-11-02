import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting, DEFAULT_SETTINGS } from './database/entities';
import { ToolRegistryService } from './gateway/registry.service';
import { UpstreamManagerService } from './gateway/upstream-manager.service';
import { RbacService } from './auth/rbac.service';
import { RateLimitService } from './governance/ratelimit.service';
import { AuditService } from './governance/audit.service';
import { NotifyService } from './notify/im.service';
import { registerEventLoopAlert } from './common/event-loop-monitor';
import { logger } from './common/logger';

/**
 * 启动引导：把散落在各 Service 的初始化按正确顺序编排一次。
 * 放在根模块，onModuleInit 在全部依赖模块就绪后触发。
 *
 * 顺序有讲究：
 * 1) 读 settings 应用即时项（限流默认值、审计开关）——后续调用链要用
 * 2) registry.loadFromSnapshot()——冷启动即可渲染权限矩阵/工具页，不必等上游连通
 * 3) rbac.loadAllRules()——预热规则缓存，避免首批请求命中「默认拒绝」空窗
 * 4) upstream.connectAll()——连通上游、刷新注册表（失败不阻断启动，交由重连兜底）
 */
@Injectable()
export class BootstrapService implements OnModuleInit {
  constructor(
    @InjectRepository(Setting)
    private readonly settingRepo: Repository<Setting>,
    private readonly registry: ToolRegistryService,
    private readonly upstream: UpstreamManagerService,
    private readonly rbac: RbacService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  async onModuleInit(): Promise<void> {
    const t0 = Date.now();
    // 0) 接入 EL 告警回调（monitor 已在 main.ts 里 start）
    registerEventLoopAlert(({ p99Ms, maxMs }) => this.notify.eventLoopSlow(p99Ms, maxMs));
    // 1) settings
    const map: Record<string, string> = { ...DEFAULT_SETTINGS };
    const rows = await this.settingRepo.find();
    for (const r of rows) map[r.key] = r.value;
    this.rateLimit.setDefaults(Number(map['ratelimit.default_qpm']), Number(map['ratelimit.burst']));
    this.audit.setEnabled(map['audit.enabled'] === '1');
    // F1 影子模式预热（默认 enforce，不会改变现有行为）
    const rbacMode = (map['rbac.mode'] === 'observe' ? 'observe' : 'enforce') as 'enforce' | 'observe';
    this.rbac.setMode(rbacMode);

    // 2) 注册表快照冷启动
    await this.registry.loadFromSnapshot();

    // 3) RBAC 规则预热
    await this.rbac.loadAllRules();

    // 4) 连接上游（不阻断启动）
    try {
      await this.upstream.connectAll();
    } catch (e) {
      logger.error('上游批量连接异常（已忽略，后台重连兜底）', { err: (e as Error).message });
    }

    logger.info('网关引导完成', {
      tools: this.registry.size(),
      upstreams: this.upstream.connectedCount(),
      registryVersion: this.registry.version,
      bootMs: Date.now() - t0,
    });
  }
}
