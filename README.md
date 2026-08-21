# StageCraft

> 本文为项目根 `README.md`，面向**开发者**。玩家向使用说明见 [`玩家看我.md`](./玩家看我.md)。  

## 文档导航

- [玩家看我.md](./玩家看我.md) —— 玩家与创作者向的使用说明（通俗版）
- [docs/architecture.md](./docs/architecture.md) —— 系统架构（四层插件、状态事务模型、平台端口）
- [docs/why-not-dsh.md](./docs/why-not-dsh.md) —— 为什么不在 dsh 上直接改造、而是另起运行时（架构决策）
- [docs/creator-dsh-integration-audit.md](./docs/creator-dsh-integration-audit.md) —— 创作者工作台与 dsh 集成审计
- [docs/certification-matrix.md](./docs/certification-matrix.md) —— 平台认证矩阵（含安卓 skip-gated 说明）

## 项目定位

StageCraft 是一个自托管、插件化的多角色角色扮演（RP）运行时，配套一个 Web 工作台。它想成为比 SillyTavern 更好上手的生态：创作者能低门槛地做角色和剧本，玩家不用配置、打开就能玩。

- 名称：`stagecraft`，版本 `0.1.0`，`private`，协议 **AGPL-3.0-only**。
- 运行形态：① 独立 Node 服务；② 作为 **dsh 插件**（经 `dsh-rp` 适配壳）；③ 安卓（远程模式 APK / Termux 本地，**当前暂不推荐**，UI 布局问题待修）。

## 已实现

以下能力已在代码与测试中落地，可直接依赖：

- **角色独立身份**：每角色独立记忆 / 性格 / 目标，且可单独指定 provider + model（`role.modelOverride` / `role.providerId`；`resolveRouteModel`）。
- **OOC 即时修正（肘击 = intervene）**：对单个角色重新决策，可携带修正后的人设 / 记忆 / 印象 / 目标（`POST /api/roles/intervene`；`room-runtime.interveneRole`）。
- **开放插件架构**：Core 为唯一状态权威，四层插件边界（人机交互 / 核心运行时 / 玩法方案 / LLM 路由）（`src/core/`；`docs/architecture.md`）。
- **DSH 辅助剧本编辑**：生成 / 润色 / 一致性检查 / 扩开场（`src/dsh-story-bridge.ts`；`creator-workbench-*.ts`）。
- **崩溃安全**：状态变化一次 SQLite 事务提交（`src/core/state-transaction.ts`）。
- **开发者调试沙箱**：sandbox 协议 + worker 管理 / RPC（`src/debug/`）。

## 待实现 / 规划中

- **ST/MVU 兼容层**：ST 卡 → 可安装、版本化的 State Module（变量 / 自动化 / 世界书均为模块贡献）。当前为设计方向、部分落地（`src/compat/st-mvu.ts`），重度卡仍以文字导入为主。
- **安卓本地运行 APK**：完全本地运行的安卓形态（不依赖远程服务）。当前安卓 UI 有严重布局问题、暂不推荐使用；远程模式 APK / Termux 本地为实验性形态。
- **更丰富的剧情引擎**：在不破坏边界的前提下支持更灵活、可版本化的玩法定义与补丁。
- **社区扩展与皮肤 / 一键分享分发**：开放 UI 扩展机制与内容分发。
- **通用 Workflow 编排**：当前 Workflow Executor 负责固定定义的注册 / 投影 / 合法转换，不是通用自动业务编排器（见下文"当前限制"）。
- **独立模式 AI 编辑流**：创作者工作台的 AI 编辑（生成 / 润色 / 一致性检查 / 扩开场）当前依赖 dsh（`dsh-story-bridge`）。脱离 dsh 的"独立模式"AI 编辑流**尚未充分测试**，暂不保证可用。

## 技术栈

| 层      | 选型                                                                               |
| ------ | -------------------------------------------------------------------------------- |
| 运行时    | **Node.js ≥ 24**（脚本用 `node --experimental-strip-types` 直接跑 TS，**服务端无打包 / 编译步骤**） |
| 语言     | TypeScript（类型剥离执行，非 tsc 编译）                                                      |
| 服务端    | 原生 `node:http`                                                                   |
| 存储     | 原生 `node:sqlite`（SQLite，运行数据 `data/stagecraft.sqlite`）                           |
| 插件容器   | `@deepseek-ai/cordis` `4.0.0-rc.8`（npm 别名 `cordis`）                              |
| 配置校验   | `@deepseek-ai/schemastery` `3.18.1`                                              |
| 前端     | `public/` 下**原生 JS + CSS**（无前端框架）                                                |
| 安卓核心构建 | `esbuild` `0.28.2`（`scripts/build-android-core.mjs`）                             |

> 注意：早期文档曾设想 Fastify / Drizzle / React 技术栈，与现状不符，已归档（见 `custom/docs/archive/`）。

- **dsh 生态兼容（低成本）**：StageCraft 以 Cordis 宿主插件形态（`dsh-rp` / `cordis.patch.yml`，`runtimeMode: sandboxed`，`RP_PORT` 默认 8799）运行于 dsh 内。对 **dsh 依赖较低** 的外围功能性插件，可通过 `dsh-rp` 适配壳以**简单桥接**的方式接入，无需重写。

## 架构

核心循环：

```
State → Human Interaction / Workflow Action → Core → LLM Route
     → Model Result → State Event → Reducer / Local Rules → New State
```

**四层插件边界**（Core 是唯一状态权威）：

1. **人-核心交互插件**：Web / HTTP / Cordis Session / CLI 入口。只发 `HumanCommand`，只消费 `CoreView` / `CoreEvent`，**不直接碰 Store / 模型 / 领域流程**。
2. **核心运行时插件**：状态、Reducer、本地规则、审批、事件历史、取消 / 恢复、Command 调度。不依赖 HTTP / DOM / Cordis / 具体模型。
3. **玩法方案插件**（`CoreSolutionHost`）：注册固定、版本化的 Workflow Definition、只读房间投影、状态类别 / 投影、可撤销 Command Handler。默认 `StageCraftSolutionPlugin` 提供三条 StageCraft 流程、默认状态类别与群聊命令处理器。
4. **核心-LLM 路由插件**：负责 `ModelRequest` / `ModelResult`（provider 路由、SSE、thinking、usage、超时、request-scoped 取消、错误归一化）。以 `requestId` 等待匹配结果、隔离迟到结果。

**平台端口（Port）**：Core 通过小型端口使用时间、UUID、仓储、资源、秘密、文件选择、生命周期、模型传输。当前**已正式接入** `Clock`、`IdFactory`、`CoreStateRepository`；`AssetRepository` / `SecretStore` / `FilePicker` / `PlatformLifecycle` / `ModelTransport` 已定义稳定边界，**供后续 Human Plugin、Android 本地运行、UI Extension 阶段逐项接入**。Node / SQLite / HTTP 适配器在桌面组合根；浏览器 / 安卓可提供自身实现，**Core 源码不得直接依赖 Node 文件系统 / Android API / DOM / 平台密钥**。

**状态模型**：状态类别可注册（默认 room / world / entities / narrative / memory / goals / workflow / runtime）。所有变化统一为 `StateEvent`，由 Reducer / Local Rules 产生新状态；`applyStateEvents` 先计算候选状态，再由 Repository **一次 SQLite 事务**提交状态 + 批量事件 + WorkflowInstance，成功后才更新内存并广播。模型只能返回结构化结果或事件提议，**不能直接写库或绕过状态校验**。

**兼容策略**：群聊 / 导演 / 管理命令由已安装的 StageCraft Command Handler 接管；旧 HTTP 路由只构造带 scope / action 的 Core command。两条垂直流程由 `StageCraftChatService` / `StageCraftDirectorService` 持有，编辑由 `StageCraftManagementService` 持有。旧 `RoomRuntime` 仅作兼容 facade，生产组合根不安装 `LegacyRuntimeSolutionPlugin`。Core 对无 handler 命令 **fail closed**。

## 目录与关键入口

```
src/
  server.ts                  服务入口（node:http 启动）
  app-boot.ts                应用引导（装配组合根、挂载 Core / UI / DSH）
  core/                      运行时内核（插件容器、状态仓储、Workflow、协议、平台端口）
    index.ts, container.ts, plugins.ts, runtime.ts, protocol.ts
    state*.ts, workflow-*.ts, domain-events.ts
    http-human-plugin.ts, model-router-adapter.ts
    cordis-plugins.ts, extensions.ts, ui.ts, renderer-host.ts, connection.ts
    platform.ts              端口定义
  platform/                  Node 适配：node.ts, node-sqlite-repository.ts, composition.ts, model-gateway-transport.ts
  portable/                  android-core.ts, android-composition.ts（安卓本地组合根）
  stagecraft-*.ts            业务服务：chat / director / management / repository
  creator-*.ts              创作者工作台：service / ui / contracts / preview-apply
  dsh-*.ts                   dsh 桥接：story-bridge / story-session
  debug/                     沙箱协议、worker 管理（开发期）
  compat/                    兼容层：index.ts, st-mvu.ts（ST 卡 / MVU 兼容器，前瞻）
  legacy-sandbox.ts          旧 sandbox（兼容）
  store.ts, model-gateway.ts, workers.ts, room-runtime.ts, st-card-import.ts
  prompts.ts, provider-config.ts, thinking-params.ts, types.ts, remote-access.ts
android/                     安卓工程（远程模式 APK；本地运行在路线图中）
dsh-rp/                      dsh 适配壳（见其 README）
public/                      前端（原生 JS / CSS）
stories/eldoria.json         默认剧本
prompts/prompts.json         提示词分组（role / director / consult / skills / chat，共 5 组）
scripts/build-android-core.mjs
```

## 安装与运行

**要求**：Node.js **≥ 24**（低于 22.6 不支持类型剥离）。

```bash
# 推荐 pnpm（仓库带 pnpm-lock.yaml）
pnpm install
pnpm dev            # 即 node --experimental-strip-types src/server.ts

# 或使用 npm
npm install
npm run dev
```

启动后访问 `http://127.0.0.1:8787`。运行数据在 `data/stagecraft.sqlite`。

**模型配置**：把 `providers.example.json` 复制为 `providers.json`，填入你的模型端点与密钥（详见该文件注释）。

**测试**：

```bash
pnpm test           # node --experimental-strip-types --test --test-concurrency=8 test/*.test.ts
```

**作为 dsh 插件**：`dsh --profile <name>` 在 `RP_PORT`（默认 **8799**）启动，核心代码与独立运行一致，仅换入口。详见 `dsh-rp/README.md`。

**安卓**：

- 远程模式 APK（连接你自己的StageCraft服务）：构建产物见 `android/` 工程。
- Termux 本地跑：`bash start-android.sh`（脚本启动服务并打印局域网地址）；停止 `bash close-android.sh`。
- 本地运行核心构建：`pnpm build:android-core`（即 `scripts/build-android-core.mjs`）。

> ⚠️ 安卓端**暂时不推荐使用**：当前存在较严重的 UI 布局问题，尚未经充分实测。玩家向说明见 `docs/玩家看我.md` 的「怎么开始」。

> 注意：`custom/docs/` 目录**不进仓库**（已 ignore），里面是私有设计 / 交接 / 审计文档，请勿视为发布内容。

## 开发速览

- **状态权威在 Core**：任何要改状态的动作都走 Command → Core → StateEvent → 事务提交。不要绕过 Core 直接写 Store / 库。
- **扩展点**：新玩法通过 `CoreSolutionHost` 注册方案插件；UI 扩展走 `core/extensions.ts` + `core/ui.ts` + `renderer-host.ts`；模型接入走 LLM 路由插件。
- **兼容层**：ST 卡导入在 `st-card-import.ts`；旧接口 / 外部调用经 `compat/`。改动旧接口前先读 `docs/architecture.md` 的"兼容策略"与 `custom/docs/` 相关设计文档。
- **不要做的事**：Core 不得依赖 Node 文件系统 / Android API / DOM / 平台密钥；Workflow Definition 不允许被 LLM 或 Author Pack 直接修改（未来走版本化 `WorkflowPatchProposal` 且需授权校验）。
- **验证基准**：Cordis 锁定 `4.0.0-rc.8`，跟随 dsh 平台版本（`dsh-rp/verify.mjs` 校验 vendor 版本）。

## 当前限制

Core 通用内核、插件容器、状态仓储、Workflow Registry / Executor、HTTP 人机插件、LLM 路由边界已进入启动链；StageCraft 的 Store-backed domain services 仍是当前业务状态变化的执行者，并通过 Core 投影与事务仓储保持一致。Workflow Executor 当前负责固定定义的注册 / 投影 / 合法转换，**不是通用自动业务编排器**。未来仍需在不破坏边界的前提下继续收紧旧外部接口与迁移策略。
