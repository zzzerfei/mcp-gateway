import { Global, Module } from '@nestjs/common';
import { SessionManager } from './session.manager';
import { McpController } from './mcp.controller';

/**
 * MCP 传输模块（对客户端通道）。与 Admin 通道代码路径完全隔离。
 * - SessionManager：会话生命周期 + TTL 回收 + 上限保护 + list_changed 广播
 *   （admin 侧改权限/上下线工具后要广播，故 @Global 导出）
 * - McpController：POST/GET(SSE)/DELETE /mcp，直接用 Express req/res 控制底层流
 */
@Global()
@Module({
  controllers: [McpController],
  providers: [SessionManager],
  exports: [SessionManager],
})
export class TransportModule {}
