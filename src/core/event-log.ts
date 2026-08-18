import type { StateEvent } from './protocol.ts'

/** Core Runtime 使用的最小事件日志端口，避免 core 直接依赖 SQLite Store。 */
export interface CoreEventLog {
  append(roomId: string, revision: number, event: StateEvent): void
  list(roomId: string, limit?: number): StateEvent[]
}
