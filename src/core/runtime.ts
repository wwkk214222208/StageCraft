import type { RoomSnapshot } from '../types.ts'
import { roomSnapshotEvent, type StateCategoryDefinition } from './state.ts'
import type { RoomRuntime } from '../room-runtime.ts'
import { dispatchLegacyCommand } from './command-adapter.ts'
import type { CoreEventLog } from './event-log.ts'
import type { DomainEvent } from './domain-events.ts'
import { validateWorkflowDefinition, WorkflowExecutor, WorkflowRegistry } from './workflow-engine.ts'
import type { WorkflowInstanceStore } from './workflow-store.ts'
import type { CoreCommandHandler, CoreLlmRouterPlugin, CoreRuntimeBindingPort, CoreSolutionBinding, CoreSolutionProjection, CoreSolutionProjectionProvider, CoreStateProjectionProvider, Disposable } from './plugins.ts'
import type { CoreStateRepository } from './state-repository.ts'
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
  private readonly stateProjectionProviders = new Map<string, CoreStateProjectionProvider>()
  private readonly stateProjectionOwners = new Map<string, string>()
  private readonly commandHandlers = new Map<string, CoreCommandHandler>()
  private readonly interactionOwners = new Map<string, string>()
  private readonly categories = new Map<string, StateCategoryDefinition>()
  private readonly categoryOwners = new Map<string, string>()
  private legacyRuntime?: { runtime: RoomRuntime; defaultRoomId: string }
  private llmRouter?: CoreLlmRouterPlugin
  private llmRouterDisposable?: Disposable
  private llmBindingSequence = 0
  private eventLog?: CoreEventLog
  private workflowStore?: WorkflowInstanceStore
  private stateRepository?: CoreStateRepository
  private lastRoom?: RoomSnapshot
  private solutionBindingCounter = 0
  private readonly modelWaiters = new Map<string, { resolve: (result: ModelResult) => void; reject: (error: unknown) => void; bindingId: number }>()
  private readonly cancelledModelRequests = new Map<string, number>()

  constructor() {
    this.workflowExecutor = new WorkflowExecutor(this.workflowRegistry)
  }

  attachEventLog(eventLog: CoreEventLog): void {
    this.eventLog = eventLog
  }

  attachWorkflowStore(store: WorkflowInstanceStore): void {
    this.workflowStore = store
  }

  attachStateRepository(repository: CoreStateRepository): void {
    this.stateRepository = repository
  }

  restoreState(roomId: string, eventLimit = 100): boolean {
    const restored = this.stateRepository?.restore(roomId, eventLimit)
    if (!restored) return false
    const workflows = restored.workflows.filter(instance => this.isRestorableWorkflowInstance(instance))
    const actions = workflows.flatMap(instance => this.workflowExecutor.plan(instance))
    this.state = this.filterState(restored.state)
    this.revision = restored.revision
    this.workflows.clear()
    for (const instance of workflows) this.workflows.set(instance.id, instance)
    this.actions.length = 0
    this.actions.push(...actions)
    this.recentEvents.length = 0
    this.recentEvents.push(...restored.events.slice(-100))
    return true
  }

  restoreWorkflowInstances(roomId: string): void {
    if (!this.workflowStore) return
    this.workflows.clear()
    // 方案可能在存档写入后被卸载；未知 Definition 不能阻止 Core 启动。
    for (const instance of this.workflowStore.list(roomId)) {
      if (this.isRestorableWorkflowInstance(instance)) this.workflows.set(instance.id, instance)
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
    this.categoryOwners.set(category.id, 'legacy')
  }

  /** 以事务式 reducer 计算多个 StateEvent；任一 reducer 失败时不替换当前 state。 */
  applyStateEvents(events: StateEvent[]): void {
    if (events.length === 0) return
    const next = this.reduceState(this.state, events)
    const workflows = [...this.workflows.values()]
    const actions = workflows.flatMap(workflow => this.workflowExecutor.plan(workflow))
    this.commitStateCandidate(next, events, workflows, actions, this.roomIdFromEvents(events))
  }

  projectRoom(room: RoomSnapshot, causedBy = 'legacy-room-runtime', options: { persist?: boolean } = {}): void {
    const persist = options.persist !== false
    const candidateState = this.projectState(room)
    const solutionProjection = this.projectSolution(room)
    const projected = solutionProjection.flatMap(([, projection]) => projection.workflows)
    const workflows = projected.map(fresh => {
      const existing = this.workflows.get(fresh.id)
      if (!existing) return fresh
      if (existing.definitionId !== fresh.definitionId || existing.definitionVersion !== fresh.definitionVersion) return fresh
      return { ...fresh, step: existing.step, status: existing.status, locals: existing.locals, pendingInteractionIds: existing.pendingInteractionIds, pendingModelRequestIds: existing.pendingModelRequestIds, retryCount: existing.retryCount, createdAt: existing.createdAt, updatedAt: existing.updatedAt }
    })
    const candidateInteractions = new Map<string, import('./protocol.ts').InteractionRequest>()
    const candidateOwners = new Map<string, string>()
    for (const [id, interaction] of this.interactions) {
      const owner = this.interactionOwners.get(id)
      if (id.startsWith(`interaction:${room.id}:`) && owner && this.projectionProviders.has(owner)) {
        candidateInteractions.set(id, interaction)
        candidateOwners.set(id, owner)
      }
    }
    for (const [owner, projection] of solutionProjection) {
      for (const pending of projection.interactions) {
        candidateInteractions.set(pending.id, pending)
        candidateOwners.set(pending.id, owner)
      }
    }
    const candidateWorkflows = new Map(workflows.map(workflow => [workflow.id, workflow]))
    for (const interaction of candidateInteractions.values()) {
      const owner = candidateOwners.get(interaction.id)
      const provider = owner ? this.projectionProviders.get(owner) : undefined
      const workflow = workflows.find(item => provider?.interactionBelongsToWorkflow?.(interaction, item) ?? false)
      if (!workflow) continue
      candidateWorkflows.set(workflow.id, { ...workflow, pendingInteractionIds: [interaction.id], updatedAt: new Date().toISOString() })
    }
    const finalWorkflows = [...candidateWorkflows.values()]
    const candidateActions = finalWorkflows.flatMap(workflow => this.workflowExecutor.plan(workflow))
    const event = roomSnapshotEvent(room, causedBy, candidateState)
    const candidateRecentEvents = this.withRecentEvents([event])

    // Repository commit is deliberately before any in-memory replacement or event emission.
    if (persist && this.stateRepository) {
      this.stateRepository.commit({ roomId: room.id, revision: room.revision, state: candidateState, events: [event], workflows: finalWorkflows })
    } else if (persist) {
      this.eventLog?.append(room.id, room.revision, event)
      for (const workflow of finalWorkflows) this.workflowStore?.save(room.id, workflow)
    }

    this.lastRoom = room
    this.state = candidateState
    this.revision = room.revision
    this.workflows.clear()
    for (const workflow of finalWorkflows) this.workflows.set(workflow.id, workflow)
    this.actions.length = 0
    this.actions.push(...candidateActions)
    this.interactions.clear()
    this.interactionOwners.clear()
    for (const [id, interaction] of candidateInteractions) {
      this.interactions.set(id, interaction)
      this.interactionOwners.set(id, candidateOwners.get(id)!)
    }
    this.recentEvents.length = 0
    this.recentEvents.push(...candidateRecentEvents)
    this.emit({ type: 'state.changed', revision: this.revision, transition: { revision: this.revision, events: [event], changes: [] } })
    for (const workflow of finalWorkflows) this.emit({ type: 'workflow.changed', revision: this.revision, workflow })
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
    const categories = new Map<string, StateCategoryDefinition>()
    const stateProjections = new Map<string, CoreStateProjectionProvider>()
    const commandHandlers = new Map<string, CoreCommandHandler>()
    const bindingOwner = `solution-binding:${++this.solutionBindingCounter}`
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
      registerStateCategory: (category: StateCategoryDefinition): Disposable => {
        if (settled) throw new Error('Solution binding is already settled.')
        if (!category.id.trim()) throw new Error('State category id is required.')
        if (categories.has(category.id) || this.categories.has(category.id)) throw new Error(`State category already registered: ${category.id}`)
        categories.set(category.id, category)
        let active = true
        return { dispose: () => { if (active) { active = false; if (!settled) categories.delete(category.id) } } }
      },
      registerStateProjection: (provider: CoreStateProjectionProvider): Disposable => {
        if (settled) throw new Error('Solution binding is already settled.')
        if (!provider.id.trim()) throw new Error('State projection id is required.')
        if (stateProjections.has(provider.id) || this.stateProjectionProviders.has(provider.id)) throw new Error(`State projection already registered: ${provider.id}`)
        stateProjections.set(provider.id, provider)
        let active = true
        return { dispose: () => { if (active) { active = false; if (!settled) stateProjections.delete(provider.id) } } }
      },
      registerCommandHandler: (handler: CoreCommandHandler): Disposable => {
        if (settled) throw new Error('Solution binding is already settled.')
        if (!handler.id.trim()) throw new Error('Core command handler id is required.')
        if (commandHandlers.has(handler.id) || this.commandHandlers.has(handler.id)) throw new Error(`Core command handler already registered: ${handler.id}`)
        commandHandlers.set(handler.id, handler)
        let active = true
        return { dispose: () => { if (active) { active = false; if (!settled) commandHandlers.delete(handler.id) } } }
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
        for (const category of categories.values()) {
          if (this.categories.has(category.id)) throw new Error(`State category already registered: ${category.id}`)
        }
        for (const provider of stateProjections.values()) {
          if (this.stateProjectionProviders.has(provider.id)) throw new Error(`State projection already registered: ${provider.id}`)
        }
        for (const handler of commandHandlers.values()) {
          if (this.commandHandlers.has(handler.id)) throw new Error(`Core command handler already registered: ${handler.id}`)
        }
        for (const definition of workflows.values()) {
          this.definitions.set(definition.id, definition)
          this.workflowRegistry.register(definition)
        }
        for (const provider of projections.values()) this.projectionProviders.set(provider.id, provider)
        for (const [id, category] of categories) {
          this.categories.set(id, category)
          this.categoryOwners.set(id, bindingOwner)
        }
        for (const [id, provider] of stateProjections) {
          this.stateProjectionProviders.set(id, provider)
          this.stateProjectionOwners.set(id, bindingOwner)
        }
        for (const [id, handler] of commandHandlers) this.commandHandlers.set(id, handler)
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
            const stateProjectionIds = new Set(stateProjections.keys())
            const categoryIds = new Set(categories.keys())
            for (const id of stateProjectionIds) {
              this.stateProjectionProviders.delete(id)
              this.stateProjectionOwners.delete(id)
            }
            for (const id of categoryIds) {
              this.categories.delete(id)
              this.categoryOwners.delete(id)
              delete this.state[id]
            }
            for (const id of commandHandlers.keys()) this.commandHandlers.delete(id)
            this.replanActions()
          },
        }
      },
      rollback: () => {
        if (settled) return
        settled = true
        workflows.clear()
        projections.clear()
        categories.clear()
        stateProjections.clear()
        commandHandlers.clear()
      },
    }
  }

  private validateWorkflow(definition: WorkflowDefinition): void {
    validateWorkflowDefinition(definition)
  }

  private projectSolution(room: RoomSnapshot): Array<[string, CoreSolutionProjection]> {
    return [...this.projectionProviders.values()].map(provider => [provider.id, provider.project(room)] as [string, CoreSolutionProjection])
  }

  private projectState(room: RoomSnapshot): Record<string, unknown> {
    const projected: Record<string, unknown> = {}
    for (const [providerId, provider] of this.stateProjectionProviders) {
      const owner = this.stateProjectionOwners.get(providerId)
      const values = provider.project(room)
      for (const [categoryId, value] of Object.entries(values)) {
        const category = this.categories.get(categoryId)
        if (this.categoryOwners.get(categoryId) !== owner || category?.enabled === false) continue
        projected[categoryId] = value
      }
    }
    return projected
  }

  private filterState(state: Record<string, unknown>): Record<string, unknown> {
    const filtered: Record<string, unknown> = {}
    for (const [id, value] of Object.entries(state)) if (this.categories.get(id)?.enabled !== false && this.categories.has(id)) filtered[id] = value
    return filtered
  }

  private reduceState(state: Record<string, unknown>, events: StateEvent[]): Record<string, unknown> {
    const next = structuredClone(state)
    for (const event of events) {
      for (const [id, category] of this.categories) {
        if (category.enabled === false || !category.reducer) continue
        next[id] = category.reducer(next[id], event)
      }
    }
    return this.filterState(next)
  }

  private roomIdFromEvents(events: StateEvent[]): string | undefined {
    for (const event of events) {
      const payload = event.payload as { roomId?: unknown }
      if (payload?.roomId) return String(payload.roomId)
    }
    return this.lastRoom?.id
  }

  /** 提交 reducer 结果；Repository 成功前不改变任何 Core 内存或事件流。 */
  private commitStateCandidate(state: Record<string, unknown>, events: StateEvent[], workflows: WorkflowInstance[], actions: import('./protocol.ts').CoreAction[], roomId?: string, domainEvent = false): void {
    if (events.length === 0) return
    const recentEvents = this.withRecentEvents(events)
    if (roomId && this.stateRepository) {
      this.stateRepository.commit({ roomId, revision: this.revision, state, events, workflows })
    } else if (roomId) {
      for (const event of events) {
        if (domainEvent) this.eventLog?.appendDomain(roomId, this.revision, event as DomainEvent)
        else this.eventLog?.append(roomId, this.revision, event)
      }
      for (const workflow of workflows) this.workflowStore?.save(roomId, workflow)
    }
    this.state = state
    this.workflows.clear()
    for (const workflow of workflows) this.workflows.set(workflow.id, workflow)
    this.actions.length = 0
    this.actions.push(...actions)
    this.recentEvents.length = 0
    this.recentEvents.push(...recentEvents)
    this.emit({ type: 'state.changed', revision: this.revision, transition: { revision: this.revision, events, changes: [] } })
  }

  private withRecentEvents(events: StateEvent[]): StateEvent[] {
    const merged = [...this.recentEvents]
    for (const event of events) if (!merged.some(existing => existing.id === event.id)) merged.push(event)
    return merged.slice(-100)
  }

  private isRestorableWorkflowInstance(instance: WorkflowInstance): boolean {
    const definition = this.definitions.get(instance.definitionId)
    return Boolean(definition && instance.definitionVersion === definition.version && definition.steps[instance.step])
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
    const handler = [...this.commandHandlers.values()].find(candidate => candidate.canHandle(command))
    if (handler) {
      try {
        await handler.handle(command, { core: this })
        if (interaction) this.resolveInteraction(interaction, command)
        return
      } catch (error) {
        this.emit({ type: 'error', revision: this.revision, message: error instanceof Error ? error.message : String(error) })
        throw error
      }
    }
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
    const bindingId = ++this.llmBindingSequence
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
        this.rejectModelRequestsForBinding(bindingId, new Error('LLM router was disposed.'), true)
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

  async requestModel(request: import('./protocol.ts').ModelRequest): Promise<ModelResult> {
    if (!this.llmRouter) throw new Error('Core has no LLM router.')
    if (this.modelWaiters.has(request.requestId)) throw new Error(`Model request ID is already active: ${request.requestId}`)
    this.pruneCancelledModelRequests()
    if (this.cancelledModelRequests.has(request.requestId)) throw new Error(`Model request ID was cancelled and cannot be reused yet: ${request.requestId}`)
    const bindingId = this.llmBindingSequence
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
    return new Promise<ModelResult>((resolve, reject) => {
      let settled = false
      const resolveResult = (result: ModelResult): void => {
        if (settled) return
        settled = true
        this.modelWaiters.delete(request.requestId)
        resolve(result)
      }
      const rejectRequest = (error: unknown): void => {
        if (settled) return
        settled = true
        this.modelWaiters.delete(request.requestId)
        this.clearPendingModelRequest(request.requestId)
        this.emit({ type: 'error', revision: this.revision, requestId: request.requestId, message: error instanceof Error ? error.message : String(error) })
        reject(error)
      }
      this.modelWaiters.set(request.requestId, { resolve: resolveResult, reject: rejectRequest, bindingId })
      const router = this.llmRouter
      if (!router) { rejectRequest(new Error('Core has no LLM router.')); return }
      try {
        void Promise.resolve(router.request(request)).catch(error => {
          const waiter = this.modelWaiters.get(request.requestId)
          if (waiter) waiter.reject(error)
          else if (!settled) rejectRequest(error)
        })
      } catch (error) {
        rejectRequest(error)
      }
    })
  }

  emitDomainEvent(event: DomainEvent): void {
    const payload = event.payload as { roomId?: unknown }
    const roomId = payload.roomId ? String(payload.roomId) : undefined
    const nextState = this.reduceState(this.state, [event])
    const previousWorkflows = [...this.workflows.values()]
    const nextWorkflows = previousWorkflows.map(instance => {
      if (roomId && instance.locals.roomId !== roomId) return instance
      return this.workflowExecutor.transition(instance, event)
    })
    const changed = nextWorkflows.some((instance, index) => instance !== previousWorkflows[index])
    const actions = nextWorkflows.flatMap(workflow => this.workflowExecutor.plan(workflow))
    this.commitStateCandidate(nextState, [event], nextWorkflows, actions, roomId, true)
    this.emit({ type: 'domain.event', revision: this.revision, event })
    if (changed) {
      nextWorkflows.forEach((workflow, index) => {
        if (workflow !== previousWorkflows[index]) this.emit({ type: 'workflow.changed', revision: this.revision, workflow })
      })
    }
  }

  async submitModelResult(result: ModelResult): Promise<void> {
    this.pruneCancelledModelRequests()
    const cancelledUntil = this.cancelledModelRequests.get(result.requestId)
    if (cancelledUntil && cancelledUntil > Date.now()) { this.cancelledModelRequests.delete(result.requestId); return }
    const waiter = this.modelWaiters.get(result.requestId)
    if (waiter) {
      this.modelWaiters.delete(result.requestId)
      waiter.resolve(result)
    }
    for (const [id, workflow] of this.workflows) {
      if (!workflow.pendingModelRequestIds.includes(result.requestId)) continue
      const next = { ...workflow, pendingModelRequestIds: workflow.pendingModelRequestIds.filter(requestId => requestId !== result.requestId), updatedAt: new Date().toISOString() }
      this.workflows.set(id, next)
      const roomId = String(next.locals.roomId ?? '')
      if (roomId) this.workflowStore?.save(roomId, next)
      this.emit({ type: 'workflow.changed', revision: this.revision, workflow: next })
    }
    this.emit({ type: 'model.completed', revision: this.revision, result })
    if (result.error) this.emit({ type: 'error', revision: this.revision, requestId: result.requestId, message: result.error })
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
    if (requestId) {
      const waiter = this.modelWaiters.get(requestId)
      if (waiter) {
        this.modelWaiters.delete(requestId)
        this.rememberCancelledModelRequest(requestId)
        waiter.reject(new Error(`Model request cancelled: ${requestId}`))
      }
      if (this.llmRouter) await this.llmRouter.cancel(requestId)
      return
    }
    for (const [id, waiter] of this.modelWaiters) {
      this.modelWaiters.delete(id)
      this.rememberCancelledModelRequest(id)
      waiter.reject(new Error(`Model request cancelled: ${id}`))
    }
    if (this.llmRouter) await this.llmRouter.cancel('')
  }

  private emit(event: CoreEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private rejectModelRequestsForBinding(bindingId: number, error: Error, tombstone: boolean): void {
    for (const [requestId, waiter] of [...this.modelWaiters]) {
      if (waiter.bindingId !== bindingId) continue
      this.modelWaiters.delete(requestId)
      if (tombstone) this.rememberCancelledModelRequest(requestId)
      waiter.reject(error)
    }
  }

  private clearPendingModelRequest(requestId: string): void {
    for (const [id, workflow] of this.workflows) {
      if (!workflow.pendingModelRequestIds.includes(requestId)) continue
      const next = { ...workflow, pendingModelRequestIds: workflow.pendingModelRequestIds.filter(item => item !== requestId), updatedAt: new Date().toISOString() }
      this.workflows.set(id, next)
      const roomId = String(next.locals.roomId ?? '')
      if (roomId) this.workflowStore?.save(roomId, next)
      this.emit({ type: 'workflow.changed', revision: this.revision, workflow: next })
    }
  }

  private rememberCancelledModelRequest(requestId: string): void {
    this.pruneCancelledModelRequests()
    this.cancelledModelRequests.set(requestId, Date.now() + 5 * 60_000)
    while (this.cancelledModelRequests.size > 512) this.cancelledModelRequests.delete(this.cancelledModelRequests.keys().next().value as string)
  }

  private pruneCancelledModelRequests(): void {
    const now = Date.now()
    for (const [requestId, expiresAt] of this.cancelledModelRequests) if (expiresAt <= now) this.cancelledModelRequests.delete(requestId)
  }
}
