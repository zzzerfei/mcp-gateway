import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ToolSnapshot, ToolOverride } from '../database/entities/tool.entity';

export interface ToolDef {
  name: string; // 原始名（上游侧）
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface RegistryEntry {
  fullName: string; // wiki__search
  upstream: string;
  originalName: string;
  def: ToolDef; // 套用覆写后的定义
  rawDescription: string; // 上游原始描述
  enabled: boolean; // 覆写可下线单个工具
  sensitivity: 'normal' | 'high';
}

/**
 * 工具注册表：命名空间聚合（upstream__tool）+ 版本戳 + 快照落库 + 覆写套用。
 * registryVersion 变化触发 RBAC allowedSet 缓存整体失效（防权限漂移）。
 */
@Injectable()
export class ToolRegistryService {
  private entries = new Map<string, RegistryEntry>();
  private overrides = new Map<string, ToolOverride>();
  private sensitivityByUpstream = new Map<string, 'normal' | 'high'>();
  private _version = 0;

  constructor(
    @InjectRepository(ToolSnapshot)
    private readonly snapshotRepo: Repository<ToolSnapshot>,
    @InjectRepository(ToolOverride)
    private readonly overrideRepo: Repository<ToolOverride>,
  ) {}

  get version(): number {
    return this._version;
  }

  private bump(): void {
    this._version++;
  }

  async loadOverrides(): Promise<void> {
    const rows = await this.overrideRepo.find();
    this.overrides.clear();
    for (const r of rows) this.overrides.set(r.fullName, r);
  }

  setUpstreamSensitivity(name: string, sensitivity: 'normal' | 'high'): void {
    this.sensitivityByUpstream.set(name, sensitivity);
  }

  /** 用某上游的最新工具集替换其在注册表中的条目，并落快照 */
  async refreshUpstream(upstream: string, tools: ToolDef[], sensitivity: 'normal' | 'high'): Promise<void> {
    this.sensitivityByUpstream.set(upstream, sensitivity);
    // 移除该上游旧条目
    for (const [fn, e] of this.entries) if (e.upstream === upstream) this.entries.delete(fn);

    const now = Date.now();
    for (const t of tools) {
      const fullName = `${upstream}__${t.name}`;
      const ov = this.overrides.get(fullName);
      const entry: RegistryEntry = {
        fullName,
        upstream,
        originalName: t.name,
        rawDescription: t.description ?? '',
        def: {
          name: t.name,
          title: t.title ?? '',
          // 覆写描述优先，否则用上游原始描述
          description: ov?.description ?? t.description ?? '',
          inputSchema: t.inputSchema ?? {},
        },
        enabled: ov ? ov.enabled === 1 : true,
        sensitivity,
      };
      this.entries.set(fullName, entry);
    }
    await this.persistSnapshot(upstream, tools, now);
    this.bump();
  }

  private async persistSnapshot(upstream: string, tools: ToolDef[], now: number): Promise<void> {
    // 删除该上游旧快照，写入新快照
    await this.snapshotRepo.delete({ upstream });
    if (tools.length === 0) return;
    const rows = tools.map((t) => {
      const s = new ToolSnapshot();
      s.fullName = `${upstream}__${t.name}`;
      s.upstream = upstream;
      s.originalName = t.name;
      s.title = t.title ?? '';
      s.description = t.description ?? '';
      s.inputSchema = JSON.stringify(t.inputSchema ?? {});
      s.firstSeenAt = now;
      s.lastSeenAt = now;
      return s;
    });
    await this.snapshotRepo.save(rows);
  }

  /** 上游下线：移除其全部工具 */
  async removeUpstream(upstream: string): Promise<void> {
    for (const [fn, e] of this.entries) if (e.upstream === upstream) this.entries.delete(fn);
    await this.snapshotRepo.delete({ upstream });
    this.bump();
  }

  /** 全量工具名（含被下线的？否——只返回 enabled 的，供 list/call 使用） */
  allToolNames(includeDisabled = false): string[] {
    const out: string[] = [];
    for (const [fn, e] of this.entries) if (includeDisabled || e.enabled) out.push(fn);
    return out;
  }

  get(fullName: string): RegistryEntry | undefined {
    return this.entries.get(fullName);
  }

  /** 按 allowedSet 过滤后的工具定义（用于 tools/list 响应） */
  listFor(allowedSet: Set<string>): Array<{ name: string; description?: string; inputSchema?: unknown }> {
    const out: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
    for (const fn of allowedSet) {
      const e = this.entries.get(fn);
      if (!e || !e.enabled) continue;
      out.push({
        name: e.fullName, // 对外暴露命名空间全名
        description: e.def.description,
        inputSchema: e.def.inputSchema ?? { type: 'object', properties: {} },
      });
    }
    return out;
  }

  /** 应用覆写变更（描述/下线/限流），刷新受影响条目 */
  async applyOverride(fullName: string, patch: Partial<ToolOverride>): Promise<void> {
    const e = this.entries.get(fullName);
    if (patch.description !== undefined && e) e.def.description = patch.description ?? e.rawDescription;
    if (patch.enabled !== undefined && e) e.enabled = patch.enabled === 1;
    const ov = this.overrides.get(fullName);
    if (ov) Object.assign(ov, patch);
    this.bump();
  }

  getOverride(fullName: string): ToolOverride | undefined {
    return this.overrides.get(fullName);
  }

  /** 从快照冷启动加载（进程重启后、上游尚未连通时也能渲染权限矩阵） */
  async loadFromSnapshot(): Promise<void> {
    const snaps = await this.snapshotRepo.find();
    await this.loadOverrides();
    for (const s of snaps) {
      const ov = this.overrides.get(s.fullName);
      const sens = this.sensitivityByUpstream.get(s.upstream) ?? 'normal';
      this.entries.set(s.fullName, {
        fullName: s.fullName,
        upstream: s.upstream,
        originalName: s.originalName,
        rawDescription: s.description,
        def: {
          name: s.originalName,
          title: s.title,
          description: ov?.description ?? s.description,
          inputSchema: safeParse(s.inputSchema),
        },
        enabled: ov ? ov.enabled === 1 : true,
        sensitivity: sens,
      });
    }
    this.bump();
  }

  size(): number {
    return this.entries.size;
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
