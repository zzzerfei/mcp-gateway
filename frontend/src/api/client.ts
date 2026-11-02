/**
 * API 客户端：基于原生 fetch 的轻量封装（不引 axios，契合轻量化诉求）。
 *
 * 职责：
 * - 统一注入 Admin Token（Bearer）与操作者标识（x-admin-user，供后端 change_logs 留痕）
 * - 统一 JSON 解析与错误归一化（后端 HttpException 的 message 直接可用）
 * - 401 自动登出并跳登录（Token 失效/被改）
 * - 提供 CSV 下载（审计导出）与 querystring 拼接
 */

const TOKEN_KEY = 'mgw_admin_token';
const USER_KEY = 'mgw_admin_user';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const tokenStore = {
  get token(): string {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  },
  set token(v: string) {
    if (v) localStorage.setItem(TOKEN_KEY, v);
    else localStorage.removeItem(TOKEN_KEY);
  },
  get user(): string {
    return localStorage.getItem(USER_KEY) ?? 'admin';
  },
  set user(v: string) {
    localStorage.setItem(USER_KEY, v || 'admin');
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

/** 401 时触发，由 router/store 监听跳转登录 */
export type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {};
export function setUnauthorizedHandler(fn: UnauthorizedHandler): void {
  onUnauthorized = fn;
}

export function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.append(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

interface RequestOpts {
  body?: unknown;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
  const url = `${path}${buildQuery(opts.query)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokenStore.token}`,
    'x-admin-user': tokenStore.user,
    ...opts.headers,
  };
  let bodyStr: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: bodyStr, signal: opts.signal });
  } catch (e) {
    // 网络层错误（后端未起/断网）
    throw new ApiError(0, `网络错误：无法连接网关（${(e as Error).message}）`);
  }

  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'Admin Token 无效或已失效，请重新登录');
  }

  // 204 / 空响应
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;

  if (!res.ok) {
    const msg = extractMessage(data) ?? `请求失败（HTTP ${res.status}）`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractMessage(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, any>;
    if (typeof d.message === 'string') return d.message;
    if (Array.isArray(d.message)) return d.message.join('; ');
    if (typeof d.error === 'string') return d.error;
  }
  return null;
}

export const http = {
  get: <T>(path: string, query?: Record<string, unknown>, signal?: AbortSignal) =>
    request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown, query?: Record<string, unknown>) =>
    request<T>('POST', path, { body, query }),
  put: <T>(path: string, body?: unknown, query?: Record<string, unknown>) =>
    request<T>('PUT', path, { body, query }),
  del: <T>(path: string, query?: Record<string, unknown>) => request<T>('DELETE', path, { query }),
};

/** CSV 导出：带 Token 拉取 blob 并触发浏览器下载 */
export async function downloadCsv(path: string, query?: Record<string, unknown>, filename = 'export.csv'): Promise<void> {
  const res = await fetch(`${path}${buildQuery(query)}`, {
    headers: { Authorization: `Bearer ${tokenStore.token}`, 'x-admin-user': tokenStore.user },
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'Admin Token 无效或已失效，请重新登录');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, text || `导出失败（HTTP ${res.status}）`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
