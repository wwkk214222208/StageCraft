#!/bin/bash
# Start Character Tavern inside WSL, bound to 0.0.0.0 so Windows can reach it via the WSL IP.
set -u
cd "$(dirname "$0")" || exit 1

if curl -sf -o /dev/null http://127.0.0.1:8787/api/room 2>/dev/null; then
  echo "Character Tavern already running in WSL."
  exit 0
fi

# setsid detaches from the wsl.exe one-shot session so the server survives after this command exits
HOST=0.0.0.0 PORT=8787 setsid nohup node --experimental-strip-types src/server.ts >data/server.log 2>data/server-error.log </dev/null &
disown

for i in $(seq 1 15); do
  sleep 1
  if curl -sf -o /dev/null http://127.0.0.1:8787/api/room 2>/dev/null; then
    echo "Character Tavern started in WSL."
    exit 0
  fi
done

echo "START FAILED - check data/server-error.log"
exit 1
