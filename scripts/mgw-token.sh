#!/usr/bin/env bash
# ==============================================================================
#  用 Logto 机器身份换取管理端 access token（client_credentials）
#  ─────────────────────────────────────────────────────────────────────────────
#  背景：管理端已改为只认 Logto JWT，旧的 ADMIN_TOKEN 不再被接受。
#        回归脚本用网关冒烟客户端（角色 gateway_ci）换取 token 后再调用。
#
#  用法：
#    TOKEN=$(./scripts/mgw-token.sh)     # stdout 只输出 token，便于 $( )
#    ./scripts/mgw-token.sh --debug      # 额外把过期信息打到 stderr
#
#  依赖 backend/.env 里的 MGW_M2M_CLIENT_ID / MGW_M2M_CLIENT_SECRET
#  （由 auth-platform 的 provision.mjs 创建「MCP 网关冒烟客户端」得到）。
#
#  缓存：token 有效期 15 分钟，缓存在 $TMPDIR/mgw-token-<clientId>.cache，
#        提前 60 秒过期，避免连续跑多个脚本时反复请求 Logto。
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEBUG=0
[[ "${1:-}" == "--debug" ]] && DEBUG=1

load_env() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  local had_u=0; [[ "$-" == *u* ]] && { had_u=1; set +u; }
  set -a
  # shellcheck disable=SC1090
  source "$f" 2>/dev/null || true
  set +a
  [[ "$had_u" == "1" ]] && set -u
}
load_env "$ROOT_DIR/backend/.env"
load_env "$ROOT_DIR/.env"

ENDPOINT="${MGW_LOGTO_ENDPOINT:-${LOGTO_ENDPOINT:-http://localhost:3001}}"
ENDPOINT="${ENDPOINT%/}"
AUDIENCE="${LOGTO_AUDIENCE:-https://api.gateway.local}"
SCOPE="${MGW_TOKEN_SCOPE:-gateway:read gateway:write gateway:sensitive}"
CLIENT_ID="${MGW_M2M_CLIENT_ID:-}"
CLIENT_SECRET="${MGW_M2M_CLIENT_SECRET:-}"

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  cat >&2 <<'EOF'
✗ 缺少机器身份凭据（MGW_M2M_CLIENT_ID / MGW_M2M_CLIENT_SECRET）
  backend/.env 里补上，值来自 auth-platform 执行 provision.mjs 后打印的
  「MCP 网关冒烟客户端」client id / secret。
EOF
  exit 2
fi

# 缓存按「client + scope」区分：同一 client 用不同 scope 换的 token 不能互相复用
CACHE="${TMPDIR:-/tmp}/mgw-token-${CLIENT_ID}-$(printf '%s' "$SCOPE" | cksum | cut -d' ' -f1).cache"
now=$(date +%s)
if [[ -f "$CACHE" ]]; then
  read -r exp token < "$CACHE" || true
  if [[ -n "${exp:-}" && -n "${token:-}" && "$now" -lt "$exp" ]]; then
    [[ "$DEBUG" == "1" ]] && echo "· 命中缓存，剩余 $((exp - now))s" >&2
    printf '%s\n' "$token"
    exit 0
  fi
fi

resp=$(curl -sS -u "$CLIENT_ID:$CLIENT_SECRET" -X POST "$ENDPOINT/oidc/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "resource=$AUDIENCE" \
  --data-urlencode "scope=$SCOPE" 2>&1) || {
  echo "✗ 请求 Logto token 失败（$ENDPOINT/oidc/token）: $resp" >&2
  exit 2
}

parsed=$(printf '%s' "$resp" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("ERR|响应不是 JSON"); raise SystemExit
t = d.get("access_token") or ""
if not t:
    print("ERR|" + str(d.get("error_description") or d.get("error") or d)[:200]); raise SystemExit
print(str(d.get("expires_in", 900)) + "|" + t)
')

if [[ "$parsed" == ERR\|* ]]; then
  echo "✗ 换取 token 被拒：${parsed#ERR|}" >&2
  exit 2
fi

expires_in="${parsed%%|*}"
token="${parsed#*|}"
exp=$((now + expires_in - 60))
printf '%s %s\n' "$exp" "$token" > "$CACHE"
chmod 600 "$CACHE" 2>/dev/null || true
[[ "$DEBUG" == "1" ]] && echo "· 新 token 已获取，有效期 ${expires_in}s" >&2
printf '%s\n' "$token"
