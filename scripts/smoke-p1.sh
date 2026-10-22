#!/usr/bin/env bash
# ==============================================================================
#  P1 首批交付 · 冒烟护栏
#  ─────────────────────────────────────────────────────────────────────────────
#  覆盖范围（对应 docs/todo.md 第六节 P1 三项快赢）：
#    · P1-C  熔断事件面板：/admin/api/breaker/{status,events,summary} 端点结构
#    · P1-A  数据库自动备份：/admin/api/backups/{summary,run,list,download} 端到端 + 文件真实落盘
#    · P1-B  Prometheus 标准指标：/metrics.prom text 格式 + 6 项自定义 gauge + 默认指标 + /metrics JSON 兼容
#
#  设计原则：
#    - 结构断言为主（endpoint 契约、响应字段、Content-Type），不做真实熔断触发（后者留给运维面板演示）
#    - P1-A 走完整"生成 → 查询 → 下载 → 校验字节一致"闭环，验证 better-sqlite3 在线备份真的可用
#    - P1-B 断言至少 6 个 mgw_* 自定义指标行 + 至少 1 个 mgw_process_* 默认指标行 + 老 /metrics JSON 兼容
#
#  前置：
#    - ./start.sh 已启动后端 :8080
#    - backend/.env 已有 MGW_M2M_CLIENT_ID / MGW_M2M_CLIENT_SECRET（scripts/mgw-token.sh 换 token）
#    - 建议先跑 smoke-domestic.sh --no-cleanup 建立在线上游（非必需，本脚本对 0 工具也稳）
#
#  用法：
#    ./scripts/smoke-p1.sh
#    ./scripts/smoke-p1.sh --base http://127.0.0.1:8080
#    ./scripts/smoke-p1.sh --keep  # 保留本次生成的备份文件
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="http://127.0.0.1:8080"
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE_URL="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
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
BACKUP_DIR="$ROOT_DIR/backend/data/backup"

# ---------- 断言/统计 ----------
PASS=0; FAIL=0; STEP=0
C_GREEN='\033[32m'; C_RED='\033[31m'; C_DIM='\033[2m'; C_BOLD='\033[1m'; C_CY='\033[36m'; C_AMBER='\033[33m'; C_RST='\033[0m'
step() { STEP=$((STEP+1)); printf "${C_BOLD}${C_CY}[%02d] %s${C_RST}\n" "$STEP" "$1"; }
ok()   { PASS=$((PASS+1)); printf "    ${C_GREEN}✓${C_RST} %s ${C_DIM}%s${C_RST}\n" "$1" "${2:-}"; }
bad()  { FAIL=$((FAIL+1)); printf "    ${C_RED}✗${C_RST} %s ${C_DIM}%s${C_RST}\n" "$1" "${2:-}"; }
info() { printf "    ${C_DIM}· %s${C_RST}\n" "$1"; }
warn() { printf "    ${C_AMBER}!${C_RST} %s ${C_DIM}%s${C_RST}\n" "$1" "${2:-}"; }

AA_GET()  { curl -sS -H "Authorization: Bearer $AT" -H "x-admin-user: smoke-p1" "$BASE_URL/admin/api$1"; }
AA_POST() { curl -sS -X POST -H "Authorization: Bearer $AT" -H "x-admin-user: smoke-p1" -H 'Content-Type: application/json' -d "${2:-{\}}" "$BASE_URL/admin/api$1"; }

# ================================================================
printf "${C_BOLD}MCP 网关 · P1 首批冒烟（熔断面板 · 自动备份 · Prometheus）${C_RST}\n"
printf "${C_DIM}base=%s  backupDir=%s${C_RST}\n\n" "$BASE_URL" "$BACKUP_DIR"

# ---------- [01] 后端存活 ----------
step "前置：/healthz 200"
H=$(curl -sS "$BASE_URL/healthz" || true)
if echo "$H" | python3 -c "import json,sys;d=json.load(sys.stdin);sys.exit(0 if d.get('status')=='ok' else 1)" 2>/dev/null; then
  ok "后端健康" "$(echo "$H" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("tools="+str(d.get("tools",0))+",up="+str(d.get("upstreamsConnected",0))+",v="+str(d.get("registryVersion",0)))')"
else
  bad "后端未启动或 /healthz 不可达" "$H"; exit 2
fi

# ================================================================
# P1-C · 熔断事件面板
# ================================================================
step "P1-C · GET /breaker/status 结构：config 三键 + upstreams 数组"
BS=$(AA_GET /breaker/status)
BSC=$(echo "$BS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
cfg=d.get('config',{})
ups=d.get('upstreams',[])
ok=(all(k in cfg for k in ('failThreshold','openMs','windowMs'))
    and isinstance(ups, list))
print('PASS' if ok else 'FAIL', len(ups))
sys.exit(0 if ok else 1)
" 2>&1) || { bad "status 结构非法" "$BS"; BSC="FAIL 0"; }
if [[ "$BSC" == PASS* ]]; then ok "config 完整" "upstreams=${BSC#PASS } ${BSC:5}"; fi

step "P1-C · GET /breaker/events 分页：total/page/size/rows"
BE=$(AA_GET "/breaker/events?page=1&size=5")
BEC=$(echo "$BE" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ok=all(k in d for k in ('total','page','size','rows')) and isinstance(d['rows'], list)
print('PASS' if ok else 'FAIL', d.get('total','?'), len(d.get('rows',[])))
sys.exit(0 if ok else 1)
" 2>&1) || { bad "events 结构非法" "$BE"; BEC="FAIL"; }
[[ "$BEC" == PASS* ]] && ok "分页结构齐" "total/rows ${BEC#PASS }"

step "P1-C · GET /breaker/summary?days=7 数组"
BSM=$(AA_GET "/breaker/summary?days=7")
BSMC=$(echo "$BSM" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ok=isinstance(d, list)
print('PASS' if ok else 'FAIL', len(d) if ok else '')
sys.exit(0 if ok else 1)
" 2>&1) || { bad "summary 非数组" "$BSM"; BSMC="FAIL"; }
[[ "$BSMC" == PASS* ]] && ok "summary 结构合法" "count=${BSMC#PASS }"

step "P1-C · breaker 默认阈值：failThreshold=5 · openMs=60000 · windowMs=60000"
CFGCHK=$(echo "$BS" | python3 -c "
import json,sys
d=json.load(sys.stdin)['config']
ok=(d['failThreshold']==5 and d['openMs']==60000 and d['windowMs']==60000)
print('PASS' if ok else 'FAIL', d)
sys.exit(0 if ok else 1)
" 2>&1) || true
if [[ "$CFGCHK" == PASS* ]]; then ok "阈值与代码一致" "$CFGCHK"; else bad "阈值漂移" "$CFGCHK"; fi

step "P1-C · circuit_breaker_events 表已在 SQLite 中建出"
TABLE_OK="no"
if [[ -f "$ROOT_DIR/backend/data/gateway.db" ]]; then
  TNAME=$(python3 -c "
import sqlite3
c=sqlite3.connect('$ROOT_DIR/backend/data/gateway.db')
r=c.execute(\"SELECT name FROM sqlite_master WHERE type='table' AND name='circuit_breaker_events'\").fetchone()
print('yes' if r else 'no')
" 2>/dev/null || echo "err")
  [[ "$TNAME" == "yes" ]] && TABLE_OK="yes"
fi
if [[ "$TABLE_OK" == "yes" ]]; then ok "circuit_breaker_events 表存在"
else
  # 表可能因运行时首次访问才建，退而求其次通过 events API 无 500 判断
  if echo "$BE" | grep -q '"rows"'; then ok "events 端点响应正常（表已就绪）"; else bad "表不存在且端点异常"; fi
fi

# ================================================================
# P1-A · 数据库自动备份
# ================================================================
step "P1-A · GET /backups/summary 结构（8 字段齐）"
BPS=$(AA_GET /backups/summary)
BPSC=$(echo "$BPS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
keys=('enabled','cron','tz','keep','latest','lastFailed','totalCount','totalBytes')
missing=[k for k in keys if k not in d]
print('FAIL '+str(missing) if missing else 'PASS '+d.get('cron','')+' tz='+d.get('tz','')+' keep='+str(d.get('keep','')))
sys.exit(0 if not missing else 1)
" 2>&1) || { bad "summary 结构非法" "$BPS"; BPSC="FAIL"; }
[[ "$BPSC" == PASS* ]] && ok "字段齐" "${BPSC#PASS }"

step "P1-A · POST /backups/run 触发一次手动备份 → status=ok"
BR=$(AA_POST /backups/run '{}')
BRID=$(echo "$BR" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if d.get('status') == 'ok' and d.get('bytes',0) > 0:
    print('ID', d['id'], d['bytes'], d.get('durationMs',0), d.get('filename',''))
else:
    print('FAIL', d)
    sys.exit(1)
" 2>&1) || { bad "备份失败" "$BR"; BRID="FAIL"; }
if [[ "$BRID" == ID* ]]; then
  read -r _ ID BYTES DUR FNAME <<< "$BRID"
  ok "备份成功 id=$ID" "bytes=$BYTES ms=$DUR file=$FNAME"
else
  ID=""
fi

step "P1-A · GET /backups 首行 = 刚才新记录（按 ts DESC）"
if [[ -n "${ID:-}" ]]; then
  BL=$(AA_GET "/backups?page=1&size=5")
  TOPCHK=$(echo "$BL" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rows=d.get('rows',[])
ok=(rows and rows[0].get('id')==$ID)
print('PASS' if ok else 'FAIL top='+str(rows[0].get('id') if rows else 'none')+' want=$ID')
sys.exit(0 if ok else 1)
" 2>&1) || true
  [[ "$TOPCHK" == PASS* ]] && ok "首行 id=$ID" || bad "首行不匹配" "$TOPCHK"
else
  bad "跳过：无有效备份 id"
fi

step "P1-A · GET /backups/:id/download HTTP 200 + Content-Disposition + 字节数一致"
if [[ -n "${ID:-}" ]]; then
  DL=/tmp/p1-dl-$TS.db
  HD=/tmp/p1-dl-$TS.hdr
  HTTP=$(curl -sS -D "$HD" -o "$DL" -w '%{http_code}' \
    -H "Authorization: Bearer $AT" -H "x-admin-user: smoke-p1" \
    "$BASE_URL/admin/api/backups/$ID/download")
  SIZE=$(wc -c < "$DL" | tr -d ' ')
  DISP=$(grep -i '^content-disposition:' "$HD" | tr -d '\r')
  if [[ "$HTTP" == "200" && "$SIZE" == "$BYTES" && "$DISP" == *attachment* ]]; then
    ok "下载一致" "http=200 size=$SIZE filename=$(echo "$DISP" | sed -E 's/.*filename=\"?([^\";]+)\"?.*/\1/')"
  else
    bad "下载校验失败" "http=$HTTP size=$SIZE want=$BYTES disp=$DISP"
  fi
  [[ "$KEEP" == "0" ]] && rm -f "$DL" "$HD"
else
  bad "跳过：无有效备份 id"
fi

step "P1-A · 备份文件真实存在于磁盘 backup 目录"
if [[ -n "${FNAME:-}" && -f "$BACKUP_DIR/$FNAME" ]]; then
  ok "磁盘留痕" "$BACKUP_DIR/$FNAME"
else
  bad "文件不存在或 fname 未取到" "fname=${FNAME:-}"
fi

step "P1-A · change_logs 里含 targetType=backup action=create（人工触发留痕）"
CL=$(AA_GET "/changes?targetType=backup&page=1&size=5")
CLCHK=$(echo "$CL" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rows=d.get('rows',[])
ok=any(r.get('targetType')=='backup' and r.get('action')=='create' for r in rows)
print('PASS' if ok else 'FAIL rows='+str(len(rows)))
sys.exit(0 if ok else 1)
" 2>&1) || true
[[ "$CLCHK" == PASS* ]] && ok "变更留痕已入" || bad "变更留痕缺失" "$CLCHK"

# ================================================================
# P1-B · Prometheus 标准指标
# ================================================================
step "P1-B · GET /metrics.prom Content-Type 含 text/plain"
PROMH=$(curl -sS -D - -o /tmp/p1-prom-$TS.txt "$BASE_URL/metrics.prom" | tr -d '\r' | grep -i '^content-type:' || true)
if echo "$PROMH" | grep -qi 'text/plain'; then
  ok "Content-Type" "$PROMH"
else
  bad "Content-Type 非 text/plain" "$PROMH"
fi

step "P1-B · /metrics.prom 至少含 6 个 mgw_ 自定义指标行"
if [[ -s /tmp/p1-prom-$TS.txt ]]; then
  MISS=$(python3 -c "
required = [
  'mgw_registry_tools_total',
  'mgw_registry_version',
  'mgw_sessions_active',
  'mgw_upstreams_connected',
  'mgw_audit_queue_depth',
  'mgw_ratelimit_buckets',
]
with open('/tmp/p1-prom-$TS.txt','r') as f: t=f.read()
missing=[m for m in required if m+' ' not in t and m+'{' not in t]
print(','.join(missing) if missing else '')
" 2>&1)
  if [[ -z "$MISS" ]]; then
    ok "6 项齐" "registry/sessions/upstreams/audit/ratelimit"
  else
    bad "缺失" "$MISS"
  fi
else
  bad "/metrics.prom 响应体为空"
fi

step "P1-B · 默认指标 mgw_process_resident_memory_bytes + mgw_nodejs_eventloop_lag 至少存在"
if [[ -s /tmp/p1-prom-$TS.txt ]]; then
  DM=$(python3 -c "
with open('/tmp/p1-prom-$TS.txt','r') as f: t=f.read()
has_rss = 'mgw_process_resident_memory_bytes ' in t
has_el  = 'mgw_nodejs_eventloop_lag' in t
if has_rss and has_el: print('PASS')
elif has_rss: print('PARTIAL no EL lag')
elif has_el: print('PARTIAL no RSS')
else: print('FAIL')
" 2>&1)
  if [[ "$DM" == "PASS" ]]; then ok "默认指标齐" "process_cpu/rss + eventloop_lag"
  elif [[ "$DM" == PARTIAL* ]]; then warn "默认指标不完整" "$DM"
  else bad "默认指标缺失" "$DM"
  fi
fi

step "P1-B · /metrics JSON 端点向后兼容（老 smoke 依赖）"
MJ=$(curl -sS "$BASE_URL/metrics")
MJCHK=$(echo "$MJ" | python3 -c "
import json,sys
d=json.load(sys.stdin)
need=('rss_mb','uptime_s','tools_total','sessions_active','upstreams_connected','el_p99_ms')
missing=[k for k in need if k not in d]
print('FAIL '+str(missing) if missing else 'PASS rss='+str(d['rss_mb'])+'MB p99='+str(d['el_p99_ms'])+'ms')
sys.exit(0 if not missing else 1)
" 2>&1) || true
[[ "$MJCHK" == PASS* ]] && ok "JSON 兼容" "${MJCHK#PASS }" || bad "JSON 字段漂移" "$MJCHK"

# ================================================================
# 汇总
# ================================================================
rm -f /tmp/p1-prom-$TS.txt
echo
printf "${C_BOLD}════════ P1 冒烟汇总 ════════${C_RST}\n"
printf "  ${C_GREEN}PASS ${PASS}${C_RST}  ${C_RED}FAIL ${FAIL}${C_RST}  步骤 ${STEP}\n"
[[ "$KEEP" == "1" ]] && printf "  ${C_DIM}--keep：备份文件 %s 已保留${C_RST}\n" "$BACKUP_DIR/${FNAME:-}"
[[ $FAIL -gt 0 ]] && exit 1 || exit 0
