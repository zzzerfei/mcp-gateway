import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { ConfigService } from '../../config/config.service';
import { CryptoService } from '../../auth/crypto.service';

/**
 * Admin 通道鉴权：独立 Admin Token（mgw_admin_ 前缀），与 MCP Key 体系完全隔离。
 * 用 timingSafeEqual 防时序侧信道。
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const h = req.headers.authorization ?? '';
    let token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    // P1-F・SSE 回退：浏览器原生 EventSource 无法设自定义 header，仅对 `/stream` 结尾的路径
    // 允许 `?token=` query（安全卡三件套：timingSafeEqual + 窄路径 + 不开全局，需 nginx 下 access_log 屏蔽 query）
    if (!token && req.path.endsWith('/stream')) {
      const q = req.query?.token;
      if (typeof q === 'string') token = q.trim();
    }
    if (!token) throw new UnauthorizedException('缺少 Admin Token');
    const expected = this.config.get().adminToken;
    if (!this.crypto.safeEqual(token, expected)) {
      throw new UnauthorizedException('Admin Token 无效');
    }
    return true;
  }
}
