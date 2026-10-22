import { Injectable } from '@nestjs/common';
import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';
import { ConfigService } from '../config/config.service';

/**
 * 加密原语：
 * - SHA-256：API Key 哈希（只存哈希，明文仅签发响应出现一次）
 * - AES-256-GCM：上游凭据加解密，格式 iv(12) | tag(16) | ciphertext，base64
 * - timingSafeEqual：Admin Token 比较，防时序侧信道
 */
@Injectable()
export class CryptoService {
  private readonly masterKey: Buffer;

  constructor(private readonly config: ConfigService) {
    const secret = this.config.get().secret;
    // 支持 64 hex 字符，或直接以 utf8 派生
    this.masterKey = /^[0-9a-fA-F]{64}$/.test(secret)
      ? Buffer.from(secret, 'hex')
      : createHash('sha256').update(secret).digest();
  }

  sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  /** 生成 API Key 明文：mgw_live_ + base64url(24 bytes) */
  generateApiKey(): { raw: string; hash: string; prefix: string } {
    const body = randomBytes(24).toString('base64url');
    const raw = `mgw_live_${body}`;
    return { raw, hash: this.sha256(raw), prefix: raw.slice(0, 16) };
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  decrypt(payload: string): string {
    const buf = Buffer.from(payload, 'base64');
    if (buf.length < 28) throw new Error('密文格式非法');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  /** 加密对象（如上游 headers），返回密文；空对象返回 null */
  encryptJson(obj: unknown): string | null {
    if (obj == null) return null;
    const s = JSON.stringify(obj);
    if (s === '{}' || s === '') return null;
    return this.encrypt(s);
  }

  decryptJson<T>(payload: string | null): T | null {
    if (!payload) return null;
    try {
      return JSON.parse(this.decrypt(payload)) as T;
    } catch {
      // 主密钥错误时不静默返回乱码，显式抛出让运维感知
      throw new Error('凭据解密失败：主密钥可能不匹配或密文损坏');
    }
  }

  /** 前端展示用掩码：Bearer sk-**** */
  maskSecret(value: string): string {
    if (!value) return '';
    const parts = value.split(' ');
    const last = parts[parts.length - 1];
    if (last.length <= 6) return '****';
    return `${parts.length > 1 ? parts[0] + ' ' : ''}${last.slice(0, 3)}****${last.slice(-2)}`;
  }

  safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
