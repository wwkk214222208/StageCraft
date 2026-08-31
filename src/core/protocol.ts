import type { ThinkingStrength, TokenUsage } from '../types.ts'
import type { DomainEvent } from './domain-events.ts'
import type { ViewContribution } from './extensions.ts'
import type { UiRenderResult } from './ui.ts'

/** 核心协议版本；外部 adapter 以此版本协商，不直接依赖内部 RoomRuntime。 */
export const CORE_PROTOCOL_VERSION = '1.1'
/** 服务端支持的最旧协议版本：1.1 server 声明支持 1.0..1.1（远程兼容窗口）；最早到 1.2 才允许移除 1.0。 */
export const MIN_SUPPORTED_PROTOCOL_VERSION = '1.0'
/** 服务端支持的最新协议版本；与 CORE_PROTOCOL_VERSION 同步演进。 */
export const MAX_SUPPORTED_PROTOCOL_VERSION = CORE_PROTOCOL_VERSION

/**
 * 版本支持判定（计划 §3.2）：
 * - 同 APK 本地连接：要求精确匹配 CORE_PROTOCOL_VERSION，不做降级；
 * - 远程连接：client 版本落在 [min, max] 支持范围内即可；
 * - 无交集时返回 protocol_incompatible 语义（见 supportsProtocolVersion）。
 */
export function supportsProtocolVersion(version: string, min: string, max: string): boolean {
  return compareVersions(version, min) >= 0 && compareVersions(version, max) <= 0
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const delta = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/** 启动握手健康报告（§3.1）：主进程校验全部字段后才允许完整 UI 进入运行态。 */
export interface CoreHealth {
  protocolVersion: string
  minSupportedProtocolVersion: string
  maxSupportedProtocolVersion: string
  bridgeVersion: string
  coreBundleVersion: string
  coreBundleHash: string
  pluginSetHash: string
  stateSchemaVersion: string
  status: 'starting' | 'ready' | 'degraded' | 'failed' | 'stopping'
  pid?: number
  startedAt: string
  failure?: { code: string; message: string }
}

/** 宿主能力矩阵（§3.5）：Android 不支持的能力必须返回稳定 unsupported_capability，不得随机 404/503。 */
export interface CoreCapability {
  id: string
  supported: boolean
  mode: 'full' | 'readonly' | 'unsupported'
  reason?: string
}

/** 命令回执（§3.3）：断线发生在提交之后时标记 unknown-after-disconnect，禁止自动重放。 */
export interface CommandReceipt {
  requestId: string
  status: 'accepted' | 'rejected' | 'unknown-after-disconnect'
  revision?: number
  view?: CoreView
  error?: { code: string; message: string }
}

/** 统一事件包（§3.4）：1.1 连接的所有 CoreEvent 经此包传输；1.0 对端按协商版本收到旧形状。 */
export interface CoreEventEnvelope {
  protocolVersion: string
  roomId: string
  revision: number
  turnId?: string
  requestId?: string
  type: string
  payload: CoreEvent
  createdAt: string
}

export type CoreActor = 'player' | 'operator' | 'system' | 'plugin'

export interface HumanCommand {
  id: string
  actor: CoreActor
  sessionId?: string
  interactionId?: string
  type:
    | 'submit-text'
    | 'select-role'
    | 'approve'
    | 'reject'
    | 'edit-proposal'
    | 'choose'
    | 'cancel'
    | 'retry'
    | 'restart'
    | 'role-management'
  payload?: unknown
  createdAt?: string
}

export interface ModelRouteSelector {
  role?: string
  providerId?: string
  model?: string
  purpose?: string
}

/** Native tool contract forwarded to the provider; contains no credentials. */
export interface ModelToolDefinition {
  name: string
  description: string
  parameters: object
}

export interface PromptProgram {
  system: string
  user: string
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string; binding?: string }>
  tools?: unknown[]
  metadata?: {
    capability?: string
    strategyId?: string
    strategyVersion?: string
    promptHash?: string
  }
}

export interface ResponseContract {
  id: string
  version: string
  schema: object
}

export interface ModelRequest {
  requestId: string
  workflowId?: string
  capability: string
  prompt: PromptProgram
  contract: ResponseContract
  route?: ModelRouteSelector
  tool?: ModelToolDefinition
  thinkingStrength?: ThinkingStrength
  stream?: boolean
  metadata?: Record<string, unknown>
}

export interface ModelResult {
  requestId: string
  output: unknown
  thinking?: string
  toolCalls?: unknown[]
  usage?: TokenUsage
  finishReason?: string
  error?: string
}

export interface InteractionField {
  id: string
  type: 'text' | 'textarea' | 'number' | 'checkbox' | 'select' | 'json'
  label: string
  value?: unknown
  required?: boolean
  editable?: boolean
  options?: Array<{ id: string; label: string; value?: unknown }>
}

export interface InteractionRequest {
  id: string
  kind: 'text' | 'choice' | 'multi-choice' | 'approval' | 'edit' | 'role-select' | 'progress' | 'error'
  title?: string
  description?: string
  fields?: InteractionField[]
  options?: Array<{ id: string; label: string; value?: unknown }>
  submitLabel?: string
  cancelable?: boolean
  createdAt: string
}

export interface WorkflowInstance {
  id: string
  definitionId: string
  definitionVersion: string
  step: string
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  locals: Record<string, unknown>
  pendingInteractionIds: string[]
  pendingModelRequestIds: string[]
  retryCount: number
  createdAt: string
  updatedAt: string
}

export interface WorkflowStep {
  id: string
  actions: WorkflowActionDefinition[]
  terminal?: boolean
}

export type WorkflowActionDefinition =
  | { type: 'human-interaction'; interactionKind: InteractionRequest['kind']; label?: string }
  | { type: 'model-interaction'; capability: string; contractId: string; promptProfile: string; stream?: boolean }
  | { type: 'local-compute'; operation: string }
  | { type: 'state-commit'; eventTypes?: string[] }
  | { type: 'emit'; eventType: string }
  | { type: 'spawn-workflow'; workflowId: string; version?: string }
  | { type: 'finish' }

export interface WorkflowTransition {
  from: string
  event: string
  to: string
}

export interface WorkflowDefinition {
  id: string
  version: string
  initialStep: string
  steps: Record<string, WorkflowStep>
  transitions: WorkflowTransition[]
  promptProfiles?: Record<string, string>
  contracts?: Record<string, string>
}

/** 预留动态 workflow 设计；第一版只保存/校验，不执行 patch。 */
export interface WorkflowPatchProposal {
  id: string
  baseDefinitionId: string
  baseVersion: string
  patch: unknown[]
  requestedBy: 'author' | 'llm' | 'plugin'
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
}

export type CoreAction =
  | { type: 'human-interaction'; request: InteractionRequest; workflowId?: string }
  | { type: 'model-interaction'; request: ModelRequest; workflowId?: string }
  | { type: 'local-compute'; operation: string; input: unknown; workflowId?: string }
  | { type: 'state-commit'; events: StateEvent[]; workflowId?: string }
  | { type: 'emit'; eventType: string; payload: unknown; workflowId?: string }

export interface StateEvent {
  id: string
  type: string
  source: 'player' | 'llm' | 'rule' | 'plugin' | 'system'
  payload: unknown
  causedBy?: string
  workflowId?: string
  createdAt: string
}

export interface StateTransition {
  revision: number
  events: StateEvent[]
  changes: Array<{ path: string; before?: unknown; after?: unknown }>
}

export interface CoreView {
  protocolVersion: string
  revision: number
  state: unknown
  workflows: WorkflowInstance[]
  interactions: InteractionRequest[]
  actions: CoreAction[]
  availableCommands: Array<{ type: HumanCommand['type']; label: string; enabled: boolean }>
  recentEvents: StateEvent[]
  /** Optional generic extension output; absent for legacy consumers. */
  viewContributions?: ViewContribution[]
  /** Declarative UI extension projection; contains no executable functions. */
  ui?: UiRenderResult
}

export interface ModelEventCorrelation {
  mode?: string
  roomId?: string
  turnId?: string
  actor?: 'role' | 'director'
  roleId?: string
}

export type CoreEvent =
  | { type: 'state.changed'; revision: number; transition: StateTransition }
  | { type: 'domain.event'; revision: number; event: DomainEvent }
  | { type: 'workflow.changed'; revision: number; workflow: WorkflowInstance }
  | { type: 'interaction.created'; revision: number; interaction: InteractionRequest }
  | { type: 'interaction.resolved'; revision: number; interactionId: string; command: HumanCommand }
  | { type: 'model.started'; revision: number; request: ModelRequest }
  | { type: 'model.thinking.delta'; revision: number; requestId: string; text: string; sequence?: number; correlation?: ModelEventCorrelation }
  | { type: 'model.thinking.completed'; revision: number; requestId?: string; text?: string; correlation?: ModelEventCorrelation }
  | { type: 'model.completed'; revision: number; result: ModelResult; correlation?: ModelEventCorrelation }
  | { type: 'error'; revision: number; message: string; requestId?: string; correlation?: ModelEventCorrelation }
  | { type: 'ui.manifest.changed'; revision: number; manifestId: string; operation: 'registered' | 'unregistered'; sequence: number }

export type CoreEventListener = (event: CoreEvent) => void

export interface CoreRuntimePort {
  dispatch(command: HumanCommand): Promise<void>
  requestModel(request: ModelRequest): Promise<ModelResult>
  emitDomainEvent(event: DomainEvent): void
  submitModelResult(result: ModelResult): Promise<void>
  getView(): CoreView
  subscribe(listener: CoreEventListener): () => void
  cancel(requestId?: string): Promise<void>
  /** 可选的 1.1 握手扩展：health/capabilities 由具体 runtime 实现，adapter 不得假设存在。 */
  getHealth?(): CoreHealth
  getCapabilities?(): CoreCapability[]
}
