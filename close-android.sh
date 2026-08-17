#!/bin/bash
# 停止安卓（Termux）上运行的 StageCraft。
pkill -f 'experimental-strip-types src/server.ts' && echo "StageCraft 已停止。" || echo "没有正在运行的 StageCraft。"
