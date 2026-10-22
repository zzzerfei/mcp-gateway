import { Global, Module } from '@nestjs/common';
import { NotifyService } from './im.service';

/**
 * 告警通知模块（全局）。IM Webhook 推送（熔断开启/恢复、会话达上限、上游宕机），
 * 带 5 分钟同类抑制，避免告警风暴。被 UpstreamManager、SessionManager 调用。
 */
@Global()
@Module({
  providers: [NotifyService],
  exports: [NotifyService],
})
export class NotifyModule {}
