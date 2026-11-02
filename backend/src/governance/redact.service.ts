import { Injectable } from '@nestjs/common';

/**
 * PII 正则脱敏：手机、身份证、银行卡、邮箱。
 * 脱敏在「入库前」完成，不依赖查询时脱敏——否则审计库自身成为最大泄漏面。
 */
@Injectable()
export class RedactService {
  private readonly patterns: Array<{ re: RegExp; mask: (m: string) => string }> = [
    // 中国大陆手机号
    { re: /\b1[3-9]\d{9}\b/g, mask: (m) => m.slice(0, 3) + '****' + m.slice(-4) },
    // 邮箱
    { re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, mask: (m) => m.slice(0, 2) + '***' + m.slice(m.indexOf('@')) },
    // 身份证（18 位，末位可 X）
    { re: /\b\d{17}[\dXx]\b/g, mask: (m) => m.slice(0, 4) + '**********' + m.slice(-4) },
    // 银行卡（16-19 位）
    { re: /\b\d{16,19}\b/g, mask: (m) => m.slice(0, 4) + '****' + m.slice(-4) },
  ];

  /** 对字符串做脱敏，返回 { value, redacted } */
  redactString(input: string): { value: string; redacted: boolean } {
    if (!input) return { value: input, redacted: false };
    let out = input;
    let redacted = false;
    for (const p of this.patterns) {
      if (p.re.test(out)) {
        redacted = true;
        out = out.replace(p.re, (m) => p.mask(m));
      }
    }
    return { value: out, redacted };
  }

  /**
   * 深度脱敏任意对象（递归 JSON）。用于 args_full 与 error_msg。
   */
  redactDeep(input: unknown): { value: unknown; redacted: boolean } {
    let redacted = false;
    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') {
        const r = this.redactString(node);
        if (r.redacted) redacted = true;
        return r.value;
      }
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
        return out;
      }
      return node;
    };
    return { value: walk(input), redacted };
  }

  /** 参数摘要：SHA-256 前 16 位（由调用方拼脱敏文本） */
  digestPrefix(hashHex: string): string {
    return hashHex.slice(0, 16);
  }
}
