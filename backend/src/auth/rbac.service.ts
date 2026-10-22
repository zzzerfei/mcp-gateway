import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoleRule } from '../database/entities/identity.entity';

export interface MatchableRule {
  effect: 'allow' | 'deny';
  pattern: string;
  sort: number;
}

interface CacheEntry {
  allowed: Set<string>;
  registryVersion: number;
  rulesVersion: number;
  expireAt: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === '*' ? m : '\\' + m));
}

/** ReDoS 防护：拒绝嵌套量词如 (a+)+、(a*)*、(a{1,}){1,} */
const NESTED_QUANTIFIER = /\([^)]*[+*]\)[+*{]/;

@Injectable()
export class RbacService {
  /** pattern -> RegExp 预编译缓存（600 工具 × 20 规则不能每次 new RegExp） */
  private readonly reCache = new Map<string, RegExp>();
  /** (role) -> 计算结果缓存，键含 registryVersion 与 rulesVersion */
  private readonly allowedCache = new Map<string, CacheEntry>();
  private rulesVersion = 0;
  /** F1 影子模式开关：
   *  - enforce（默认）→ 无权限直接拒绝（保持旧语义）
   *  - observe → 无权限仍放行，但写 event='rbac_would_forbid' 审计（不影响主链 tool_call 记录）
   */
  private mode: 'enforce' | 'observe' = 'enforce';

  constructor(
    @InjectRepository(RoleRule)
    private readonly ruleRepo: Repository<RoleRule>,
  ) {}

  setMode(mode: 'enforce' | 'observe'): void {
    if (mode !== 'enforce' && mode !== 'observe') return;
    if (this.mode !== mode) {
      this.mode = mode;
    }
  }

  getMode(): 'enforce' | 'observe' {
    return this.mode;
  }

  private toRegex(pattern: string): RegExp {
    let re = this.reCache.get(pattern);
    if (!re) {
      if (pattern.length > 200 || NESTED_QUANTIFIER.test(pattern)) {
        throw new Error(`非法 pattern（过长或疑似 ReDoS）: ${pattern}`);
      }
      const body = pattern.split('*').map(escapeRegExp).join('.*');
      re = new RegExp('^' + body + '$', 's');
      this.reCache.set(pattern, re);
    }
    return re;
  }

  /** 按 sort 升序首条命中即决定；无命中 = 默认拒绝 */
  private firstMatch(rulesSorted: MatchableRule[], name: string): MatchableRule | null {
    for (const r of rulesSorted) {
      if (this.toRegex(r.pattern).test(name)) return r;
    }
    return null;
  }

  /** 规则更新后调用：递增版本使 allowedSet 缓存整体失效 */
  bumpRulesVersion(): void {
    this.rulesVersion++;
    this.allowedCache.clear();
  }

  /**
   * 计算角色的可见/可调工具集。list 与 call 共用同一份结果（可见即可调契约）。
   * @param role 角色名
   * @param allToolNames 注册表全量工具名
   * @param registryVersion 注册表版本戳
   */
  buildAllowedSet(role: string, allToolNames: string[], registryVersion: number): Set<string> {
    const key = role;
    const now = Date.now();
    const cached = this.allowedCache.get(key);
    if (
      cached &&
      cached.registryVersion === registryVersion &&
      cached.rulesVersion === this.rulesVersion &&
      cached.expireAt > now
    ) {
      return cached.allowed;
    }
    const allowed = new Set<string>();
    const rules = this.rulesForRole(role);
    for (const name of allToolNames) {
      const hit = this.firstMatch(rules, name);
      if (hit && hit.effect === 'allow') allowed.add(name);
    }
    this.allowedCache.set(key, {
      allowed,
      registryVersion,
      rulesVersion: this.rulesVersion,
      expireAt: now + 60_000, // TTL 60s
    });
    return allowed;
  }

  /** 从库中读取某角色规则并按 sort 升序（同步缓存到内存） */
  private roleRulesCache = new Map<string, { rules: MatchableRule[]; ver: number }>();

  private rulesForRole(role: string): MatchableRule[] {
    const cached = this.roleRulesCache.get(role);
    if (cached && cached.ver === this.rulesVersion) return cached.rules;
    // 同步不可行（Repository 是异步），此处由 loadRules 预热；未预热则返回空（默认拒绝）
    return cached?.rules ?? [];
  }

  /** 预热/刷新某角色规则到内存（异步） */
  async loadRules(role: string): Promise<MatchableRule[]> {
    const rows = await this.ruleRepo.find({ where: { role }, order: { sort: 'ASC' } });
    const rules: MatchableRule[] = rows.map((r) => ({ effect: r.effect, pattern: r.pattern, sort: r.sort }));
    this.roleRulesCache.set(role, { rules, ver: this.rulesVersion });
    return rules;
  }

  /** 全量刷新所有角色规则 */
  async loadAllRules(): Promise<void> {
    const rows = await this.ruleRepo.find({ order: { role: 'ASC', sort: 'ASC' } });
    const byRole = new Map<string, MatchableRule[]>();
    for (const r of rows) {
      if (!byRole.has(r.role)) byRole.set(r.role, []);
      byRole.get(r.role)!.push({ effect: r.effect, pattern: r.pattern, sort: r.sort });
    }
    this.roleRulesCache.clear();
    for (const [role, rules] of byRole) {
      this.roleRulesCache.set(role, { rules, ver: this.rulesVersion });
    }
  }

  /** 单个工具鉴权：是否可调用 */
  canCall(role: string, toolName: string, allToolNames: string[], registryVersion: number): boolean {
    return this.buildAllowedSet(role, allToolNames, registryVersion).has(toolName);
  }

  /**
   * 变更预览专用：用一组（可能尚未落库的）规则直接计算可见集，不走缓存、不污染线上状态。
   * 复用与线上完全相同的 firstMatch + toRegex，保证「预览即所得」。
   */
  computeWithRules(rules: MatchableRule[], allToolNames: string[]): Set<string> {
    const sorted = [...rules].sort((a, b) => a.sort - b.sort);
    const allowed = new Set<string>();
    for (const name of allToolNames) {
      const hit = this.firstMatch(sorted, name);
      if (hit && hit.effect === 'allow') allowed.add(name);
    }
    return allowed;
  }

  /**
   * 保存规则时按语义自动重排 sort：deny 组排前，allow 组排后，组内保持原顺序。
   * 而不是让管理员手工填数字。
   */
  static normalizeSort(rules: { effect: 'allow' | 'deny'; pattern: string; memo?: string }[]): MatchableRule[] {
    const denies = rules.filter((r) => r.effect === 'deny');
    const allows = rules.filter((r) => r.effect === 'allow');
    const out: MatchableRule[] = [];
    let sort = 10;
    for (const r of denies) out.push({ effect: 'deny', pattern: r.pattern, sort: (sort += 10) - 10 });
    sort = 10 * denies.length;
    for (const r of allows) out.push({ effect: 'allow', pattern: r.pattern, sort: (sort += 10) });
    return out;
  }
}
