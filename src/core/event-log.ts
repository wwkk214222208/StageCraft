import type { StateEvent } from './protocol.ts'
import type { DomainEvent } from './domain-events.ts'

/** Core Runtime 使用的最小事件日志端口，避免 core 直接依赖 SQLite Store。 */
export interface CoreEventLog {
  append(roomId: string, revision: number, event: StateEvent): void
  appendDomain(roomId: string, revision: number, event: DomainEvent): void
  list(roomId: string, limit?: number): StateEvent[]
  listDomain(roomId: string, limit?: number): DomainEvent[]
}
