# dsh-rp —— StageCraft 的 Cordis/dsh bundle

这是一个可直接安装的 AGPL-3.0-only DSH bundle。它把 StageCraft 的同一份业务实现打包为 dist/index.js；独立运行入口和 DSH 入口不会维护两套逻辑，bundle 不依赖安装目录之外的仓库源码。

## 兼容性

- **DSH**：`0.1.0-rc.7`（以 `dsh --profile web` 形态验证；沙盒 worker、热重载、slash 命令、AppData 用户数据均在 rc.7 上实测）
- **Cordis**：`4.0.0-rc.8`（`@deepseek-ai/cordis` scoped alias，与 DSH scoped 包名惯例一致）
- **Node**：`>= 24`（依赖 `node --experimental-strip-types` 运行 TS 入口）
- 可选服务（`webServer` / `commands` / `systemPrompt` / `apiProxy`）通过 `ctx.get(name, false)` 宽松读取，**不要求 profile 显式声明 inject**；服务未挂载时对应能力自动降级（无 reload 端点、无 slash 命令等）

## 运行模型

DSH 保持 supervisor 身份；StageCraft 支持两个明确的 Cordis 配置模式：

- `runtimeMode: embedded`（默认）：当前自包含开发路径，StageCraft HTTP、SQLite、静态资源与模型连接在 DSH 进程内运行。
- `runtimeMode: sandboxed`：DSH 仅在宿主 Context 中注册 `ctx.stagecraftDebug`，并启动 `dist/worker.js` 子进程。状态、日志、Core view/event 通过版本化、bounded JSON RPC 流转；可调用 `start`、`stop`、`kill`、`restart`、`recover` 与 `request`。worker 崩溃只更新 supervisor 状态并发送日志/状态事件，不会销毁 DSH Context。

`ctx.stagecraftDebug` 是可选调试桥；Inspector 不会自动开启，也不提供默认公网或非 loopback 端点。sandboxed worker 默认只监听内部 stdio RPC，不暴露 StageCraft HTTP。

构建脚本把公开的默认剧本、提示词、UI 资源和 worker entry 写入 dist/。data/、save/、custom/、本地媒体、私有卡片内容和本地保存不会进入 bundle。

## 验证与打包

构建并验证：

    node dsh-rp/scripts/build.mjs
    node dsh-rp/verify.mjs
    cd dsh-rp
    npm pack

验证脚本会用宿主解析到的 @deepseek-ai/cordis 加载真实打包入口，执行 ctx.plugin、请求 /api/room，再等待 fiber.dispose() 释放端口。

npm pack 产物只包含 dist/、bundle patch、许可证与 README；生成的 tgz 不提交到仓库。

## 安装到 DSH

1. 将本包安装到目标 profile 的 node_modules。
2. 使用本包提供的 cordis.patch.yml，或在 profile patch 中插入 id 为 rp、name 为 dsh-rp 的配置行。
3. 用 dsh --profile name --dump-config 确认该行已进入组合配置。
4. 启动 profile 后访问配置的 HTTP 地址。

## Cordis Config

cordis.patch.yml 中的 config 是正式配置入口：

| 字段 | 默认 | 说明 |
|---|---|---|
| runtimeMode | embedded | `embedded`（开发兼容）或 `sandboxed`（独立 worker） |
| port | 8799 | embedded 模式的酒馆 HTTP 端口 |
| host | 127.0.0.1 | HTTP 监听地址 |
| root | bundle 的 dist/ | 数据、剧本、提示词和静态资源根目录 |
| remoteEnabled | false | 显式开启开发期局域网配对与 Bearer 鉴权 |
| remotePairingTtlMs | 300000 | 一次性配对码有效期（毫秒） |
| remoteSessionTtlMs | 43200000 | 远程会话有效期（毫秒） |

远程入口目前只用于受信任局域网内的开发验证，本身不提供 TLS；跨越不受信任网络时必须由外部 TLS 终结层保护。监听非回环地址但未显式启用 `remoteEnabled` 会拒绝启动。

RP_PORT、HOST、RP_ROOT 仍作为独立开发运行时的兼容回退；DSH 配置字段优先。

## 许可证与源码

bundle 为 AGPL-3.0-only。LICENSE、NOTICE.md 和构建生成的 dist/SOURCE.md 随产物提供；若 SOURCE_REPOSITORY_URL 未设置，构建脚本会明确标记为开发产物，发布者必须在正式分发前提供可访问的对应源码位置。
