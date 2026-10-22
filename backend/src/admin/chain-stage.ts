/**
 * 治理链阶段判定：把错误码映射为「卡在第几步」。
 * 供管理后台的试调用 / 冒烟用例复用，保证两处口径一致。
 */

/** 治理链六步（顺序不可调换，见 router.service 的编排） */
export const CHAIN_STEPS = ["注册表", "RBAC", "限流", "熔断", "并发", "转发"];

/** 错误码 → 卡住的步骤下标 */
const FAILED_STEP: Record<string, number> = {
  TOOL_NOT_FOUND: 0,
  FORBIDDEN: 1,
  RATE_LIMITED: 2,
  UPSTREAM_DOWN: 3,
  UPSTREAM_BUSY: 4,
  UPSTREAM_TIMEOUT: 5,
  UPSTREAM_ERROR: 5,
  INTERNAL: 5,
};

const DETAIL = [
  "工具不存在或已下线",
  "当前角色无权调用",
  "超过 QPM 限制",
  "上游已熔断",
  "信号量已满",
  "上游超时或报错",
];

const MARK = ["①", "②", "③", "④", "⑤", "⑥"];

function failedIndex(code?: string): number {
  return code ? FAILED_STEP[code] ?? 5 : -1;
}

/** 一句话结论：卡在哪一步，或全链路通过 */
export function stageOf(code?: string): string {
  const i = failedIndex(code);
  if (i < 0) return "✅ 全链路通过";
  return `${MARK[i]} ${CHAIN_STEPS[i]}：${DETAIL[i]}`;
}

/** 六步状态：治理链严格串行，失败步骤之后的一定没执行 */
export function stagesOf(
  code?: string,
): { no: number; name: string; status: "passed" | "failed" | "skipped" }[] {
  const failed = failedIndex(code);
  return CHAIN_STEPS.map((name, i) => ({
    no: i + 1,
    name,
    status:
      failed < 0 ? "passed" : i < failed ? "passed" : i === failed ? "failed" : "skipped",
  }));
}
