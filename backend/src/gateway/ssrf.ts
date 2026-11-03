import { promises as dns } from "node:dns";
import { isIP } from "node:net";

/**
 * SSRF 防护：上游 URL 由管理员填入，等于开放内网探测入口。
 *
 * 两种模式：
 * - blocklist（默认）：阻断回环/私网/链路本地/云元数据等受限地址，公网默认放行。
 *   适合聚合任意第三方 MCP 上游的常规场景，新增公网上游无需维护白名单。
 * - allowlist（高安全场景）：只允许命中 allowedCidrs 的地址，默认拒绝其它全部。
 *
 * 其它约束：协议限 http/https；云元数据地址永久拒绝；禁跟随重定向（fetch 层设置）。
 */

export type OutboundMode = "blocklist" | "allowlist";

export interface OutboundPolicy {
  mode: OutboundMode;
  /** allowlist 模式下的允许网段（仅 IPv4 CIDR） */
  allowedCidrs: string[];
  /** blocklist 模式下额外放开的私网段（如自建内网上游） */
  allowPrivateCidrs: string[];
}

function ipToLong(ip: string): number {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes("/")) return ip === cidr;
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  if (isIP(base) !== 4 || isIP(ip) !== 4) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(base) & mask);
}

/** 云元数据地址：无论哪种模式都永久拒绝 */
const ALWAYS_DENY = ["169.254.0.0/16", "100.100.100.200/32", "168.63.129.16/32"];

/** 回环 / 私网 / CGNAT / 保留 / 组播 / 基准测试等非公网地址 */
const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

/** IPv6 受限地址：回环、链路本地 fe80::/10、唯一本地 fc00::/7、IPv4-mapped */
function isBlockedIpv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) {
    const rest = v.slice("::ffff:".length);
    return isIP(rest) === 4 ? isBlockedIpv4(rest) : true;
  }
  const first = v.split(":")[0];
  if (/^fe[89ab]/.test(first)) return true; // fe80::/10
  if (/^f[cd]/.test(first)) return true; // fc00::/7
  return false;
}

function isBlockedIpv4(ip: string): boolean {
  return BLOCKED_V4.some((cidr) => inCidr(ip, cidr));
}

/** 是否为内网/受限地址（blocklist 模式默认阻断） */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

export interface SsrfCheckResult {
  ok: boolean;
  reason?: string;
  hostname: string;
  resolvedIp?: string;
}

/**
 * 校验上游 URL。resolvedIp 由调用方传入 DNS 解析结果（域名场景），
 * 用于在建立连接前按实际 IP 判定，避免“域名直接放行”的绕过。
 */
export function checkUpstreamUrl(
  rawUrl: string,
  policy: OutboundPolicy,
  resolvedIp?: string,
): SsrfCheckResult {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "URL 格式非法", hostname: "" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return {
      ok: false,
      reason: `协议不允许：${u.protocol}`,
      hostname: u.hostname,
    };
  }
  const host = u.hostname;
  const ipToCheck = resolvedIp ?? (isIP(host) ? host : null);

  if (ipToCheck) {
    for (const deny of ALWAYS_DENY) {
      if (inCidr(ipToCheck, deny) || ipToCheck === deny.split("/")[0]) {
        return {
          ok: false,
          reason: `拒绝访问云元数据/受限网段：${deny}`,
          hostname: host,
        };
      }
    }
  }

  if (policy.mode === "allowlist") {
    if (!policy.allowedCidrs || policy.allowedCidrs.length === 0) {
      return {
        ok: false,
        reason:
          "allowlist 模式下未配置 MGW_OUTBOUND_ALLOWED_CIDRS，默认拒绝所有上游",
        hostname: host,
      };
    }
    // 域名（尚未解析）先放行，由 checkUpstreamUrlResolved 做二次校验
    if (!ipToCheck) return { ok: true, hostname: host };
    if (isIP(ipToCheck) === 6) {
      return {
        ok: false,
        reason: "allowlist 模式仅支持 IPv4 网段，域名解析到 IPv6 无法校验",
        hostname: host,
      };
    }
    for (const cidr of policy.allowedCidrs) {
      if (inCidr(ipToCheck, cidr)) return { ok: true, hostname: host };
    }
    return {
      ok: false,
      reason: `主机 ${ipToCheck} 不在出站白名单内`,
      hostname: host,
    };
  }

  // blocklist 模式：公网放行，内网/受限地址默认拒绝
  if (!ipToCheck) return { ok: true, hostname: host };
  if (!isBlockedIp(ipToCheck)) return { ok: true, hostname: host };

  // 显式放开的私网段（仅 IPv4）
  if (
    isIP(ipToCheck) === 4 &&
    policy.allowPrivateCidrs?.some((cidr) => inCidr(ipToCheck, cidr))
  ) {
    return { ok: true, hostname: host };
  }
  return {
    ok: false,
    reason: `拒绝访问内网/受限地址：${ipToCheck}（blocklist 模式默认阻断，确需访问请配置 MGW_OUTBOUND_ALLOW_PRIVATE_CIDRS）`,
    hostname: host,
  };
}

/**
 * 异步校验：域名先做 DNS 解析，再对解析结果逐个走策略校验。
 * 注册/更新上游与建立连接前都会调用，避免“域名直接放行”的 SSRF 绕过。
 */
export async function checkUpstreamUrlResolved(
  rawUrl: string,
  policy: OutboundPolicy,
): Promise<SsrfCheckResult> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return { ok: false, reason: "URL 格式非法", hostname: "" };
  }
  if (isIP(host)) return checkUpstreamUrl(rawUrl, policy);

  // 先跑与解析无关的基础校验（协议、allowlist 是否为空）
  const base = checkUpstreamUrl(rawUrl, policy);
  if (!base.ok) return base;

  const [v4, v6] = await Promise.all([
    dns.resolve4(host).catch(() => [] as string[]),
    dns.resolve6(host).catch(() => [] as string[]),
  ]);
  if (v4.length === 0 && v6.length === 0) {
    return {
      ok: false,
      reason: `域名 ${host} 解析不到 IP 地址`,
      hostname: host,
    };
  }
  for (const ip of v4) {
    const r = checkUpstreamUrl(rawUrl, policy, ip);
    if (!r.ok) return r;
  }
  for (const ip of v6) {
    const r = checkUpstreamUrl(rawUrl, policy, ip);
    if (!r.ok) return r;
  }
  return { ok: true, hostname: host, resolvedIp: v4[0] ?? v6[0] };
}
