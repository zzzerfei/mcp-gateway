import { Global, Module } from '@nestjs/common';
import { ToolRegistryService } from './registry.service';
import { UpstreamManagerService } from './upstream-manager.service';
import { GatewayRouterService } from './router.service';

/**
 * 网关核心模块（全局）。
 * - ToolRegistryService：命名空间聚合 + 版本戳 + 快照落库
 * - UpstreamManagerService：MCP Client 池（动态 import ESM SDK）+ 健康检查 + 重连
 * - GatewayRouterService：治理链十字路口（权限→限流→熔断→并发→转发）
 * transport（对客户端）与 admin（对管理员）都依赖这三者，故 @Global。
 */
@Global()
@Module({
  providers: [ToolRegistryService, UpstreamManagerService, GatewayRouterService],
  exports: [ToolRegistryService, UpstreamManagerService, GatewayRouterService],
})
export class GatewayModule {}
