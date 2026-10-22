import { isIP } from 'node:net';

/**
 * SSRF 防护：上游 URL 由管理员填入，等于开放内网探测入口。
 * - 协议限 http/https
 * - 主机解析后必须命中 outbound.allowed_cidrs 白名单（默认拒绝）
 * - 169.254.0.0/16 云元数据地址永久拒绝
 * - 禁跟随重定向（在 fetch 层设置 redirect:'manual'）
 */

function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr;
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (isIP(base) !== 4 || isIP(ip) !== 4) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(base) & mask);
}

/** 永久拒绝的元数据/链路本地网段 */
const ALWAYS_DENY = ['169.254.0.0/16', '127.0.0.0/8'];

export interface SsrfCheckResult {
  ok: boolean;
  reason?: string;
  hostname: string;
}

/**
 * 校验上游 URL。allowedCidrs 为空则拒绝所有 http 上游注册（安全默认值）。
 * 注意：域名解析在此只做字面 IP 校验；生产应在 fetch 时对解析后的 IP 二次校验
 * （此处提供 resolveHook 由调用方注入实际解析结果）。
 */
export function checkUpstreamUrl(
  rawUrl: string,
  allowedCidrs: string[],
  resolvedIp?: string,
): SsrfCheckResult {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'URL 格式非法', hostname: '' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `协议不允许：${u.protocol}`, hostname: u.hostname };
  }
  const host = u.hostname;
  const ipToCheck = resolvedIp ?? (isIP(host) ? host : null);

  // 云元数据地址永久拒绝（无论白名单如何配置）
  if (ipToCheck) {
    for (const deny of ALWAYS_DENY) {
      if (deny === '127.0.0.0/8' && allowedCidrs.some((c) => c.startsWith('127.'))) {
        // 显式允许本地回环时（开发环境）跳过 127 拒绝
        continue;
      }
      if (inCidr(ipToCheck, deny)) {
        return { ok: false, reason: `拒绝访问受限网段：${deny}`, hostname: host };
      }
    }
  }

  if (!allowedCidrs || allowedCidrs.length === 0) {
    return { ok: false, reason: '未配置 MGW_OUTBOUND_ALLOWED_CIDRS，默认拒绝所有上游', hostname: host };
  }

  // 域名（非 IP）无法在此静态校验，放行但要求 fetch 层二次校验解析 IP
  if (!ipToCheck) {
    return { ok: true, hostname: host };
  }

  for (const cidr of allowedCidrs) {
    if (inCidr(ipToCheck, cidr)) return { ok: true, hostname: host };
  }
  return { ok: false, reason: `主机 ${ipToCheck} 不在出站白名单内`, hostname: host };
}
