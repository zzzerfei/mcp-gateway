/**
 * safeMessage：给模型/客户端的错误文本净化。
 * 剥离堆栈、内网 IP/端口、SQL 片段、绝对路径，截断至 200 字符。
 * 这是安全边界，不是体验优化：原始错误只进 audit_logs.error_msg。
 */

const IP_PORT_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
const ABS_PATH_RE = /(\/[\w.-]+){2,}|([A-Za-z]:\\[\w.-\\]+)/g;
const SQL_RE = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE TABLE)\b[^;\n]{0,120}/gi;
const STACK_RE = /at\s+[\w.$<>]+\s+\([^)]*\)/g;
const BEARER_RE = /(Bearer|Authorization)\s*[:=]?\s*[\w.-]+/gi;

export function safeMessage(raw: unknown, maxLen = 200): string {
  if (raw == null) return '';
  let msg = raw instanceof Error ? raw.message : String(raw);
  msg = msg
    .replace(STACK_RE, '[stack]')
    .replace(BEARER_RE, '[redacted-auth]')
    .replace(SQL_RE, '[sql]')
    .replace(IP_PORT_RE, '[ip]')
    .replace(ABS_PATH_RE, '[path]')
    .replace(/\s+/g, ' ')
    .trim();
  if (msg.length > maxLen) msg = msg.slice(0, maxLen) + '…';
  return msg || '未知错误';
}

/** 完整原始错误（含堆栈），仅写入审计库，绝不返回客户端 */
export function rawErrorMessage(raw: unknown): string {
  if (raw instanceof Error) return raw.stack ?? raw.message;
  return String(raw);
}
