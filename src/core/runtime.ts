import type { RoomSnapshot } from '../types.ts'
import { defaultStateCategories, projectRoomSnapshot, roomSnapshotEvent, type StateCategoryDefinition } from './state.ts'
import type { RoomRuntime } from '../room-runtime.ts'
import { dispatchLegacyCommand } from './command-adapter.ts'
import { chatDirectorWorkflow, chatSpeechWorkflow, directorTurnWorkflow, interactionFromRoom, workflowInstancesFromRoom } from './solutions.ts'
import type { CoreEventLog } from './event-log.ts'
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

  attachEventLog(eventLog: CoreEventLog): void {
    this.eventLog = eventLog
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
    for (const workflow of workflows) this.workflows.set(workflow.id, workflow)
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
