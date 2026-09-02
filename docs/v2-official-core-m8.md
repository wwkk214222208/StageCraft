# M8：可选官方 Core 运行层

M8 提供 `src/v2/official-core-runtime.ts`，把采用 StageCraft authoring SDK 的 Core 接到 M3 `HostCoreEntry`。创建 runtime 时只提供已验证的 Core 自身份；普通插件完全来自 boot 时 Host 传入的 `context.components`，不会静态缓存一份组件列表。它不是 Host–Core ABI 的组成部分：第三方 Core 仍然只需实现 `boot/invoke/shutdown`，也可以完全不使用官方插件 API。

运行层接收 Host 已验证的 `LoadedCoreComponent[]`，再次核对 M3 manifest 与 authoring default export 的 id、version、category 和 kind。组件依赖按 id/version 排序加载；必需依赖缺失、依赖环、identity/category 校验失败和 LLM harness 初始化失败会把该插件**隔离进 quarantined**（带原因，经 `listQuarantined()` 与 `plugins/status` 暴露），并沿 required dependency 边递归隔离所有依赖者。传给 inner Core 的 `components` 及 `listPlugins()` 只包含最终 active 集合，因此隔离组件及其依赖者不可达；可选依赖缺失则跳过。Core 自身身份或启动失败仍整体失败。

稳定操作名：

- `plugins/list`、`plugins/status`（`status` 返回 `{ plugins, quarantined }`）
- `solution/assemble`、`solution/command`（`solutionId` 多实例时必须显式提供）
- `llm/complete`、`llm/stream`（invoke 语义下聚合为 chunk 数组；传输层真流式经 HostCoreEntry 可选 `stream` 通道直通 harness，桌面由 `/api/v2/core/stream` 以 SSE 逐块转发）、`llm/cancel`、`llm/usage/query`、`llm/usage/aggregate`
- `llm/credential/set`、`llm/credential/list`（按 profileId 写入/查询 secret；list 只返回元数据与 `hasSecret` 标记，永不回传 secret）
- `config/get`、`config/update`（Core 配置区域：update 合并后经 host.storage 持久化；启动时与 options.config 合并回填，Core 的 start 上下文直接看到持久化配置）
- `tool/execute`、`ui/render`、`ui/dispose`
- `core/command`

LLM System 通过现有内存 harness 运行；选中的独立 `provider-driver` 组件作为 driver seed 注入 harness。Driver 只处理 LLM System 已决定的 provider/model/credential/messages，不获得全局路由或凭据存储权。Solution 的 `systemPrompt` 原样成为 system message，LLM 接收的 messages 由调用方/系统传入，不由 LLM 或 Driver 拼接。harness 接受可选持久化 store：credential profiles、usage 与 secrets 组成快照，经 host.storage 按组件命名空间（`llm-harness` 区域）读写，usage/secret 写入为 best-effort 不阻塞流；存储拒绝时优雅退化为内存行为。secrets 当前走参考路径明文存储（与 v1 providers.json 信任级别一致）；虽然 `secret.*` 是可用的原生能力，官方 v2 LLM reference 尚未切换到它。由于同一 WebView 中的第三方可以伪造 caller 并读取 host.storage，用户须自行承担风险；生产应迁移到平台秘密存储。

停止时先取消并停止已启动的 LLM Systems，并等待 harness 已排队的 persistence writes 完成，再停止 Core；所有停止操作都会尝试执行，最终以聚合错误报告失败。当前 UI、Tool 没有额外的通用启动/停止生命周期，UI 资源由 `ui/dispose` 显式释放。
