import type { StateEvent, WorkflowInstance } from './protocol.ts'

/** Core 状态持久化的一次提交单元；实现必须以一个数据库事务保存全部字段。 */
export interface CoreStateCommit {
  roomId: string
  revision: number
  state: Record<string, unknown>
  events: StateEvent[]
  workflows: WorkflowInstance[]
}

export interface CoreStateRestore {
  roomId: string
  revision: number
  state: Record<string, unknown>
  events: StateEvent[]
  workflows: WorkflowInstance[]
}

/** 框架无关的 Core 状态仓储端口；Core 不感知 SQLite、Store 或 RoomRuntime。 */
export interface CoreStateRepository {
  commit(snapshot: CoreStateCommit): void
  restore(roomId: string, eventLimit?: number): CoreStateRestore | undefined
}
