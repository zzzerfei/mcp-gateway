import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey } from '../database/entities/identity.entity';
import { CryptoService } from './crypto.service';

/** 鉴权成功后的调用方身份，随会话固定 */
export interface Caller {
  keyId: number;
  keyPrefix: string;
  userName: string;
  team: string;
  role: string;
  profile: string;
}

interface AuthCacheEntry {
  caller: Caller | null;
  expireAt: number;
}

/**
 * API Key 签发 / 校验 / 吊销 / 轮换。
 * 鉴权结果缓存 TTL 60s：吊销生效延迟 ≤ 10s 由「吊销时主动清缓存」保证，
 * 而非等 TTL 到期。
 */
@Injectable()
export class ApiKeyService {
  private readonly authCache = new Map<number, AuthCacheEntry>();
  private readonly AUTH_TTL = 60_000;
  /** last_used_at 写放大控制：每 Key 每分钟最多落库一次 */
  private readonly lastFlush = new Map<number, number>();
  private pendingUsage = new Map<number, number>();

  constructor(
    @InjectRepository(ApiKey)
    private readonly keyRepo: Repository<ApiKey>,
    private readonly crypto: CryptoService,
  ) {}

  /** 签发：明文只在此返回一次，库中只存哈希 */
  async issue(input: {
    name: string;
    userName: string;
    team?: string;
    role: string;
    profile?: string;
    expiresInDays?: number | null;
    createdBy?: string;
  }): Promise<{ raw: string; key: ApiKey }> {
    const { raw, hash, prefix } = this.crypto.generateApiKey();
    const now = Date.now();
    const entity = this.keyRepo.create({
      keyHash: hash,
      keyPrefix: prefix,
      name: input.name,
      userName: input.userName,
      team: input.team ?? '',
      role: input.role,
      profile: input.profile ?? '',
      expiresAt: input.expiresInDays ? now + input.expiresInDays * 86_400_000 : null,
      createdBy: input.createdBy ?? '',
      createdAt: now,
      revoked: 0,
    });
    const saved = await this.keyRepo.save(entity);
    return { raw, key: saved };
  }

  /**
   * 校验原始 Key。返回 caller 或 null。
   * 走 60s 缓存，但吊销/过期检查每次基于缓存的 keyId 复查库中 revoked 位（轻量）。
   */
  async verify(rawKey: string): Promise<Caller | null> {
    if (!rawKey) return null;
    const hash = this.crypto.sha256(rawKey);
    // 缓存以 hash 定位（避免明文入缓存键）
    const cacheKey = this.hashToId.get(hash);
    if (cacheKey != null) {
      const cached = this.authCache.get(cacheKey);
      if (cached && cached.expireAt > Date.now()) {
        if (!cached.caller) return null;
        // 吊销即时生效：命中缓存也要复查 revoked（≤10s 生效的关键）
        const fresh = await this.keyRepo.findOne({ where: { id: cached.caller.keyId } });
        if (!fresh || fresh.revoked === 1) {
          this.authCache.delete(cacheKey);
          this.revokeCacheById(cached.caller.keyId);
          return null;
        }
        if (fresh.expiresAt && fresh.expiresAt < Date.now()) return null;
        this.touchUsage(fresh.id);
        return cached.caller;
      }
    }

    const row = await this.keyRepo.findOne({ where: { keyHash: hash } });
    if (!row) return null;
    if (row.revoked === 1) return null;
    if (row.expiresAt && row.expiresAt < Date.now()) return null;

    const caller: Caller = {
      keyId: row.id,
      keyPrefix: row.keyPrefix,
      userName: row.userName,
      team: row.team,
      role: row.role,
      profile: row.profile,
    };
    this.hashToId.set(hash, row.id);
    this.authCache.set(row.id, { caller, expireAt: Date.now() + this.AUTH_TTL });
    this.touchUsage(row.id);
    return caller;
  }

  private readonly hashToId = new Map<string, number>();

  private revokeCacheById(keyId: number): void {
    this.authCache.delete(keyId);
  }

  private touchUsage(keyId: number): void {
    this.pendingUsage.set(keyId, Date.now());
  }

  /**
   * 吊销：主动清鉴权缓存 + hashToId 映射，保证≤2s 生效（同实例内为即时）。
   * 多实例场景下靠 verify 命中时复查 DB 作为兼价。
   */
  async revoke(id: number, reason: string, actor: string): Promise<ApiKey | null> {
    const row = await this.keyRepo.findOne({ where: { id } });
    if (!row) return null;
    row.revoked = 1;
    row.revokedAt = Date.now();
    row.revokeReason = reason;
    const saved = await this.keyRepo.save(row);
    // 双缓存一致性清理：authCache (keyId) + hashToId (旧 hash)，避免后续同一 raw 命中旧映射
    this.authCache.delete(id);
    if (row.keyHash) this.hashToId.delete(row.keyHash);
    return saved;
  }
  
  /**
   * 按使用者名批量吊销（离职 / 封禁场景）。
   *
   * Key 表里没有 Logto `sub`，无法和账号做外键；因此“停用某人”必须落到
   * 「把这个 userName 名下的 Key 全部吊销」，否则 Logto 里禁用账号后
   * 他手里的 `mgw_live_` 依然能调工具。
   *
   * 逐条复用 revoke()，保证 authCache / hashToId 双缓存都被清理（本实例内即时生效）。
   */
  async revokeByUser(
    userName: string,
    reason: string,
    actor: string,
  ): Promise<{ count: number; prefixes: string[] }> {
    const rows = await this.keyRepo.find({
      where: { userName, revoked: 0 },
    });
    const prefixes: string[] = [];
    for (const row of rows) {
      const saved = await this.revoke(row.id, reason, actor);
      if (saved) prefixes.push(saved.keyPrefix);
    }
    return { count: prefixes.length, prefixes };
  }

  /** 对外暴露的显式失效入口（为 P2 多实例场景预埋） */
  invalidate(keyId: number, keyHash?: string): void {
    this.authCache.delete(keyId);
    if (keyHash) this.hashToId.delete(keyHash);
  }

  /** 轮换：签发新 Key，可选旧 Key 宽限期后立即吊销旧 Key */
  async rotate(id: number, graceMs: number, actor: string): Promise<{ raw: string; key: ApiKey } | null> {
    const old = await this.keyRepo.findOne({ where: { id } });
    if (!old) return null;
    const issued = await this.issue({
      name: old.name,
      userName: old.userName,
      team: old.team,
      role: old.role,
      profile: old.profile,
      createdBy: actor,
    });
    if (graceMs <= 0) {
      await this.revoke(id, 'rotate', actor);
    } else {
      old.expiresAt = Date.now() + graceMs;
      await this.keyRepo.save(old);
    }
    return issued;
  }

  /** 随审计攒批一起提交：每 Key 每分钟最多落库一次，避免热 key 频繁写盘 */
  async flushKeyUsage(): Promise<void> {
    const now = Date.now();
    const batch = this.pendingUsage;
    this.pendingUsage = new Map();
    for (const [keyId, ts] of batch) {
      const last = this.lastFlush.get(keyId) ?? 0;
      if (now - last < 60_000) continue;
      this.lastFlush.set(keyId, now);
      await this.keyRepo.update({ id: keyId }, { lastUsedAt: ts });
    }
  }

  async list(filter: { user?: string; role?: string; revoked?: number }): Promise<ApiKey[]> {
    const qb = this.keyRepo.createQueryBuilder('k');
    if (filter.user) qb.andWhere('k.user_name = :user', { user: filter.user });
    if (filter.role) qb.andWhere('k.role = :role', { role: filter.role });
    if (filter.revoked != null) qb.andWhere('k.revoked = :revoked', { revoked: filter.revoked });
    qb.orderBy('k.created_at', 'DESC');
    const rows = await qb.getMany();
    // 绝不返回哈希
    return rows.map((r) => ({ ...r, keyHash: '' } as ApiKey));
  }

  async countByRole(role: string): Promise<number> {
    return this.keyRepo.count({ where: { role, revoked: 0 } });
  }
}
