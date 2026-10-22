import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { logger } from '../common/logger';

/**
 * 企业 IM 告警：钉钉/企微/飞书 webhook 均为一个 HTTP POST，统一封装。
 * 含 5 分钟同类事件抑制，防告警风暴。
 */
@Injectable()
export class NotifyService {
  private readonly lastSent = new Map<string, number>();
  private readonly SUPPRESS_MS = 5 * 60_000;

  constructor(private readonly config: ConfigService) {}

  private suppress(key: string): boolean {
    const now = Date.now();
    const last = this.lastSent.get(key) ?? 0;
    if (now - last < this.SUPPRESS_MS) return true;
    this.lastSent.set(key, now);
    return false;
  }

  private async post(text: string): Promise<void> {
    const webhook = this.config.get().imWebhook;
    if (!webhook) {
      logger.info('IM webhook 未配置，仅记日志', { text });
      return;
    }
    try {
      // 统一 payload：多数 IM 支持 { msgtype:'text', text:{content} } 或 { content }
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text }, content: text }),
        redirect: 'manual',
      });
    } catch (err) {
      logger.warn('IM 告警发送失败', { err: String(err) });
    }
  }

  async circuitOpened(upstream: string, owner: string): Promise<void> {
    if (this.suppress(`open:${upstream}`)) return;
    await this.post(`[MCP网关] 上游 ${upstream} 已熔断，工具暂时不可用。负责人：${owner || '未指定'}`);
  }

  async circuitClosed(upstream: string, owner: string): Promise<void> {
    if (this.suppress(`close:${upstream}`)) return;
    await this.post(`[MCP网关] 上游 ${upstream} 已恢复正常。负责人：${owner || '未指定'}`);
  }

  async upstreamRecovered(upstream: string, owner: string): Promise<void> {
    if (this.suppress(`up:${upstream}`)) return;
    await this.post(`[MCP网关] 上游 ${upstream} 重连成功。负责人：${owner || '未指定'}`);
  }

  async sessionLimitReached(active: number, max: number): Promise<void> {
    if (this.suppress('session:limit')) return;
    await this.post(`[MCP网关] 活跃会话 ${active} 已达上限 ${max} 的 80%，请关注`);
  }

  async auditFallbackGrowing(lines: number): Promise<void> {
    if (this.suppress('audit:fallback')) return;
    await this.post(`[MCP网关] 审计写库失败，fallback 文件已有 ${lines} 行，请立即排查磁盘/SQLite`);
  }

  /** 事件循环延迟超阈值告警（PRD 8.1：P99 > 200ms） */
  async eventLoopSlow(p99Ms: number, maxMs: number): Promise<void> {
    if (this.suppress('el:slow')) return;
    await this.post(`[MCP网关] 事件循环延迟 P99=${p99Ms.toFixed(1)}ms、峰值=${maxMs.toFixed(1)}ms（阈值 200ms），可能存在同步阻塞或 GC 风暴`);
  }

  /** stdio 上游 crash loop 自动下线（PRD R4） */
  async stdioCrashLoop(upstream: string, restarts: number, windowS: number): Promise<void> {
    if (this.suppress(`crash:${upstream}`)) return;
    await this.post(`[MCP网关] stdio 上游 ${upstream} 在 ${windowS}s 内重启 ${restarts} 次，已自动下线；请检查子进程启动失败原因`);
  }

  /** P1-D・数据库备份失败告警（PRD 13.1-4）。同 trigger 5min 内只报一次，防风暴。 */
  async backupFailed(trigger: 'cron' | 'manual', error: string, actor: string): Promise<void> {
    if (this.suppress(`backup:fail:${trigger}`)) return;
    await this.post(
      `[MCP网关] 数据库备份失败（trigger=${trigger} actor=${actor}）：${error}。请检查磁盘空间 / 权限 / SQLite 文件锁；面板「数据库备份」页可查详情与重试。`,
    );
  }

  /** P1-D・备份滚动清理失败（罕见，仅在文件 unlink 失败时） */
  async backupPruneFailed(detail: string): Promise<void> {
    if (this.suppress('backup:prune')) return;
    await this.post(`[MCP网关] 旧备份文件清理失败：${detail}。请手动检查 data/backup/ 目录权限。`);
  }
}
