#!/bin/bash
# 在安卓（Termux）上启动 StageCraft 角色酒馆。
# 前置：Termux 里 `pkg install node`（需 Node 24+），然后用手机浏览器打开输出的地址。
set -u
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"

# 先停掉可能残留的旧实例，避免两个服务抢同一个数据库
pkill -f 'experimental-strip-types src/server.ts' 2>/dev/null; true

NODE_VER="$(node -v 2>/dev/null || echo 'v0')"
echo "Node 版本: $NODE_VER"
MAJOR="$(printf '%s' "$NODE_VER" | sed 's/^v//;s/\..*//')"
if [ "${MAJOR:-0}" -lt 22 ]; then
  echo "警告：当前 Node 版本过低，可能无法运行（项目要求 Node 24+）。"
fi

echo "正在启动 StageCraft..."
echo "  本机浏览器： http://127.0.0.1:$PORT"
# 尝试拿到局域网 IP，方便同网其它设备访问
IP="$(ip route get 1 2>/dev/null | awk '{print $7; exit}' || true)"
if [ -n "$IP" ]; then
  echo "  局域网访问： http://$IP:$PORT  （同一 Wi-Fi 下的手机/电脑均可打开）"
fi

HOST="$HOST" PORT="$PORT" node --experimental-strip-types src/server.ts
