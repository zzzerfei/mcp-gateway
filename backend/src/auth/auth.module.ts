import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { ApiKeyService } from './apikey.service';
import { RbacService } from './rbac.service';

/**
 * 认证鉴权模块（全局）。
 * - CryptoService：SHA-256 / AES-256-GCM / timingSafeEqual 原语，被 Admin 守卫、Key、上游凭据共用
 * - ApiKeyService：MCP Key 校验（带 60s authCache）
 * - RbacService：通配符规则匹配 + allowedSet 缓存
 * 三者是网关调用链与管理链的共同底座，故 @Global 导出。
 */
@Global()
@Module({
  providers: [CryptoService, ApiKeyService, RbacService],
  exports: [CryptoService, ApiKeyService, RbacService],
})
export class AuthModule {}
