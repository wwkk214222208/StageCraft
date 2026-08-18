import type { RoomSnapshot } from '../types.ts'
import { defaultStateCategories, projectRoomSnapshot, roomSnapshotEvent, type StateCategoryDefinition } from './state.ts'
import type { RoomRuntime } from '../room-runtime.ts'
import { dispatchLegacyCommand } from './command-adapter.ts'
import { chatDirectorWorkflow, chatSpeechWorkflow, directorTurnWorkflow, interactionFromRoom, workflowInstancesFromRoom } from './solutions.ts'
import type { CoreEventLog } from './event-log.ts'
import type { DomainEvent } from './domain-events.ts'
import { WorkflowExecutor, WorkflowRegistry } from './workflow-engine.ts'
import type { WorkflowInstanceStore } from './workflow-store.ts'
import type { CoreLlmRouterPlugin, Disposable } from './plugins.ts'
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
  private readonly workflowRegistry = new WorkflowRegistry()
  private readonly workflowExecutor: WorkflowExecutor
  private readonly definitions = new Map<string, WorkflowDefinition>([
    [chatSpeechWorkflow.id, chatSpeechWorkflow],
    [chatDirectorWorkflow.id, chatDirectorWorkflow],
    [directorTurnWorkflow.id, directorTurnWorkflow],
  ])
  private readonly categories = new Map<string, StateCategoryDefinition>(defaultStateCategories.map(category => [category.id, category]))
  private legacyRuntime?: { runtime: RoomRuntime; defaultRoomId: string }
  private llmRouter?: CoreLlmRouterPlugin
  private llmRouterDisposable?: Disposable
  private eventLog?: CoreEventLog
  private workflowStore?: WorkflowInstanceStore

  constructor() {
    for (const definition of this.definitions.values()) this.workflowRegistry.register(definition)
    this.workflowExecutor = new WorkflowExecutor(this.workflowRegistry)
  }

  attachEventLog(eventLog: CoreEventLog): void {
    this.eventLog = eventLog
  }

  attachWorkflowStore(store: WorkflowInstanceStore): void {
    this.workflowStore = store
  }

  restoreWorkflowInstances(roomId: string): void {
    if (!this.workflowStore) return
    this.workflows.clear()
    for (const instance of this.workflowStore.list(roomId)) this.workflows.set(instance.id, instance)
    this.actions.length = 0
    for (const instance of this.workflows.values()) this.actions.push(...this.workflowExecutor.plan(instance))
  }

  restoreEventHistory(roomId: string, limit = 100): void {
    if (!this.eventLog) return
    this.recentEvents.length = 0
    this.recentEvents.push(...this.eventLog.list(roomId, limit))
  }

  registerCategory(category: StateCategoryDefinition): void {
    if (!category.id.trim()) throw new Error('State category id is required.')
    if (this.categories.has(category.id)) throw new Error(`State category already registered: ${category.id}`)
    this.categories.set(category.id, category)
  }

  projectRoom(room: RoomSnapshot, causedBy = 'legacy-room-runtime'): void {
    this.state = projectRoomSnapshot(room).categories
    this.revision = room.revision
    const workflows = workflowInstancesFromRoom(room)
    this.workflows.clear()
    for (const workflow of workflows) {
      this.workflows.set(workflow.id, workflow)
      this.workflowStore?.save(room.id, workflow)
    }
    this.actions.length = 0
    for (const workflow of workflows) this.actions.push(...this.workflowExecutor.plan(workflow))
    const interaction = interactionFromRoom(room)
    this.interactions.clear()
    if (interaction) this.interactions.set(interaction.id, interaction)
    const event = roomSnapshotEvent(room, causedBy)
    this.eventLog?.append(room.id, room.revision, event)
    this.recentEvents.push(event)
    while (this.recentEvents.length > 100) this.recentEvents.shift()
    this.emit({ type: 'state.changed', revision: this.revision, transition: { revision: this.revision, events: [event], changes: [] } })
    for (const workflow of workflows) this.emit({ type: 'workflow.changed', revision: this.revision, workflow })
    if (interaction) this.emit({ type: 'interaction.created', revision: this.revision, interaction })
  }

  registerWorkflow(definition: WorkflowDefinition): void {
    if (!definition.id || !definition.version || !definition.initialStep) throw new Error('Invalid workflow definition.')
    if (!definition.steps[definition.initialStep]) throw new Error(`Workflow initial step is missing: ${definition.initialStep}`)
    if (this.definitions.has(definition.id)) throw new Error(`Workflow already registered: ${definition.id}`)
    this.definitions.set(definition.id, definition)
    this.workflowRegistry.register(definition)
  }

  attachLegacyRuntime(runtime: RoomRuntime, defaultRoomId: string): void {
    this.legacyRuntime = { runtime, defaultRoomId }
  }

  async dispatch(command: HumanCommand): Promise<void> {
    if (!this.legacyRuntime) {
      this.emit({ type: 'error', revision: this.revision, message: `Core command has no runtime adapter: ${command.type}` })
      return
    }
    try {
      await dispatchLegacyCommand(this.legacyRuntime, command)
    } catch (error) {
      this.emit({ type: 'error', revision: this.revision, message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  attachLlmRouter(router: CoreLlmRouterPlugin): void {
    this.llmRouterDisposable?.dispose()
    this.llmRouter = router
    this.llmRouterDisposable = router.install({
      submitModelResult: result => this.submitModelResult(result),
      publishModelEvent: event => this.emit(event),
    })
  }

  async requestModel(request: import('./protocol.ts').ModelRequest): Promise<void> {
    if (!this.llmRouter) throw new Error('Core has no LLM router.')
    await this.llmRouter.request(request)
  }

  emitDomainEvent(event: DomainEvent): void {
    const payload = event.payload as { roomId?: unknown }
    const roomId = payload.roomId ? String(payload.roomId) : undefined
    if (roomId) this.eventLog?.appendDomain(roomId, this.revision, event)
    this.emit({ type: 'domain.event', revision: this.revision, event })

    // 领域事件只推进声明了对应 transition 的固定 workflow；旧 RoomRuntime 仍是状态写入权威。
    let changed = false
    for (const [id, instance] of this.workflows) {
      if (roomId && instance.locals.roomId !== roomId) continue
      const next = this.workflowExecutor.transition(instance, event)
      if (next === instance) continue
      this.workflows.set(id, next)
      if (roomId) this.workflowStore?.save(roomId, next)
      this.emit({ type: 'workflow.changed', revision: this.revision, workflow: next })
      changed = true
    }
    if (changed) this.replanActions()
  }

  async submitModelResult(result: ModelResult): Promise<void> {
    this.emit({ type: 'model.completed', revision: this.revision, result })
  }

  private replanActions(): void {
    this.actions.length = 0
    for (const instance of this.workflows.values()) this.actions.push(...this.workflowExecutor.plan(instance))
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

  async cancel(requestId?: string): Promise<void> {
    if (requestId && this.llmRouter) await this.llmRouter.cancel(requestId)
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
