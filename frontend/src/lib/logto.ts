import LogtoClient from "@logto/browser";

/**
 * Logto OIDC 客户端（单例）。
 *
 * - 放在 setup 之外，因为 api/client.ts、router、EventSource 都需要取 token
 * - resources 与后端 LOGTO_AUDIENCE 必须是同一个 indicator，否则 access token 的 aud 不匹配
 * - scopes 是 API Resource 上定义的权限名，角色授予后才会进 token
 */
export const LOGTO_ENDPOINT =
  import.meta.env.VITE_LOGTO_ENDPOINT ?? "http://localhost:3001";
export const GATEWAY_AUDIENCE =
  import.meta.env.VITE_LOGTO_AUDIENCE ?? "https://api.gateway.local";
const APP_ID = import.meta.env.VITE_LOGTO_APP_ID ?? "";

/**
 * 账号中心：Logto 自带的终端用户自助页（改姓名/头像/密码/MFA/会话），
 * 不需要各业务应用自己实现。生产可指向统一域名。
 */
export const ACCOUNT_CENTER_BASE =
  import.meta.env.VITE_ACCOUNT_CENTER_URL ?? `${LOGTO_ENDPOINT}/account`;

/**
 * 账号中心深链：改完资料后回到当前页，界面固定中文。
 * 例：accountCenterUrl('/security')
 */
export function accountCenterUrl(path = ""): string {
  const url = new URL(`${ACCOUNT_CENTER_BASE.replace(/\/$/, "")}${path}`);
  url.searchParams.set("ui_locales", "zh-CN");
  url.searchParams.set(
    "redirect",
    `${window.location.origin}${window.location.pathname}`,
  );
  return url.toString();
}

export const logto = new LogtoClient({
  endpoint: LOGTO_ENDPOINT,
  appId: APP_ID,
  resources: [GATEWAY_AUDIENCE],
  scopes: ["gateway:read", "gateway:write", "gateway:sensitive"],
});

/** 取网关 access token；过期时 SDK 自动用 refresh token 换新 */
export function getGatewayToken(): Promise<string> {
  return logto.getAccessToken(GATEWAY_AUDIENCE);
}

/** 解 JWT payload（不验签，仅用于 UI 展示与按钮可见性；安全判断在后端） */
function readScopes(token: string): string[] {
  try {
    const part = token.split(".")[1];
    if (!part) return [];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { scope?: unknown };
    return typeof payload.scope === "string"
      ? payload.scope.split(/\s+/).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

let cache: { token: string; scopes: string[] } | null = null;

/** 当前 token 里的 scope（同一 token 复用解析结果） */
export async function getGatewayScopes(): Promise<string[]> {
  const token = await getGatewayToken();
  if (cache?.token === token) return cache.scopes;
  const scopes = readScopes(token);
  cache = { token, scopes };
  return scopes;
}

let inFlight: Promise<string[]> | null = null;

/**
 * 强制换一张 access token 再读 scope。
 * 用于"管理员刚改了角色，但旧 token 里还是旧 scope"的场景。
 * 并发调用共享同一个 Promise，避免同时清 token 互相打架。
 */
export function refreshGatewayScopes(): Promise<string[]> {
  if (!inFlight) {
    inFlight = (async () => {
      cache = null;
      try {
        await logto.clearAccessToken();
      } catch {
        /* 无缓存时 SDK 可能抛，忽略 */
      }
      const token = await getGatewayToken();
      const scopes = readScopes(token);
      cache = { token, scopes };
      return scopes;
    })().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
