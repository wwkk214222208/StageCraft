import type { RoomSnapshot } from '../types.ts'
import { defaultStateCategories, projectRoomSnapshot, roomSnapshotEvent, type StateCategoryDefinition } from './state.ts'
import type { RoomRuntime } from '../room-runtime.ts'
import { dispatchLegacyCommand } from './command-adapter.ts'
import type { CoreEventLog } from './event-log.ts'
import type { DomainEvent } from './domain-events.ts'
import { validateWorkflowDefinition, WorkflowExecutor, WorkflowRegistry } from './workflow-engine.ts'
import type { WorkflowInstanceStore } from './workflow-store.ts'
import type { CoreLlmRouterPlugin, CoreRuntimeBindingPort, CoreSolutionBinding, CoreSolutionProjection, CoreSolutionProjectionProvider, Disposable } from './plugins.ts'
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
export class CoreRuntimeSkeleton implements CoreRuntimePort, CoreRuntimeBindingPort {
  private revision = 0
  private state: Record<string, unknown> = {}
  private readonly workflows = new Map<string, WorkflowInstance>()
  private readonly interactions = new Map<string, import('./protocol.ts').InteractionRequest>()
  private readonly actions: import('./protocol.ts').CoreAction[] = []
  private readonly recentEvents: StateEvent[] = []
  private readonly listeners = new Set<CoreEventListener>()
  private readonly workflowRegistry = new WorkflowRegistry()
  private readonly workflowExecutor: WorkflowExecutor
  private readonly definitions = new Map<string, WorkflowDefinition>()
  private readonly projectionProviders = new Map<string, CoreSolutionProjectionProvider>()
  private readonly interactionOwners = new Map<string, string>()
  private readonly categories = new Map<string, StateCategoryDefinition>(defaultStateCategories.map(category => [category.id, category]))
  private legacyRuntime?: { runtime: RoomRuntime; defaultRoomId: string }
  private llmRouter?: CoreLlmRouterPlugin
  private llmRouterDisposable?: Disposable
  private eventLog?: CoreEventLog
  private workflowStore?: WorkflowInstanceStore

  constructor() {
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
    // 方案可能在存档写入后被卸载；未知 Definition 不能阻止 Core 启动。
    for (const instance of this.workflowStore.list(roomId)) {
      if (this.definitions.has(instance.definitionId)) this.workflows.set(instance.id, instance)
    }
    this.actions.length = 0
    for (const instance of this.workflows.values()) this.actions.push(...this.workflowExecutor.plan(instance))
  }

  restoreInteractionRequests(room: RoomSnapshot): void {
    this.interactions.clear()
    this.interactionOwners.clear()
    for (const [owner, projection] of this.projectSolution(room)) {
      for (const interaction of projection.interactions) {
        this.interactions.set(interaction.id, interaction)
        this.interactionOwners.set(interaction.id, owner)
      }
    }
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
    const solutionProjection = this.projectSolution(room)
    const projected = solutionProjection.flatMap(([, projection]) => projection.workflows)
    const workflows = projected.map(fresh => {
      const existing = this.workflows.get(fresh.id)
      if (!existing) return fresh
      if (existing.definitionId !== fresh.definitionId || existing.definitionVersion !== fresh.definitionVersion) return fresh
      return { ...fresh, step: existing.step, status: existing.status, locals: existing.locals, pendingInteractionIds: existing.pendingInteractionIds, pendingModelRequestIds: existing.pendingModelRequestIds, retryCount: existing.retryCount, createdAt: existing.createdAt, updatedAt: existing.updatedAt }
    })
    this.workflows.clear()
    for (const workflow of workflows) {
      this.workflows.set(workflow.id, workflow)
      this.workflowStore?.save(room.id, workflow)
    }
    this.actions.length = 0
    for (const workflow of workflows) this.actions.push(...this.workflowExecutor.plan(workflow))
    const restoredInteractions = [...this.interactions]
      .filter(([id]) => id.startsWith(`interaction:${room.id}:`))
      .map(([id, interaction]) => [id, interaction, this.interactionOwners.get(id)] as const)
      .filter((entry): entry is readonly [string, typeof entry[1], string] => Boolean(entry[2] && this.projectionProviders.has(entry[2])))
    this.interactions.clear()
    this.interactionOwners.clear()
    for (const [id, pending, owner] of restoredInteractions) {
      this.interactions.set(id, pending)
      this.interactionOwners.set(id, owner)
    }
    for (const [owner, projection] of solutionProjection) {
      for (const pending of projection.interactions) {
        this.interactions.set(pending.id, pending)
        this.interactionOwners.set(pending.id, owner)
      }
    }
    for (const interaction of this.interactions.values()) {
      const workflow = workflows.find(item => this.interactionBelongsToWorkflow(interaction, item))
      if (!workflow) continue
      const pending = { ...workflow, pendingInteractionIds: [interaction.id], updatedAt: new Date().toISOString() }
      this.workflows.set(pending.id, pending)
      this.workflowStore?.save(room.id, pending)
    }
    const event = roomSnapshotEvent(room, causedBy)
    this.eventLog?.append(room.id, room.revision, event)
    this.recentEvents.push(event)
    while (this.recentEvents.length > 100) this.recentEvents.shift()
    this.emit({ type: 'state.changed', revision: this.revision, transition: { revision: this.revision, events: [event], changes: [] } })
    for (const workflow of workflows) this.emit({ type: 'workflow.changed', revision: this.revision, workflow })
    for (const interaction of this.interactions.values()) {
      if (interaction.id.startsWith(`interaction:${room.id}:`)) this.emit({ type: 'interaction.created', revision: this.revision, interaction })
    }
  }

  registerWorkflow(definition: WorkflowDefinition): void {
    this.validateWorkflow(definition)
    if (this.definitions.has(definition.id)) throw new Error(`Workflow already registered: ${definition.id}`)
    this.definitions.set(definition.id, definition)
    this.workflowRegistry.register(definition)
  }

  createSolutionBinding(): CoreSolutionBinding {
    const workflows = new Map<string, WorkflowDefinition>()
    const projections = new Map<string, CoreSolutionProjectionProvider>()
    let settled = false
    const host = {
      registerWorkflow: (definition: WorkflowDefinition): Disposable => {
        if (settled) throw new Error('Solution binding is already settled.')
        this.validateWorkflow(definition)
        if (workflows.has(definition.id) || this.definitions.has(definition.id)) throw new Error(`Workflow already registered: ${definition.id}`)
        workflows.set(definition.id, definition)
        let active = true
        return { dispose: () => { if (active) { active = false; if (!settled) workflows.delete(definition.id) } } }
      },
      registerProjection: (provider: CoreSolutionProjectionProvider): Disposable => {
        if (settled) throw new Error('Solution binding is already settled.')
        if (!provider.id.trim()) throw new Error('Solution projection id is required.')
        if (projections.has(provider.id) || this.projectionProviders.has(provider.id)) throw new Error(`Solution projection already registered: ${provider.id}`)
        projections.set(provider.id, provider)
        let active = true
        return { dispose: () => { if (active) { active = false; if (!settled) projections.delete(provider.id) } } }
      },
    }
    return {
      host,
      commit: () => {
        if (settled) throw new Error('Solution binding is already settled.')
        for (const definition of workflows.values()) {
          if (this.definitions.has(definition.id)) throw new Error(`Workflow already registered: ${definition.id}`)
        }
        for (const provider of projections.values()) {
          if (this.projectionProviders.has(provider.id)) throw new Error(`Solution projection already registered: ${provider.id}`)
        }
        for (const definition of workflows.values()) {
          this.definitions.set(definition.id, definition)
          this.workflowRegistry.register(definition)
        }
        for (const provider of projections.values()) this.projectionProviders.set(provider.id, provider)
        settled = true
        return {
          dispose: () => {
            if (!settled) return
            settled = false
            const definitionIds = new Set(workflows.keys())
            const projectionIds = new Set(projections.keys())
            for (const [id, workflow] of this.workflows) if (definitionIds.has(workflow.definitionId)) this.workflows.delete(id)
            for (const [id, owner] of this.interactionOwners) if (projectionIds.has(owner)) { this.interactions.delete(id); this.interactionOwners.delete(id) }
            for (const id of definitionIds) { this.definitions.delete(id); this.workflowRegistry.unregister(id) }
            for (const id of projectionIds) this.projectionProviders.delete(id)
            this.replanActions()
          },
        }
      },
      rollback: () => {
        if (settled) return
        settled = true
        workflows.clear()
        projections.clear()
      },
    }
  }

  private validateWorkflow(definition: WorkflowDefinition): void {
    validateWorkflowDefinition(definition)
  }

  private projectSolution(room: RoomSnapshot): Array<[string, CoreSolutionProjection]> {
    return [...this.projectionProviders.values()].map(provider => [provider.id, provider.project(room)] as [string, CoreSolutionProjection])
  }

  attachLegacyRuntime(runtime: RoomRuntime, defaultRoomId: string): void {
    this.legacyRuntime = { runtime, defaultRoomId }
  }

  async dispatch(command: HumanCommand): Promise<void> {
    const interaction = command.interactionId ? this.interactions.get(command.interactionId) : undefined
    if (command.interactionId && !interaction) throw new Error(`Interaction is not pending: ${command.interactionId}`)
    if (interaction?.id.endsWith(':director-suggestion') && command.type === 'submit-text') {
      const payload = command.payload && typeof command.payload === 'object' ? command.payload as { text?: unknown } : {}
      command = { ...command, type: 'submit-text', payload: { text: String(payload.text ?? ''), action: 'director-chat' } }
    }
    if (interaction && !this.commandMatchesInteraction(command, interaction)) throw new Error(`Command ${command.type} is not allowed for interaction: ${interaction.id}`)
    if (!this.legacyRuntime) {
      this.emit({ type: 'error', revision: this.revision, message: `Core command has no runtime adapter: ${command.type}` })
      return
    }
    try {
      await dispatchLegacyCommand(this.legacyRuntime, command)
      if (interaction) this.resolveInteraction(interaction, command)
    } catch (error) {
      this.emit({ type: 'error', revision: this.revision, message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  private resolveInteraction(interaction: import('./protocol.ts').InteractionRequest, command: HumanCommand): void {
    this.interactions.delete(interaction.id)
    for (const [id, workflow] of this.workflows) {
      if (!workflow.pendingInteractionIds.includes(interaction.id)) continue
      const next = { ...workflow, pendingInteractionIds: workflow.pendingInteractionIds.filter(id => id !== interaction.id), updatedAt: new Date().toISOString() }
      this.workflows.set(id, next)
      const roomId = String(next.locals.roomId ?? '')
      if (roomId) this.workflowStore?.save(roomId, next)
      this.emit({ type: 'workflow.changed', revision: this.revision, workflow: next })
    }
    this.emit({ type: 'interaction.resolved', revision: this.revision, interactionId: interaction.id, command })
  }

  private interactionBelongsToWorkflow(interaction: import('./protocol.ts').InteractionRequest, workflow: WorkflowInstance): boolean {
    const owner = this.interactionOwners.get(interaction.id)
    const provider = owner ? this.projectionProviders.get(owner) : undefined
    return provider?.interactionBelongsToWorkflow?.(interaction, workflow) ?? false
  }

  private commandMatchesInteraction(command: HumanCommand, interaction: import('./protocol.ts').InteractionRequest): boolean {
    if (interaction.kind === 'text') return command.type === 'submit-text'
    if (interaction.kind === 'role-select') return command.type === 'select-role'
    if (interaction.kind === 'approval') return command.type === 'approve' || command.type === 'reject' || command.type === 'cancel'
    if (interaction.kind === 'text') return command.type === 'submit-text'
    return false
  }

  bindLlmRouter(router: CoreLlmRouterPlugin): Disposable {
    const previous = this.llmRouterDisposable
    if (previous) {
      try {
        void Promise.resolve(previous.dispose()).catch(() => {})
      } catch {
        // 兼容 attach/bind 的同步边界：旧插件释放失败不能产生未处理拒绝。
      }
    }
    this.llmRouter = undefined
    this.llmRouterDisposable = undefined
    let active = true
    const installed = router.install({
      submitModelResult: async result => {
        if (!active) throw new Error('LLM router host is disposed.')
        return this.submitModelResult(result)
      },
      publishModelEvent: event => {
        if (active) this.emit(event)
      },
    })
    const binding: Disposable = {
      dispose: async () => {
        if (!active) return
        active = false
        // 身份检查很重要：旧绑定的释放不能清掉后来替换的新路由。
        if (this.llmRouter === router && this.llmRouterDisposable === binding) {
          this.llmRouter = undefined
          this.llmRouterDisposable = undefined
        }
        // 先撤销 host，再等待插件资源释放，迟到结果不能回写 Core。
        await installed.dispose()
      },
    }
    this.llmRouter = router
    this.llmRouterDisposable = binding
    return binding
  }

  attachLlmRouter(router: CoreLlmRouterPlugin): void {
    void this.bindLlmRouter(router)
  }

  async requestModel(request: import('./protocol.ts').ModelRequest): Promise<void> {
    if (!this.llmRouter) throw new Error('Core has no LLM router.')
    if (request.workflowId) {
      const workflow = this.workflows.get(request.workflowId)
      if (workflow) {
        const next = { ...workflow, pendingModelRequestIds: [...new Set([...workflow.pendingModelRequestIds, request.requestId])], updatedAt: new Date().toISOString() }
        this.workflows.set(workflow.id, next)
        const roomId = String(next.locals.roomId ?? '')
        if (roomId) this.workflowStore?.save(roomId, next)
        this.emit({ type: 'workflow.changed', revision: this.revision, workflow: next })
      }
    }
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
    for (const [id, workflow] of this.workflows) {
      if (!workflow.pendingModelRequestIds.includes(result.requestId)) continue
      const next = { ...workflow, pendingModelRequestIds: workflow.pendingModelRequestIds.filter(requestId => requestId !== result.requestId), updatedAt: new Date().toISOString() }
      this.workflows.set(id, next)
      const roomId = String(next.locals.roomId ?? '')
      if (roomId) this.workflowStore?.save(roomId, next)
      this.emit({ type: 'workflow.changed', revision: this.revision, workflow: next })
    }
    this.emit({ type: 'model.completed', revision: this.revision, result })
  }

  private availableCommands(): Array<{ type: HumanCommand['type']; label: string; enabled: boolean }> {
    const commands = new Map<HumanCommand['type'], string>()
    for (const interaction of this.interactions.values()) {
      if (interaction.kind === 'text') commands.set('submit-text', interaction.submitLabel ?? '提交')
      if (interaction.kind === 'role-select') commands.set('select-role', interaction.submitLabel ?? '发言')
      if (interaction.kind === 'approval') {
        commands.set('approve', interaction.submitLabel ?? '批准')
        commands.set('reject', '拒绝')
      }
    }
    return [...commands].map(([type, label]) => ({ type, label, enabled: true }))
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
      availableCommands: this.availableCommands(),
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
