import type { RoomSnapshot } from '../types.ts'
import { roomSnapshotEvent, type StateCategoryDefinition } from './state.ts'
import type { CoreEventLog } from './event-log.ts'
import type { DomainEvent } from './domain-events.ts'
import { validateWorkflowDefinition, WorkflowExecutor, WorkflowRegistry } from './workflow-engine.ts'
import type { WorkflowInstanceStore } from './workflow-store.ts'
import type { CoreCommandHandler, CoreLlmRouterPlugin, CoreRuntimeBindingPort, CoreSolutionBinding, CoreSolutionProjection, CoreSolutionProjectionProvider, CoreStateProjectionProvider, Disposable } from './plugins.ts'
import type { CoreStateRepository } from './state-repository.ts'
import { systemClock, systemIds, type Clock, type IdFactory, type PortableRuntimePorts } from './platform.ts'
import { jsonDeepEqual } from './json-values.ts'
import { applyStatePatches, type StateModuleManifest, type StateReducer, type StateReducerEvent, type StateSchemaDefinition, type StateTransactionRequest, type StateTransactionResult } from './state-transaction.ts'
import type { CoreExtensionPort, EffectHandlerDefinition, PromptContributorDefinition, Proposal, ProposalOperationRequest, ProposalTypeDefinition, RecordCollectionDefinition, RecordOperationRequest, RecordOperationResult, ViewContribution, ViewContributorDefinition, PromptFragment } from './extensions.ts'
import { UiExtensionRegistry, type UiActionHandler, type UiManifest, type UiRendererHost, type UiRenderResult } from './ui.ts'
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

function pointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

function isModulePath(path: string, moduleId: string): boolean {
  const prefix = `/modules/${pointerSegment(moduleId)}`
  return path === prefix || path.startsWith(`${prefix}/`)
}

function decodePointer(path: string): string[] {
  if (path === '') return []
  if (!path.startsWith('/')) throw new Error(`Invalid extension JSON Pointer: ${path}`)
  return path.slice(1).split('/').map(segment => {
    if (/~(?![01])/.test(segment)) throw new Error(`Invalid extension JSON Pointer escape: ${segment}`)
    const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (['__proto__', 'prototype', 'constructor'].includes(decoded)) throw new Error(`Forbidden extension JSON Pointer segment: ${decoded}`)
    return decoded
  })
}

function readPointer(root: unknown, path: string): unknown {
  let current = root
  for (const segment of decodePointer(path)) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment) || Number(segment) >= current.length) return undefined
      current = current[Number(segment)]
    } else if (current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[segment]
    } else return undefined
  }
  return current
}

function copy<T>(value: T): T {
  return structuredClone(value)
}

function assertJsonSafe(value: unknown, label = 'Value', seen = new Set<object>()): void {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error(`${label} must be JSON-safe.`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${label} must be JSON-safe.`)
  if (value === null || typeof value !== 'object') return
  const prototype = Object.getPrototypeOf(value)
  if (value instanceof Date || value instanceof RegExp || value instanceof URL || value instanceof Map || value instanceof Set || ArrayBuffer.isView(value) || (prototype !== Object.prototype && prototype !== null && !Array.isArray(value))) throw new Error(`${label} must be JSON-safe.`)
  if (seen.has(value)) throw new Error(`${label} must not contain cycles.`)
  seen.add(value)
  if (Array.isArray(value)) for (const item of value) assertJsonSafe(item, label, seen)
  else for (const item of Object.values(value)) assertJsonSafe(item, label, seen)
  seen.delete(value)
}

/**
 * Core runtime skeleton：提供稳定的 Command/Event/View、方案投影与模型请求边界。
 * StageCraft 的具体玩法由方案插件和 Core 外部领域服务提供；未安装方案时 Core 保持空白。
 */
export class CoreRuntimeSkeleton implements CoreRuntimePort, CoreRuntimeBindingPort, CoreExtensionPort {
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
  private readonly stateModules = new Map<string, StateModuleManifest>()
  private readonly stateModuleOwners = new Map<string, object | string>()
  private readonly stateSchemas = new Map<string, StateSchemaDefinition>()
  private readonly stateSchemaOwners = new Map<string, object | string>()
  private readonly stateReducers = new Map<string, StateReducer>()
  private readonly stateReducerOwners = new Map<string, object | string>()
  private readonly recordCollections = new Map<string, RecordCollectionDefinition>()
  private readonly recordCollectionOwners = new Map<string, object | string>()
  private readonly proposalTypes = new Map<string, ProposalTypeDefinition>()
  private readonly proposalTypeOwners = new Map<string, object | string>()
  private readonly effectHandlers = new Map<string, EffectHandlerDefinition>()
  private readonly effectHandlerOwners = new Map<string, object | string>()
  private readonly promptContributors = new Map<string, PromptContributorDefinition>()
  private readonly promptContributorOwners = new Map<string, object | string>()
  private readonly viewContributors = new Map<string, ViewContributorDefinition>()
  private readonly viewContributorOwners = new Map<string, object | string>()
  private readonly uiRegistry: UiExtensionRegistry
  private stateTransactionActive = false
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
  private readonly clock: Clock
  private readonly ids: IdFactory

  constructor(ports: PortableRuntimePorts = {}) {
    this.clock = ports.clock ?? systemClock
    this.ids = ports.ids ?? systemIds
    this.workflowExecutor = new WorkflowExecutor(this.workflowRegistry)
    this.uiRegistry = new UiExtensionRegistry(() => this.getView(), event => this.emit(event))
  }

  attachEventLog(eventLog: CoreEventLog): void {
    this.eventLog = eventLog
  }

  attachWorkflowStore(store: WorkflowInstanceStore): void {
    this.workflowStore = store
  }

  attachStateRepository(repository: CoreStateRepository): Disposable {
    this.stateRepository = repository
    let active = true
    return {
      dispose: () => {
        if (!active) return
        active = false
        if (this.stateRepository === repository) this.stateRepository = undefined
      },
    }
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

  registerStateModule(manifest: StateModuleManifest): Disposable {
    if (!manifest.id.trim()) throw new Error('State module id is required.')
    if (this.stateModules.has(manifest.id)) throw new Error(`State module already registered: ${manifest.id}`)
    const owner = {}
    this.stateModules.set(manifest.id, manifest)
    this.stateModuleOwners.set(manifest.id, owner)
    let active = true
    return { dispose: () => { if (active && this.stateModuleOwners.get(manifest.id) === owner) { active = false; this.stateModules.delete(manifest.id); this.stateModuleOwners.delete(manifest.id) } } }
  }

  registerStateSchema(schema: StateSchemaDefinition): Disposable {
    if (!schema.id.trim() || !schema.moduleId.trim()) throw new Error('State schema id and module id are required.')
    if (!this.stateModules.has(schema.moduleId)) throw new Error(`State module is not registered: ${schema.moduleId}`)
    if (this.stateSchemas.has(schema.id)) throw new Error(`State schema already registered: ${schema.id}`)
    const owner = {}
    this.stateSchemas.set(schema.id, schema)
    this.stateSchemaOwners.set(schema.id, owner)
    let active = true
    return { dispose: () => { if (active && this.stateSchemaOwners.get(schema.id) === owner) { active = false; this.stateSchemas.delete(schema.id); this.stateSchemaOwners.delete(schema.id) } } }
  }

  registerStateReducer(reducer: StateReducer): Disposable {
    if (!reducer.id.trim() || !reducer.moduleId.trim()) throw new Error('State reducer id and module id are required.')
    if (!this.stateModules.has(reducer.moduleId)) throw new Error(`State module is not registered: ${reducer.moduleId}`)
    if (this.stateReducers.has(reducer.id)) throw new Error(`State reducer already registered: ${reducer.id}`)
    const owner = {}
    this.stateReducers.set(reducer.id, reducer)
    this.stateReducerOwners.set(reducer.id, owner)
    let active = true
    return { dispose: () => { if (active && this.stateReducerOwners.get(reducer.id) === owner) { active = false; this.stateReducers.delete(reducer.id); this.stateReducerOwners.delete(reducer.id) } } }
  }

  registerRecordCollection(definition: RecordCollectionDefinition): Disposable {
    if (!definition.id.trim() || !definition.moduleId.trim() || !definition.path.startsWith('/')) throw new Error('Record collection id, moduleId and JSON Pointer path are required.')
    decodePointer(definition.path)
    if (!this.stateModules.has(definition.moduleId)) throw new Error(`State module is not registered: ${definition.moduleId}`)
    if (this.recordCollections.has(definition.id)) throw new Error(`Record collection already registered: ${definition.id}`)
    const owner = {}
    this.recordCollections.set(definition.id, definition)
    this.recordCollectionOwners.set(definition.id, owner)
    let active = true
    return { dispose: () => { if (active && this.recordCollectionOwners.get(definition.id) === owner) { active = false; this.recordCollections.delete(definition.id); this.recordCollectionOwners.delete(definition.id) } } }
  }

  operateRecord(request: RecordOperationRequest): RecordOperationResult {
    const collection = this.recordCollections.get(request.collectionId)
    if (!collection) throw new Error(`Record collection is not registered: ${request.collectionId}`)
    const absolute = `/modules/${pointerSegment(collection.moduleId)}${collection.path === '/' ? '' : collection.path}`
    const current = readPointer(this.state, absolute)
    const records = Array.isArray(current) ? copy(current) : []
    const idOf = (record: unknown): string => {
      const id = (record as { id?: unknown })?.id
      if (typeof id !== 'string' || !id) throw new Error(`Record in ${collection.id} must have a string id.`)
      return id
    }
    const recordIds = records.map(idOf)
    if (new Set(recordIds).size !== records.length) throw new Error(`Record collection contains duplicate ids: ${collection.id}`)
    const validate = (record: unknown): void => {
      assertJsonSafe(record, 'Record')
      const result = collection.validate?.(copy(record))
      if (Array.isArray(result) && result.length) throw new Error(`Record validation failed: ${result.join('; ')}`)
    }
    if (request.operation === 'list') {
      if (request.baseRevision !== undefined && request.baseRevision !== this.revision) throw new Error(`State revision conflict: expected ${request.baseRevision}, current ${this.revision}`)
      return { revision: this.revision, records: copy(records) }
    }
    const roomId = request.roomId ?? this.lastRoom?.id
    if (!roomId) throw new Error('Record mutation roomId is required.')
    let patches: StatePatch[]
    if (request.operation === 'create-or-upsert') {
      if (request.record === undefined) throw new Error('Record create-or-upsert requires record.')
      validate(request.record)
      const id = idOf(request.record)
      const index = records.findIndex(record => idOf(record) === id)
      patches = index >= 0
        ? [{ op: 'set', path: `${absolute}/${index}`, value: copy(request.record) }]
        : [...(Array.isArray(current) ? [] : [{ op: 'set', path: absolute, value: [] } as StatePatch]), { op: 'insert', path: `${absolute}/-`, value: copy(request.record) }]
    } else if (request.operation === 'edit') {
      if (!request.id || (request.record === undefined && !request.patches)) throw new Error('Record edit requires id and record or patches.')
      const index = records.findIndex(record => idOf(record) === request.id)
      if (index < 0) throw new Error(`Record does not exist: ${request.id}`)
      const edited = request.patches ? applyStatePatches(records[index], request.patches).after : request.record
      if (idOf(edited) !== request.id) throw new Error('Edited record id must match the target id.')
      validate(edited)
      patches = [{ op: 'replace', path: `${absolute}/${index}`, value: copy(edited) }]
    } else if (request.operation === 'remove') {
      if (!request.id) throw new Error('Record remove requires id.')
      const index = records.findIndex(record => idOf(record) === request.id)
      if (index < 0) throw new Error(`Record does not exist: ${request.id}`)
      patches = [{ op: 'remove', path: `${absolute}/${index}` }]
    } else {
      if (!request.order || new Set(request.order).size !== request.order.length || request.order.length !== records.length) throw new Error('Record reorder must contain each existing id exactly once.')
      const byId = new Map(records.map(record => [idOf(record), record]))
      if (request.order.some(id => !byId.has(id))) throw new Error('Record reorder contains an unknown id.')
      patches = [{ op: 'set', path: absolute, value: request.order.map(id => copy(byId.get(id))) }]
    }
    const transaction = this.transactState({ roomId, moduleId: collection.moduleId, baseRevision: request.baseRevision, patches })
    return { revision: transaction.revision, records: copy(readPointer(transaction.after, absolute) ?? []) as unknown[], transaction }
  }

  registerProposalType(definition: ProposalTypeDefinition): Disposable {
    if (!definition.id.trim() || !definition.moduleId.trim() || !definition.path.startsWith('/')) throw new Error('Proposal type id, moduleId and JSON Pointer path are required.')
    decodePointer(definition.path)
    if (!this.stateModules.has(definition.moduleId)) throw new Error(`State module is not registered: ${definition.moduleId}`)
    if (this.proposalTypes.has(definition.id)) throw new Error(`Proposal type already registered: ${definition.id}`)
    const owner = {}
    this.proposalTypes.set(definition.id, definition)
    this.proposalTypeOwners.set(definition.id, owner)
    let active = true
    return { dispose: () => { if (active && this.proposalTypeOwners.get(definition.id) === owner) { active = false; this.proposalTypes.delete(definition.id); this.proposalTypeOwners.delete(definition.id) } } }
  }

  operateProposal(request: ProposalOperationRequest): Proposal | Proposal[] | undefined {
    if (request.baseRevision !== undefined && request.baseRevision !== this.revision) throw new Error(`State revision conflict: expected ${request.baseRevision}, current ${this.revision}`)
    const absolutePath = (type: ProposalTypeDefinition): string => `/modules/${pointerSegment(type.moduleId)}${type.path === '/' ? '' : type.path}`
    const find = (state: unknown, id: string, typeId?: string): { proposal: Proposal; type: ProposalTypeDefinition; index: number; path: string } | undefined => {
      for (const type of this.proposalTypes.values()) {
        if (typeId && type.id !== typeId) continue
        const values = readPointer(state, absolutePath(type))
        if (!Array.isArray(values)) continue
        const index = values.findIndex(value => (value as Proposal)?.id === id && (value as Proposal)?.typeId === type.id)
        if (index >= 0) return { proposal: values[index] as Proposal, type, index, path: absolutePath(type) }
      }
      return undefined
    }
    if (request.operation === 'list') {
      const values: Proposal[] = []
      for (const type of this.proposalTypes.values()) {
        if (request.typeId && request.typeId !== type.id) continue
        const collection = readPointer(this.state, absolutePath(type))
        if (Array.isArray(collection)) values.push(...collection.filter(value => (value as Proposal).typeId === type.id && (!request.status || (value as Proposal).status === request.status)).map(copy))
      }
      return values
    }
    if (request.operation === 'get') return request.id ? copy(find(this.state, request.id, request.typeId)?.proposal) : undefined
    if (request.operation === 'create') {
      if (!request.typeId || request.input === undefined) throw new Error('Proposal create requires typeId and input.')
      const type = this.proposalTypes.get(request.typeId)
      if (!type) throw new Error(`Proposal type is not registered: ${request.typeId}`)
      const validation = type.validate(copy(request.input))
      assertJsonSafe(request.input, 'Proposal input')
      if (Array.isArray(validation) && validation.length) throw new Error(`Proposal validation failed: ${validation.join('; ')}`)
      const now = this.clock.now()
      const proposal: Proposal = { id: request.id ?? this.ids.create(), typeId: type.id, moduleId: type.moduleId, status: 'pending', input: copy(request.input), createdAt: now, updatedAt: now }
      const path = absolutePath(type)
      const current = readPointer(this.state, path)
      if (find(this.state, proposal.id) || (Array.isArray(current) && current.some(value => (value as Proposal)?.id === proposal.id))) throw new Error(`Proposal already exists: ${proposal.id}`)
      const patches: StatePatch[] = Array.isArray(current) ? [] : [{ op: 'set', path, value: [] }]
      patches.push({ op: 'insert', path: `${path}/-`, value: proposal })
      const roomId = request.roomId ?? this.lastRoom?.id
      if (!roomId) throw new Error('Proposal mutation roomId is required.')
      const transaction = this.transactState({ roomId, moduleId: type.moduleId, baseRevision: request.baseRevision, patches })
      return copy(find(transaction.after, proposal.id, type.id)?.proposal)
    }
    if (!request.id) throw new Error('Proposal operation requires id.')
    const found = find(this.state, request.id, request.typeId)
    if (!found) throw new Error(`Proposal does not exist: ${request.id}`)
    const proposal = found.proposal
    if (request.operation === 'edit') {
      if (proposal.status !== 'pending' || request.input === undefined) throw new Error('Only pending proposals can be edited.')
      const type = this.proposalTypes.get(proposal.typeId)
      if (!type) throw new Error(`Proposal type is not registered: ${proposal.typeId}`)
      const validation = type.validate(copy(request.input))
      assertJsonSafe(request.input, 'Proposal input')
      if (Array.isArray(validation) && validation.length) throw new Error(`Proposal validation failed: ${validation.join('; ')}`)
      const edited = { ...proposal, input: copy(request.input), updatedAt: this.clock.now() }
      const roomId = request.roomId ?? this.lastRoom?.id
      if (!roomId) throw new Error('Proposal mutation roomId is required.')
      const transaction = this.transactState({ roomId, moduleId: type.moduleId, baseRevision: request.baseRevision, patches: [{ op: 'replace', path: `${found.path}/${found.index}`, value: edited }] })
      return copy(find(transaction.after, request.id, type.id)?.proposal)
    }
    if (request.operation === 'reject') {
      if (proposal.status !== 'pending') throw new Error('Only pending proposals can be rejected.')
      const rejected = { ...proposal, status: 'rejected' as const, updatedAt: this.clock.now() }
      const roomId = request.roomId ?? this.lastRoom?.id
      if (!roomId) throw new Error('Proposal mutation roomId is required.')
      const transaction = this.transactState({ roomId, moduleId: proposal.moduleId, baseRevision: request.baseRevision, patches: [{ op: 'replace', path: `${found.path}/${found.index}`, value: rejected }] })
      return copy(find(transaction.after, request.id)?.proposal)
    }
    if (proposal.status !== 'pending') throw new Error('Only pending proposals can be approved.')
    const type = this.proposalTypes.get(proposal.typeId)
    if (!type) throw new Error(`Proposal type is not registered: ${proposal.typeId}`)
    const applied = type.apply(copy(proposal.input))
    const transaction = Array.isArray(applied) ? { patches: applied } : applied
    assertJsonSafe(transaction, 'Proposal transaction')
    const roomId = request.roomId ?? this.lastRoom?.id
    if (!roomId) throw new Error('Proposal mutation roomId is required.')
    const approved = { ...proposal, status: 'approved' as const, updatedAt: this.clock.now() }
    const guard = { op: 'test', path: `${found.path}/${found.index}`, value: proposal } as StatePatch
    const patches = [guard, ...transaction.patches, { op: 'test', path: `${found.path}/${found.index}`, value: proposal } as StatePatch, { op: 'replace', path: `${found.path}/${found.index}`, value: approved } as StatePatch]
    const result = this.transactState({ roomId, moduleId: proposal.moduleId, baseRevision: request.baseRevision, patches, events: transaction.events })
    return copy(find(result.after, request.id)?.proposal)
  }

  registerEffectHandler(definition: EffectHandlerDefinition): Disposable {
    if (!definition.id.trim() || this.effectHandlers.has(definition.id)) throw new Error(`Effect handler already registered: ${definition.id}`)
    const owner = {}
    this.effectHandlers.set(definition.id, definition)
    this.effectHandlerOwners.set(definition.id, owner)
    let active = true
    return { dispose: () => { if (active && this.effectHandlerOwners.get(definition.id) === owner) { active = false; this.effectHandlers.delete(definition.id); this.effectHandlerOwners.delete(definition.id) } } }
  }

  async invokeEffect(id: string, input: unknown): Promise<unknown> {
    const handler = this.effectHandlers.get(id)
    if (!handler) throw new Error(`Effect handler is not registered: ${id}`)
    return copy(await handler.handle(copy(input)))
  }

  registerPromptContributor(definition: PromptContributorDefinition): Disposable {
    return this.registerContributor(this.promptContributors, this.promptContributorOwners, definition, 'Prompt contributor')
  }

  composePrompt(input: unknown): PromptFragment[] {
    const output: PromptFragment[] = []
    for (const contributor of this.sorted(this.promptContributors)) {
      const fragments = contributor.contribute(copy(input))
      for (const fragment of (Array.isArray(fragments) ? fragments : [fragments])) { if (!fragment || typeof fragment.kind !== 'string' || !fragment.kind) throw new Error('Prompt fragment kind must be a non-empty string.'); assertJsonSafe(fragment, 'Prompt fragment'); output.push(copy(fragment)) }
    }
    return output
  }

  registerViewContributor(definition: ViewContributorDefinition): Disposable {
    return this.registerContributor(this.viewContributors, this.viewContributorOwners, definition, 'View contributor')
  }

  composeView(input: unknown): ViewContribution[] {
    const output: ViewContribution[] = []
    for (const contributor of this.sorted(this.viewContributors)) {
      const contributions = contributor.contribute(copy(input))
      for (const contribution of (Array.isArray(contributions) ? contributions : [contributions])) { if (!contribution || typeof contribution.kind !== 'string' || !contribution.kind) throw new Error('View contribution kind must be a non-empty string.'); assertJsonSafe(contribution, 'View contribution'); output.push(copy(contribution)) }
    }
    return output
  }

  private sorted<T extends { id: string; priority?: number }>(items: Map<string, T>): T[] {
    return [...items.values()].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id))
  }

  private registerContributor<T extends { id: string }>(items: Map<string, T>, owners: Map<string, object | string>, definition: T, label: string): Disposable {
    if (!definition.id.trim() || items.has(definition.id)) throw new Error(`${label} already registered: ${definition.id}`)
    const owner = {}
    items.set(definition.id, definition)
    owners.set(definition.id, owner)
    let active = true
    return { dispose: () => { if (active && owners.get(definition.id) === owner) { active = false; items.delete(definition.id); owners.delete(definition.id) } } }
  }

  /** 以事务式 reducer 计算多个 StateEvent；任一 reducer 失败时不替换当前 state。 */
  applyStateEvents(events: StateEvent[]): void {
    if (events.length === 0) return
    const next = this.reduceState(this.state, events)
    const workflows = [...this.workflows.values()]
    const actions = workflows.flatMap(workflow => this.workflowExecutor.plan(workflow))
    this.commitStateCandidate(next, events, workflows, actions, this.roomIdFromEvents(events))
  }

  transactState(request: StateTransactionRequest): StateTransactionResult {
    if (this.stateTransactionActive) throw new Error('Nested state transaction is not allowed.')
    this.stateTransactionActive = true
    try {
      return this.transactStateInternal(request)
    } finally {
      this.stateTransactionActive = false
    }
  }

  private transactStateInternal(request: StateTransactionRequest): StateTransactionResult {
    if (request.baseRevision !== undefined && request.baseRevision !== this.revision) throw new Error(`State revision conflict: expected ${request.baseRevision}, current ${this.revision}`)
    const roomId = request.roomId || this.lastRoom?.id
    if (!roomId) throw new Error('State transaction roomId is required.')
    if (!request.system && !request.moduleId) throw new Error('State transaction moduleId is required.')
    if (request.moduleId && !this.stateModules.has(request.moduleId)) throw new Error(`State module is not registered: ${request.moduleId}`)
    const checkPath = (path: string, label: string): void => {
      if (path.startsWith('/modules/')) {
        const moduleSegment = path.slice('/modules/'.length).split('/')[0].replace(/~1/g, '/').replace(/~0/g, '~')
        if (!this.stateModules.has(moduleSegment)) throw new Error(`${label} targets an unregistered state module: ${moduleSegment}`)
        if (!request.system && !isModulePath(path, request.moduleId!)) throw new Error(`${label} is outside /modules/${request.moduleId}`)
        return
      }
      if (!request.system) throw new Error(`${label} is outside /modules/${request.moduleId}`)
      const category = path.slice(1).split('/')[0].replace(/~1/g, '/').replace(/~0/g, '~')
      if (!category || !this.categories.has(category)) throw new Error(`${label} targets an unregistered state category: ${category}`)
    }
    for (const patch of request.patches ?? []) {
      checkPath(patch.path, 'State patch')
      if (patch.op === 'move') checkPath(patch.from, 'State move source')
    }
    for (const assertion of request.assertions ?? []) {
      if (assertion.op !== 'test') throw new Error('State assertions only support test patches.')
      checkPath(assertion.path, 'State assertion')
    }
    const before = structuredClone(this.state)
    let candidate = structuredClone(this.state)
    const trace = { events: [] as StateReducerEvent[], reducers: [] as string[], changes: [] as import('./state-transaction.ts').StateChange[], assertions: structuredClone(request.assertions ?? []) }
    if (request.patches?.length) candidate = applyStatePatches(candidate, request.patches).after
    const queue: Array<{ event: StateReducerEvent; depth: number }> = structuredClone(request.events ?? []).map(event => ({ event, depth: 0 }))
    const seen = new Set<string>()
    for (const { event } of queue) {
      if (!event.id.trim() || seen.has(event.id)) throw new Error(`Duplicate state transaction event id: ${event.id}`)
      seen.add(event.id)
    }
    let cursor = 0
    const reducers = [...this.stateReducers.values()].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id))
    while (cursor < queue.length) {
      if (trace.events.length >= 256) throw new Error('State transaction event limit exceeded.')
      const queued = queue[cursor++]
      if (queued.depth > 32) throw new Error('State transaction cascade depth exceeded.')
      const event = queued.event
      trace.events.push(event)
      for (const reducer of reducers) {
        if (reducer.listensTo && !reducer.listensTo.includes(event.type)) continue
        if (reducer.match && !reducer.match(event)) continue
        const namespace = structuredClone((candidate.modules as Record<string, unknown> | undefined)?.[reducer.moduleId])
        const result = reducer.reduce(namespace, event)
        if (!result) continue
        trace.reducers.push(reducer.id)
        const output = Array.isArray(result) ? { patches: result } : result
        for (const patch of output.patches ?? []) {
          if (!isModulePath(patch.path, reducer.moduleId) || (patch.op === 'move' && !isModulePath(patch.from, reducer.moduleId))) throw new Error(`Reducer ${reducer.id} cannot modify outside /modules/${reducer.moduleId}`)
          candidate = applyStatePatches(candidate, [patch]).after
        }
        for (const next of output.events ?? []) {
          const clonedNext = structuredClone(next)
          if (!clonedNext.id.trim() || seen.has(clonedNext.id)) throw new Error(`Duplicate state transaction event id: ${clonedNext.id}`)
          seen.add(clonedNext.id)
          queue.push({ event: clonedNext, depth: queued.depth + 1 })
        }
      }
    }
    if (request.assertions?.length) applyStatePatches(candidate, request.assertions)
    for (const schema of this.stateSchemas.values()) {
      const result = schema.validate(structuredClone((candidate.modules as Record<string, unknown> | undefined)?.[schema.moduleId]))
      if (Array.isArray(result) && result.length) throw new Error(`State schema ${schema.id} failed: ${result.join('; ')}`)
    }
    const changes = applyStatePatches(before, [{ op: 'set', path: '', value: candidate }]).changes
    trace.changes = changes
    if (!request.patches?.length && !request.events?.length) return { roomId, revision: this.revision, before: structuredClone(before), after: structuredClone(candidate), changes: structuredClone(changes), assertions: structuredClone(request.assertions ?? []), trace: structuredClone(trace) }
    const nextRevision = this.revision + 1
    const events: StateEvent[] = trace.events.map(event => ({ id: event.id, type: event.type, source: 'plugin', payload: event.payload, createdAt: this.clock.now() }))
    if (events.length === 0) events.push({ id: request.traceId ?? `state.transaction:${nextRevision}`, type: 'state.transaction', source: request.system ? 'system' : 'plugin', payload: { patches: request.patches ?? [] }, createdAt: this.clock.now() })
    const workflows = [...this.workflows.values()]
    const recent = this.withRecentEvents(events)
    this.stateRepository?.commit({ roomId, revision: nextRevision, state: structuredClone(candidate), events: structuredClone(events), workflows: structuredClone(workflows) })
    this.state = candidate
    this.revision = nextRevision
    this.recentEvents.length = 0
    this.recentEvents.push(...recent)
    const transition = { revision: nextRevision, events, changes }
    this.emit({ type: 'state.changed', revision: nextRevision, transition })
    return { roomId, revision: nextRevision, before: structuredClone(before), after: structuredClone(candidate), changes: structuredClone(changes), assertions: structuredClone(request.assertions ?? []), trace: structuredClone(trace) }
  }

  projectRoom(room: RoomSnapshot, causedBy = 'core.project-room', options: { persist?: boolean } = {}): void {
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
      candidateWorkflows.set(workflow.id, { ...workflow, pendingInteractionIds: [interaction.id], updatedAt: this.clock.now() })
    }
    const finalWorkflows = [...candidateWorkflows.values()]
    const candidateActions = finalWorkflows.flatMap(workflow => this.workflowExecutor.plan(workflow))
    const event = roomSnapshotEvent(room, causedBy, candidateState, this.clock)
    const candidateRecentEvents = this.withRecentEvents([event])
    const projectionRevision = jsonDeepEqual(candidateState, this.state)
      ? Math.max(this.revision, room.revision)
      : Math.max(room.revision, this.revision + 1)

    // Repository commit is deliberately before any in-memory replacement or event emission.
    if (persist && this.stateRepository) {
      this.stateRepository.commit({ roomId: room.id, revision: projectionRevision, state: structuredClone(candidateState), events: structuredClone([event]), workflows: structuredClone(finalWorkflows) })
    } else if (persist) {
      this.eventLog?.append(room.id, projectionRevision, event)
      for (const workflow of finalWorkflows) this.workflowStore?.save(room.id, workflow)
    }

    this.lastRoom = room
    this.state = candidateState
    // A legacy room projection may carry an older room revision than a
    // generic state transaction already committed in this runtime. Projection
    // must never make the optimistic revision go backwards.
    this.revision = projectionRevision
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
    const modules = new Map<string, StateModuleManifest>()
    const schemas = new Map<string, StateSchemaDefinition>()
    const reducers = new Map<string, StateReducer>()
    const recordCollections = new Map<string, RecordCollectionDefinition>()
    const proposalTypes = new Map<string, ProposalTypeDefinition>()
    const effectHandlers = new Map<string, EffectHandlerDefinition>()
    const promptContributors = new Map<string, PromptContributorDefinition>()
    const viewContributors = new Map<string, ViewContributorDefinition>()
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
      registerStateModule: (manifest: StateModuleManifest): Disposable => {
        if (settled) throw new Error('Solution binding is already settled.')
        if (!manifest.id.trim() || modules.has(manifest.id) || this.stateModules.has(manifest.id)) throw new Error(`State module already registered: ${manifest.id}`)
        modules.set(manifest.id, manifest)
        return { dispose: () => { if (!settled) modules.delete(manifest.id) } }
      },
      registerStateSchema: (schema: StateSchemaDefinition): Disposable => {
        if (settled) throw new Error('Solution binding is already settled.')
        if (!schema.id.trim() || schemas.has(schema.id) || this.stateSchemas.has(schema.id)) throw new Error(`State schema already registered: ${schema.id}`)
        if (!modules.has(schema.moduleId) && !this.stateModules.has(schema.moduleId)) throw new Error(`State module is not registered: ${schema.moduleId}`)
        schemas.set(schema.id, schema)
        return { dispose: () => { if (!settled) schemas.delete(schema.id) } }
      },
      registerStateReducer: (reducer: StateReducer): Disposable => {
        if (settled) throw new Error('Solution binding is already settled.')
        if (!reducer.id.trim() || reducers.has(reducer.id) || this.stateReducers.has(reducer.id)) throw new Error(`State reducer already registered: ${reducer.id}`)
        if (!modules.has(reducer.moduleId) && !this.stateModules.has(reducer.moduleId)) throw new Error(`State module is not registered: ${reducer.moduleId}`)
        reducers.set(reducer.id, reducer)
          return { dispose: () => { if (!settled) reducers.delete(reducer.id) } }
        },
        registerRecordCollection: (definition: RecordCollectionDefinition): Disposable => {
          if (settled) throw new Error('Solution binding is already settled.')
          if (!definition.id.trim() || !definition.path.startsWith('/') || recordCollections.has(definition.id) || this.recordCollections.has(definition.id)) throw new Error(`Record collection already registered: ${definition.id}`)
          decodePointer(definition.path)
          if (!modules.has(definition.moduleId) && !this.stateModules.has(definition.moduleId)) throw new Error(`State module is not registered: ${definition.moduleId}`)
          recordCollections.set(definition.id, definition)
          return { dispose: () => { if (!settled) recordCollections.delete(definition.id) } }
        },
        registerProposalType: (definition: ProposalTypeDefinition): Disposable => {
          if (settled) throw new Error('Solution binding is already settled.')
          if (!definition.id.trim() || !definition.path.startsWith('/') || proposalTypes.has(definition.id) || this.proposalTypes.has(definition.id)) throw new Error(`Proposal type already registered: ${definition.id}`)
          decodePointer(definition.path)
          if (!modules.has(definition.moduleId) && !this.stateModules.has(definition.moduleId)) throw new Error(`State module is not registered: ${definition.moduleId}`)
          proposalTypes.set(definition.id, definition)
          return { dispose: () => { if (!settled) proposalTypes.delete(definition.id) } }
        },
        registerEffectHandler: (definition: EffectHandlerDefinition): Disposable => {
          if (settled) throw new Error('Solution binding is already settled.')
          if (!definition.id.trim() || effectHandlers.has(definition.id) || this.effectHandlers.has(definition.id)) throw new Error(`Effect handler already registered: ${definition.id}`)
          effectHandlers.set(definition.id, definition)
          return { dispose: () => { if (!settled) effectHandlers.delete(definition.id) } }
        },
        registerPromptContributor: (definition: PromptContributorDefinition): Disposable => {
          if (settled) throw new Error('Solution binding is already settled.')
          if (!definition.id.trim() || promptContributors.has(definition.id) || this.promptContributors.has(definition.id)) throw new Error(`Prompt contributor already registered: ${definition.id}`)
          promptContributors.set(definition.id, definition)
          return { dispose: () => { if (!settled) promptContributors.delete(definition.id) } }
        },
        registerViewContributor: (definition: ViewContributorDefinition): Disposable => {
          if (settled) throw new Error('Solution binding is already settled.')
          if (!definition.id.trim() || viewContributors.has(definition.id) || this.viewContributors.has(definition.id)) throw new Error(`View contributor already registered: ${definition.id}`)
          viewContributors.set(definition.id, definition)
          return { dispose: () => { if (!settled) viewContributors.delete(definition.id) } }
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
        for (const manifest of modules.values()) if (this.stateModules.has(manifest.id)) throw new Error(`State module already registered: ${manifest.id}`)
        for (const schema of schemas.values()) {
          if (this.stateSchemas.has(schema.id)) throw new Error(`State schema already registered: ${schema.id}`)
          if (!modules.has(schema.moduleId) && !this.stateModules.has(schema.moduleId)) throw new Error(`State module is not registered: ${schema.moduleId}`)
        }
        for (const reducer of reducers.values()) {
          if (this.stateReducers.has(reducer.id)) throw new Error(`State reducer already registered: ${reducer.id}`)
          if (!modules.has(reducer.moduleId) && !this.stateModules.has(reducer.moduleId)) throw new Error(`State module is not registered: ${reducer.moduleId}`)
        }
        for (const definition of recordCollections.values()) {
          if (this.recordCollections.has(definition.id)) throw new Error(`Record collection already registered: ${definition.id}`)
          if (!modules.has(definition.moduleId) && !this.stateModules.has(definition.moduleId)) throw new Error(`State module is not registered: ${definition.moduleId}`)
        }
        for (const definition of proposalTypes.values()) {
          if (this.proposalTypes.has(definition.id)) throw new Error(`Proposal type already registered: ${definition.id}`)
          if (!modules.has(definition.moduleId) && !this.stateModules.has(definition.moduleId)) throw new Error(`State module is not registered: ${definition.moduleId}`)
        }
        for (const definition of effectHandlers.values()) if (this.effectHandlers.has(definition.id)) throw new Error(`Effect handler already registered: ${definition.id}`)
        for (const definition of promptContributors.values()) if (this.promptContributors.has(definition.id)) throw new Error(`Prompt contributor already registered: ${definition.id}`)
        for (const definition of viewContributors.values()) if (this.viewContributors.has(definition.id)) throw new Error(`View contributor already registered: ${definition.id}`)
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
        for (const [id, manifest] of modules) { this.stateModules.set(id, manifest); this.stateModuleOwners.set(id, bindingOwner) }
        for (const [id, schema] of schemas) { this.stateSchemas.set(id, schema); this.stateSchemaOwners.set(id, bindingOwner) }
        for (const [id, reducer] of reducers) { this.stateReducers.set(id, reducer); this.stateReducerOwners.set(id, bindingOwner) }
        for (const [id, definition] of recordCollections) { this.recordCollections.set(id, definition); this.recordCollectionOwners.set(id, bindingOwner) }
        for (const [id, definition] of proposalTypes) { this.proposalTypes.set(id, definition); this.proposalTypeOwners.set(id, bindingOwner) }
        for (const [id, definition] of effectHandlers) { this.effectHandlers.set(id, definition); this.effectHandlerOwners.set(id, bindingOwner) }
        for (const [id, definition] of promptContributors) { this.promptContributors.set(id, definition); this.promptContributorOwners.set(id, bindingOwner) }
        for (const [id, definition] of viewContributors) { this.viewContributors.set(id, definition); this.viewContributorOwners.set(id, bindingOwner) }
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
            for (const id of modules.keys()) { this.stateModules.delete(id); this.stateModuleOwners.delete(id) }
            for (const id of schemas.keys()) { this.stateSchemas.delete(id); this.stateSchemaOwners.delete(id) }
            for (const id of reducers.keys()) { this.stateReducers.delete(id); this.stateReducerOwners.delete(id) }
            for (const id of recordCollections.keys()) { this.recordCollections.delete(id); this.recordCollectionOwners.delete(id) }
            for (const id of proposalTypes.keys()) { this.proposalTypes.delete(id); this.proposalTypeOwners.delete(id) }
            for (const id of effectHandlers.keys()) { this.effectHandlers.delete(id); this.effectHandlerOwners.delete(id) }
            for (const id of promptContributors.keys()) { this.promptContributors.delete(id); this.promptContributorOwners.delete(id) }
            for (const id of viewContributors.keys()) { this.viewContributors.delete(id); this.viewContributorOwners.delete(id) }
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
        modules.clear()
        schemas.clear()
        reducers.clear()
        recordCollections.clear()
        proposalTypes.clear()
        effectHandlers.clear()
        promptContributors.clear()
        viewContributors.clear()
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
    if (this.state.modules !== undefined) projected.modules = structuredClone(this.state.modules)
    return projected
  }

  private filterState(state: Record<string, unknown>): Record<string, unknown> {
    const filtered: Record<string, unknown> = {}
    for (const [id, value] of Object.entries(state)) if (this.categories.get(id)?.enabled !== false && this.categories.has(id)) filtered[id] = value
    if (state.modules !== undefined) filtered.modules = structuredClone(state.modules)
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
      this.stateRepository.commit({ roomId, revision: this.revision, state: structuredClone(state), events: structuredClone(events), workflows: structuredClone(workflows) })
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
    const error = new Error(`Core command has no handler: ${command.type}`)
    this.emit({ type: 'error', revision: this.revision, message: error.message })
    throw error
  }

  private resolveInteraction(interaction: import('./protocol.ts').InteractionRequest, command: HumanCommand): void {
    this.interactions.delete(interaction.id)
    for (const [id, workflow] of this.workflows) {
      if (!workflow.pendingInteractionIds.includes(interaction.id)) continue
      const next = { ...workflow, pendingInteractionIds: workflow.pendingInteractionIds.filter(id => id !== interaction.id), updatedAt: this.clock.now() }
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
        const next = { ...workflow, pendingModelRequestIds: [...new Set([...workflow.pendingModelRequestIds, request.requestId])], updatedAt: this.clock.now() }
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
    if (cancelledUntil && cancelledUntil > this.clockTimestamp()) { this.cancelledModelRequests.delete(result.requestId); return }
    const waiter = this.modelWaiters.get(result.requestId)
    if (waiter) {
      this.modelWaiters.delete(result.requestId)
      waiter.resolve(result)
    }
    for (const [id, workflow] of this.workflows) {
      if (!workflow.pendingModelRequestIds.includes(result.requestId)) continue
      const next = { ...workflow, pendingModelRequestIds: workflow.pendingModelRequestIds.filter(requestId => requestId !== result.requestId), updatedAt: this.clock.now() }
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

  registerUiManifest(manifest: UiManifest, handlers?: UiActionHandler[]): Disposable { return this.uiRegistry.register(manifest, handlers) }
  listUiManifests(): UiManifest[] { return this.uiRegistry.list() }
  renderUi(view = this.getView()): UiRenderResult { return this.uiRegistry.render(view) }
  invokeUiAction(actionId: string, input: unknown, owner: string): Promise<unknown> { return this.uiRegistry.invoke(actionId, input, owner) }
  subscribeUi(listener: (event: CoreEvent) => void): Disposable { const unsubscribe = this.uiRegistry.subscribe(listener); return { dispose: unsubscribe } }

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
      viewContributions: this.composeView({ roomId: this.lastRoom?.id, revision: this.revision, state: structuredClone(this.state) }),
      ui: this.uiRegistry.render({ protocolVersion: CORE_PROTOCOL_VERSION, revision: this.revision, state: structuredClone(this.state), workflows: [...this.workflows.values()], interactions: [...this.interactions.values()], actions: structuredClone(this.actions), availableCommands: this.availableCommands(), recentEvents: structuredClone(this.recentEvents) }),
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
      const next = { ...workflow, pendingModelRequestIds: workflow.pendingModelRequestIds.filter(item => item !== requestId), updatedAt: this.clock.now() }
      this.workflows.set(id, next)
      const roomId = String(next.locals.roomId ?? '')
      if (roomId) this.workflowStore?.save(roomId, next)
      this.emit({ type: 'workflow.changed', revision: this.revision, workflow: next })
    }
  }

  private rememberCancelledModelRequest(requestId: string): void {
    this.pruneCancelledModelRequests()
    this.cancelledModelRequests.set(requestId, this.clockTimestamp() + 5 * 60_000)
    while (this.cancelledModelRequests.size > 512) this.cancelledModelRequests.delete(this.cancelledModelRequests.keys().next().value as string)
  }

  private pruneCancelledModelRequests(): void {
    const now = this.clockTimestamp()
    for (const [requestId, expiresAt] of this.cancelledModelRequests) if (expiresAt <= now) this.cancelledModelRequests.delete(requestId)
  }

  private clockTimestamp(): number {
    const timestamp = Date.parse(this.clock.now())
    if (!Number.isFinite(timestamp)) throw new Error('Platform clock returned an invalid ISO timestamp.')
    return timestamp
  }
}
