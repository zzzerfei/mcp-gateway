import { http, downloadCsv } from "./client";

/**
 * 类型化 API 层。接口与响应结构与后端 admin controllers 严格对应。
 * 页面只调 api.xxx.yyy()，不直接拼 URL，端点变更只改这一处。
 */

// ── 通用 ──────────────────────────────────────────────
export interface Paged<T> {
  total: number;
  page: number;
  size: number;
  rows: T[];
}

// ── 上游 ──────────────────────────────────────────────
export interface Upstream {
  id: number;
  name: string;
  displayName: string;
  transport: "http" | "stdio";
  url: string | null;
  headersMasked: Record<string, string> | null;
  command: string | null;
  args: string[];
  cwd: string | null;
  sensitivity: "normal" | "high";
  enabled: number;
  owner: string;
  timeoutMs: number;
  concurrency: number;
  remark: string;
  lastStatus: "unknown" | "up" | "down" | "connecting";
  lastError: string;
  lastCheckedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpstreamInput {
  name: string;
  displayName?: string;
  transport: "http" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sensitivity?: "normal" | "high";
  owner?: string;
  timeoutMs?: number;
  concurrency?: number;
  remark?: string;
}

// ── 工具 ──────────────────────────────────────────────
export interface ToolItem {
  fullName: string;
  upstream: string;
  originalName: string;
  title: string;
  description: string;
  rawDescription: string;
  enabled: boolean;
  sensitivity: "normal" | "high";
  overridden: boolean;
  rateQpm: number | null;
  note: string;
}

export interface ToolDetail extends ToolItem {
  inputSchema: unknown;
  override: unknown | null;
}

/** 试调用结果：走完整治理链，stage 指出卡在哪一步 */
/** 治理链单步状态：passed=已通过，failed=卡在此步，skipped=未执行 */
export interface ChainStage {
  no: number;
  name: string;
  status: "passed" | "failed" | "skipped";
}

export interface ToolInvokeResult {
  ok: boolean;
  requestId: string | null;
  durationMs: number;
  errorCode: string | null;
  stage: string;
  stages: ChainStage[];
  result: unknown;
}

// ── 角色 / 规则 / 矩阵 ────────────────────────────────
export interface RoleItem {
  name: string;
  description: string;
  isBuiltin: boolean;
  ruleCount: number;
  activeKeyCount: number;
  createdAt: number;
}

export interface RuleItem {
  id?: number;
  effect: "allow" | "deny";
  pattern: string;
  sort?: number;
  memo?: string;
}

export interface PreviewResult {
  role: string;
  currentCount: number;
  nextCount: number;
  gained: string[];
  lost: string[];
  affectedKeys: Array<{
    id: number;
    name: string;
    userName: string;
    keyPrefix: string;
  }>;
  /** F3・影响面量化：受影响 Key 数（同 affectedKeys.length，方便表格列直接绑定） */
  affectedKeyCount?: number;
  /** F3・近 7d 该角色对 lost/gained 工具的命中次数（tool → count） */
  recent7dCalls?: Record<string, number>;
  lostCalls7d?: number;
  gainedCalls7d?: number;
  totalImpact7d?: number;
}

export interface MatrixColumn {
  fullName: string;
  upstream: string;
  enabled: boolean;
  sensitivity: "normal" | "high";
}
export interface MatrixRow {
  role: string;
  description: string;
  allowedCount: number;
  cells: Record<string, boolean>;
}
export interface Matrix {
  columns: MatrixColumn[];
  rows: MatrixRow[];
  registryVersion: number;
}

// ── Key ───────────────────────────────────────────────
export interface KeyItem {
  id: number;
  prefix: string;
  name: string;
  userName: string;
  team: string;
  role: string;
  profile: string;
  expiresAt: number | null;
  revoked: number;
  revokeReason: string;
  lastUsedAt: number | null;
  createdAt: number;
}
export interface IssuedKey {
  raw: string;
  id: number;
  prefix: string;
  name?: string;
  userName?: string;
  role?: string;
}

// ── 审计 / 变更 ───────────────────────────────────────
export interface AuditItem {
  id: number;
  ts: number;
  requestId: string;
  event: string;
  userName: string | null;
  team: string | null;
  role: string | null;
  tool: string | null;
  upstream: string | null;
  argsDigest: string | null;
  resultBytes: number | null;
  resultOk: number;
  errorCode: string | null;
  durationMs: number | null;
  queueMs: number | null;
  sensitive: number;
  redacted: number;
  callerIp: string | null;
}
export interface AuditDetail extends AuditItem {
  argsFull: string | null;
  errorMsg: string | null;
  sessionId: string | null;
  clientInfo: string | null;
  channel: string;
}
export interface ChangeItem {
  id: number;
  ts: number;
  actor: string;
  actorIp: string;
  targetType: string;
  targetId: string;
  action: string;
  beforeJson: string | null;
  afterJson: string | null;
  diffSummary: string;
}

// ── 报表 ──────────────────────────────────────────────
export interface StatsOverview {
  days: number;
  topTools: Array<{
    tool: string;
    n: number;
    avg_ms: number;
    fail_pct: number;
  }>;
  byUpstream: Array<{ upstream: string; n: number; fail_pct: number }>;
  failTop: Array<{ tool: string; n: number; fail_pct: number }>;
  topUsers: Array<{ user_name: string; n: number }>;
  sensitiveCount: number;
  totalCalls: number;
  totalFails: number;
  p95ByUpstream: Array<{ upstream: string; count: number; p95_ms: number }>;
  /** F1・影子模式：当前生效的 RBAC 模式 */
  rbacMode?: "enforce" | "observe";
  /** F1・影子模式下会拦截而实际放行的越权命中总数 */
  wouldForbidCount?: number;
  /** F1・影子命中 Top（按 tool × role 聚合） */
  wouldForbidTop?: Array<{ tool: string; role: string; n: number }>;
}
export interface TimeseriesPoint {
  ts: number;
  total: number;
  fails: number;
  fail_pct: number;
}

// ── 系统 ──────────────────────────────────────────────
export interface Health {
  status: string;
  uptime_s: number;
  registryVersion: number;
  tools: number;
  sessions: number;
  upstreamsConnected: number;
  auditQueueDepth: number;
  ts: number;
  /** F7・事件循环 p99 延迟（ms），采样间隔 5s */
  el_p99_ms?: number;
}
export interface RegistryStatus {
  version: number;
  toolCount: number;
  sessions: number;
  upstreamsConnected: number;
  auditQueueDepth: number;
  ratelimitBuckets: number;
}
export type Settings = Record<string, string>;

// ── P1-C・熔断事件面板 ───────────────────────────
export interface BreakerConfig {
  failThreshold: number;
  openMs: number;
  windowMs: number;
}
export type BreakerState = "closed" | "open" | "half-open";
export interface BreakerStatusItem {
  upstream: string;
  state: BreakerState;
  fails: number;
  openedAt: number;
}
export interface BreakerStatus {
  config: BreakerConfig;
  upstreams: BreakerStatusItem[];
}
export interface BreakerEventItem {
  id: number;
  ts: number;
  upstream: string;
  event: "opened" | "recovered";
  fromState: BreakerState;
  toState: BreakerState;
  failsInWindow: number;
  openMs: number;
  reason: string | null;
}
export interface BreakerSummaryItem {
  upstream: string;
  opened: number;
  recovered: number;
  lastEventTs: number;
}

// ── P1-A・数据库备份 ──────────────────────────
export interface BackupItem {
  id: number;
  ts: number;
  filename: string;
  absPath: string;
  bytes: number;
  durationMs: number;
  trigger: "cron" | "manual";
  status: "ok" | "failed";
  errorMsg: string | null;
  actor: string;
}
export interface BackupSummary {
  enabled: boolean;
  cron: string;
  tz: string;
  keep: number;
  latest: {
    ts: number;
    filename: string;
    bytes: number;
    durationMs: number;
    trigger: string;
  } | null;
  lastFailed: { ts: number; filename: string; errorMsg: string | null } | null;
  totalCount: number;
  totalBytes: number;
}

// ── P3・冒烟用例 ─────────────────────────────
export interface SmokeCaseItem {
  id: number;
  name: string;
  toolFullName: string;
  argsJson: string;
  role: string;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  lastOk: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  /** 工具是否仍在注册表中（上游下线后用例会失效） */
  toolExists: boolean;
}
export interface CaseRunItem {
  id: number;
  name: string;
  toolFullName: string;
  role: string;
  ok: boolean;
  requestId: string | null;
  durationMs: number;
  errorCode: string | null;
  stage: string;
  stages: ChainStage[];
  result: unknown;
}
export interface CaseRunAllResult {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  items: CaseRunItem[];
}

const B = "/admin/api";
export const api = {
  // 上游
  upstreams: {
    list: () => http.get<Upstream[]>(`${B}/upstreams`),
    create: (input: UpstreamInput) =>
      http.post<Upstream>(`${B}/upstreams`, input),
    update: (name: string, patch: Partial<UpstreamInput>) =>
      http.put<Upstream>(`${B}/upstreams/${name}`, patch),
    remove: (name: string) =>
      http.del<{ ok: boolean }>(`${B}/upstreams/${name}`),
    probe: (name: string) => http.post<any>(`${B}/upstreams/${name}/probe`),
    refresh: (name: string) => http.post<any>(`${B}/upstreams/${name}/refresh`),
  },
  // 工具
  tools: {
    list: (q?: { upstream?: string; q?: string; overridden?: string }) =>
      http.get<ToolItem[]>(`${B}/tools`, q),
    detail: (fullName: string) =>
      http.get<ToolDetail>(`${B}/tools/${encodeURIComponent(fullName)}`),
    setDescription: (fullName: string, description: string) =>
      http.put<{ ok: boolean; warning?: string }>(
        `${B}/tools/${encodeURIComponent(fullName)}/description`,
        { description },
      ),
    setEnabled: (fullName: string, enabled: boolean) =>
      http.put<{ ok: boolean }>(
        `${B}/tools/${encodeURIComponent(fullName)}/enabled`,
        { enabled },
      ),
    setRateLimit: (fullName: string, rateQpm: number | null) =>
      http.put<{ ok: boolean }>(
        `${B}/tools/${encodeURIComponent(fullName)}/ratelimit`,
        { rateQpm },
      ),
    invoke: (fullName: string, args: Record<string, unknown>, role?: string) =>
      http.post<ToolInvokeResult>(
        `${B}/tools/${encodeURIComponent(fullName)}/invoke`,
        { args, role },
      ),
  },
  // 角色 / 规则 / 矩阵
  permissions: {
    roles: () => http.get<RoleItem[]>(`${B}/roles`),
    createRole: (name: string, description?: string) =>
      http.post<{ ok: boolean; name: string }>(`${B}/roles`, {
        name,
        description,
      }),
    deleteRole: (name: string) =>
      http.del<{ ok: boolean }>(`${B}/roles/${name}`),
    getRules: (name: string) =>
      http.get<{ role: string; rules: RuleItem[] }>(`${B}/roles/${name}/rules`),
    saveRules: (name: string, rules: RuleItem[], dryRun = false) =>
      http.put<{ ok: boolean; dryRun?: boolean; preview: PreviewResult }>(
        `${B}/roles/${name}/rules`,
        { rules, dryRun },
      ),
    preview: (role: string, rules: RuleItem[]) =>
      http.post<PreviewResult>(`${B}/permissions/preview`, { role, rules }),
    matrix: (upstream?: string) =>
      http.get<Matrix>(`${B}/permissions/matrix`, { upstream }),
    /** F2・一键回滚角色规则到某次变更前快照 */
    rollback: (name: string, changeId: number) =>
      http.post<{ ok: boolean; rolledBackTo: number; preview: PreviewResult }>(
        `${B}/roles/${name}/rules/rollback`,
        { changeId },
      ),
  },
  // Key
  keys: {
    list: (q?: { user?: string; role?: string; revoked?: number }) =>
      http.get<KeyItem[]>(`${B}/keys`, q as any),
    issue: (input: {
      name: string;
      userName: string;
      team?: string;
      role: string;
      profile?: string;
      expiresInDays?: number | null;
    }) => http.post<IssuedKey>(`${B}/keys`, input),
    revoke: (id: number, reason: "leak" | "offboard" | "rotate" | "other") =>
      http.post<{ ok: boolean }>(`${B}/keys/${id}/revoke`, { reason }),
    /** 按使用者一键吊销其名下所有有效 Key（离职/封禁） */
    revokeUser: (
      userName: string,
      reason: "leak" | "offboard" | "rotate" | "other" = "offboard",
    ) =>
      http.post<{ ok: boolean; count: number; prefixes: string[] }>(
        `${B}/keys/revoke-user`,
        { userName, reason },
      ),
    rotate: (id: number, graceMinutes = 0) =>
      http.post<IssuedKey>(`${B}/keys/${id}/rotate`, { graceMinutes }),
  },
  // 审计 / 变更
  audit: {
    query: (q: Record<string, unknown>) =>
      http.get<Paged<AuditItem>>(`${B}/audit`, q),
    detail: (id: number) => http.get<AuditDetail>(`${B}/audit/${id}`),
    export: (q: Record<string, unknown>) =>
      downloadCsv(`${B}/audit/export`, q, `audit-${Date.now()}.csv`),
    changes: (q: Record<string, unknown>) =>
      http.get<{ rows: ChangeItem[]; total: number }>(`${B}/changes`, q),
  },
  // 报表
  stats: {
    overview: (days = 7) =>
      http.get<StatsOverview>(`${B}/stats/overview`, { days }),
    timeseries: (days = 7, bucket: "hour" | "day" = "hour") =>
      http.get<TimeseriesPoint[]>(`${B}/stats/timeseries`, { days, bucket }),
  },
  // P3・冒烟用例 + 一键回归
  cases: {
    list: () => http.get<SmokeCaseItem[]>(`${B}/cases`),
    create: (input: {
      name: string;
      toolFullName: string;
      args: Record<string, unknown>;
      role?: string;
    }) => http.post<{ ok: boolean; id: number }>(`${B}/cases`, input),
    update: (
      id: number,
      patch: {
        name?: string;
        args?: Record<string, unknown>;
        role?: string;
        enabled?: boolean;
      },
    ) => http.put<{ ok: boolean }>(`${B}/cases/${id}`, patch),
    remove: (id: number) => http.del<{ ok: boolean }>(`${B}/cases/${id}`),
    run: (id: number) => http.post<CaseRunItem>(`${B}/cases/${id}/run`),
    runAll: () => http.post<CaseRunAllResult>(`${B}/cases/run-all`),
  },
  // 系统
  system: {
    health: () => http.get<Health>("/healthz"),
    registry: () => http.get<RegistryStatus>(`${B}/system/registry`),
    refreshRegistry: () =>
      http.post<{ ok: boolean; version: number }>(
        `${B}/system/registry/refresh`,
      ),
    getSettings: () => http.get<Settings>(`${B}/settings`),
    updateSettings: (patch: Settings) =>
      http.put<{ ok: boolean }>(`${B}/settings`, patch),
  },
  // P1-C・熔断事件
  breaker: {
    status: () => http.get<BreakerStatus>(`${B}/breaker/status`),
    events: (q: Record<string, unknown>) =>
      http.get<Paged<BreakerEventItem>>(`${B}/breaker/events`, q),
    summary: (days = 7) =>
      http.get<BreakerSummaryItem[]>(`${B}/breaker/summary`, { days }),
  },
  // P1-A・数据库备份
  backup: {
    list: (q: Record<string, unknown>) =>
      http.get<Paged<BackupItem>>(`${B}/backups`, q),
    summary: () => http.get<BackupSummary>(`${B}/backups/summary`),
    run: () => http.post<BackupItem>(`${B}/backups/run`),
    /** 下载带鉴权头的备份文件（复用 downloadCsv 的 blob 拉取能力） */
    download: (id: number, filename: string) =>
      downloadCsv(`${B}/backups/${id}/download`, undefined, filename),
  },
};
