import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * P1-E・HTTP 入口 QPS / 延时 histogram 埋点中间件。
 *
 * 关键设计：
 * - 标签 route 使用 `req.baseUrl + req.route.path` 模板（形如 `/admin/api/keys/:id/revoke`），
 *   而不是 `req.originalUrl`，避免 path 里的 id 造成标签爆炸。
 * - 未匹配路由（404）在 controller 匹配前不会填 `req.route`，统一归一化为 `__unmatched__`，
 *   便于 Grafana 里发现"某个前缀一直在 404"这种扫描行为。
 * - `/metrics*` `/healthz` 从埋点里排除：避免 Prometheus scrape 自身产生 QPS 波峰，
 *   也避免 liveness probe 拉高 histogram 分布。
 * - SSE 长连接（`text/event-stream`）不在 `res.on('finish')` 埋点，因为 finish 只在响应
 *   关闭时触发，若计入会把 30 分钟长连的 duration 当成一次调用的 p99，污染分布。
 *   NestJS 的 @Sse() 走的是 `res.flushHeaders` 而非 `res.end`，因此这里的 finish
 *   会自然不被触发；额外用 `res.getHeader('content-type')` 判一次兜底。
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const url = req.originalUrl || req.url || req.path;
    // 排除监控端点自身，防自反馈（scrape 不应拉高 histogram、不应产生 QPS 峰）
    if (isExcluded(url)) return next();
    const start = Date.now();
    res.on('finish', () => {
      // 二次排除：防止 NestJS 内部 rewrite URL 时首轮判断遗漏
      const finalUrl = req.originalUrl || req.url || req.path;
      if (isExcluded(finalUrl)) return;
      // SSE 长连接：跳过（无 finish 一般到不了这里，多一层保险）
      const ct = res.getHeader('content-type');
      if (typeof ct === 'string' && ct.includes('text/event-stream')) return;
      const route = normalizeRoute(req);
      this.metrics.recordHttpRequest(req.method, route, res.statusCode, Date.now() - start);
    });
    next();
  }
}

/** 集中排除列表：监控入口自身。包含精确匹配与 prefix。 */
function isExcluded(url: string): boolean {
  if (!url) return false;
  // 去掉 query 部分（`/metrics.prom?x=1` 也归入排除）
  const path = url.split('?')[0];
  return (
    path === '/metrics' ||
    path === '/metrics.prom' ||
    path === '/healthz' ||
    path.startsWith('/metrics/')
  );
}

/** 归一化：优先取 Express 路由模板；404 或 middleware chain 中断则回落到 __unmatched__ */
function normalizeRoute(req: Request): string {
  // Express 里 `req.route` 在 router 匹配后填充，形如 { path: '/:id/revoke' }
  const route = (req as unknown as { route?: { path?: string } }).route;
  const routePath = route?.path;
  const baseUrl = req.baseUrl || '';
  if (routePath) {
    // baseUrl 可能已经带完整前缀（对 Nest 全局前缀 + Controller 前缀组合）
    const full = baseUrl + routePath;
    // 去掉尾斜杠（除根）
    return full.length > 1 && full.endsWith('/') ? full.slice(0, -1) : full;
  }
  // 未匹配（404）或已被 guard 拦（401/403 时 req.route 通常已存在，不会走到这）
  return '__unmatched__';
}
