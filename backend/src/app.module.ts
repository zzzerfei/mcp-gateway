import { Module } from '@nestjs/common';
import { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { GovernanceModule } from './governance/governance.module';
import { NotifyModule } from './notify/notify.module';
import { GatewayModule } from './gateway/gateway.module';
import { TransportModule } from './transport/transport.module';
import { AdminModule } from './admin/admin.module';
import { BootstrapService } from './bootstrap.service';
import { MetricsMiddleware } from './governance/metrics.middleware';

/**
 * 根模块。装配顺序即依赖层次（自底向上）：
 *   Config → Database → Auth/Governance/Notify（横切底座）
 *          → Gateway（核心）→ Transport（对客户端）/ Admin（对管理员）
 * 横切模块均 @Global，业务模块无需重复 imports。
 * BootstrapService 在全部模块就绪后统一编排启动动作。
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    GovernanceModule,
    NotifyModule,
    GatewayModule,
    TransportModule,
    AdminModule,
  ],
  providers: [BootstrapService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // P1-E・HTTP 入口埋点：全路由、全局前，内部会排除 /metrics /healthz
    consumer.apply(MetricsMiddleware).forRoutes('*');
  }
}
