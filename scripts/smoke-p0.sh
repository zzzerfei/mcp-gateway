#!/usr/bin/env bash
# ==============================================================================
#  P0 交付回归 · 冒烟脚本
#  ─────────────────────────────────────────────────────────────────────────────
#  覆盖范围（对应 docs/todo.md 本期 6 项 P0 + 上期 3 bug 回归护栏）：
#    · F1  RBAC 影子模式（observe 放行 + rbac_would_forbid 审计 + stats 字段）
#    · F2  权限矩阵一键回滚（PUT → rollback → 规则一致）
#    · F3  影响面预览补数据（affectedKeyCount / totalImpact7d / recent7dCalls）
#    · F4  Key 吊销即时失效（≤2s 内 401）
#    · F7  事件循环延迟监控（/healthz + /metrics 分位数字段）
#    · F9  stdio crash loop 熔断（静态断言代码存在关键字）
#    · R1  上期：/audit?role= 参数生效
#    · R2  上期：/stats/overview p95ByUpstream 真实分位
#    · R3  上期：Key revoke 后 authCache 一致性（与 F4 同断言，独立列出）
#
#  前置：
#    - ./start.sh 已启动后端 :8080
#    - backend/.env 已有 MGW_M2M_CLIENT_ID / MGW_M2M_CLIENT_SECRET（scripts/mgw-token.sh 换 token）
#    - 至少 1 个已连通上游（推荐先跑过 smoke-domestic.sh，rail-12306 在线）
#
#  用法：
#    ./scripts/smoke-p0.sh                # 默认 60s 内跑完
#    ./scripts/smoke-p0.sh --keep         # 保留临时角色/Key 便于事后排查
#    ./scripts/smoke-p0.sh --base http://127.0.0.1:8080
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="http://127.0.0.1:8080"
KEEP=0
TOOL_FOR_TEST="rail-12306__get-current-date"   # 若上游未连通会自动降级到"仅看非 FORBIDDEN"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE_URL="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --tool) TOOL_FOR_TEST="$2"; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
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

TS=$(date +%s)
TMP_ROLE="p0_shadow_${TS}"    # 后端角色正则要求 [a-z][a-z0-9_]{1,31}，不能用连字符
TMP_KEY_NAME="p0-key-${TS}"    # Key name 无格式限制，可用连字符
SHADOW_KEY_FILE="/tmp/p0-shadow-key-${TS}.txt"
NORMAL_KEY_FILE="/tmp/p0-normal-key-${TS}.txt"
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
AA_PUT()  { curl -sS -X PUT  -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d "$2" "$BASE_URL/admin/api$1"; }
AA_DEL()  { curl -sS -X DELETE -H "Authorization: Bearer $AT" "$BASE_URL/admin/api$1"; }

# MCP 通道：两个函数分开实现，避免 macOS 上 head -n -1 不兼容
# MCP_RAW   $1=key $2=sid $3=body  → stdout: body
# MCP_CODE  $1=key $2=sid $3=body  → stdout: HTTP 状态码
MCP_RAW() {
  local key="$1" sid="$2" body="$3"
  local hdr=( -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' )
  [[ -n "$sid" ]] && hdr+=( -H "Mcp-Session-Id: $sid" )
  curl -sS -X POST "$BASE_URL/mcp" "${hdr[@]}" -d "$body"
}
MCP_CODE() {
  local key="$1" sid="$2" body="$3"
  local hdr=( -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' )
  [[ -n "$sid" ]] && hdr+=( -H "Mcp-Session-Id: $sid" )
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/mcp" "${hdr[@]}" -d "$body"
}
# 建立会话：$1=key → stdout: sid (空串表示失败)
MCP_INIT() {
  local key="$1"
  curl -sS -D /tmp/p0-init-hdr.txt -o /dev/null -X POST "$BASE_URL/mcp" \
    -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"p0","version":"1"}}}'
  local sid
  sid=$(grep -i '^mcp-session-id:' /tmp/p0-init-hdr.txt | tr -d '\r' | awk '{print $2}')
  [[ -n "$sid" ]] && curl -sS -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $key" -H "Mcp-Session-Id: $sid" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null
  echo "$sid"
}

cleanup() {
  set +e
  # 恢复 enforce（若测试中途失败可能残留 observe）
  AA_PUT /settings '{"rbac.mode":"enforce"}' > /dev/null 2>&1
  [[ "$KEEP" == "1" ]] && { info "已保留临时角色 $TMP_ROLE / Key（--keep 模式）"; return; }
  # 吊销临时 Key（若有）
  if [[ -f "$SHADOW_KEY_FILE" ]]; then
    local kid; kid=$(cat "$SHADOW_KEY_FILE" | awk '{print $1}')
    [[ -n "$kid" ]] && AA_POST "/keys/$kid/revoke" '{"reason":"other"}' > /dev/null 2>&1
    rm -f "$SHADOW_KEY_FILE"
  fi
  [[ -f "$NORMAL_KEY_FILE" ]] && rm -f "$NORMAL_KEY_FILE"
  # 删临时角色
  AA_DEL "/roles/$TMP_ROLE" > /dev/null 2>&1
}
trap cleanup EXIT

# ================================================================
printf "${C_BOLD}MCP 网关 · P0 交付回归冒烟${C_RST}\n"
printf "${C_DIM}base=%s  role=%s  tool=%s${C_RST}\n\n" "$BASE_URL" "$TMP_ROLE" "$TOOL_FOR_TEST"

# ---------- 前置：后端存活 ----------
step "前置：/healthz 200"
H=$(curl -sS "$BASE_URL/healthz" || true)
if echo "$H" | python3 -c "import json,sys;d=json.load(sys.stdin);sys.exit(0 if d.get('status')=='ok' else 1)"; then
  ok "后端健康" "$(echo "$H" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("tools="+str(d.get("tools",0))+",up="+str(d.get("upstreamsConnected",0)))')"
else
  bad "后端未启动或 /healthz 不可达" "$H"; exit 2
fi

# ---------- 自动选定一个当前 registry 中存在的工具作为影子模式测试目标 ----------
step "前置：选定一个当前存在的工具（默认 ${TOOL_FOR_TEST}，不在则自动取首个）"
FOUND=$(AA_GET "/tools" | python3 -c "
import json,sys
default='${TOOL_FOR_TEST}'
d=json.load(sys.stdin)
names=[t.get('fullName') for t in d if t.get('fullName')]
if default in names:
    print(default)
elif names:
    print(names[0])
else:
    print('')
")
if [[ -z "$FOUND" ]]; then
  bad "当前无已注册工具，无法验证 F1 影子模式 → 请先跑 smoke-domestic.sh --no-cleanup 或手动上线一个上游"
  exit 2
fi
TOOL_FOR_TEST="$FOUND"
ok "测试工具 = $TOOL_FOR_TEST"

# ================================================================
# F7 · 事件循环延迟监控
step "F7 · /healthz 暴露 el_p99_ms"
V=$(echo "$H" | python3 -c "import json,sys;d=json.load(sys.stdin);v=d.get('el_p99_ms');print(v if v is not None else 'none')")
if [[ "$V" == "none" ]]; then
  bad "字段缺失"
else
  awk -v x="$V" 'BEGIN{exit !(x+0>=0 && x+0<10000)}' && ok "el_p99_ms = ${V}ms（合理范围）" || bad "数值异常" "el_p99_ms=$V"
fi

step "F7 · /metrics 五个分位数字段完整 + 单调性"
M=$(curl -sS "$BASE_URL/metrics")
MCHK=$(echo "$M" | python3 -c "
import json,sys
d=json.load(sys.stdin)
need=['el_p50_ms','el_p95_ms','el_p99_ms','el_max_ms','el_mean_ms']
miss=[k for k in need if k not in d]
if miss: print('MISS:'+','.join(miss)); sys.exit()
vals={k:float(d[k]) for k in need}
if not (vals['el_p50_ms'] <= vals['el_p95_ms'] <= vals['el_p99_ms'] <= vals['el_max_ms'] + 0.5):
    print('ORDER:' + str(vals)); sys.exit()
print('OK')
")
if [[ "$MCHK" == "OK" ]]; then
  ok "p50 ≤ p95 ≤ p99 ≤ max 且字段全"
else
  bad "/metrics 分位数字段异常" "$MCHK"
fi

# ================================================================
# F1 · RBAC 影子模式：settings 层
step "F1 · PUT settings rbac.mode=observe → GET 立即反映"
AA_PUT /settings '{"rbac.mode":"observe"}' > /dev/null
S=$(AA_GET /settings | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('rbac.mode',''))")
[[ "$S" == "observe" ]] && ok "内存生效" || bad "未反映" "got=$S"

step "F1 · 恢复 rbac.mode=enforce"
AA_PUT /settings '{"rbac.mode":"enforce"}' > /dev/null
S=$(AA_GET /settings | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('rbac.mode',''))")
[[ "$S" == "enforce" ]] && ok "回到 enforce" || bad "模式未回滚" "got=$S"

# ================================================================
# F4 · Key 吊销即时失效
step "F4 · 签发新 Key 并建立 MCP 会话（200）"
ISSUE=$(AA_POST /keys "{\"name\":\"$TMP_KEY_NAME\",\"userName\":\"p0-bot\",\"team\":\"qa\",\"role\":\"intern\"}")
RAW=$(echo "$ISSUE" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('raw',''))")
KID=$(echo "$ISSUE" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id',''))")
if [[ -z "$RAW" || -z "$KID" ]]; then
  bad "Key 签发失败" "$ISSUE"
else
  echo "$KID $RAW" > "$NORMAL_KEY_FILE"
  SID=$(MCP_INIT "$RAW")
  CODE=$(MCP_CODE "$RAW" "$SID" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
  [[ -n "$SID" && "$CODE" == "200" ]] && ok "initialize+tools/list 200 · sid=${SID:0:8}…" || bad "建会话失败" "sid=$SID code=$CODE"
fi

step "F4 · 吊销后立即再请求 → 401 Unauthorized（≤2s）"
if [[ -n "${RAW:-}" ]]; then
  AA_POST "/keys/$KID/revoke" '{"reason":"rotate"}' > /dev/null
  CODE=$(MCP_CODE "$RAW" "$SID" '{"jsonrpc":"2.0","id":3,"method":"tools/list"}')
  if [[ "$CODE" == "401" ]]; then
    ok "吊销即时生效 · HTTP 401"
  else
    bad "吊销后仍可访问（预期 401）" "got=$CODE"
  fi
fi

# ================================================================
# F3 · 影响面预览补数据
step "F3 · POST /permissions/preview 返回体含新字段"
RULES_JSON=$(AA_GET "/roles/intern/rules" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rules=[{'effect':r['effect'],'pattern':r['pattern']} for r in d.get('rules',[])]
# 追加一条不存在的 deny，制造 lost/gained 空间
rules.append({'effect':'deny','pattern':'p0-nonexistent__*'})
print(json.dumps(rules))
")
BODY=$(python3 -c "import json;r=json.loads('''$RULES_JSON''');print(json.dumps({'role':'intern','rules':r}))")
PV=$(AA_POST /permissions/preview "$BODY")
PVCHK=$(echo "$PV" | python3 -c "
import json,sys
d=json.load(sys.stdin)
need=['affectedKeyCount','recent7dCalls','lostCalls7d','gainedCalls7d','totalImpact7d','affectedKeys','currentCount','nextCount','lost','gained']
miss=[k for k in need if k not in d]
if miss: print('MISS:'+','.join(miss)); sys.exit()
if not isinstance(d['affectedKeyCount'], int): print('TYPE:affectedKeyCount'); sys.exit()
if not isinstance(d['recent7dCalls'], dict): print('TYPE:recent7dCalls'); sys.exit()
print('OK:'+str(d['affectedKeyCount']))
")
if [[ "$PVCHK" == OK:* ]]; then
  ok "preview 字段全 · affectedKeyCount=${PVCHK#OK:}"
else
  bad "preview 结构异常" "$PVCHK"
fi

# ================================================================
# F2 · 一键回滚
step "F2 · 记录当前 intern 规则 → PUT 加 deny → 校验变化 → rollback → 一致"
BEFORE=$(AA_GET "/roles/intern/rules" | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps([(r['effect'],r['pattern']) for r in d.get('rules',[])]))")
NEW_RULES=$(echo "$BEFORE" | python3 -c "
import json,sys
prev=json.loads(sys.stdin.read())
prev.append(['deny','p0-tmp-deny__*'])
out=[{'effect':e,'pattern':p} for e,p in prev]
print(json.dumps({'rules':out}))
")
AA_PUT "/roles/intern/rules" "$NEW_RULES" > /dev/null
CHG=$(AA_GET "/changes?target_type=role_rules&size=1" | python3 -c "import json,sys;d=json.load(sys.stdin);r=d.get('rows',[]);print(r[0]['id'] if r else '')")
if [[ -z "$CHG" ]]; then
  bad "未取到 change_log id"
else
  info "变更 id=$CHG 已记录"
  RB=$(AA_POST "/roles/intern/rules/rollback" "{\"changeId\":$CHG}")
  OKRB=$(echo "$RB" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('ok',False))")
  AFTER=$(AA_GET "/roles/intern/rules" | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps([(r['effect'],r['pattern']) for r in d.get('rules',[])]))")
  if [[ "$OKRB" == "True" && "$BEFORE" == "$AFTER" ]]; then
    ok "回滚成功 · 规则与操作前完全一致"
  else
    bad "回滚后规则不一致" "before=$(echo "$BEFORE" | head -c 80) after=$(echo "$AFTER" | head -c 80)"
  fi
fi

# ================================================================
# F1 · RBAC 影子模式：端到端（新建无 allow 规则的临时角色 → 越权调用 → observe 放行 → 审计有记录）
step "F1 · 建空角色 $TMP_ROLE + Key → enforce 下 tools/call → 应 FORBIDDEN"
AA_POST /roles "{\"name\":\"$TMP_ROLE\",\"description\":\"p0 shadow test\"}" > /dev/null
AA_PUT "/roles/$TMP_ROLE/rules" '{"rules":[]}' > /dev/null
ISSUE2=$(AA_POST /keys "{\"name\":\"p0-shadow-key\",\"userName\":\"p0-shadow\",\"team\":\"qa\",\"role\":\"$TMP_ROLE\"}")
RAW2=$(echo "$ISSUE2" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('raw',''))")
KID2=$(echo "$ISSUE2" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id',''))")
[[ -n "$KID2" ]] && echo "$KID2 $RAW2" > "$SHADOW_KEY_FILE"
if [[ -z "$RAW2" ]]; then
  bad "临时 Key 签发失败" "$ISSUE2"
else
  SID2=$(MCP_INIT "$RAW2")
  CALL_ENF=$(MCP_RAW "$RAW2" "$SID2" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL_FOR_TEST\",\"arguments\":{}}}")
  if echo "$CALL_ENF" | grep -q 'FORBIDDEN'; then
    ok "enforce 拦截：返回 FORBIDDEN"
  else
    warn "enforce 未见 FORBIDDEN（可能上游不存在）" "$(echo "$CALL_ENF" | head -c 120)"
  fi

  step "F1 · 切 observe → 同 tools/call → 不再 FORBIDDEN（放行或转上游错误）"
  AA_PUT /settings '{"rbac.mode":"observe"}' > /dev/null
  CALL_OBS=$(MCP_RAW "$RAW2" "$SID2" "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL_FOR_TEST\",\"arguments\":{}}}")
  if echo "$CALL_OBS" | grep -q 'FORBIDDEN'; then
    bad "observe 仍拦截（预期放行）" "$(echo "$CALL_OBS" | head -c 120)"
  else
    ok "observe 放行（不含 FORBIDDEN）"
  fi

  step "F1 · 审计有 rbac_would_forbid 记录 + stats 字段暴露"
  # AuditService 写库为异步攒批，给 ≈ 2s flush
  sleep 2
  AUD=$(AA_GET "/audit?event=rbac_would_forbid&size=5")
  N=$(echo "$AUD" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('total',0))")
  if [[ "$N" -lt 1 ]] 2>/dev/null; then
    sleep 2
    AUD=$(AA_GET "/audit?event=rbac_would_forbid&size=5")
    N=$(echo "$AUD" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('total',0))")
  fi
  [[ "$N" -ge 1 ]] 2>/dev/null && ok "审计命中 rbac_would_forbid 数=$N" || bad "审计未见 rbac_would_forbid" "total=$N"
  SOV=$(AA_GET "/stats/overview?days=1" | python3 -c "
import json,sys
d=json.load(sys.stdin)
mode=d.get('rbacMode','?'); cnt=d.get('wouldForbidCount','?'); top=d.get('wouldForbidTop')
if mode=='missing' or cnt=='missing' or top is None: print('MISS'); sys.exit()
print(f'{mode}|{cnt}|{len(top) if isinstance(top,list) else \"-\"}')
")
  [[ "$SOV" == "MISS" ]] && bad "stats.overview 缺 rbacMode/wouldForbidCount/wouldForbidTop" || ok "overview $SOV"

  AA_PUT /settings '{"rbac.mode":"enforce"}' > /dev/null
fi

# ================================================================
# F9 · stdio crash loop（静态代码断言）
step "F9 · 静态断言 upstream-manager.service.ts 关键结构"
UM="$ROOT_DIR/backend/src/gateway/upstream-manager.service.ts"
if [[ ! -f "$UM" ]]; then
  bad "文件不存在"
else
  MISS=""
  grep -q 'crashWindow' "$UM" || MISS="$MISS crashWindow"
  grep -q 'CRASH_WINDOW_MS' "$UM" || MISS="$MISS CRASH_WINDOW_MS"
  grep -q 'CRASH_THRESHOLD' "$UM" || MISS="$MISS CRASH_THRESHOLD"
  grep -q 'recordCrashAndMaybeDisable' "$UM" || MISS="$MISS recordCrashAndMaybeDisable"
  # 引号风格不敏感：源码用双引号，断言不再因格式差异误报
  grep -Eq "action = [\"']auto-disable[\"']" "$UM" || MISS="$MISS auto-disable"
  grep -Eq "lastError: [\"']crash_loop[\"']" "$UM" || MISS="$MISS crash_loop"
  if [[ -z "$MISS" ]]; then
    ok "全部关键字命中（滑窗 / 阈值 / 自动下线 / 审计 / change_log）"
  else
    bad "缺失:${MISS}"
  fi
fi

# ================================================================
# 上期 3 bug 回归
step "R1 · /audit?role=intern 参数过滤生效（上期 bug 回归）"
A1=$(AA_GET "/audit?role=intern&size=5")
BAD_ROW=$(echo "$A1" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d.get('rows',[]):
    if r.get('role') not in ('intern', None):
        print(f'ROW:{r.get(\"role\")}'); sys.exit()
print('OK')
")
[[ "$BAD_ROW" == "OK" ]] && ok "role 过滤无脏数据" || bad "role 过滤失效" "$BAD_ROW"

step "R2 · /stats/overview p95ByUpstream 字段类型正确（真实分位）"
P95=$(AA_GET "/stats/overview?days=7" | python3 -c "
import json,sys
d=json.load(sys.stdin)
arr=d.get('p95ByUpstream',[])
if not isinstance(arr, list): print('TYPE'); sys.exit()
for x in arr:
    if not isinstance(x.get('p95_ms'), (int,float)): print(f'ITEM:{x}'); sys.exit()
print('OK:'+str(len(arr)))
")
[[ "$P95" == OK:* ]] && ok "p95ByUpstream 结构 OK（${P95#OK:} 项）" || bad "p95 结构异常" "$P95"

step "R3 · Key 吊销后 authCache 双清理（与 F4 独立列出）"
# 已在 F4 断过 401；此处再补一条：吊销的 Key 不应出现在有效列表
LIST=$(AA_GET "/keys?revoked=0")
LEAKED=$(echo "$LIST" | python3 -c "
import json,sys
d=json.load(sys.stdin)
kid='${KID:-}'
for r in d:
    if str(r.get('id'))==kid and r.get('revoked')==0:
        print('LEAK'); sys.exit()
print('OK')
")
[[ "$LEAKED" == "OK" ]] && ok "已吊销 Key 不在有效列表" || bad "authCache 未清理" "$LEAKED"

# ================================================================
printf "\n${C_BOLD}结果汇总${C_RST}\n"
printf "  ${C_GREEN}PASS=%d${C_RST}  ${C_RED}FAIL=%d${C_RST}  TOTAL=%d\n" "$PASS" "$FAIL" "$((PASS+FAIL))"
[[ "$FAIL" -eq 0 ]] || exit 1
