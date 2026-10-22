/**
 * 错误码表（对模型的返回契约）。
 * 治理链的每一步失败都对应一个稳定错误码，前端与模型据此行动。
 */
export const ErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  /** 影子模式（rbac.mode=observe）命中的“若切 enforce 将被拦”标记，不影响实际放行 */
  WOULD_FORBID: 'WOULD_FORBID',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  UPSTREAM_DOWN: 'UPSTREAM_DOWN',
  UPSTREAM_BUSY: 'UPSTREAM_BUSY',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  BAD_ARGS: 'BAD_ARGS',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误码 → 给模型的中文简述 */
export const ERROR_TEXT: Record<ErrorCodeType, string> = {
  UNAUTHORIZED: '未授权',
  FORBIDDEN: '无权调用该工具',
  WOULD_FORBID: '影子模式下放行，实际无权限（仅审计标记）',
  TOOL_NOT_FOUND: '工具不存在或已下线',
  RATE_LIMITED: '调用过于频繁，请稍后重试',
  UPSTREAM_DOWN: '上游服务暂不可用',
  UPSTREAM_BUSY: '上游繁忙，请稍后重试',
  UPSTREAM_TIMEOUT: '上游响应超时',
  UPSTREAM_ERROR: '工具执行失败',
  BAD_ARGS: '参数不合法',
  INTERNAL: '网关内部错误',
};

/**
 * 归一化工具错误：MCP 规范下「工具业务失败」用 isError:true 而非 JSON-RPC error，
 * 让模型有机会调整策略。文本格式统一为 `[错误码] 简短中文`。
 */
export class GatewayToolError extends Error {
  constructor(
    public readonly code: ErrorCodeType,
    public readonly safeMessage: string,
    public readonly rawError?: string,
    public readonly kind: 'client-error' | 'upstream-error' = 'upstream-error',
    public readonly meta: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${safeMessage}`);
  }

  /** 客户端问题（BAD_ARGS / FORBIDDEN）不计入熔断 */
  get isClientError(): boolean {
    return this.kind === 'client-error';
  }
}

export function clientError(code: ErrorCodeType, msg: string, meta?: Record<string, unknown>): GatewayToolError {
  return new GatewayToolError(code, msg, undefined, 'client-error', meta);
}

export function upstreamError(code: ErrorCodeType, msg: string, raw?: string, meta?: Record<string, unknown>): GatewayToolError {
  return new GatewayToolError(code, msg, raw, 'upstream-error', meta);
}
