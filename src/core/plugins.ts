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
}

export type { CoreStateCommit, CoreStateRestore, CoreStateRepository }

/** 方案插件向 Core 注册固定 Workflow 与只读状态投影的最小 Host。 */
export interface CoreSolutionHost {
  registerWorkflow(definition: WorkflowDefinition): Disposable
  registerProjection(provider: CoreSolutionProjectionProvider): Disposable
  registerStateCategory(category: StateCategoryDefinition): Disposable
  registerStateProjection(provider: CoreStateProjectionProvider): Disposable
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
