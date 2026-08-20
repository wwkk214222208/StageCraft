import type {
  CoreEvent,
  CoreEventListener,
  CoreRuntimePort,
  HumanCommand,
  ModelRequest,
  ModelResult,
  InteractionRequest,
  WorkflowDefinition,
  WorkflowInstance,
} from './protocol.ts'
import type { RoomSnapshot } from '../types.ts'
import type { StateCategoryDefinition } from './state.ts'
import type { CoreStateCommit, CoreStateRestore, CoreStateRepository } from './state-repository.ts'
import type { StateModuleManifest, StateReducer, StateSchemaDefinition, StateTransactionRequest, StateTransactionResult } from './state-transaction.ts'
import type { EffectHandlerDefinition, PromptContributorDefinition, ProposalTypeDefinition, RecordCollectionDefinition, ViewContributorDefinition } from './extensions.ts'
import type { UiActionHandler, UiManifest, UiRenderResult } from './ui.ts'

/** 可逆资源句柄：HTTP、Cordis、SSE 等 adapter 安装后都必须能释放。 */
export interface Disposable {
  dispose(): void | Promise<void>
}

/** 人-核心交互插件：只处理输入输出协议，不直接访问业务 Store。 */
export interface HumanCoreInteractionPlugin {
  readonly id: string
  install(core: CoreRuntimePort): Disposable
  dispatch(command: HumanCommand): Promise<void>
  publish(event: CoreEvent): void
}

/** 核心-LLM 路由插件：只负责 ModelRequest/ModelResult，不推进业务状态。 */
export interface CoreLlmRouterPlugin {
  readonly id: string
  install(core: CoreLlmRouterHost): Disposable
  request(request: ModelRequest): Promise<void>
  cancel(requestId: string): Promise<void>
}

export interface CoreLlmRouterHost {
  submitModelResult(result: ModelResult): Promise<void>
  publishModelEvent(event: CoreEvent): void
}

/** 仅供插件容器使用的核心绑定端口，不暴露给普通交互 adapter。 */
export interface CoreRuntimeBindingPort {
  bindLlmRouter(plugin: CoreLlmRouterPlugin): Disposable
  createSolutionBinding(): CoreSolutionBinding
  registerStateModule(manifest: StateModuleManifest): Disposable
  registerStateSchema(schema: StateSchemaDefinition): Disposable
  registerStateReducer(reducer: StateReducer): Disposable
  transactState(request: StateTransactionRequest): StateTransactionResult
  registerRecordCollection(definition: RecordCollectionDefinition): Disposable
  operateRecord(request: import('./extensions.ts').RecordOperationRequest): import('./extensions.ts').RecordOperationResult
  registerProposalType(definition: ProposalTypeDefinition): Disposable
  operateProposal(request: import('./extensions.ts').ProposalOperationRequest): import('./extensions.ts').Proposal | import('./extensions.ts').Proposal[] | undefined
  registerEffectHandler(definition: EffectHandlerDefinition): Disposable
  invokeEffect(id: string, input: unknown): Promise<unknown>
  registerPromptContributor(definition: PromptContributorDefinition): Disposable
  composePrompt(input: unknown): import('./extensions.ts').PromptFragment[]
  registerViewContributor(definition: ViewContributorDefinition): Disposable
  composeView(input: unknown): import('./extensions.ts').ViewContribution[]
  registerUiManifest(manifest: UiManifest, handlers?: UiActionHandler[]): Disposable
  listUiManifests(): UiManifest[]
  renderUi(): UiRenderResult
  invokeUiAction(actionId: string, input: unknown, owner: string): Promise<unknown>
}

export type { CoreStateCommit, CoreStateRestore, CoreStateRepository }

/** 方案插件向 Core 注册固定 Workflow 与只读状态投影的最小 Host。 */
export interface CoreSolutionHost {
  registerWorkflow(definition: WorkflowDefinition): Disposable
  registerProjection(provider: CoreSolutionProjectionProvider): Disposable
  registerStateCategory(category: StateCategoryDefinition): Disposable
  registerStateProjection(provider: CoreStateProjectionProvider): Disposable
  registerCommandHandler(handler: CoreCommandHandler): Disposable
  registerStateModule(manifest: StateModuleManifest): Disposable
  registerStateSchema(schema: StateSchemaDefinition): Disposable
  registerStateReducer(reducer: StateReducer): Disposable
  registerRecordCollection(definition: RecordCollectionDefinition): Disposable
  registerProposalType(definition: ProposalTypeDefinition): Disposable
  registerEffectHandler(definition: EffectHandlerDefinition): Disposable
  registerPromptContributor(definition: PromptContributorDefinition): Disposable
  registerViewContributor(definition: ViewContributorDefinition): Disposable
}

/** 玩法对 Core 命令的扩展点；实现不得绕过 Core 事件/状态边界。 */
export interface CoreCommandHandler {
  readonly id: string
  canHandle(command: HumanCommand): boolean
  handle(command: HumanCommand, context: CoreHandlerContext): Promise<void>
}

export interface CoreHandlerContext {
  readonly core: CoreRuntimePort
}

export interface CoreSolutionProjection {
  workflows: WorkflowInstance[]
  interactions: InteractionRequest[]
}

export interface CoreSolutionProjectionProvider {
  readonly id: string
  project(room: RoomSnapshot): CoreSolutionProjection
  interactionBelongsToWorkflow?(interaction: InteractionRequest, workflow: WorkflowInstance): boolean
}

/** 方案对 Core State 的只读投影；返回值只能包含该方案已注册的类别。 */
export interface CoreStateProjectionProvider {
  readonly id: string
  project(room: RoomSnapshot): Record<string, unknown>
}

export interface CoreSolutionBinding {
  host: CoreSolutionHost
  commit(): Disposable
  rollback(): void
}

/** 固定、版本化的玩法方案；不支持动态 patch。 */
export interface CoreSolutionPlugin {
  readonly id: string
  install(host: CoreSolutionHost): Disposable
}

/** 核心运行时插件：持有状态与 workflow，向外提供统一 Core Port。 */
export interface CoreRuntimePlugin {
  readonly id: 'stagecraft.core' | string
  runtime: CoreRuntimePort
  install(): Disposable
}

/** 宿主用于装配三类插件的最小容器；不绑定 Cordis 或 HTTP。 */
export interface CorePluginContainer {
  core: CoreRuntimePort
  corePlugins?: CoreRuntimePlugin[]
  human?: HumanCoreInteractionPlugin[]
  llm?: CoreLlmRouterPlugin[]
  solutions?: CoreSolutionPlugin[]
  addCore(plugin: CoreRuntimePlugin): Disposable
  addHuman(plugin: HumanCoreInteractionPlugin): Disposable
  addLlm(plugin: CoreLlmRouterPlugin): Disposable
  addSolution(plugin: CoreSolutionPlugin): Disposable
  subscribe(listener: CoreEventListener): Disposable
  dispose(): void | Promise<void>
}
