#!/usr/bin/env bash
# ==============================================================================
#  国内开源 MCP 上游 + 仪表盘指标覆盖 · 深度冒烟脚本
#  ─────────────────────────────────────────────────────────────────────────────
#  目标：
#    1. 建立 12306-mcp（社区开源、无需 key、直连中国铁路公开数据）作为**国内上游**，
#       跑通「注册 → 治理 → MCP 通道 → 真实业务工具调用」的完整闭环，用真数据
#       证明网关不是玩具。
#    2. 覆盖前端仪表盘 (Dashboard.vue / Reports.vue) 所依赖的**全部指标**，一条
#       条断言 overview/timeseries/healthz/metrics 的字段完备性、类型正确性与
#       数值合理性，避免前端"看起来空"或"字段漂移"。
#
#  前置：
#    - ./start.sh 已启动后端 :8080
#    - backend/node_modules/12306-mcp 已安装：
#      cd backend && npm i --no-save --registry=https://registry.npmmirror.com 12306-mcp
#    - backend/.env 已有 MGW_M2M_CLIENT_ID / MGW_M2M_CLIENT_SECRET（scripts/mgw-token.sh 换 token）
#
#  用法：
#    ./scripts/smoke-domestic.sh              # 默认 3 日期后北京→上海 G 字头
#    ./scripts/smoke-domestic.sh --from 广州 --to 深圳 --days 5
#    ./scripts/smoke-domestic.sh --no-cleanup # 保留 rail-12306 上游
#    ./scripts/smoke-domestic.sh --help
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="http://127.0.0.1:8080"
UPSTREAM_NAME="rail-12306"
FROM_ST="北京"
TO_ST="上海"
DAYS_AHEAD=3
FLAGS="G"
LIMIT_NUM=3
CLEANUP=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM_ST="$2"; shift 2 ;;
    --to) TO_ST="$2"; shift 2 ;;
    --days) DAYS_AHEAD="$2"; shift 2 ;;
    --flags) FLAGS="$2"; shift 2 ;;
    --no-cleanup) CLEANUP=0; shift ;;
    --base) BASE_URL="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

# ---------- 加载 env ----------
load_env() {
  local f="$1"; [[ -f "$f" ]] || return 0
  local had_u=0; [[ "$-" == *u* ]] && { had_u=1; set +u; }
  set -a; source "$f" 2>/dev/null || true; set +a
  [[ "$had_u" == "1" ]] && set -u
}
load_env "$ROOT_DIR/backend/.env"
# 管理端只认 Logto JWT：这里用机器身份换 token（旧 ADMIN_TOKEN 已失效）
AT="${MGW_TOKEN:-$(bash "$SCRIPT_DIR/mgw-token.sh")}" || { echo "✗ 无法获取管理端 token"; exit 2; }
export AT   # 后续 python heredoc 需要读环境变量
BACKEND_DIR="$ROOT_DIR/backend"
RAIL_ENTRY="./node_modules/12306-mcp/build/index.js"
if [[ ! -f "$BACKEND_DIR/$RAIL_ENTRY" ]]; then
  echo "✗ 12306-mcp 未安装，先跑：cd backend && npm i --no-save --registry=https://registry.npmmirror.com 12306-mcp"
  exit 2
fi

# ---------- 断言/统计 ----------
PASS=0; FAIL=0; STEP=0
C_GREEN='\033[32m'; C_RED='\033[31m'; C_DIM='\033[2m'; C_BOLD='\033[1m'; C_CY='\033[36m'; C_AMBER='\033[33m'; C_RST='\033[0m'
step() { STEP=$((STEP+1)); printf "${C_BOLD}${C_CY}[%02d] %s${C_RST}\n" "$STEP" "$1"; }
ok()   { PASS=$((PASS+1)); printf "    ${C_GREEN}✓${C_RST} %s ${C_DIM}%s${C_RST}\n" "$1" "${2:-}"; }
bad()  { FAIL=$((FAIL+1)); printf "    ${C_RED}✗${C_RST} %s ${C_DIM}%s${C_RST}\n" "$1" "${2:-}"; }
info() { printf "    ${C_DIM}· %s${C_RST}\n" "$1"; }
warn() { printf "    ${C_AMBER}!${C_RST} %s ${C_DIM}%s${C_RST}\n" "$1" "${2:-}"; }

AA_GET()  { curl -sS -H "Authorization: Bearer $AT" "$BASE_URL/admin/api$1"; }
AA_POST() { curl -sS -X POST -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d "$2" "$BASE_URL/admin/api$1"; }

# ================================================================
#  Part A · 国内上游：12306-mcp 建立 & 治理 & 真实调用
# ================================================================
step "健康检查 /healthz"
HZ=$(curl -sS "$BASE_URL/healthz")
echo "$HZ" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['status']=='ok', d
print(f\"    ✓ backend 在跑 registry=v{d['registryVersion']} tools={d['tools']} sessions={d['sessions']}\")" || { bad "backend 未响应"; exit 2; }

step "幂等建立上游：${UPSTREAM_NAME}（如已存在则复用）"
LIST=$(AA_GET "/upstreams")
EXIST_ID=$(echo "$LIST" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in (d if isinstance(d,list) else []):
    if r.get('name')=='$UPSTREAM_NAME': print(r['id']); break
else: print('')")

if [[ -n "$EXIST_ID" ]]; then
  info "已存在 id=${EXIST_ID}，走 PUT 更新（重新连接并同步工具）"
  BODY=$(python3 - <<PY
import json
print(json.dumps({
  "command":"node","args":["$RAIL_ENTRY"],"cwd":"$BACKEND_DIR",
  "env":{},"timeoutMs":20000,"concurrency":4,"sensitivity":"normal",
  "displayName":"中国铁路12306","remark":"国内社区开源 · 无需 API Key",
  "enabled":1,
}))
PY
)
  curl -sS -X PUT -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d "$BODY" \
    "$BASE_URL/admin/api/upstreams/$UPSTREAM_NAME" > /dev/null
  UP_ID="$EXIST_ID"
  ok "上游复用 id=$UP_ID"
else
  BODY=$(python3 - <<PY
import json
print(json.dumps({
  "name":"$UPSTREAM_NAME","displayName":"中国铁路12306",
  "description":"社区开源 MCP Server（12306-mcp），无需 API Key 直连 12306 余票/经停站/车站码等公开数据。",
  "transport":"stdio","command":"node","args":["$RAIL_ENTRY"],"cwd":"$BACKEND_DIR",
  "env":{},"sensitivity":"normal","timeoutMs":20000,"concurrency":4,
  "remark":"国内社区开源 · 无需 API Key",
}))
PY
)
  RESP=$(AA_POST "/upstreams" "$BODY")
  UP_ID=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
  [[ -n "$UP_ID" ]] && ok "上游创建成功 id=$UP_ID" || { bad "创建失败" "$(echo "$RESP"|head -c 200)"; exit 2; }
fi

step "上游探活（不改状态，只连接 + 列工具）"
PROBE=$(AA_POST "/upstreams/$UPSTREAM_NAME/probe" '{}')
echo "$PROBE" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ok=d.get('ok'); tc=d.get('toolCount'); ms=d.get('ms')
assert ok is True, f'probe failed: {d}'
print(f\"    ✓ 连接成功 {ms}ms · 工具数 {tc}\")"

step "工具注册表校验（应含 8 个中文铁路工具）"
TOOLS=$(AA_GET "/tools?upstream=$UPSTREAM_NAME")
echo "$TOOLS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
names = sorted({t['fullName'] for t in d})
expect = {'get-tickets','get-interline-tickets','get-train-route-stations','get-current-date',
          'get-stations-code-in-city','get-station-code-of-citys','get-station-code-by-names','get-station-by-telecode'}
missing = {f'${UPSTREAM_NAME}__' + e for e in expect} - set(names)
print(f\"    · 共 {len(names)} 个：\" + ', '.join(n.split('__')[1] for n in names[:4]) + ' …')
if missing:
    raise SystemExit('缺失：' + str(missing))" && ok "全部关键工具已注册" || bad "工具集不完整"

step "权限矩阵（admin=allow / intern=0 / support=0）"
AA_GET "/permissions/matrix" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rail_cols = [c['fullName'] for c in d['columns'] if c['upstream']=='$UPSTREAM_NAME']
by_role = {r['role']: sum(1 for fn in rail_cols if r['cells'].get(fn)) for r in d['rows']}
print(f'    · $UPSTREAM_NAME 在矩阵中列数={len(rail_cols)} 各角色 allow 数={by_role}')
assert len(rail_cols) >= 8
assert by_role.get('admin',0) == len(rail_cols), 'admin 应 allow 全量'"

step "启用一致性（--no-cleanup 后可在 UI 看到「已启用」，非软删状态）"
AA_GET "/upstreams" | python3 -c "
import json,sys
d=json.load(sys.stdin)
row = next((r for r in d if r['name']=='$UPSTREAM_NAME'), None)
assert row is not None, '$UPSTREAM_NAME 不在列表里'
assert row.get('enabled') == 1, f\"期望 enabled=1，实际={row.get('enabled')}（PUT 未能重新启用，回归产品缺陷）\"
print(f\"    · enabled={row['enabled']}  lastStatus={row.get('lastStatus','?')}  {row.get('displayName','')}\")"
ok "上游启用位与 runtime 连接一致"

step "签发一次性 Key 用于真实调用（role=admin）"
KJ=$(AA_POST "/keys" '{"name":"rail-demo","userName":"rail-traveler","role":"admin","profile":"domestic-call"}')
RA=$(echo "$KJ" | python3 -c "import json,sys;print(json.load(sys.stdin)['raw'])")
KID=$(echo "$KJ" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
[[ -n "$RA" ]] && ok "Key 已签发 id=$KID prefix=${RA:0:12}…" || { bad "签发失败"; exit 2; }

# ---------- MCP 通道 ----------
step "MCP 通道 initialize（获取 session）"
curl -sS -D /tmp/h-dom.txt -o /dev/null -X POST "$BASE_URL/mcp" \
  -H "Authorization: Bearer $RA" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"rail","version":"1"}}}'
SID=$(grep -i '^mcp-session-id:' /tmp/h-dom.txt | tr -d '\r' | awk '{print $2}')
[[ -n "$SID" ]] && ok "session=${SID:0:12}…" || { bad "session 未创建"; exit 2; }
curl -sS -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $RA" -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null

# 通用 tools/call 助手：$1=tool $2=args-json  返回 result.content[0].text 或 error
MCP_CALL() {
  curl -sS -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $RA" -H "Mcp-Session-Id: $SID" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}

step "真实调用①：get-current-date（零参数）"
R=$(MCP_CALL "${UPSTREAM_NAME}__get-current-date" "{}")
DATE=$(echo "$R" | python3 -c "
import json,sys,re
raw=sys.stdin.read()
m=re.search(r'data:\s*(\{.+\})',raw) or re.search(r'^(\{.+\})',raw,re.M)
d=json.loads(m.group(1)) if m else {}
r=d.get('result',{})
assert not r.get('isError'), r
print(r['content'][0]['text'].strip())")
[[ ${#DATE} -eq 10 ]] && ok "上游返回日期 ${DATE}（Asia/Shanghai 时区）" || bad "日期格式异常" "$DATE"
QUERY_DATE=$(python3 -c "import datetime;d=datetime.date.fromisoformat('$DATE')+datetime.timedelta(days=$DAYS_AHEAD);print(d.isoformat())")
info "查询日期：${QUERY_DATE}（${DAYS_AHEAD} 天后）"

step "真实调用②：get-stations-code-in-city「${FROM_ST}」"
R=$(MCP_CALL "${UPSTREAM_NAME}__get-stations-code-in-city" "{\"city\":\"$FROM_ST\"}")
STATIONS=$(echo "$R" | python3 -c "
import json,sys,re
raw=sys.stdin.read()
m=re.search(r'data:\s*(\{.+\})',raw) or re.search(r'^(\{.+\})',raw,re.M)
d=json.loads(m.group(1)) if m else {}
r=d.get('result',{})
assert not r.get('isError'), r
text = r['content'][0]['text']
arr = json.loads(text) if text.startswith('[') else []
codes = [s['station_code'] for s in arr[:5]]
print(f'站点数={len(arr)} 前5 codes={codes}')")
[[ -n "$STATIONS" ]] && ok "上游返回车站码 · $STATIONS" || bad "车站查询失败"

step "真实调用③：get-tickets「${FROM_ST}」→「${TO_ST}」 ${QUERY_DATE} ${FLAGS} 字头"
R=$(MCP_CALL "${UPSTREAM_NAME}__get-tickets" "{\"date\":\"$QUERY_DATE\",\"fromStation\":\"$FROM_ST\",\"toStation\":\"$TO_ST\",\"trainFilterFlags\":\"$FLAGS\",\"limitedNum\":$LIMIT_NUM,\"format\":\"text\"}")
echo "$R" | python3 -c "
import json,sys,re
raw=sys.stdin.read()
m=re.search(r'data:\s*(\{.+\})',raw) or re.search(r'^(\{.+\})',raw,re.M)
d=json.loads(m.group(1)) if m else {}
r=d.get('result',{})
if r.get('isError'):
    print('    ✗ 上游 isError=True:', str(r)[:200]); raise SystemExit(2)
text = r['content'][0]['text']
lines = [l for l in text.split('\n') if l.strip()]
trains = [l for l in lines if re.match(r'^[GDKZTOFS]\d+\s',l)]
if not trains:
    print('    ! 未拿到车次（可能非营业时段或线路无 G 字头）'); print('    首行：', lines[0][:100] if lines else '(空)')
    raise SystemExit(3)
print(f'    ✓ 拿到 {len(trains)} 个车次：')
for t in trains[:3]: print('      ·', t)
sys.exit(0)
" && ok "真实 12306 数据回传成功" || { warn "调用返回空车次"; }

step "审计链验证（本次 3 次调用应全部落库）"
sleep 1.3
AA_GET "/audit?page=1&size=10&upstream=$UPSTREAM_NAME" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rows=d.get('rows') or []
toolcalls=[r for r in rows if r.get('event')=='tool_call']
# 后端 serialize 返回 camelCase：resultOk，不是 result_ok
ok_ct=sum(1 for r in toolcalls if r.get('resultOk')==1)
fail_ct=sum(1 for r in toolcalls if r.get('resultOk')==0)
print(f'    · tool_call 记录={len(toolcalls)} 成功={ok_ct} 失败={fail_ct}')
assert len(toolcalls)>=3, f'期望≥3 实际{len(toolcalls)}'
assert ok_ct>=3, f'成功≥3 实际{ok_ct}'"
ok "≥ 3 条 tool_call 已落库且 resultOk=1"

# ================================================================
#  Part B · 仪表盘/报表指标覆盖（Dashboard.vue & Reports.vue 所需全字段）
# ================================================================
step "指标①：/healthz 全字段完备"
AA_HZ=$(curl -sS "$BASE_URL/healthz")
echo "$AA_HZ" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for k in ['status','uptime_s','registryVersion','tools','sessions','upstreamsConnected','auditQueueDepth','ts']:
    assert k in d, f'missing {k}'
    assert d[k] is not None, f'{k}=None'
print(f\"    ✓ 8 字段齐 · uptime={d['uptime_s']}s tools={d['tools']} sessions={d['sessions']} upstreamsConnected={d['upstreamsConnected']} queueDepth={d['auditQueueDepth']}\")"
ok "字段完备性通过"

step "指标②：/metrics（Prometheus 风格 RSS 等）"
MET=$(curl -sS "$BASE_URL/metrics")
echo "$MET" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert 'rss_mb' in d, 'no rss_mb'
print(f\"    ✓ rss_mb={d['rss_mb']} heap_mb={d.get('heap_mb','?')} sessions={d.get('sessions','?')}\")" || warn "metrics 无 rss_mb"

step "指标③：/stats/overview 12 项业务指标齐"
AA_GET "/stats/overview?days=7" | python3 -c "
import json,sys
d=json.load(sys.stdin)
expect=['days','topTools','byUpstream','failTop','topUsers','sensitiveCount','totalCalls','totalFails','p95ByUpstream']
for k in expect:
    assert k in d, f'missing {k}'
assert isinstance(d['topTools'], list)
assert isinstance(d['byUpstream'], list)
assert isinstance(d['p95ByUpstream'], list)
# 结构完整性（每条子记录字段齐）
for t in d['topTools'][:1]:
    for f in ['tool','n','avg_ms','fail_pct']: assert f in t, f'topTools missing {f}'
for u in d['byUpstream'][:1]:
    for f in ['upstream','n','fail_pct']: assert f in u, f'byUpstream missing {f}'
for p in d['p95ByUpstream'][:1]:
    for f in ['upstream','count','p95_ms']: assert f in p, f'p95 missing {f}'
print(f\"    ✓ days={d['days']} calls={d['totalCalls']} fails={d['totalFails']} sens={d['sensitiveCount']} topTools={len(d['topTools'])} byUpstream={len(d['byUpstream'])} p95={len(d['p95ByUpstream'])} topUsers={len(d['topUsers'])} failTop={len(d['failTop'])}\")"
ok "所有指标可获取且结构稳定"

step "指标④：/stats/timeseries 补齐空桶（关键 bug 验证）"
for spec in "1 hour 22" "7 hour 160" "7 day 6" "30 day 28"; do
  set -- $spec; DAYS=$1; BUCKET=$2; MIN_BUCKETS=$3
  AA_GET "/stats/timeseries?days=$DAYS&bucket=$BUCKET" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert isinstance(d,list)
n=len(d)
zero=sum(1 for x in d if x['total']==0)
nonzero=n-zero
# 按不同区间验证最小桶数（hour×day → 22 桶为下限）
assert n >= $MIN_BUCKETS, f'days=$DAYS bucket=$BUCKET: 只 {n} 桶（应≥ ${MIN_BUCKETS}）'
assert all(set(x.keys())>={'ts','total','fails','fail_pct'} for x in d), '字段缺失'
assert all(x['total']>=0 and x['fails']>=0 for x in d), '负数'
print(f\"    ✓ days=$DAYS bucket=$BUCKET: 总 {n} 桶（非零 {nonzero} · 零值 {zero}）峰值 {max((x['total'] for x in d), default=0)}\")" || bad "days=$DAYS bucket=$BUCKET"
done
ok "timeseries 全场景补齐"

step "指标⑤：Dashboard.vue 6 张卡的等价断言"
python3 - <<'PY'
import json,urllib.request,os
# 前端 dashboard cards 用的字段：
#  - o.totalCalls o.totalFails
#  - o.sensitiveCount
#  - h.tools h.registryVersion
#  - h.sessions h.uptime_s
#  - h.upstreamsConnected / upstreams.length
#  - h.auditQueueDepth m.rss_mb
AT = os.environ.get('AT','')
BASE = 'http://127.0.0.1:8080'
def get(url, tok=None):
    req = urllib.request.Request(url)
    if tok: req.add_header('Authorization', f'Bearer {tok}')
    return json.loads(urllib.request.urlopen(req).read())
h = get(BASE+'/healthz')
m = get(BASE+'/metrics')
o = get(BASE+'/admin/api/stats/overview?days=7', AT)
ups = get(BASE+'/admin/api/upstreams', AT)
cards = [
    ('近 7 日调用', o['totalCalls'], f"失败 {o['totalFails']}"),
    ('敏感调用', o['sensitiveCount'], '已 PII 脱敏入库'),
    ('注册工具', h['tools'], f"注册表 v{h['registryVersion']}"),
    ('在线会话', h['sessions'], f"运行 {h['uptime_s']}s"),
    ('上游连接', f"{h['upstreamsConnected']}/{len(ups)}", '已连通 / 总数'),
    ('审计队列', h['auditQueueDepth'], f"RSS {m.get('rss_mb','?')} MB"),
]
print(f"    ✓ 6 张卡数值：")
for label,v,sub in cards:
    print(f"      · {label:<8} = {str(v):>6}   ({sub})")
PY
ok "所有仪表盘卡有值"

step "指标⑥：报表页 4 张顶部卡 + 5 大表格数据源齐"
AA_GET "/stats/overview?days=30" | python3 -c "
import json,sys
d=json.load(sys.stdin)
failRate = (100*d['totalFails']/d['totalCalls']) if d['totalCalls'] else 0
print(f\"    ✓ 顶部卡 · 总量 {d['totalCalls']} · 失败 {d['totalFails']}({failRate:.1f}%) · 敏感 {d['sensitiveCount']} · 活跃上游 {len(d['byUpstream'])}\")
print(f'    ✓ 表格数据源 · topTools {len(d[\"topTools\"])} 行 · topUsers {len(d[\"topUsers\"])} 行 · failTop {len(d[\"failTop\"])} 行 · p95 {len(d[\"p95ByUpstream\"])} 行')"

# ---------- 清理 ----------
if [[ "$CLEANUP" == "1" ]]; then
  step "清理（吊销 Key + 软删上游，保留审计可追溯）"
  AA_POST "/keys/$KID/revoke" '{"reason":"offboard"}' > /dev/null && ok "Key #$KID 已吊销"
  curl -sS -X DELETE -H "Authorization: Bearer $AT" "$BASE_URL/admin/api/upstreams/$UPSTREAM_NAME" > /dev/null \
    && ok "上游 $UPSTREAM_NAME 已下线（软删除）"
else
  info "--no-cleanup：上游 $UPSTREAM_NAME 与 Key #$KID 保留"
fi

# ---------- 汇总 ----------
printf "\n${C_BOLD}════════ 冒烟汇总 ════════${C_RST}\n"
printf "  ${C_GREEN}PASS %d${C_RST}  ${C_RED}FAIL %d${C_RST}  步骤 %d\n\n" "$PASS" "$FAIL" "$STEP"
[[ "$FAIL" -eq 0 ]] || exit 1
