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

负责状态、Reducer、本地规则、审批、事件历史、取消、恢复和 Action 调度；Workflow Registry/Executor 由 Core 提供，但具体玩法由方案插件注册。它是状态的唯一权威，不依赖 HTTP、DOM、Cordis 或具体模型供应商。

### 玩法方案插件

通过 `CoreSolutionHost` 注册固定、版本化的 Workflow Definition、只读房间投影（WorkflowInstance、InteractionRequest）以及状态类别/状态投影。方案插件不访问 Store/RoomRuntime，也不能动态修改 Definition；安装和卸载是可撤销且按 owner 隔离的，默认 `StageCraftSolutionPlugin` 提供当前三条 StageCraft 流程和默认状态类别。

### 核心-LLM 路由插件

负责 `ModelRequest` 与 `ModelResult`，包括 provider 路由、SSE、thinking 参数、usage、超时、取消和错误归一化。它不决定房间阶段，也不直接修改状态。

## Workflow 边界

第一版 Workflow Definition 是固定的，由代码或方案包提供；Workflow Instance 是可持久化的运行状态。当前不允许 LLM 或 Author Pack 直接修改 Definition。

未来可通过版本化的 `WorkflowPatchProposal` 提议 Definition 变更，但必须经过校验和授权，且不能修改 Runtime Kernel 的事务、权限、取消和资源释放规则。

## 状态边界

状态类别不是固定领域表，而是可注册的类别。默认类别包括 room、world、entities、narrative、memory、goals、workflow 和 runtime，由 StageCraft 方案注册；其他方案可以增加、扩展或禁用自己的类别。Core State Repository 以一次 SQLite 事务保存状态快照、对应 StateEvent 和 WorkflowInstance，恢复时过滤未注册类别/Workflow Definition。

所有状态变化统一表现为 `StateEvent`，由核心 Reducer / Local Rules 处理后产生新的状态。`applyStateEvents` 与领域事件会先计算完整候选状态，再由 Repository 将状态、批量事件和当前 WorkflowInstance 一次事务提交；提交成功后才更新内存并广播。Core revision 由房间投影推进，事件 reducer 不单独递增 revision。模型只能返回结构化结果或事件提议，不能直接写数据库或绕过状态校验。

## 兼容策略

本阶段只增加协议和装配骨架，不替换现有 `RoomRuntime`、`Store`、HTTP 路由和 `WorkerSet`。现有 API 继续作为兼容适配层；后续再逐步让旧 facade 委托给 Core Runtime。
