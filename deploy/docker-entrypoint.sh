#!/bin/sh
set -e

DATA_DIR="${MGW_DATA_DIR:-/app/data}"

# 仅首次启动（库文件不存在）执行 seed；后续重启不覆盖运维调整
if [ "${MGW_SEED:-1}" = "1" ] && [ ! -f "$DATA_DIR/gateway.db" ]; then
  echo "[entrypoint] 首次启动，初始化数据库..."
  node dist/database/seed.js
fi

exec "$@"
