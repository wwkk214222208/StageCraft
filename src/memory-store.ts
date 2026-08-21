import type { InitialMemory, NpcMemory } from './types.ts'

/**
 * 可插拔的记忆数据源端口。
 *
 * StageCraft 的运行时记忆（NpcMemory）通过此端口读写，Store 的 SQLite 实现是默认 adapter。
 * 替换记忆存储（内存 / 文件 / 远程服务 / 向量库）时，实现本接口并注入 startTavern 的
 * memoryStore 选项即可，业务服务与状态序列不感知底层引擎。
 *
 * 状态序列（core_state_snapshots）不内联记忆值，只存 roleId 引用；回溯恢复时经本端口
 * 重新读取记忆，因此记忆引擎可换而快照不变。
 */
export interface MemoryStore {
  /** 列出某角色的记忆（默认只看 active；includeInactive 含已撤回/替代的历史记录） */
  listNpcMemories(roomId: string, roleId: string, includeInactive?: boolean): NpcMemory[]
  /** 追加记忆记录（digest 消化 / 手动 / 剧本 seed 共用） */
  insertNpcMemories(roomId: string, roleId: string, entries: Array<{ id: string; sceneId?: string; turnId?: string; worldChangeId?: string; occurredAt: string; occurredLocation?: string; source: import('./types.ts').MemorySource; text: string }>): void
  /** 撤回（软删）一条记忆 */
  retractNpcMemory(roomId: string, memoryId: string): void
  /** 更新记忆正文/时间 */
  updateNpcMemory(roomId: string, memoryId: string, entry: { text?: string; occurredAt?: string }): void
  /** 调整记忆顺序 */
  reorderNpcMemories(roomId: string, roleId: string, memoryIds: string[]): void
  /** 替代一条记忆（旧记标记 superseded，写入新记录） */
  supersedeNpcMemory(roomId: string, memoryId: string, replacement: { id: string; text: string; occurredAt: string }): void
  /** 剧本 seed：把初始记忆写入结构化记录 */
  seedNpcMemories(roomId: string, roleId: string, memories?: InitialMemory[]): void
}
