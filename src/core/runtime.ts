import type { RoomSnapshot } from '../types.ts'
import { defaultStateCategories, projectRoomSnapshot, roomSnapshotEvent, type StateCategoryDefinition } from './state.ts'
import {
  CORE_PROTOCOL_VERSION,
  type CoreEvent,
  type CoreEventListener,
  type CoreRuntimePort,
  type CoreView,
  type HumanCommand,
  type ModelResult,
  type StateEvent,
  type WorkflowDefinition,
  type WorkflowInstance,
} from './protocol.ts'

/**
 * Phase 1 的核心运行时骨架。
 *
 * 它暂时不替换 RoomRuntime：旧业务仍由 RoomRuntime/Store 执行；该类先提供
 * 稳定的 Core Command/Event/View 边界，后续 workflow facade 再逐步迁移到这里。
 */
export class CoreRuntimeSkeleton implements CoreRuntimePort {
  private revision = 0
  private state: Record<string, unknown> = {}
  private readonly workflows = new Map<string, WorkflowInstance>()
  private readonly interactions = new Map<string, import('./protocol.ts').InteractionRequest>()
  private readonly actions: import('./protocol.ts').CoreAction[] = []
  private readonly recentEvents: StateEvent[] = []
  private readonly listeners = new Set<CoreEventListener>()
  private readonly definitions = new Map<string, WorkflowDefinition>()
  private readonly categories = new Map<string, StateCategoryDefinition>(defaultStateCategories.map(category => [category.id, category]))

  registerCategory(category: StateCategoryDefinition): void {
    if (!category.id.trim()) throw new Error('State category id is required.')
    if (this.categories.has(category.id)) throw new Error(`State category already registered: ${category.id}`)
    this.categories.set(category.id, category)
  }

  projectRoom(room: RoomSnapshot, causedBy = 'legacy-room-runtime'): void {
    this.state = projectRoomSnapshot(room).categories
    this.revision = room.revision
    this.recentEvents.push(roomSnapshotEvent(room, causedBy))
    while (this.recentEvents.length > 100) this.recentEvents.shift()
    this.emit({ type: 'state.changed', revision: this.revision, transition: { revision: this.revision, events: [roomSnapshotEvent(room, causedBy)], changes: [] } })
  }

  registerWorkflow(definition: WorkflowDefinition): void {
    if (!definition.id || !definition.version || !definition.initialStep) throw new Error('Invalid workflow definition.')
    if (!definition.steps[definition.initialStep]) throw new Error(`Workflow initial step is missing: ${definition.initialStep}`)
    if (this.definitions.has(definition.id)) throw new Error(`Workflow already registered: ${definition.id}`)
    this.definitions.set(definition.id, definition)
  }

  async dispatch(command: HumanCommand): Promise<void> {
    // 第一阶段只保留协议入口；旧 Runtime facade 仍是实际业务执行者。
    this.emit({ type: 'error', revision: this.revision, message: `Core command is not wired yet: ${command.type}` })
  }

  async submitModelResult(result: ModelResult): Promise<void> {
    this.emit({ type: 'model.completed', revision: this.revision, result })
  }

  getView(): CoreView {
    return {
      protocolVersion: CORE_PROTOCOL_VERSION,
      revision: this.revision,
      state: structuredClone(this.state),
      workflows: [...this.workflows.values()].map(workflow => structuredClone(workflow)),
      interactions: [...this.interactions.values()].map(interaction => structuredClone(interaction)),
      actions: structuredClone(this.actions),
      availableCommands: [],
      recentEvents: structuredClone(this.recentEvents),
    }
  }

  subscribe(listener: CoreEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async cancel(_requestId?: string): Promise<void> {
    // 取消语义将在 Workflow Executor 接入后实现；接口先固定下来供 adapter 使用。
  }

  protected appendStateEvents(events: StateEvent[]): void {
    this.revision += 1
    this.recentEvents.push(...events)
    while (this.recentEvents.length > 100) this.recentEvents.shift()
    this.emit({
      type: 'state.changed',
      revision: this.revision,
      transition: { revision: this.revision, events, changes: [] },
    })
  }

  private emit(event: CoreEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
