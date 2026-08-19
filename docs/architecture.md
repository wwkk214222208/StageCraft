# StageCraft 架构

## 目标

StageCraft 采用固定 Workflow 的第一版运行时，同时为未来的可变 Workflow 保留版本与实例边界。核心循环为：

```text
State → Human Interaction / Workflow Action → Core → LLM Route
     → Model Result → State Event → Reducer / Local Rules → New State
```

## 插件边界

### 人-核心交互插件

负责 Web、HTTP、Cordis Session、CLI 等人机入口。它只发送 `HumanCommand`，只消费 `CoreView` 与 `CoreEvent`，不直接访问 Store、模型或领域流程。

### 核心运行时插件

负责状态、Reducer、本地规则、审批、事件历史、取消、恢复和 Command 调度；Workflow Registry/Executor 由 Core 提供，但具体玩法由方案插件注册。它是状态的唯一权威，不依赖 HTTP、DOM、Cordis 或具体模型供应商。

### 玩法方案插件

通过 `CoreSolutionHost` 注册固定、版本化的 Workflow Definition、只读房间投影（WorkflowInstance、InteractionRequest）、状态类别/状态投影和可撤销的 Command Handler。方案插件不访问 Store/RoomRuntime，也不能动态修改 Definition；安装和卸载是可撤销且按 owner 隔离的，默认 `StageCraftSolutionPlugin` 提供当前三条 StageCraft 流程、默认状态类别和群聊命令处理器。

### 核心-LLM 路由插件

负责 `ModelRequest` 与 `ModelResult`，包括 provider 路由、SSE、thinking 参数、usage、超时、request-scoped 取消和错误归一化。Core 以 requestId 等待匹配结果并隔离取消的迟到结果；它不决定房间阶段，也不直接修改状态。

## Workflow 边界

第一版 Workflow Definition 是固定的，由代码或方案包提供；Workflow Instance 是可持久化的运行状态。当前不允许 LLM 或 Author Pack 直接修改 Definition。

未来可通过版本化的 `WorkflowPatchProposal` 提议 Definition 变更，但必须经过校验和授权，且不能修改 Runtime Kernel 的事务、权限、取消和资源释放规则。

## 状态边界

状态类别不是固定领域表，而是可注册的类别。默认类别包括 room、world、entities、narrative、memory、goals、workflow 和 runtime，由 StageCraft 方案注册；其他方案可以增加、扩展或禁用自己的类别。Core State Repository 以一次 SQLite 事务保存状态快照、对应 StateEvent 和 WorkflowInstance，恢复时过滤未注册类别/Workflow Definition。

所有状态变化统一表现为 `StateEvent`，由核心 Reducer / Local Rules 处理后产生新的状态。`applyStateEvents` 与领域事件会先计算完整候选状态，再由 Repository 将状态、批量事件和当前 WorkflowInstance 一次事务提交；提交成功后才更新内存并广播。Core revision 由房间投影推进，事件 reducer 不单独递增 revision。模型只能返回结构化结果或事件提议，不能直接写数据库或绕过状态校验。

## 兼容策略

群聊、导演和管理/重启命令均由已安装的 StageCraft Command Handler 接管；旧 HTTP 路由只构造带 scope/action 或 operation 的 Core command。两条垂直流程分别由独立的 Store-backed `StageCraftChatService` 与 `StageCraftDirectorService` 持有，角色/房间编辑由独立的 `StageCraftManagementService` 持有，模型请求通过 Core LLM router 并保留非敏感 route/correlation metadata。生产组合根不安装 legacy runtime adapter；`RoomRuntime` 仅作为旧测试和外部兼容 facade。Core 对没有 handler 的命令 fail closed 并抛出可诊断错误。

## 当前完成状态与限制

Core Runtime 的通用内核、插件容器、状态仓储、Workflow Registry/Executor、HTTP 人机插件和 LLM 路由边界已经进入正式启动链；StageCraft 的 Store-backed domain services 仍是当前业务状态变化的执行者，并通过 Core 投影与事务仓储保持一致。Workflow Executor 当前负责固定定义的注册、投影和合法转换，不是通用的自动业务编排器。旧 RoomRuntime 业务 facade 只为兼容测试和外部调用保留；显式 `LegacyRuntimeSolutionPlugin` 也仅用于兼容场景，生产组合根不安装它。未来仍需在不破坏这些边界的前提下继续收紧旧外部接口和迁移策略。
