import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service';

/**
 * 配置模块（全局）。ConfigService 无依赖、进程内单例，
 * 几乎所有模块都要读配置，故设为 @Global 避免层层 imports。
 */
@Global()
@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
