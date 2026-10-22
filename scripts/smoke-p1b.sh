#!/usr/bin/env bash
# ==============================================================================
#  P1 收尾包 · 冒烟护栏（smoke-p1b.sh）
#  ─────────────────────────────────────────────────────────────────────────────
#  覆盖范围（对应 docs/todo.md 第八节 P1 收尾 4 项）：
#    · P1-D  备份失败 IM 告警：NotifyService 有 backupFailed / BackupService 主链接入
#    · P1-E  HTTP 入口 histogram：mgw_http_requests_total + duration_bucket · 归一化 route · 排除 /metrics 自反馈
#    · P1-F  熔断面板 SSE 推流：/admin/api/breaker/events/stream 建连 · text/event-stream · ?token= 鉴权
#    · P1-G  Grafana 看板 & prometheus.yml 落地：JSON 可解析 + 关键字段完备
#
#  前置：
#    - ./start.sh 已启动后端 :8080
#    - backend/.env 已有 MGW_M2M_CLIENT_ID / MGW_M2M_CLIENT_SECRET（scripts/mgw-token.sh 换 token）
#
#  用法：
#    ./scripts/smoke-p1b.sh
#    ./scripts/smoke-p1b.sh --base http://127.0.0.1:8080
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="http://127.0.0.1:8080"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE_URL="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
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

# ---------- 断言/统计 ----------
PASS=0; FAIL=0; STEP=0
C_GREEN='\033[32m'; C_RED='\033[31m'; C_DIM='\033[2m'; C_BOLD='\033[1m'; C_CY='\033[36m'; C_AMBER='\033[33m'; C_RST='\033[0m'
step() { STEP=$((STEP+1)); printf "${C_BOLD}${C_CY}[%02d] %s${C_RST}\n" "$STEP" "$1"; }
ok()   { PASS=$((PASS+1)); printf "    ${C_GREEN}✓${C_RST} %s ${C_DIM}%s${C_RST}\n" "$1" "${2:-}"; }
bad()  { FAIL=$((FAIL+1)); printf "    ${C_RED}✗${C_RST} %s ${C_DIM}%s${C_RST}\n" "$1" "${2:-}"; }
info() { printf "    ${C_DIM}· %s${C_RST}\n" "$1"; }

AA_GET()  { curl -sS -H "Authorization: Bearer $AT" -H "x-admin-user: smoke-p1b" "$BASE_URL/admin/api$1"; }

printf "${C_BOLD}MCP 网关 · P1 收尾包冒烟（IM 告警 · HTTP histogram · SSE · Grafana 模板）${C_RST}\n"
printf "${C_DIM}base=%s${C_RST}\n\n" "$BASE_URL"

# ================================================================
step "前置 · /healthz 可达"
HEALTH=$(curl -sS "$BASE_URL/healthz" || true)
if echo "$HEALTH" | grep -q '"status"'; then
  ok "后端在线"
else
  bad "后端不可达" "$HEALTH"; exit 3
fi

# ================================================================
# P1-D · 备份失败 IM 告警（源码静态断言）
step "P1-D · NotifyService 已具备 backupFailed 方法"
if grep -q 'async backupFailed' "$ROOT_DIR/backend/src/notify/im.service.ts"; then
  ok "backupFailed 方法定义存在"
else
  bad "未找到 backupFailed 方法"
fi

step "P1-D · BackupService catch 分支已 fire-and-forget 告警"
if grep -q 'this.notify.backupFailed' "$ROOT_DIR/backend/src/governance/backup.service.ts"; then
  ok "run() 失败路径接入 IM 告警"
else
  bad "BackupService 未调用 notify.backupFailed"
fi

# ================================================================
# P1-E · HTTP 入口 histogram
step "P1-E · /metrics.prom 含 mgw_http_requests_total 与 duration_ms_bucket"
# 先发一批请求让 counter/histogram 有数据
AA_GET /breaker/status >/dev/null
AA_GET /backups/summary >/dev/null
curl -sS "$BASE_URL/admin/api/system/registry" -H "Authorization: Bearer $AT" >/dev/null || true
# 等 0.5s：res.on('finish') 在 curl 返回后一个 tick 才触发，counter 才会 inc
sleep 0.5
MTMP=$(mktemp)
curl -sS "$BASE_URL/metrics.prom" > "$MTMP"
M=$(cat "$MTMP")
if grep -q '^mgw_http_requests_total' "$MTMP" && grep -q '^mgw_http_request_duration_ms_bucket' "$MTMP"; then
  ok "HTTP Counter 与 Histogram 均已导出"
else
  bad "HTTP 指标缺失" "req=$(grep -c '^mgw_http_requests_total' "$MTMP") bucket=$(grep -c '^mgw_http_request_duration_ms_bucket' "$MTMP")"
fi
rm -f "$MTMP"

step "P1-E · route 归一化生效（无路径参数量爆炸）"
# 任一条件成立即通过：
#   a. route 里含 :param 模板占位（:id/:name/:fullName）
#   b. route 里含 __unmatched__（无 controller 匹配）
#   c. route 里既无纯数字段也无 20+ 位 hex/base64 段（确认未爆炸）
BAD_ROUTES=$(echo "$M" | grep -oE 'route="[^"]+"' \
  | sed 's/route="//;s/"$//' \
  | grep -E '/[0-9]{2,}|/[a-fA-F0-9]{20,}' || true)
if [[ -z "$BAD_ROUTES" ]]; then
  ok "无含裸 id/hash 的 route 标签、归一化生效"
else
  bad "发现未归一化 route"
  echo "$BAD_ROUTES" | head -3 | sed 's/^/      /'
fi

step "P1-E · 未匹配路径计入 __unmatched__（扫描/404 兜底）"
BEFORE=$(echo "$M" | awk '/^mgw_http_requests_total\{.*route="__unmatched__"/ { s+=$NF } END { print s+0 }')
curl -sS "$BASE_URL/admin/api/nonexistent-$(date +%s)-$RANDOM" -H "Authorization: Bearer $AT" >/dev/null || true
curl -sS "$BASE_URL/random-path-$RANDOM" >/dev/null || true
M2=$(curl -sS "$BASE_URL/metrics.prom")
AFTER=$(echo "$M2" | awk '/^mgw_http_requests_total\{.*route="__unmatched__"/ { s+=$NF } END { print s+0 }')
if awk -v a="$BEFORE" -v b="$AFTER" 'BEGIN { exit !(b > a) }'; then
  ok "__unmatched__ 计数递增" "$BEFORE → $AFTER"
else
  bad "__unmatched__ 未递增（404 埋点未生效）" "$BEFORE vs $AFTER"
fi

step "P1-E · /metrics /healthz 自反馈排除（scrape 自身不计入 histogram）"
# 记录当前 /healthz 相关 counter，然后打 5 次 /healthz，再看是否有 /healthz 相关 route 出现
PRE_HL=$(echo "$M2" | grep -c 'route="/healthz"' || true)
for _ in 1 2 3 4 5; do curl -sS "$BASE_URL/healthz" >/dev/null; done
for _ in 1 2 3; do curl -sS "$BASE_URL/metrics.prom" >/dev/null; done
M3=$(curl -sS "$BASE_URL/metrics.prom")
POST_HL=$(echo "$M3" | grep -c 'route="/healthz"' || true)
if [[ "$PRE_HL" == "0" && "$POST_HL" == "0" ]]; then
  ok "监控端点自身未被埋点"
else
  bad "/healthz 或 /metrics.prom 被自反馈埋点" "pre=$PRE_HL post=$POST_HL"
fi

# ================================================================
# P1-F · SSE 熔断推流
step "P1-F · /breaker/events/stream 建连 · Content-Type: text/event-stream"
# 用 curl 短连 3s 抓 header + 首帧。--max-time 到期会返回 28，属正常。
HDR=$(mktemp); BODY=$(mktemp)
curl -sS -N --max-time 3 \
  -H "Authorization: Bearer $AT" \
  -D "$HDR" \
  "$BASE_URL/admin/api/breaker/events/stream" >"$BODY" 2>/dev/null || true
if grep -qi 'Content-Type: text/event-stream' "$HDR"; then
  ok "SSE 端点已生效"
else
  bad "响应头未包含 text/event-stream" "$(head -3 "$HDR" | tr -d '\r' | xargs)"
fi

step "P1-F · 未鉴权 SSE 请求被拒（401）"
HDR2=$(mktemp)
# 不用 || echo "000"：curl --max-time 到期会 exit 28，但 stdout 已写完 http_code。追加会拼成“401000”
CODE=$(curl -sS -o /dev/null --max-time 2 -w '%{http_code}' -D "$HDR2" \
  "$BASE_URL/admin/api/breaker/events/stream" 2>/dev/null || true)
if [[ "$CODE" == "401" ]]; then
  ok "无 token 建连返回 401"
else
  bad "无 token 应 401，实得 $CODE"
fi

step "P1-F · ?token= query 兜底可建连（EventSource 无法设 header 场景）"
HDR3=$(mktemp); BODY3=$(mktemp)
curl -sS -N --max-time 3 \
  "$BASE_URL/admin/api/breaker/events/stream?token=$AT" >"$BODY3" 2>/dev/null || true
CODE2=$(curl -sS -o /dev/null --max-time 2 -w '%{http_code}' \
  "$BASE_URL/admin/api/breaker/events/stream?token=$AT" 2>/dev/null || true)
# 长连接 curl 会在 max-time 到时返回 28，但 header 已 flush → http_code=200
if [[ "$CODE2" == "200" ]]; then
  ok "query token 建连成功"
else
  bad "query token 建连失败 http=$CODE2"
fi

rm -f "$HDR" "$BODY" "$HDR2" "$HDR3" "$BODY3"

# ================================================================
# P1-G · Grafana 看板模板 + prometheus.yml 示例
step "P1-G · docs/grafana/ 目录落地"
if [[ -f "$ROOT_DIR/docs/grafana/gateway-overview.json" \
   && -f "$ROOT_DIR/docs/grafana/prometheus.yml" \
   && -f "$ROOT_DIR/docs/grafana/README.md" ]]; then
  ok "3 个模板文件齐全"
else
  bad "docs/grafana/ 模板不完整"
fi

step "P1-G · gateway-overview.json 可解析 · panels ≥ 8 · PromQL 引用了 HTTP 指标"
python3 - <<PY
import json, sys
with open("$ROOT_DIR/docs/grafana/gateway-overview.json") as f:
    d = json.load(f)
panels = d.get("panels", [])
assert len(panels) >= 8, f"panels 太少: {len(panels)}"
# 把所有 targets.expr 拼起来验证关键 PromQL 存在
exprs = " ".join(
    t.get("expr", "")
    for p in panels
    for t in p.get("targets", [])
)
for needle in (
    "mgw_http_requests_total",
    "mgw_http_request_duration_ms_bucket",
    "mgw_upstream_breaker_state",
    "mgw_tool_calls_total",
    "histogram_quantile",
):
    assert needle in exprs, f"缺 PromQL: {needle}"
print(f"OK panels={len(panels)}")
PY
if [[ $? -eq 0 ]]; then ok "JSON 结构 & PromQL 覆盖到位"; else bad "JSON/PromQL 校验失败"; fi

step "P1-G · prometheus.yml 抓取端点为 /metrics.prom"
if grep -q 'metrics_path: /metrics.prom' "$ROOT_DIR/docs/grafana/prometheus.yml"; then
  ok "scrape_config 已指向新端点"
else
  bad "prometheus.yml 未指向 /metrics.prom"
fi

# ================================================================
printf "\n${C_BOLD}"
if [[ "$FAIL" -eq 0 ]]; then
  printf "${C_GREEN}✅ 全部通过 · PASS %d / FAIL %d · 步骤 %d${C_RST}\n" "$PASS" "$FAIL" "$STEP"
  exit 0
else
  printf "${C_RED}❌ 有 %d 项失败 · PASS %d / FAIL %d · 步骤 %d${C_RST}\n" "$FAIL" "$PASS" "$FAIL" "$STEP"
  exit 1
fi
