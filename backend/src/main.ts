import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { logger } from './common/logger';
import { ZodExceptionFilter } from './common/zod-exception.filter';
import { startEventLoopMonitor } from './common/event-loop-monitor';

/**
 * 进程入口。几个刻意的选择：
 * - bodyParser:false + 自挂 json(10mb)：MCP tools/call 的 arguments 可能较大，默认 100kb 不够
 * - enableCors 暴露 Mcp-Session-Id / MCP-Protocol-Version：浏览器端 SDK 需读到会话头
 * - trust proxy：置于 Nginx 后仍能拿到真实 client IP（审计 callerIp 依赖它）
 * - enableShutdownHooks：让 OnModuleDestroy 生效（审计 flush、会话排空、上游断连）
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false, bufferLogs: true });
  const cfg = app.get(ConfigService).get();

  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  app.getHttpAdapter().getInstance().set('trust proxy', true);

  // CORS：显式白名单优先。
  // 未配置时开发态放开、生产态关闭——管理端用 Bearer 头而不是 cookie，
  // 不能出现「反射任意 Origin + credentials」这种组合。
  const corsOrigins = cfg.allowedOrigins;
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : cfg.env !== 'production',
    credentials: corsOrigins.length > 0,
    exposedHeaders: ['Mcp-Session-Id', 'MCP-Protocol-Version', 'Content-Disposition'],
  });

  app.enableShutdownHooks();

  // 全局异常过滤：把 zod 参数校验失败从默认 500 归一化为 400 + 结构化细节
  app.useGlobalFilters(new ZodExceptionFilter());

  await app.listen(cfg.port, cfg.host);
  // PRD 8.1 事件循环延迟监控（histogram 无侵入，采样 5s 一次，主链路 0 开销）
  startEventLoopMonitor();
  logger.info('MCP 网关已启动', {
    env: cfg.env,
    host: cfg.host,
    port: cfg.port,
    mcp: `${cfg.publicOrigin}/mcp`,
    admin: `${cfg.publicOrigin}/admin/api`,
    health: `${cfg.publicOrigin}/healthz`,
  });
}

bootstrap().catch((err) => {
  logger.error('网关启动失败', { err: err?.message ?? String(err) });
  process.exit(1);
});
