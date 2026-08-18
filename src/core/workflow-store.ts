import type { WorkflowInstance } from './protocol.ts'

export interface WorkflowInstanceStore {
  save(roomId: string, instance: WorkflowInstance): void
  list(roomId: string): WorkflowInstance[]
}
