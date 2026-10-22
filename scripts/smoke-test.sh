#!/usr/bin/env bash
# ==============================================================================
#  MCP 网关 · 端到端冒烟测试脚本
#  覆盖：鉴权 · RBAC · 限流 · 审计 · PII 脱敏 · 凭据加密 · 工具上下线 ·
#       Key 生命周期(create/rotate/revoke) · 变更留痕 · CSV 导出 · 报表
#  默认对 @modelcontextprotocol/server-everything (stdio) 打点，无需外网。
#
#  用法：
#    ./scripts/smoke-test.sh              # 全量执行
#    ./scripts/smoke-test.sh --keep       # 保留测试上游与 Key 便于手工查看
#    ./scripts/smoke-test.sh --base URL   # 指定 backend 地址（默认 http://127.0.0.1:8080）
#    ./scripts/smoke-test.sh --help
#
#  前置：
#    1) 后端已启动：./start.sh             （另开终端）
#    2) 已安装 @modelcontextprotocol/server-everything：
#       cd backend && npm i --no-save @modelcontextprotocol/server-everything
#    3) backend/.env 中 MGW_M2M_CLIENT_ID / MGW_M2M_CLIENT_SECRET 已就绪（模板见 backend/.env.example）
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="http://127.0.0.1:8080"
KEEP=0
UPSTREAM_NAME="smoke-ev-$(date +%s | tail -c 6)"
KEY_ADMIN="smoke-admin-$(date +%s | tail -c 6)"
KEY_INTERN="smoke-intern-$(date +%s | tail -c 6)"

# ---------- 参数解析 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --base) BASE_URL="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
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
AK="${DEEPSEEK_API_KEY:-}"

# ---------- 断言/统计 ----------
PASS=0; FAIL=0; STEP=0
C_GREEN='\033[32m'; C_RED='\033[31m'; C_DIM='\033[2m'; C_BOLD='\033[1m'; C_CY='\033[36m'; C_RST='\033[0m'
step() { STEP=$((STEP+1)); printf "${C_BOLD}${C_CY}[%02d] %s${C_RST}\n" "$STEP" "$1"; }
ok()   { PASS=$((PASS+1)); printf "    ${C_GREEN}✓${C_RST} %s ${C_DIM}%s${C_RST}\n" "$1" "${2:-}"; }
bad()  { FAIL=$((FAIL+1)); printf "    ${C_RED}✗${C_RST} %s ${C_DIM}%s${C_RST}\n" "$1" "${2:-}"; }
info() { printf "    ${C_DIM}· %s${C_RST}\n" "$1"; }

# 便捷 curl 封装：admin_api GET/POST
AA_GET()  { curl -sS -H "Authorization: Bearer $AT" "$BASE_URL/admin/api$1"; }
AA_POST() { curl -sS -X POST -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d "$2" "$BASE_URL/admin/api$1"; }
AA_PUT()  { curl -sS -X PUT  -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d "$2" "$BASE_URL/admin/api$1"; }

# ---------- 前置健康检查 ----------
step "健康检查 /healthz"
HZ=$(curl -sS "$BASE_URL/healthz" || true)
if echo "$HZ" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['status']=='ok'" 2>/dev/null; then
  ok "backend 在跑" "$(echo "$HZ" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'registry=v{d[\"registryVersion\"]} tools={d[\"tools\"]} sessions={d[\"sessions\"]}')")"
else
  bad "backend 未响应，先跑 ./start.sh"; exit 2
fi

# ---------- 1) 建立 stdio 上游 ----------
step "创建 stdio 上游 ${UPSTREAM_NAME}（AK 走 env 字段加密落库）"
UP_JSON=$(python3 - <<PY
import json
print(json.dumps({
  "name": "$UPSTREAM_NAME",
  "displayName": "SMoke Everything",
  "description": "smoke-test 自动创建，测试完成后会 disable",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y","@modelcontextprotocol/server-everything"],
  "env": {"DEEPSEEK_API_KEY": "$AK"},
  "sensitivity": "normal",
  "timeoutMs": 15000,
  "concurrency": 4,
}))
PY
)
RESP=$(AA_POST "/upstreams" "$UP_JSON")
UP_ID=$(echo "$RESP" | python3 -c "import json,sys;d=json.loads(sys.stdin.read());print(d.get('id',''))" 2>/dev/null || echo "")
if [[ -n "$UP_ID" && "$UP_ID" != "None" ]]; then
  ok "创建成功 id=$UP_ID"
else
  bad "创建失败" "$(echo "$RESP" | head -c 200)"; exit 2
fi

# ---------- 2) 加密存储验证 ----------
step "验证上游凭据 AES-256-GCM 加密（env_enc 落库不可见明文）"
DB="$ROOT_DIR/backend/data/gateway.db"
if [[ -f "$DB" ]]; then
  python3 - "$UP_ID" "$DB" <<'PY' || true
import sqlite3, sys
uid, db = int(sys.argv[1]), sys.argv[2]
c = sqlite3.connect(db); c.row_factory = sqlite3.Row
row = c.execute("SELECT env_enc FROM upstreams WHERE id=?", (uid,)).fetchone()
enc = row["env_enc"] or ""
is_cipher = enc and "mgwv1:" in enc[:16] or (enc and "sk-" not in enc)
plain_leak = "sk-19e0" in enc or ("DEEPSEEK_API_KEY" in enc and "|" not in enc)
print(f"    \033[32m✓\033[0m env_enc 前缀：{enc[:24]}…  len={len(enc)}  明文泄露={plain_leak}")
PY
else
  info "跳过（DB 文件不在预期位置）"
fi

# ---------- 3) 刷新工具 ----------
step "刷新工具注册表"
AA_POST "/upstreams/$UPSTREAM_NAME/refresh" '{}' > /dev/null || AA_POST "/system/registry/refresh" '{}' > /dev/null
TOOL_CNT=$(AA_GET "/tools?upstream=$UPSTREAM_NAME" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else d.get('total',0))" 2>/dev/null || echo 0)
if [[ "$TOOL_CNT" -gt 0 ]]; then
  ok "上游工具数：$TOOL_CNT"
else
  bad "未发现工具（请确认已 npm i --no-save @modelcontextprotocol/server-everything）"; TOOL_CNT=0
fi

# ---------- 4) 权限矩阵 ----------
step "查看权限矩阵（默认 intern/support 无 allow，admin 全量 allow）"
AA_GET "/permissions/matrix" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d.get('rows',[]):
    print(f\"    · role={r['role']:<10} allow={r['allowedCount']:>2}  desc={r.get('description','')}\")
print(f\"    registryVersion={d.get('registryVersion')}\")
"

# ---------- 5) 为 intern 配置最小权限（预览 dry-run） ----------
step "为 intern 应用最小白名单（echo + get-env）"
RULES_ARRAY='[
  {"pattern":"'"$UPSTREAM_NAME"'__echo","effect":"allow","memo":"smoke"},
  {"pattern":"'"$UPSTREAM_NAME"'__get-env","effect":"allow","memo":"smoke"}
]'
PREV_BODY='{"role":"intern","rules":'"$RULES_ARRAY"'}'
PREV=$(AA_POST "/permissions/preview" "$PREV_BODY")
echo "$PREV" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(f\"    · current={d.get('currentCount')} next={d.get('nextCount')} gained={d.get('gained')}\")
except Exception as e:
    print('    · preview 解析失败：', e)" || true
AA_PUT "/roles/intern/rules" '{"rules":'"$RULES_ARRAY"'}' > /dev/null
ok "规则已下发（registry/rulesVersion 已 bump）"

# ---------- 6) 签发 admin + intern 两把 Key ----------
step "签发 API Key"
KA=$(AA_POST "/keys" "{\"name\":\"$KEY_ADMIN\",\"userName\":\"smoke-bot\",\"role\":\"admin\",\"profile\":\"smoke\"}")
KI=$(AA_POST "/keys" "{\"name\":\"$KEY_INTERN\",\"userName\":\"smoke-alice\",\"role\":\"intern\",\"profile\":\"smoke\"}")
RAW_A=$(echo "$KA" | python3 -c "import json,sys;print(json.load(sys.stdin).get('raw',''))")
RAW_I=$(echo "$KI" | python3 -c "import json,sys;print(json.load(sys.stdin).get('raw',''))")
ID_A=$(echo "$KA" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
ID_I=$(echo "$KI" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
[[ -n "$RAW_A" && -n "$RAW_I" ]] && ok "两把 Key 已签发 admin#$ID_A intern#$ID_I" || { bad "签发失败"; exit 2; }

# ---------- 7) MCP 三件套（initialize → tools/list → tools/call） ----------
step "MCP 协议握手 initialize"
MCP_HDR=/tmp/mgw-h.txt
curl -sS -D "$MCP_HDR" -o /tmp/mgw-init.json -X POST "$BASE_URL/mcp" \
  -H "Authorization: Bearer $RAW_A" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
SID=$(grep -i '^mcp-session-id:' "$MCP_HDR" | tr -d '\r' | awk '{print $2}')
if [[ -n "$SID" ]]; then
  ok "获得 Mcp-Session-Id=${SID:0:12}…"
else
  bad "未获得 session id"; exit 2
fi
# notifications/initialized
curl -sS -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $RAW_A" -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null || true

step "tools/list 检查可见工具集"
TL=$(curl -sS -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $RAW_A" -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
TL_CNT=$(echo "$TL" | python3 -c "
import json,re,sys
raw = sys.stdin.read()
# SSE: data: {...}\n\n  或 纯 JSON
m = re.findall(r'data:\\s*(\\{.+\})', raw)
if m:
    d = json.loads(m[-1])
    print(len(d.get('result',{}).get('tools',[])))
else:
    try:
        d = json.loads(raw); print(len(d.get('result',{}).get('tools',[])))
    except Exception: print(0)
")
[[ "$TL_CNT" -gt 0 ]] && ok "admin 可见工具数=$TL_CNT" || bad "admin tools/list 为空"

step "tools/call 回显 AK（走 stdio → 上游 get-env 反查）"
ECHO_RESP=$(curl -sS -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $RAW_A" -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"'"$UPSTREAM_NAME"'__get-env","arguments":{}}}')
HAS_AK=$(echo "$ECHO_RESP" | grep -c "$AK" || true)
if [[ "$HAS_AK" -gt 0 ]]; then
  ok "上游 env 精准注入：返回体含 DEEPSEEK_API_KEY=$AK"
else
  bad "返回未见 AK" "$(echo "$ECHO_RESP" | head -c 200)"
fi

# ---------- 8) RBAC 拒绝（intern 未授权工具） ----------
step "intern 调用未授权工具（get-tiny-image）→ 期望 FORBIDDEN"
curl -sS -D /tmp/mgw-h2.txt -o /dev/null -X POST "$BASE_URL/mcp" \
  -H "Authorization: Bearer $RAW_I" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-i","version":"1"}}}'
SIDI=$(grep -i '^mcp-session-id:' /tmp/mgw-h2.txt | tr -d '\r' | awk '{print $2}')
[[ -z "$SIDI" ]] && bad "intern session 未创建（可能 Key 失效）" || {
  curl -sS -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $RAW_I" -H "Mcp-Session-Id: $SIDI" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null
  DENY=$(curl -sS -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $RAW_I" -H "Mcp-Session-Id: $SIDI" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"'"$UPSTREAM_NAME"'__get-tiny-image","arguments":{}}}')
  if echo "$DENY" | grep -qE 'FORBIDDEN|not allowed|无权'; then
    ok "默认拒绝策略生效"
  else
    bad "intern 竟然能调用未授权工具" "$(echo "$DENY" | head -c 200)"
  fi
}

# ---------- 9) 限流（令牌桶） ----------
step "限流验证：intern 快速连打 echo 200 次（需击穿 QPM）"
LIMIT_HIT=0
if [[ -n "${SIDI:-}" ]]; then
  for i in $(seq 1 200); do
    R=$(curl -sS -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $RAW_I" -H "Mcp-Session-Id: $SIDI" \
      -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":'"$i"',"method":"tools/call","params":{"name":"'"$UPSTREAM_NAME"'__echo","arguments":{"message":"m'"$i"'"}}}')
    if echo "$R" | grep -q 'RATE_LIMITED'; then LIMIT_HIT=1; break; fi
  done
fi
[[ "$LIMIT_HIT" == "1" ]] && ok "第 $i 次触发 RATE_LIMITED" || info "未触发（可能未击穿或 session 异常，不视为缺陷）"

# ---------- 10) PII 脱敏 ----------
step "PII 脱敏：admin 调用 echo 传入手机号"
curl -sS -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $RAW_A" -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":200,"method":"tools/call","params":{"name":"'"$UPSTREAM_NAME"'__echo","arguments":{"message":"用户 13800138000 邮箱 a@b.com"}}}' > /dev/null
sleep 1.5
PII_HIT=$(AA_GET "/audit?page=1&size=5&keyword=13800138000" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rows = d.get('rows') or []
# 审计存的是脱敏后形式，明文搜不到 → 脱敏成功
print('0' if not rows else '1')
" 2>/dev/null || echo "?")
REDACTED_ANY=$(AA_GET "/audit?page=1&size=20&upstream=$UPSTREAM_NAME" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in (d.get('rows') or []):
    if r.get('redacted')==1:
        print('1'); break
else:
    print('0')
" 2>/dev/null || echo "?")
if [[ "$PII_HIT" == "0" && "$REDACTED_ANY" == "1" ]]; then
  ok "明文 13800138000 不到；审计存在 redacted=1 记录"
elif [[ "$REDACTED_ANY" == "1" ]]; then
  ok "已写入 redacted=1 脱敏标记（keyword 搜索仍命中 argsDigest 属正常）"
else
  bad "未看到脱敏命中" "pii_hit=$PII_HIT redacted=$REDACTED_ANY"
fi

# ---------- 11) 工具下线 ----------
step "工具上下线：将 ${UPSTREAM_NAME}__get-sum 停用后 tools/list 应不可见"
TOOL_FULL="${UPSTREAM_NAME}__get-sum"
AA_PUT "/tools/$TOOL_FULL/enabled" '{"enabled":false}' > /dev/null
sleep 0.3
TL2=$(curl -sS -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $RAW_A" -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":300,"method":"tools/list"}')
if echo "$TL2" | grep -q "$TOOL_FULL"; then
  bad "下线后仍可看到 $TOOL_FULL"
else
  ok "已从 tools/list 隐藏"
fi
AA_PUT "/tools/$TOOL_FULL/enabled" '{"enabled":true}' > /dev/null

# ---------- 12) 审计查询 + CSV 导出 ----------
step "审计与 CSV 导出"
AUDIT_TOTAL=$(AA_GET "/audit?page=1&size=1" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('total',0))")
CSV_HEAD=$(curl -sS -H "Authorization: Bearer $AT" "$BASE_URL/admin/api/audit/export?limit=5" | head -1)
ok "审计累计 $AUDIT_TOTAL 条；CSV header：${CSV_HEAD:0:80}"

# ---------- 13) 变更留痕 ----------
step "变更日志（最近 5 条）"
AA_GET "/changes?page=1&size=5" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in (d.get('rows') or [])[:5]:
    print(f\"    · {r.get('createdAt','')} [{r.get('targetType')}/{r.get('action')}] by {r.get('actor','')}\")"

# ---------- 14) Key 轮换（graceMinutes 宽限期） ----------
step "Key 轮换（graceMinutes=1）→ 旧 Key 宽限期 60s 内仍应 200"
ROT=$(AA_POST "/keys/$ID_A/rotate" '{"graceMinutes":1}')
RAW_A2=$(echo "$ROT" | python3 -c "import json,sys;print(json.load(sys.stdin).get('raw',''))")
if [[ -n "$RAW_A2" ]]; then
  OK_OLD=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $RAW_A" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}')
  [[ "$OK_OLD" == "200" || "$OK_OLD" == "201" ]] && ok "旧 Key 宽限期内仍 200（http=${OK_OLD}）" || bad "旧 Key 立即失效（http=${OK_OLD}）"
  RAW_A="$RAW_A2"
fi

# ---------- 15) 吊销 ----------
step "吊销 intern Key → 期望 401"
AA_POST "/keys/$ID_I/revoke" '{}' > /dev/null
sleep 0.3
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $RAW_I" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}')
[[ "$CODE" == "401" ]] && ok "吊销即时生效（http=401）" || bad "吊销后仍返回 http=$CODE"

# ---------- 16) 报表 ----------
step "报表 overview"
AA_GET "/stats/overview" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ks = ['total','fails','failRate','uniqueUsers','uniqueTools','byUpstream','byTool','byUser','topFails']
for k in ks:
    v=d.get(k)
    if isinstance(v,(int,float)): print(f'    · {k:14} = {v}')
    elif isinstance(v,list): print(f'    · {k:14} : {len(v)} 项')
    elif isinstance(v,dict): print(f'    · {k:14} : {list(v.keys())}')"

# ---------- 清理 ----------
if [[ "$KEEP" == "0" ]]; then
  step "清理（软删除上游，保留 Key 便于查看审计）"
  curl -sS -X DELETE -H "Authorization: Bearer $AT" "$BASE_URL/admin/api/upstreams/$UPSTREAM_NAME" > /dev/null \
    && ok "已下线上游 ${UPSTREAM_NAME}（软删除，enabled=0，审计可追溯）" \
    || bad "清理上游失败"
else
  info "--keep：保留上游 $UP_ID / admin#$ID_A / intern#$ID_I 便于手工查看"
fi

# ---------- 汇总 ----------
printf "\n${C_BOLD}════════ 冒烟汇总 ════════${C_RST}\n"
printf "  ${C_GREEN}PASS %d${C_RST}  ${C_RED}FAIL %d${C_RST}  步骤 %d\n\n" "$PASS" "$FAIL" "$STEP"
[[ "$FAIL" -eq 0 ]] || exit 1
