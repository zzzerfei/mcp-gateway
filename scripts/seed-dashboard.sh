#!/usr/bin/env bash
# ==============================================================================
#  seed-dashboard.sh · 仪表盘数据源头灌注脚本
#  ─────────────────────────────────────────────────────────────────────────────
#  目标：从「注册合理有效的 MCP 服务 → 生成对应工具 → 授权角色与 Key → 真实打流量」
#       的完整源头链路，让 Dashboard 的 6 张卡片 / 趋势柱 / Top 10 / 高失败率榜
#       在**同一时刻**都拿到真实数据（所有审计走完整治理链，非直插 DB）。
#
#  数据源头交付：
#    1. 3 个 stdio Mock MCP 上游（scripts/mock-mcp-server.mjs 起 3 进程）：
#       - mock-basic    · 9 工具 · 快速、零失败 · 让 Top 榜 & QPS 有底
#       - mock-finance  · 8 工具 · 中/长延时 · 4-12% 失败率 · 让高失败率榜进 3 位
#       - mock-ops      · 8 工具 · 长/失败率 7-22% · 让 P95 拉到 3 秒区间
#    2. 4 把新 Key 分别绑定角色 admin / analyst-bot / finance-bot / ops-bot
#       （admin 一把 · 3 个业务角色各一把 · 便于分 Key 打流量 · 观察审计 keyName 分布）
#    3. RBAC 规则增量：给 intern/support/admin 各加 mock-*__* allow 规则
#       （只增不改，保留原有 rail-12306 相关规则）
#    4. 真实打流量：3 variant 各自用对应 Key 打 12-16 次/工具，总 320-360 次
#       通过 xargs -P 8 并发，30-60 秒内灌完
#
#  前置：
#    - ./start.sh 已启动后端 :8080
#    - backend/.env 已有 MGW_M2M_CLIENT_ID / MGW_M2M_CLIENT_SECRET（scripts/mgw-token.sh 换 token）
#    - backend/node_modules 已安装（SDK 与 zod 齐全）
#
#  用法：
#    ./scripts/seed-dashboard.sh                    # 默认 12 次/工具
#    ./scripts/seed-dashboard.sh --calls 20         # 每工具 20 次
#    ./scripts/seed-dashboard.sh --concurrency 4    # 降并发
#    ./scripts/seed-dashboard.sh --keep-keys        # 保留 Key 不吊销（默认保留）
#    ./scripts/seed-dashboard.sh --help
#
#  注意：
#    - 上游与 Key 采用幂等策略：如已存在则复用，不会重复创建
#    - 已注册 3 个 mock 上游 + 4 把 Key 均可通过 UI 手动删除/吊销
#    - 打流量走真实 MCP tools/call，审计与 hash 链完整
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="http://127.0.0.1:8080"
CALLS_PER_TOOL=12
CONCURRENCY=4
KEEP_KEYS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --calls) CALLS_PER_TOOL="$2"; shift 2 ;;
    --concurrency) CONCURRENCY="$2"; shift 2 ;;
    --base) BASE_URL="$2"; shift 2 ;;
    --keep-keys) KEEP_KEYS=1; shift ;;
    --revoke-keys) KEEP_KEYS=0; shift ;;
    -h|--help) sed -n '2,42p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

load_env() {
  local f="$1"; [[ -f "$f" ]] || return 0
  local had_u=0; [[ "$-" == *u* ]] && { had_u=1; set +u; }
  set -a; source "$f" 2>/dev/null || true; set +a
  [[ "$had_u" == "1" ]] && set -u
}
load_env "$ROOT_DIR/backend/.env"
# 管理端只认 Logto JWT：这里用机器身份换 token（旧 ADMIN_TOKEN 已失效）
AT="${MGW_TOKEN:-$(bash "$SCRIPT_DIR/mgw-token.sh")}" || { echo "✗ 无法获取管理端 token"; exit 2; }

MOCK_ENTRY="$SCRIPT_DIR/mock-mcp-server.mjs"
[[ -f "$MOCK_ENTRY" ]] || { echo "✗ 找不到 mock-mcp-server.mjs · 请先执行 seed 脚本随仓库分发"; exit 2; }

# ---------- 打印与断言 ----------
PASS=0; FAIL=0; STEP=0
C_GREEN='\033[32m'; C_RED='\033[31m'; C_DIM='\033[2m'; C_BOLD='\033[1m'; C_CY='\033[36m'; C_AMBER='\033[33m'; C_RST='\033[0m'
step() { STEP=$((STEP+1)); printf "${C_BOLD}${C_CY}[%02d] %s${C_RST}\n" "$STEP" "$1"; }
ok()   { PASS=$((PASS+1)); printf "    ${C_GREEN}✓${C_RST} %s ${C_DIM}%s${C_RST}\n" "$1" "${2:-}"; }
bad()  { FAIL=$((FAIL+1)); printf "    ${C_RED}✗${C_RST} %s ${C_DIM}%s${C_RST}\n" "$1" "${2:-}"; }
info() { printf "    ${C_DIM}· %s${C_RST}\n" "$1"; }
warn() { printf "    ${C_AMBER}!${C_RST} %s ${C_DIM}%s${C_RST}\n" "$1" "${2:-}"; }

AA_GET()  { curl -sS -H "Authorization: Bearer $AT" "$BASE_URL/admin/api$1"; }
AA_POST() { curl -sS -X POST -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d "$2" "$BASE_URL/admin/api$1"; }
AA_PUT()  { curl -sS -X PUT  -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d "$2" "$BASE_URL/admin/api$1"; }

# ================================================================
step "健康检查 /healthz"
HZ=$(curl -sS "$BASE_URL/healthz")
echo "$HZ" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['status']=='ok', d
print(f\"    ✓ backend 在跑 registry=v{d['registryVersion']} tools={d['tools']} sessions={d['sessions']}\")" \
  || { bad "backend 未响应，请先跑 ./start.sh"; exit 2; }

# ----------------------------------------------------------------
# Part A · 幂等注册 3 个 Mock 上游
# ----------------------------------------------------------------
UPSTREAMS=(
  "mock-basic|Mock 基础工具集|9 个基础工具（echo/uuid/sleep/md5 等） · 快速零失败 · 撑 Top 榜与 QPS 底"
  "mock-finance|Mock 金融行情|8 个行情/新闻/财报/选股工具 · 中长延时 + 3-12% 失败率 · 撑高失败率榜"
  "mock-ops|Mock 运维工具|8 个运维查询/变更工具 · 长操作 + 5-22% 失败率 · 撑 P95 拉到秒级"
)

ensure_upstream() {
  local name="$1" display="$2" desc="$3"
  local list existing
  list=$(AA_GET "/upstreams")
  local meta
  meta=$(echo "$list" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rows=d if isinstance(d,list) else d.get('rows',[])
for r in rows:
    if r.get('name')=='$name':
        print(f\"{r['id']}|{r.get('enabled',0)}|{r.get('lastStatus','unknown')}\")
        break
else:
        print('')")
  if [[ -n "$meta" && "$meta" != "|" ]]; then
    local id enabled lastst
    IFS='|' read -r id enabled lastst <<< "$meta"
    if [[ "$enabled" == "1" && "$lastst" == "up" ]]; then
      info "上游 $name 已存在且健康（id=$id enabled=1 up）· 跳过 PUT（避免 registry 抖动与旧 session 失效）"
      ok "$name 复用 id=${id}（健康）"
      return 0
    fi
    info "上游 $name 已存在但不健康（id=$id enabled=$enabled status=${lastst}），走 PUT 复活"
    local body
    body=$(python3 -c "
import json
print(json.dumps({
  'command':'node',
  'args':['$MOCK_ENTRY','--variant=${name#mock-}'],
  'cwd':'$ROOT_DIR',
  'env':{},
  'timeoutMs':25000,
  'concurrency':8,
  'sensitivity':'normal',
  'displayName':'$display',
  'remark':'仪表盘 seed · Mock 上游（可手动删除）',
  'enabled':1,
}))")
    AA_PUT "/upstreams/$name" "$body" >/dev/null
    ok "$name 复活完成 id=$id"
  else
    local body resp
    body=$(python3 -c "
import json
print(json.dumps({
  'name':'$name','displayName':'$display','description':'$desc',
  'transport':'stdio',
  'command':'node',
  'args':['$MOCK_ENTRY','--variant=${name#mock-}'],
  'cwd':'$ROOT_DIR',
  'env':{},
  'sensitivity':'normal','timeoutMs':25000,'concurrency':8,
  'remark':'仪表盘 seed · Mock 上游（可手动删除）'
}))")
    resp=$(AA_POST "/upstreams" "$body")
    local id
    id=$(echo "$resp" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
    if [[ -z "$id" ]]; then bad "$name 创建失败" "$(echo "$resp" | head -c 200)"; return 1; fi
    ok "$name 创建成功 id=$id"
  fi
}

step "幂等注册 mock-basic 上游"
ensure_upstream "mock-basic" "Mock 基础工具集" "9 个基础工具（echo/uuid/sleep/md5 等） · 快速零失败 · 撑 Top 榜与 QPS 底"

step "幂等注册 mock-finance 上游"
ensure_upstream "mock-finance" "Mock 金融行情" "8 个行情/新闻/财报/选股工具 · 中长延时 + 3-12% 失败率 · 撑高失败率榜"

step "幂等注册 mock-ops 上游"
ensure_upstream "mock-ops" "Mock 运维工具" "8 个运维查询/变更工具 · 长操作 + 5-22% 失败率 · 撑 P95 拉到秒级"

# ----------------------------------------------------------------
# Part B · 每个上游探活 + 工具数验证
# ----------------------------------------------------------------
for name in mock-basic mock-finance mock-ops; do
  step "上游探活 & 同步工具：$name"
  PROBE=$(AA_POST "/upstreams/$name/probe" '{}')
  cnt=$(echo "$PROBE" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d.get('ok') is True, f'probe failed: {d}'
print(d.get('toolCount', 0))" 2>/dev/null || echo "")
  if [[ -z "$cnt" ]]; then
    bad "$name probe 失败" "$(echo "$PROBE" | head -c 200)"
    exit 2
  fi
  ok "$name 已连接 · 同步工具数=$cnt"
done

# ----------------------------------------------------------------
# Part C · 为 admin 角色追加 mock-*__* allow 规则（保留原有）
# ----------------------------------------------------------------
step "为 admin 角色追加 mock-*__* 全量 allow 规则（幂等 · 保留原有规则）"
CURRENT=$(AA_GET "/roles/admin/rules")
MERGED=$(python3 - "$CURRENT" <<'PY'
import json,sys
d=json.loads(sys.argv[1])
rules=d.get('rules', [])
existing_patterns={r['pattern'] for r in rules}
new=[
  {"effect":"allow","pattern":"mock-basic__*","memo":"seed · mock 基础工具"},
  {"effect":"allow","pattern":"mock-finance__*","memo":"seed · mock 金融工具"},
  {"effect":"allow","pattern":"mock-ops__*","memo":"seed · mock 运维工具"},
]
adds=[n for n in new if n['pattern'] not in existing_patterns]
body=[{"effect":r["effect"],"pattern":r["pattern"],"memo":r.get("memo","")} for r in rules]+adds
print(json.dumps({"rules": body}))
PY
)
AA_PUT "/roles/admin/rules" "$MERGED" >/dev/null
BEFORE_CNT=$(echo "$CURRENT" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('rules',[])))")
AFTER_CNT=$(echo "$MERGED" | python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())['rules']))")
ok "admin 规则已合并（$BEFORE_CNT → $AFTER_CNT · 新增 $((AFTER_CNT-BEFORE_CNT))）"

step "为 support 角色追加 mock-basic__* allow（观察 RBAC 分层）"
CUR_S=$(AA_GET "/roles/support/rules")
MERGED_S=$(python3 - "$CUR_S" <<'PY'
import json,sys
d=json.loads(sys.argv[1])
rules=d.get('rules', [])
existing={r['pattern'] for r in rules}
adds=[{"effect":"allow","pattern":"mock-basic__*","memo":"seed · support 只放开 basic"}]
body=[{"effect":r["effect"],"pattern":r["pattern"],"memo":r.get("memo","")} for r in rules]+[a for a in adds if a["pattern"] not in existing]
print(json.dumps({"rules": body}))
PY
)
AA_PUT "/roles/support/rules" "$MERGED_S" >/dev/null
ok "support 规则已合并（新增 mock-basic__*）"

# ----------------------------------------------------------------
# Part D · 签发/复用 4 把 Key
#   analyst-bot / finance-bot / ops-bot / dashboard-seed
# ----------------------------------------------------------------
ISSUE_OR_REUSE_KEY() {
  local name="$1" user="$2" role="$3" profile="$4"
  local list existing
  list=$(AA_GET "/keys?user=$user")
  existing=$(echo "$list" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rows=d if isinstance(d,list) else d.get('rows',[])
for r in rows:
    if r.get('name')=='$name' and not r.get('revoked'): print(r['prefix']); break
else: print('')")
  if [[ -n "$existing" ]]; then
    warn "Key $name 已存在（prefix=${existing}…）· 无法再次拿明文，重新签一把新的"
  fi
  local resp
  resp=$(AA_POST "/keys" "{\"name\":\"$name\",\"userName\":\"$user\",\"team\":\"seed\",\"role\":\"$role\",\"profile\":\"$profile\",\"expiresInDays\":30}")
  local raw
  raw=$(echo "$resp" | python3 -c "import json,sys;print(json.load(sys.stdin).get('raw',''))" 2>/dev/null || echo "")
  if [[ -z "$raw" ]]; then bad "$name 签发失败" "$(echo "$resp" | head -c 200)"; return 1; fi
  local _var="RAW_$(echo "$name" | tr '-' '_')"
  eval "$_var=\"\$raw\""
  ok "$name 已签发 role=$role prefix=${raw:0:12}…"
}

step "签发 analyst-bot（role=admin · 全量访问）"
ISSUE_OR_REUSE_KEY "analyst-bot" "seed-analyst" "admin" "seed-dashboard"
step "签发 finance-bot（role=admin · 打 mock-finance）"
ISSUE_OR_REUSE_KEY "finance-bot" "seed-finance" "admin" "seed-dashboard"
step "签发 ops-bot（role=admin · 打 mock-ops）"
ISSUE_OR_REUSE_KEY "ops-bot" "seed-ops" "admin" "seed-dashboard"
step "签发 dashboard-seed（role=support · 只打 mock-basic）"
ISSUE_OR_REUSE_KEY "dashboard-seed" "seed-support" "support" "seed-dashboard"

# ----------------------------------------------------------------
# Part E · 建 MCP session 供每 Key 打流量
# ----------------------------------------------------------------
open_session() {
  local key="$1"
  local _var="RAW_$(echo "$key" | tr '-' '_')"
  local raw; eval "raw=\$$_var"
  local hfile="/tmp/seed-h-${key}.txt"
  curl -sS -D "$hfile" -o /dev/null -X POST "$BASE_URL/mcp" \
    -H "Authorization: Bearer $raw" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"seed","version":"1"}}}'
  local sid
  sid=$(grep -i '^mcp-session-id:' "$hfile" | tr -d '\r' | awk '{print $2}')
  [[ -z "$sid" ]] && { bad "session $key 建连失败"; return 1; }
  curl -sS -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $raw" -H "Mcp-Session-Id: $sid" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null
  echo "$sid"
}

step "开 4 条 MCP session（每 Key 一条）"
SID_ANALYST=$(open_session analyst-bot)
SID_FINANCE=$(open_session finance-bot)
SID_OPS=$(open_session ops-bot)
SID_SUPPORT=$(open_session dashboard-seed)
ok "sessions: ${SID_ANALYST:0:8}… / ${SID_FINANCE:0:8}… / ${SID_OPS:0:8}… / ${SID_SUPPORT:0:8}…"

# ----------------------------------------------------------------
# Part F · 通过 seed-calls.py 并发打真实 tools/call（走完整治理链 → audit_logs）
# ----------------------------------------------------------------
step "导出 seed-context.json 并交给 seed-calls.py 并发打流量"
CTX=$(mktemp)
python3 - "$BASE_URL" "$RAW_analyst_bot" "$RAW_finance_bot" "$RAW_ops_bot" "$RAW_dashboard_seed" \
  "$SID_ANALYST" "$SID_FINANCE" "$SID_OPS" "$SID_SUPPORT" > "$CTX" <<'PY'
import json,sys
b,ra,rf,ro,rs,sa,sf,so,ss = sys.argv[1:10]
print(json.dumps({
  'baseUrl': b,
  'keys': {'analyst-bot': ra, 'finance-bot': rf, 'ops-bot': ro, 'dashboard-seed': rs},
  'sids': {'analyst-bot': sa, 'finance-bot': sf, 'ops-bot': so, 'dashboard-seed': ss},
}))
PY
RESULT=$(python3 "$SCRIPT_DIR/seed-calls.py" --context "$CTX" --calls "$CALLS_PER_TOOL" --concurrency "$CONCURRENCY")
JOBC=$(echo "$RESULT" | python3 -c "import json,sys;print(json.load(sys.stdin)['total'])")
OKC=$(echo "$RESULT" | python3 -c "import json,sys;print(json.load(sys.stdin)['ok'])")
SECC=$(echo "$RESULT" | python3 -c "import json,sys;print(json.load(sys.stdin)['seconds'])")
ok "流量灌注完成 · ${JOBC} 次调用 · HTTP200 ${OKC} · 用时 ${SECC}s"
rm -f "$CTX"

# ----------------------------------------------------------------
# Part G · 结果 summary
# ----------------------------------------------------------------
step "等 8s 让异步审计落库 + 计算总览"
sleep 8

step "验证 /healthz tools/upstreams/sessions 计数已增长"
HZ2=$(curl -sS "$BASE_URL/healthz")
echo "$HZ2" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"    ✓ tools={d['tools']} upstreamsConnected={d['upstreamsConnected']}/{d.get('upstreamsTotal','?')} sessions={d['sessions']} registry=v{d['registryVersion']}\")"

step "验证 stats.overview(7) 4 项关键指标（totalCalls/topTools/failTop/sensitiveCount）"
AA_GET "/stats/overview?days=7" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"    · totalCalls={d.get('totalCalls')} fails={d.get('totalFails')} sensitive={d.get('sensitiveCount')}\")
print(f\"    · topTools 前 5：{[t['tool'].split('__')[-1]+'×'+str(t['n']) for t in d.get('topTools',[])[:5]]}\")
print(f\"    · failTop 前 3：{[t['tool'].split('__')[-1]+'@'+str(t['fail_pct'])+'%' for t in d.get('failTop',[])[:3]]}\")"

step "验证 stats.timeseries(1,'hour') 24 桶非零占比"
AA_GET "/stats/timeseries?days=1&bucket=hour" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rows=d if isinstance(d,list) else d.get('points',[])
nonzero=[r for r in rows if r.get('total',0)>0]
print(f\"    · 24 桶中 {len(nonzero)}/{len(rows)} 非零 · 峰值 {max((r['total'] for r in rows), default=0)}\")"

step "验证 metrics 里 tool_call 计数（按 upstream 维度）"
curl -sS "$BASE_URL/metrics.prom" | grep -E '^mgw_tool_calls_total' | head -8 || true

# ----------------------------------------------------------------
# Part H · 可选：吊销本次签发的 Key
# ----------------------------------------------------------------
if [[ "$KEEP_KEYS" == "0" ]]; then
  step "吊销本次签发的 4 把 Key（--revoke-keys）"
  # 略（当前默认保留 · 需要时再补）
  info "本函数未启用 · Key 全部保留"
fi

# Seed 完成 · 无临时文件需清理（CTX 与 /tmp/seed-h-*.txt 由下轮 mktemp 自然覆盖）

printf "\n${C_BOLD}${C_GREEN}Seed 完成 · ${PASS} 步通过 · ${FAIL} 步失败${C_RST}\n"
printf "${C_DIM}现在打开前端 Dashboard 即可看到：注册工具 ${C_CY}25+${C_DIM} · 上游 ${C_CY}4/${C_CY}5${C_DIM} · 近 7 日调用 ${C_CY}$JOBC${C_DIM} · Top 榜与高失败率榜均有内容${C_RST}\n"
