# M8：可选官方 Core 运行层

M8 提供 `src/v2/official-core-runtime.ts`，把采用 StageCraft authoring SDK 的 Core 接到 M3 `HostCoreEntry`。创建 runtime 时只提供已验证的 Core 自身份；普通插件完全来自 boot 时 Host 传入的 `context.components`，不会静态缓存一份组件列表。它不是 Host–Core ABI 的组成部分：第三方 Core 仍然只需实现 `boot/invoke/shutdown`，也可以完全不使用官方插件 API。

运行层接收 Host 已验证的 `LoadedCoreComponent[]`，再次核对 M3 manifest 与 authoring default export 的 id、version、category 和 kind。组件依赖按 id/version 排序加载；必需依赖缺失和循环会在 Core ready 前失败，可选依赖缺失则跳过。

稳定操作名：

- `plugins/list`、`plugins/status`
- `solution/assemble`、`solution/command`（`solutionId` 多实例时必须显式提供）
- `llm/complete`、`llm/stream`（当前都收集为 chunk 数组）、`llm/cancel`、`llm/usage/query`、`llm/usage/aggregate`
- `tool/execute`、`ui/render`、`ui/dispose`
- `core/command`

LLM System 通过现有内存 harness 运行；选中的独立 `provider-driver` 组件作为 driver seed 注入 harness。Driver 只处理 LLM System 已决定的 provider/model/credential/messages，不获得全局路由或凭据存储权。Solution 的 `systemPrompt` 原样成为 system message，LLM 接收的 messages 由调用方/系统传入，不由 LLM 或 Driver 拼接。

停止时先取消并停止已启动的 LLM Systems，再停止 Core；所有停止操作都会尝试执行，最终以聚合错误报告失败。当前 UI、Tool 没有额外的通用启动/停止生命周期，UI 资源由 `ui/dispose` 显式释放。
