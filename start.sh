#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
#  MCP 网关 一键启动脚本
#
#  用法：
#    ./start.sh              启动（后端 :8080 + 前端 :5173）
#    ./start.sh --stop       停止已在运行的实例（含残留端口占用）
#    ./start.sh --force      端口被占用时自动停止旧实例再启动
#    ./start.sh --no-seed    跳过 seed（仅在确认库结构已就绪时使用）
#    ./start.sh -h | --help  显示帮助
#
#  说明：
#    - 依赖缺失时会自动 npm install（首次启动免手工）
#    - seed 幂等：不会覆盖已有 settings/角色/Key
#    - Ctrl+C 一键优雅停止两个进程树（TERM → 5s → KILL）
#    - 后端 :8080 与前端 :5173 若被占用会预检报错，避免误跑到备用端口
# ══════════════════════════════════════════════════════════════
set -eu

# ── 路径与端口 ─────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
RUN_DIR="$SCRIPT_DIR/.run"
PID_FILE="$RUN_DIR/gateway.pid"

BE_PORT="${MGW_PORT:-8080}"
FE_PORT="${MGW_FE_PORT:-5173}"

# ── 颜色 ───────────────────────────────────────────────
ESC=$(printf '\033')
C_RESET="${ESC}[0m"; C_DIM="${ESC}[2m"
C_CYAN="${ESC}[36m"; C_MAG="${ESC}[35m"
C_GRN="${ESC}[32m"; C_YEL="${ESC}[33m"; C_RED="${ESC}[31m"

info() { printf "%s[start]%s %s\n" "$C_GRN" "$C_RESET" "$*"; }
warn() { printf "%s[warn ]%s %s\n" "$C_YEL" "$C_RESET" "$*" >&2; }
err()  { printf "%s[err  ]%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; }
die()  { err "$@"; exit 1; }

mkdir -p "$RUN_DIR"

# ── 自动加载 .env（在当前 shell 里 source，确保变量回传主进程） ──
#   加载顺序：backend/.env 优先，仓库根 .env 兜底；set -a 自动 export 到子进程
load_dotenv() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local had_u=0
  [[ "$-" == *u* ]] && { had_u=1; set +u; }
  set -a
  # shellcheck disable=SC1090
  if ! source "$file" 2>/dev/null; then
    set +a
    [[ "$had_u" == "1" ]] && set -u
    warn "env 文件解析异常，已跳过：$file"
    return 1
  fi
  set +a
  [[ "$had_u" == "1" ]] && set -u
  info "已加载 env: ${file#$SCRIPT_DIR/}"
}
load_dotenv "$BACKEND_DIR/.env"
load_dotenv "$SCRIPT_DIR/.env"

# ── 参数解析 ───────────────────────────────────────────
MODE="start"; FORCE=0; SKIP_SEED=0
for arg in "$@"; do
  case "$arg" in
    --stop)    MODE="stop" ;;
    --force)   FORCE=1 ;;
    --no-seed) SKIP_SEED=1 ;;
    -h|--help) MODE="help" ;;
    *) die "未知参数：$arg（-h 查看帮助）" ;;
  esac
done

if [[ "$MODE" == "help" ]]; then
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

# ── 端口占用查询 ───────────────────────────────────────
port_pids() { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }

# ── 递归杀进程树（先下后上，避免孤儿子进程）──────
kill_tree() {
  local pid="$1" sig="${2:-TERM}"
  [[ -z "$pid" ]] && return 0
  kill -0 "$pid" 2>/dev/null || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child" "$sig"
  done
  kill -"$sig" "$pid" 2>/dev/null || true
}

# ── 停止：优先 TERM 服务实际持有端口的进程树（nest/vite）──
stop_all() {
  local did=0 port pid
  # 1) TERM 端口持有者进程树（这才是 nest/vite 子链的入口）
  for port in "$BE_PORT" "$FE_PORT"; do
    for pid in $(port_pids "$port"); do
      info "TERM 服务进程树 → :$port 持有者 PID $pid"
      kill_tree "$pid" TERM
      did=1
    done
  done
  # 2) TERM 我们记录的 pipeline PID（prefix_stream 的 awk）
  if [[ -f "$PID_FILE" ]]; then
    for pid in $(tr ' ' '\n' < "$PID_FILE" | grep -v '^$' || true); do
      kill_tree "$pid" TERM || true
    done
    rm -f "$PID_FILE"
    did=1
  fi
  # 3) 等优雅退出最多 5s
  if [[ "$did" == "1" ]]; then
    for _ in 1 2 3 4 5; do
      sleep 1
      local alive=0
      for port in "$BE_PORT" "$FE_PORT"; do
        [[ -n "$(port_pids "$port")" ]] && alive=1
      done
      [[ "$alive" == "0" ]] && break
    done
  fi
  # 4) 兼容残留：强制 KILL
  for port in "$BE_PORT" "$FE_PORT"; do
    for pid in $(port_pids "$port"); do
      warn "端口 $port 仍被 $pid 占用，强制 KILL"
      kill -KILL "$pid" 2>/dev/null || true
      did=1
    done
  done
  return $((did ? 0 : 1))
}

if [[ "$MODE" == "stop" ]]; then
  if stop_all; then info "已停止所有实例"; else warn "没有运行中的实例"; fi
  exit 0
fi

# ── 环境检查 ───────────────────────────────────────────
# 优先使用 nvm 里的 Node 22：better-sqlite3 等原生模块与 Node 大版本强绑定，
# 本机默认 node 若是 24，直接用会报 NODE_MODULE_VERSION 不匹配。
if [[ -d "$HOME/.nvm/versions/node" ]]; then
  for cand in "$HOME"/.nvm/versions/node/v22.*/bin; do
    if [[ -x "$cand/node" ]]; then
      export PATH="$cand:$PATH"
      break
    fi
  done
fi

command -v node   >/dev/null || die "未找到 node，请安装 Node.js >= 20.18.1（推荐 22，见 .nvmrc）"
command -v npm    >/dev/null || die "未找到 npm"
command -v lsof   >/dev/null || warn "lsof 不可用，端口预检将跳过"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node 版本过低（当前 $(node -v)），需 >= 20.18.1"
[[ -d "$BACKEND_DIR" && -d "$FRONTEND_DIR" ]] || die "项目结构异常，本脚本需放在 backend/frontend 的同级目录下"

# 原生模块 ABI 自检：不匹配时按当前 Node 重建，避免启动即崩
if [[ -d "$BACKEND_DIR/node_modules/better-sqlite3" ]]; then
  if ! (cd "$BACKEND_DIR" && node -e "require('better-sqlite3')" >/dev/null 2>&1); then
    warn "better-sqlite3 与当前 Node $(node -v) 的 ABI 不匹配，正在重建…"
    (cd "$BACKEND_DIR" && npm rebuild better-sqlite3 --no-audit --no-fund >/dev/null) \
      || die "重建失败：建议执行 nvm install 22 && nvm use 22 后重试"
    info "原生模块已按 Node $(node -v) 重建"
  fi
fi

# ── 端口预检 ───────────────────────────────────────────
if command -v lsof >/dev/null; then
  conflicts=()
  for port in "$BE_PORT" "$FE_PORT"; do
    pids=$(port_pids "$port")
    [[ -n "$pids" ]] && conflicts+=("$port($pids)")
  done
  if [[ ${#conflicts[@]} -gt 0 ]]; then
    warn "端口已被占用：${conflicts[*]}"
    if [[ "$FORCE" == "1" ]]; then
      info "--force 开启，停止现有实例…"
      stop_all || true
    else
      die "请先执行 ./start.sh --stop，或使用 ./start.sh --force 自动停止"
    fi
  fi
fi

# ── 依赖自动安装 ───────────────────────────────────────
if [[ ! -d "$BACKEND_DIR/node_modules" ]]; then
  info "安装后端依赖（首次约 1-3 分钟，better-sqlite3 会编译原生模块）…"
  (cd "$BACKEND_DIR" && npm install --no-audit --no-fund)
fi
if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  info "安装前端依赖…"
  (cd "$FRONTEND_DIR" && npm install --no-audit --no-fund)
fi

# ── Seed（幂等）─────────────────────────────────────────
if [[ "$SKIP_SEED" == "0" ]]; then
  info "初始化数据库（幂等，不会覆盖已有数据）…"
  seed_out=$( cd "$BACKEND_DIR" && npm run --silent seed 2>&1 ) || die "seed 失败：\n$seed_out"
  echo "$seed_out" | sed 's/^/  '"${C_DIM}·${C_RESET}"' /'
fi

# ── 彩色前缀流式转发 ───────────────────────────────────
prefix_stream() {
  # $1=color, $2=tag；从 stdin 读、按行加前缀写到 stdout
  awk -v c="$1" -v t="$2" '
    { printf "%s[%s]%s %s\n", c, t, ENVIRON["_MGW_RST"], $0; fflush() }
  '
}
export _MGW_RST="$C_RESET"

# ── 启动两个进程 ───────────────────────────────────────
info "启动后端 (nest start:dev) → :$BE_PORT"
(
  cd "$BACKEND_DIR"
  npm run start:dev
) 2>&1 | prefix_stream "$C_CYAN" "backend" &
BE_PID=$!

info "启动前端 (vite dev) → :$FE_PORT"
(
  cd "$FRONTEND_DIR"
  npm run dev
) 2>&1 | prefix_stream "$C_MAG" "frontend" &
FE_PID=$!

echo "$BE_PID $FE_PID" > "$PID_FILE"

# ── Ctrl+C / kill 时优雅停止 ───────────────────────────
cleanup() {
  trap - INT TERM EXIT
  printf "\n"; info "收到退出信号，正在优雅停止…"
  stop_all || true
  info "已停止"
}
trap cleanup INT TERM

# ── 启动完成提示 ───────────────────────────────────────
sleep 2
printf "\n%s════════════════════════ MCP 网关已启动 ════════════════════════%s\n" "$C_GRN" "$C_RESET"
printf "  %s▶ 管理后台%s   http://127.0.0.1:%s\n"  "$C_MAG" "$C_RESET" "$FE_PORT"
printf "                 登录由 %sLogto%s 托管（首次访问自动跳转），角色需在 Logto 分配\n" \
       "$C_YEL" "$C_RESET"
printf "  %s▶ MCP 端点%s   http://127.0.0.1:%s/mcp\n"  "$C_CYAN" "$C_RESET" "$BE_PORT"
printf "                 鉴权头: %sAuthorization: Bearer <mgw_live_…>%s\n" "$C_DIM" "$C_RESET"
printf "  %s▶ 健康检查%s   http://127.0.0.1:%s/healthz\n" "$C_GRN" "$C_RESET" "$BE_PORT"
printf "  %s按 Ctrl+C 一键停止%s  ·  或另开终端执行 %s./start.sh --stop%s\n\n" \
       "$C_YEL" "$C_RESET" "$C_DIM" "$C_RESET"

# 任一子进程退出即触发 cleanup
wait "$BE_PID" "$FE_PID"
