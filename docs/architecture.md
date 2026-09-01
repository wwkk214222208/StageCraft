# StageCraft 架构手册（施工 AI 必读）

> **本文是架构的权威来源（`docs/` 层）**。`custom/docs/` 中的设计 / 评审 / 证据文档仅供参考，
> 与本文或代码冲突时以**代码 + 本文**为准，并回补本文。
> 施工 AI 动工前**必须通读本文**。本文覆盖：分层与状态事务、运行时拓扑与事件发射点、路由宪法、
> 组合根与启动链、并发 / 流式 / 跨端约束、验证命令与动工清单。
> 事实来源：`src/core/protocol.ts`（事件类型）、`src/api-route-registry.ts`（路由宪法）、
> `src/core/runtime.ts`（状态事务）、`src/portable/android-composition.ts`（Android 权威事件源）、
> `src/app-boot.ts`（桌面组合根）。

## 说明：v1 shipping 与 v2 参考路径

本文主体描述当前仍在发布的 v1 运行时与插件契约。v2 的可替换 Core、M3 组件 manifest、桌面 Host 与 Android Component Store 已实现到 M9（2026-09-02 收尾：逐能力授权、LLM 持久化、插件级隔离、传输层真流式、桌面 UI 挂载/恢复入口/loopback token 防护，详见各 v2 文档），但仍是实验性、未冻结的参考路径；请结合 [`architecture-v2-proposal.md`](./architecture-v2-proposal.md) 与 [`v2-migration-and-usage.md`](./v2-migration-and-usage.md) 阅读。文中 legacy LLM router 不等同于 v2 LLM System：v2 的 Provider Driver 只是供应商适配，Solution 负责 system prompt/prompt assembly。

---

## 0. 一句话定位

StageCraft 是一个**自托管、插件化、多角色角色扮演（RP）运行时 + Web 工作台**：

- 运行形态：① 独立 Node 服务；② 作为 **dsh 插件**（`dsh-rp` 适配壳）；③ 安卓远程模式与同 APK 本地 Core 模式（本地模式仅 FOA-AL00 / API 31 有真机证据，实验性）。
- 技术栈：**Node.js ≥ 24**（`node --experimental-strip-types` 直跑 TS，**无打包 / 编译步骤**）、原生 `node:http`、原生 `node:sqlite`（`data/stagecraft.sqlite`）、`@deepseek-ai/cordis` `4.0.0-rc.8`、`public/` 下**原生 JS + CSS**（无前端框架）。
- dsh 只是**可选的宿主 / 维护入口**，不是实现基础。核心运行时不依赖 Cordis / HTTP / DOM / 具体模型（详见归档的 `custom/docs/archive/why-not-dsh.md`）。

核心循环：

```text
State → Human Interaction / Workflow Action → Core → LLM Route
     → Model Result → State Event → Reducer / Local Rules → New State
```

---

## 1. 四层插件边界（先读）

Core 是**唯一状态权威**。任何要改状态的动作都走 **Command → Core → StateEvent → 事务提交**，不要绕过 Core 直接写 Store / 库。

| 层 | 职责 | 约束 |
|---|---|---|
| **人-核心交互插件** | Web / HTTP / Cordis Session / CLI 入口。只发 `HumanCommand`，只消费 `CoreView` / `CoreEvent` | **不直接访问 Store、模型或领域流程** |
| **核心运行时插件** | 状态、Reducer、本地规则、审批、事件历史、取消 / 恢复、Command 调度。Workflow Registry/Executor 由 Core 提供，玩法由方案插件注册 | 不依赖 HTTP / DOM / Cordis / 具体模型；状态的唯一权威 |
| **玩法方案插件** | 经 `CoreSolutionHost` 注册固定、版本化的 Workflow Definition、只读房间投影（WorkflowInstance、InteractionRequest）、状态类别 / 投影、可撤销的 Command Handler。默认 `StageCraftSolutionPlugin` 提供三条 StageCraft 流程（`stagecraft.chat.speech` / `stagecraft.chat.director` / `stagecraft.director.turn`）、默认状态类别与群聊命令处理器 | 不访问 Store / RoomRuntime；不能动态修改 Definition；安装 / 卸载可撤销且按 owner 隔离 |
| **核心-LLM 路由插件** | `ModelRequest` / `ModelResult`：provider 路由、SSE、thinking 参数、usage、超时、request-scoped 取消、错误归一化 | 以 `requestId` 等待匹配结果并隔离取消的迟到结果；不决定房间阶段、不直接修改状态 |

> 关键文件：`src/core/plugins.ts`（插件类型）、`src/core/container.ts`（插件容器）、`src/core/runtime.ts`（CoreRuntimeSkeleton）、`src/core/solutions.ts`（默认方案与三条 Workflow）。

---

## 2. 状态模型与事务（改状态必读）

### 2.1 状态类别可注册

状态类别不是固定领域表。默认类别（`src/core/state.ts`）为 **room / world / entities / narrative / memory / goals / workflow / runtime**，由 StageCraft 方案注册；其他方案可增加 / 扩展 / 禁用自己类别。Core State Repository 以一次 SQLite 事务保存状态快照、对应 StateEvent 和 WorkflowInstance，恢复时过滤未注册类别 / Workflow Definition。

### 2.2 所有变化统一为 StateEvent

- 所有状态变化统一表现为 `StateEvent`（`src/core/protocol.ts`：`{ id, type, source: player|llm|rule|plugin|system, payload, causedBy?, workflowId?, createdAt }`）。
- 由核心 Reducer / Local Rules 处理产生新状态。**模型只能返回结构化结果或事件提议，不能直接写数据库或绕过状态校验。**
- `applyStateEvents` 与领域事件会先计算完整候选状态（reducer 失败不替换当前 state），再由 Repository **一次事务**提交状态 + 批量事件 + 当前 WorkflowInstance；提交成功后才更新内存并广播。
- Core revision 由房间投影推进，事件 reducer **不单独递增 revision**。
- 未安装方案时 Core 保持空白；对没有 handler 的命令 **fail closed** 并抛出可诊断错误。

> 实现：`src/core/state-transaction.ts`（`transactState`：模块路径校验、JSON-safe 校验、断言、reducer 级联、schema 校验、单事务提交）、`src/core/state-repository.ts`、`src/core/event-log.ts`。
> 事务规则（`runtime.ts`）：state patch / 断言 / reducer 只能操作 `/modules/<moduleId>` 或已注册类别路径；嵌套事务禁止；事件 id 去重；级联深度 / 事件数有上限。

### 2.3 兼容投影

`RoomSnapshot`（旧 Store-backed 领域服务的形状）经 `projectRoomSnapshot` **只读投影**为 Core State categories（`src/core/state.ts`），不改变旧快照形状，也不把内部 SQLite 字段暴露给 adapter。

---

## 3. 平台端口（Port）

Core 通过小型平台端口使用时间、UUID、仓储、资源、秘密、文件选择、生命周期和模型传输能力（`src/core/platform.ts`）。

- **已正式接入**：`Clock`、`IdFactory`、`CoreStateRepository`，以及 Android 本地的资源 / 秘密 / 模型传输端口。
- Node 文件资源适配器仍在 Core 之外，且限制所有路径不能逃逸资源根目录。
- 默认桌面组合根使用 Node / SQLite / HTTP 适配器（`src/platform/`）；浏览器与 Android 提供自己的实现，**不需要复制 Core、Workflow、审批或状态事务逻辑**。
- **Core 源码不得直接依赖 Node 文件系统 / Android API / DOM / 平台密钥存储。**

---

## 4. 运行时拓扑与事件发射点（施工 AI 硬约束 ⚠️）

> 本节来自 `DRAFT-事件流与运行时拓扑契约`（已归档至 `custom/docs/archive/`）的教训：2026-08-31 的
> thinking 字符重复 + 草稿卡死 bug 由 4 条重复发射通道在 4 天内分别埋入，谁也没清理前面的人。
> **施工 AI 只能看到自己模块里最显眼的那条发射点，看不到全局 —— 所以本文把"每种事件唯一权威发射器"写成铁律。**

### 4.1 三种运行时模式

| 模式 | 标志 | 承载 Core | 权威事件源 | 禁用 / 注意 |
|---|---|---|---|---|
| 桌面（非本地） | `window.__STAGECRAFT_LOCAL__` 为假 | 主进程 Core / HTTP | `/api/core/events`（1.1 envelope）或旧 `/api/stream`（桌面仍开） | — |
| Android 本地·非 gateway | `__STAGECRAFT_LOCAL__=true`，`gateway`≠`1` | 页面内 Core（`embedded-core.js` → `android-composition.ts`） | 嵌入式 Core 事件总线 | `local-runtime-web-entry.js` `if (!gatewayMode) core.start(...)` |
| Android 本地·gateway | `__STAGECRAFT_GATEWAY__` 存在且 `gateway`≠`0` | `:core` 进程（`CoreGatewayServer`） | `:core` Core Event 通道（`:core` SSE） | 页面内 Core 被 `if (!gatewayMode) core.start` **禁用**；`requirePageCore()` 守卫，误用抛错兜底；旧 `/api/stream` 在此模式返回 410 |

**铁律前提：每个模式下，每种 CoreEvent 有且仅有一个权威发射器。** 新增模式（进程服务化 / 网关 / 运行时切换）必须显式声明"本模式下谁是权威源、谁被禁用"。

### 4.2 CoreEvent 发射点登记表（动工前必须对账）

> 施工 AI 动工前必须在此对账：本任务涉及的每个事件，是否违反了"唯一权威发射器"。

| 事件 | 唯一权威发射器 | 禁止重复发射 | 备注 |
|---|---|---|---|
| `model.thinking.delta`（思维链增量） | `src/portable/android-composition.ts` → `NativeCoreLlmRouter.request()` 内 `onThinking` 回调：`publish({ type:'model.thinking.delta', requestId, text, sequence: ++sequence, ...correlation })`（带单调递增 `sequence`） | ① `core-host-bridge.js` 不得再转 legacy `thinking`（`if (message.type==='thinking') return null` 拦截）；② `local-runtime-web-entry.js` service 层 `publish('thinking')` 已删除；③ 本地模式不开旧 `/api/stream`（`public/app.js` `if (!window.__STAGECRAFT_LOCAL__)`） | 前端按 `requestId + sequence` 去重，`actor:requestId` 防跨请求串流 |
| `model.thinking.completed` | 同 `NativeCoreLlmRouter`（结果完成时，带 `requestId?`，见 `protocol.ts`） | 与上同源，禁止任何层二次转发 | — |
| `model.started` / `model.completed` | `NativeCoreLlmRouter.request()`：`model.started`（`publish`）建立 `requestId→{roomId,turnId,actor,roleId}` 上下文；`model.completed` 由 `host.submitModelResult(...)` 收尾 | 缺 `model.started` 会导致 delta 因查不到上下文而不被转发（Android"无法即时显示流式思维链"） | — |
| `state.changed` | Core 内核 `transactState` / `projectRoom`（`src/core/runtime.ts`），经 `CoreRuntimeSkeleton.emit` 广播 | 组合根 / bridge / 前端不得自行构造第二份 `state.changed` | 提交成功后才 emit |
| `workflow.changed` / `interaction.created` | Core 内核 `projectRoom`（`runtime.ts`） | — | 与 `state.changed` 同批 emit |
| `ui.manifest.changed` | `UiExtensionRegistry`（`src/core/ui.ts`） | — | 声明式 UI 扩展投影 |

### 4.3 铁律（违反即打回）

1. **先对账再动手**：新增 / 改写任一 CoreEvent 发射点前，先在 §4.2 登记表对账，确认**不引入第二个发射器**。
2. **跨模式必须枚举**：凡是"进程服务化 / 网关 / 运行时切换"级改动，必须列出受影响的所有模式（桌面 / Android 非 gateway / Android gateway），逐一核对各模式权威源与禁用项。
3. **"再发一次"先三问**：任何"转发一次 / 再 publish 一次"的冲动，先问——① 谁是权威发射器？② 我这条是不是第二个？③ 前端 / 网关会不会因此重复？
4. **提交前跑契约测试**：见 §8 验证清单，缺测试不许合。

### 4.4 事件包与协议版本

- `CoreEventEnvelope`（1.1）：`{ protocolVersion, roomId, revision, turnId?, requestId?, type, payload: CoreEvent, createdAt }`。
- HTTP/SSE 边界按客户端 `x-core-protocol-version` 输出：1.1 客户端收 envelope / receipt，1.0 客户端收旧 CoreEvent 与 `{ok:true,view}`；缺省按 1.0。
- 协议版本：`CORE_PROTOCOL_VERSION = '1.1'`，支持窗口 `1.0..1.1`；同 APK 本地连接要求精确匹配，远程连接落在 `[min,max]` 即可。
- **身份四件套不得混用**：`transportId`（外部请求）、`requestId`（模型请求）、`turnId`（回合作用域）、`revision`（状态作用域）。
- `CommandReceipt`：断线发生在提交之后时标记 `unknown-after-disconnect`，**禁止自动重放**。

---

## 5. 路由宪法（API 契约）

> 权威来源：`src/api-route-registry.ts`。**新增 / 修改 / 删除路由必须遵循 `docs/CONTRIBUTING-API.zh.md`**（三层结构：运行时契约 / 治理层 / 行为测试）。

- **`src/api-route-registry.ts` 是全部 `/api/*` 路由的唯一事实来源**；每条 `(method, pattern)` 只有一个 owner。
- owner 决定分派：`core`（代理到 Core）/ `main-host`（宿主 handler）/ `desktop-only`（Android 返回稳定 `unsupported_capability`）/ `deprecated`（迁移 adapter）。`authPolicy` / `dispatchPolicy` **按 owner 自动派生**，禁止逐路由手写漂移。
- 构建期由 `scripts/generate-api-route-registry.mjs` 生成**确定性排序**的 `android/app/src/main/assets/api-route-registry.json`（Java gateway 消费），`test/api-route-registry.test.ts` 强制与生成器逐字节一致。**改路由必须重生成并提交 JSON。**
- native 操作（JS bridge）：`src/native-operation-registry.ts`，`core-native` 与 `main-host` 两份 allowlist **必须不相交**；新操作不要标 `legacy-main-core`。
- **note 只写行为**；治理数据（Gate/工单/期限/裁决）一律进 `governance/api-governance.ts`，运行时与资产生成器**永不 import** 治理层。

---

## 6. 组合根与启动链

### 兼容策略

- 群聊 / 导演 / 管理 / 重启命令均由已安装的 StageCraft Command Handler 接管；旧 HTTP 路由只构造带 scope / action 或 operation 的 Core command（`app-boot.ts` 的 `dispatchManagement` / `dispatchRestart`）。
- 两条垂直流程分别由独立的 Store-backed `StageCraftChatService` 与 `StageCraftDirectorService` 持有，角色 / 房间编辑由独立的 `StageCraftManagementService` 持有；模型请求通过 Core LLM router 并保留非敏感 route / correlation metadata。
- 生产组合根不安装 legacy runtime adapter；`RoomRuntime` 仅作为旧测试和外部兼容 facade，`LegacyRuntimeSolutionPlugin` 仅用于兼容场景。
- Core 对没有 handler 的命令 **fail closed** 并抛出可诊断错误。

### 6.1 桌面组合根（`src/app-boot.ts`）

`startTavern(options)` 装配：

1. Cordis `Context`（独立模式新建；DSH 传入宿主 Context）。
2. 数据目录：`userDataRoot`（DSH 插件形态 = AppData）下 `stories/save/data/prompts`；bundle 默认剧本首次拷贝到用户数据。
3. `NodeSqliteRepository`（`data/stagecraft.sqlite`，含旧库 `character-tavern.sqlite` 更名迁移）。
4. `ProviderConfigStore`（`data/providers.json`；占位符 apiKey 视为未配置 → 默认群聊模式）。
5. `CoreRuntimeSkeleton` + `DefaultCorePluginContainer` + `HttpHumanCorePlugin` + `RoomRuntime`（兼容 facade）+ `StageCraftSolutionPlugin` + `StoreCoreStateRepository`。
6. `createStageCraftService(core, roomId, container, repository => core.attachStateRepository(repository))` —— 把 Store-backed 领域服务（chat / director / management）接到 Core。
7. `core.restoreState(roomId)` + `core.projectRoom(initialRoom, ...)`（恢复后仍提交一次：事件 `INSERT OR IGNORE` 幂等，内存投影与 Repository 保持一致）。
8. 有真实 provider 时 `installProvider`（`ModelGatewayRouterAdapter` + `createRealWorkers`，模型请求经 `core.requestModel` / `core.cancel`）。
9. `createServer`：远程访问授权（非 loopback 需配对；**adb reverse 隧道以 loopback 呈现，经 `/api/remote/device-token` 免配对码直发会话**）→ 旧业务路由 → `humanCore.handle(...)`（`/api/core/*` 协议端点）。

> 关键路由语义：`/api/remote/sync`（仅配对后可达，含 API Key）、`/api/remote/device-token`（仅本机回环
> = adb reverse 隧道可达，免配对码直发会话 token，供手机 ADB 免码绑定）、`/api/state/rollback` / `branch`
> （先存档再按 revision 截断，仅 `awaiting-player-input` 可执行）、`/api/creator/*`（预览→应用→回滚，基线冲突校验）、
> `/api/agent/*`（DSH 会话，独立模式 503）。

### 6.2 Android 本地组合根

- 非 gateway：页面内 Core（`embedded-core.js` → `android-composition.ts`），`local-runtime-web-entry.js` 把 fetch / EventSource 桥接到本地运行时。
- gateway：`:core` 进程 `CoreGatewayServer` 按 registry 分派；页面 fetch 直通同源 gateway；`core-host-bridge.js` 经 WebMessagePort 与 `:core` 通信，**不含业务路由**。
- 旧 `RoomRuntime` 业务 facade 只为兼容测试和外部调用保留；生产组合根不安装 `LegacyRuntimeSolutionPlugin`。

### 6.3 dsh 宿主形态

`dsh-rp/`：同一份业务实现打包为 Cordis bundle（`runtimeMode: sandboxed`，`RP_PORT` 默认 8799），dsh 只做 supervisor。`dsh-rp/verify.mjs` 校验 vendor 版本（Cordis 锁定 `4.0.0-rc.8`）。

---

## 7. 并发 / 流式 / 跨端约束（改这些必读）

- **新行为先在共享 Core / handler 定义**，再接入 Node、Android 本地和 Android 远程 adapter；不在 Android shim 复制桌面业务规则。
- 每个共享行为至少有成功 / 空态 / 错误 / 取消（迟到，适用时）fixture。
- 流式修复必须同时检查：逐块投递、客户端断开、上游取消、迟到结果、revision 和 active operation 清理。
- **导演模式必须单独验证**；普通 chat 测试不能替代导演路径。
- 取消语义：重试只重新调用 Director，不重复角色决策；取消清理当前未发布回合并回到输入阶段；迟到的异步结果必须被忽略；不得把失败内容发布为公共事实。
- 角色决策分为 `required / optional / excluded`：`excluded/abstained` 正常；`optional/unavailable` 角色失败但 Director 可继续；`required/unavailable` 阻止 Director。每个失败 Decision 必须保存 `error`。
- 模型输出是不可信输入，必须在 Worker 边界校验（字段别名归一化、默认值填充、最小工具协议重试一次、两次失败后保存明确错误）。

---

## 8. 验证命令（提交前）

```bash
# 全量行为测试（约 2 分钟；并发可能挂起，必要时 --test-concurrency=1）
pnpm test

# 治理检查（独立于运行时测试）
node --experimental-strip-types scripts/check-governance.mjs

# 前端 / 服务端语法检查
node --check public/app.js
node --experimental-strip-types --check src/server.ts

# 改动路由 / native 操作后重生成 Android 资产（必须提交 JSON）
node --experimental-strip-types scripts/generate-api-route-registry.mjs
node --experimental-strip-types scripts/generate-gatebc-assets.mjs

# 改了 Java / 资产时：Android JVM 测试
cd android
$env:JAVA_HOME = "D:\AI\AIRP\character-tavern\.toolchains\jdk-extract\jdk-17.0.20+8"
$env:GRADLE_USER_HOME = "D:\AI\AIRP\character-tavern\.gradle-home"
./gradlew :app:testDebugUnitTest

# 平台认证（可选，含 --skip-gradle）
node scripts/certify-platform.mjs
```

**增量规范**：所有后续修改遵循 `docs/INCREMENTAL-UPDATE-WORK-RULES.zh.md`（变更分类、证据格式、评审等级 P0/P1/P2、并发合流规则）。测试未执行时写 `未执行` 或 `skip`，不得写成通过。

---

## 9. 施工 AI 动工前清单（checklist）

- [ ] 已读本文 + `src/core/protocol.ts` + `src/api-route-registry.ts`（改路由时 + `docs/CONTRIBUTING-API.zh.md`）
- [ ] 已在 §4.2 登记表对账本任务涉及的每个事件（确认未新增第二个发射器，跨模式已枚举）
- [ ] 状态修改走 Command → Core → StateEvent → 事务提交，未绕过 Core
- [ ] 未违反 §3 平台端口约束（Core 不依赖 Node fs / Android API / DOM / 平台密钥）
- [ ] 契约测试 / 相关单测通过；生成物（registry / assets）已重生成并提交
- [ ] 无遗留死代码（参考 §4.4 与归档 DRAFT 的债务清单）

---

## 10. 目录速查

```
src/
  server.ts                  服务入口（node:http 启动；startTavern 失败时进入插件管理恢复模式）
  app-boot.ts                应用引导（桌面组合根：经 PluginBootstrap 装配 Core / UI / DSH）
  core/                      运行时内核（容器、状态仓储、Workflow、协议、平台端口）
    protocol.ts              CoreEvent / HumanCommand / Workflow / ModelRequest 类型（事件真相）
    runtime.ts               CoreRuntimeSkeleton（状态事务、投影、emit 广播）
    state-transaction.ts     状态事务引擎（单事务提交）
    state.ts                 默认状态类别与 RoomSnapshot 投影
    solutions.ts             默认方案：三条 Workflow + 群聊/导演/管理端口
    http-human-plugin.ts     HTTP 人机插件（/api/core/* + SSE envelope）
    platform.ts              端口定义（Clock / IdFactory / ...）
  plugin-contract.ts         插件契约：manifest / 状态 / 隔离记录 / LaunchPlan / 存档依赖快照 / ConfigStore
  plugin-bootstrap.ts        引导层（唯一深度校验实现）：manifest 校验、依赖拓扑、provides 预检、单插件失败隔离
  plugin-config-store.ts     插件配置存储（独立于 Core；内存 + Node 文件实现）
  plugin-manifests.ts        桌面内置插件候选集（与 Android BUILTIN_PLUGIN_MANIFESTS 同契约）
  plugin-admin.ts            管理层（D2）：状态聚合、启用意图、存档依赖提示、/admin/plugins 兜底页
  plugin-fallback-server.ts  桌面恢复模式兜底服务器（startTavern 失败时仍可管理插件；不 import 主运行时）
  platform/                  Node 适配：node.ts, node-sqlite-repository.ts, composition.ts, model-gateway-transport.ts
  portable/                  android-core.ts, android-composition.ts（Android 本地组合根 + 权威事件源）
  stagecraft-*.ts            业务服务：chat / director / management / repository
  creator-*.ts              创作者工作台
  dsh-*.ts                   dsh 桥接
  api-route-registry.ts      路由宪法（唯一事实来源）
  native-operation-registry.ts  native 操作（JS bridge）注册
android/                     安卓工程（远程模式 + 同 APK 本地独立 Core）
dsh-rp/                      dsh 适配壳（supervisor 模式）
public/                      前端（原生 JS / CSS）
stories/                     剧本（bundle 默认；用户数据在 <userDataRoot>/stories）
prompts/gameplay/            玩法场景提示词（userEditable=true 才下发）
governance/                  治理数据（裁决/工单/期限；不进运行时）
```

---

## 11. 当前完成状态与限制

- Core 通用内核、插件容器、状态仓储、Workflow Registry/Executor、HTTP 人机插件、LLM 路由边界已进入正式启动链；StageCraft 的 Store-backed domain services 仍是当前业务状态变化的执行者，并通过 Core 投影与事务仓储保持一致。
- **插件管理器已闭环（D1/D2/D3）**：桌面组合根经 `plugin-bootstrap.ts` 装载内置插件（§6.3：manifest 校验 / 依赖拓扑 / provides 预检 / 单插件失败隔离——坏插件只进 quarantined，不再拖垮启动）；配置存独立 `PluginConfigStore`（`<dataDir>/plugins.json`，Core 未启动仍可读写）；管理面 = 主工作台「插件」面板（`/api/plugins`，Android 走 native 桥等价通道）+ `/admin/plugins` 兜底页；`server.ts` 在 `startTavern` 失败时进入恢复模式（兜底链不 import 主运行时，有契约测试强制）。D1：改动启用状态重启生效，不做热加载。D3（2026-09-01 拍板弱化）：存档导出写插件依赖快照（`plugins` 字段），导入前经 `/api/archive/check` 提示缺失/不兼容，**只提示、不阻断**（无"禁止产生新剧情"放行门）。
- Android 同 APK 独立 Core、Gateway、PluginManager 和恢复链已完成主体施工，当前仅有 **FOA-AL00 / API 31** 真机证据；其他版本 / release 变体 / 多设备矩阵未验证，不承诺兼容。
- Workflow Executor 当前负责固定定义的注册 / 投影 / 合法转换，**不是通用自动业务编排器**；LLM 或 Author Pack 不允许直接修改 Definition（未来走版本化 `WorkflowPatchProposal` 且需授权校验）。
- 兼容层：ST 卡导入在 `st-card-import.ts`；ST/MVU 兼容器在 `src/compat/st-mvu.ts`（前瞻、部分落地）；旧接口 / 外部调用经 `compat/`。
- 创作者工作台的 AI 编辑（生成 / 润色 / 一致性检查 / 扩开场）当前依赖 dsh（`dsh-story-bridge`）；脱离 dsh 的独立模式暂不保证可用。
- **ADB 免码直连**：手机经 `adb reverse tcp:8787 tcp:8787` 把本机回环映射到电脑后，`POST /api/remote/device-token`
  以 loopback 身份免配对码直发会话 token（与配对码同一会话表）；配对码通道完整保留，二者互不影响。
