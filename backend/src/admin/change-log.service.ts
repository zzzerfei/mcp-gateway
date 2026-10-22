import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChangeLog } from '../database/entities/audit.entity';

export interface ChangeRecord {
  actor: string;
  actorIp?: string;
  targetType: ChangeLog['targetType'];
  targetId: string;
  action: ChangeLog['action'];
  before?: unknown;
  after?: unknown;
  diffSummary?: string;
}

/**
 * 变更留痕：治理系统自身可信度的底线。
 * 管理员的每一次写操作都进这里，含 before/after（脱敏后），支持一键回滚。
 */
@Injectable()
export class ChangeLogService {
  constructor(
    @InjectRepository(ChangeLog)
    private readonly repo: Repository<ChangeLog>,
  ) {}

  async record(r: ChangeRecord): Promise<void> {
    const entity = new ChangeLog();
    entity.ts = Date.now();
    entity.actor = r.actor;
    entity.actorIp = r.actorIp ?? '';
    entity.targetType = r.targetType;
    entity.targetId = r.targetId;
    entity.action = r.action;
    entity.beforeJson = r.before != null ? JSON.stringify(r.before) : null;
    entity.afterJson = r.after != null ? JSON.stringify(r.after) : null;
    entity.diffSummary = r.diffSummary ?? '';
    await this.repo.save(entity);
  }

  /** 供一键回滚取历史快照（F2） */
  async getById(id: number): Promise<ChangeLog | null> {
    return this.repo.findOne({ where: { id } });
  }

  async query(filter: {
    targetType?: string;
    actor?: string;
    from?: number;
    to?: number;
    page?: number;
    size?: number;
  }): Promise<{ rows: ChangeLog[]; total: number }> {
    const qb = this.repo.createQueryBuilder('c');
    if (filter.targetType) qb.andWhere('c.target_type = :tt', { tt: filter.targetType });
    if (filter.actor) qb.andWhere('c.actor = :actor', { actor: filter.actor });
    if (filter.from) qb.andWhere('c.ts >= :from', { from: filter.from });
    if (filter.to) qb.andWhere('c.ts <= :to', { to: filter.to });
    const total = await qb.getCount();
    const page = Math.max(1, filter.page ?? 1);
    const size = Math.min(200, Math.max(1, filter.size ?? 20));
    qb.orderBy('c.ts', 'DESC').skip((page - 1) * size).take(size);
    const rows = await qb.getMany();
    return { rows, total };
  }
}
