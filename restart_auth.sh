#!/bin/bash
# 重启黄果剧场后端（认证 / 收藏 / 静态托管）
# 凭据从同目录 .env 读取（.env 不进入版本库，见 .env.example）
set -a
[ -f "$(dirname "$0")/.env" ] && . "$(dirname "$0")/.env"
set +a

cd "$(dirname "$0")" || exit 1

if [ -f auth_server.pid ]; then
  kill "$(cat auth_server.pid)" 2>/dev/null
  sleep 1
fi

nohup node auth_server.mjs >> auth_server.log 2>&1 &
echo $! > auth_server.pid
echo "auth_server started pid=$(cat auth_server.pid)"
