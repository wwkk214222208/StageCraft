import type { TokenUsage } from '../types.ts'
import type { DomainEvent } from './domain-events.ts'

/** 核心协议版本；外部 adapter 以此版本协商，不直接依赖内部 RoomRuntime。 */
export const CORE_PROTOCOL_VERSION = '1.0'

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

export interface PromptProgram {
  system: string
  user: string
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
}

export type CoreEvent =
  | { type: 'state.changed'; revision: number; transition: StateTransition }
  | { type: 'domain.event'; revision: number; event: DomainEvent }
  | { type: 'workflow.changed'; revision: number; workflow: WorkflowInstance }
  | { type: 'interaction.created'; revision: number; interaction: InteractionRequest }
  | { type: 'interaction.resolved'; revision: number; interactionId: string; command: HumanCommand }
  | { type: 'model.started'; revision: number; request: ModelRequest }
  | { type: 'model.thinking.delta'; revision: number; requestId: string; text: string }
  | { type: 'model.completed'; revision: number; result: ModelResult }
  | { type: 'error'; revision: number; message: string; requestId?: string }

export type CoreEventListener = (event: CoreEvent) => void

export interface CoreRuntimePort {
  dispatch(command: HumanCommand): Promise<void>
  requestModel(request: ModelRequest): Promise<void>
  emitDomainEvent(event: DomainEvent): void
  submitModelResult(result: ModelResult): Promise<void>
  getView(): CoreView
  subscribe(listener: CoreEventListener): () => void
  cancel(requestId?: string): Promise<void>
}
