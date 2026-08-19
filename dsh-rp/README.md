# dsh-rp —— StageCraft 的 Cordis/dsh bundle

这是一个可直接安装的 AGPL-3.0-only DSH bundle。它把 StageCraft 的同一份业务实现打包为 dist/index.js；独立运行入口和 DSH 入口不会维护两套逻辑，bundle 不依赖安装目录之外的仓库源码。

## 运行模型

- DSH 只提供 Cordis 宿主；Tavern 自己负责 SQLite、HTTP、静态资源与模型连接。
- 构建脚本把公开的默认剧本、提示词和 UI 资源写入 dist/。
- data/、save/、custom/ 和本地媒体不会进入 bundle。

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
| port | 8799 | 酒馆 HTTP 端口 |
| host | 127.0.0.1 | HTTP 监听地址 |
| root | bundle 的 dist/ | 数据、剧本、提示词和静态资源根目录 |

RP_PORT、HOST、RP_ROOT 仍作为独立开发运行时的兼容回退；DSH 配置字段优先。

## 许可证与源码

bundle 为 AGPL-3.0-only。LICENSE、NOTICE.md 和构建生成的 dist/SOURCE.md 随产物提供；若 SOURCE_REPOSITORY_URL 未设置，构建脚本会明确标记为开发产物，发布者必须在正式分发前提供可访问的对应源码位置。
