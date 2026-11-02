import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Caller } from '../auth/apikey.service';
import { ConfigService } from '../config/config.service';
import { NotifyService } from '../notify/im.service';
import { logger } from '../common/logger';

/**
 * 会话对象最小结构。只放协议必需项，业务身份（caller）可从 Key 重建，
 * 为二期会话外置（Redis/PG）预埋：外置时只需序列化一小段 JSON。
 */
export interface Session {
  id: string;
  caller: Caller;
  protocolVersion: string;
  clientInfo: string;
  createdAt: number;
  lastSeenAt: number;
  /** SSE 写句柄（server→client 通知流），进程内持有 */
  sse?: { write: (event: string, data: unknown) => boolean; close: () => void } | null;
}

/**
 * SessionManager：会话生命周期、TTL 回收、上限保护、优雅退出排空。
 * 一期单实例 + 有会话（SDK Streamable HTTP 事实约束）。
 */
@Injectable()
export class SessionManager implements OnModuleDestroy {
  private readonly sessions = new Map<string, Session>();
  private reclaimTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly notify: NotifyService,
  ) {
    this.reclaimTimer = setInterval(() => this.reclaim(), 60_000);
  }

  onModuleDestroy(): void {
    if (this.reclaimTimer) clearInterval(this.reclaimTimer);
    this.drainAll();
  }

  /** 创建会话；超上限返回 null（调用方回 503） */
  create(caller: Caller, protocolVersion: string, clientInfo: string): Session | null {
    const { maxSessions } = this.config.get();
    if (this.sessions.size >= maxSessions) {
      void this.notify.sessionLimitReached(this.sessions.size, maxSessions);
      logger.warn('会话数达上限，拒绝新 initialize', { active: this.sessions.size, max: maxSessions });
      return null;
    }
    const session: Session = {
      id: randomUUID(),
      caller,
      protocolVersion,
      clientInfo,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      sse: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (s) s.lastSeenAt = Date.now();
    return s;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  delete(id: string): void {
    const s = this.sessions.get(id);
    if (s?.sse) s.sse.close();
    this.sessions.delete(id);
  }

  /** 向某会话推送 SSE 通知（如 tools/list_changed） */
  notifySession(id: string, event: string, data: unknown): boolean {
    const s = this.sessions.get(id);
    if (!s?.sse) return false;
    return s.sse.write(event, data);
  }

  /** 广播 tools/list_changed 给所有在线会话（注册表刷新后调用） */
  broadcastListChanged(): void {
    const payload = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };
    let sent = 0;
    for (const s of this.sessions.values()) {
      if (s.sse && s.sse.write('message', payload)) sent++;
    }
    logger.debug('广播 list_changed', { sent, total: this.sessions.size });
  }

  private reclaim(): void {
    const idleMs = this.config.get().sessionIdleTimeoutS * 1000;
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeenAt > idleMs) {
        if (s.sse) s.sse.close();
        this.sessions.delete(id);
      }
    }
  }

  /** 优雅退出：关闭所有 SSE，清空会话 */
  drainAll(): void {
    for (const s of this.sessions.values()) if (s.sse) s.sse.close();
    this.sessions.clear();
  }

  get active(): number {
    return this.sessions.size;
  }
}
