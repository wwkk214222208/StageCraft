import type { StatePatch, StateTransactionResult } from './state-transaction.ts'

export interface RecordCollectionDefinition {
  id: string
  moduleId: string
  /** JSON Pointer relative to the module namespace; the collection must be an array. */
  path: string
  validate?(record: unknown): void | string[]
}

export type RecordOperation = 'list' | 'create-or-upsert' | 'edit' | 'remove' | 'reorder'

export interface RecordOperationRequest {
  collectionId: string
  operation: RecordOperation
  roomId?: string
  baseRevision?: number
  record?: unknown
  id?: string
  patches?: StatePatch[]
  order?: string[]
}

export interface RecordOperationResult {
  revision: number
  records: unknown[]
  transaction?: StateTransactionResult
}

export interface ProposalTypeDefinition {
  id: string
  moduleId: string
  path: string
  validate(input: unknown): void | string[]
  apply(input: unknown): StatePatch[] | { patches: StatePatch[]; events?: Array<{ id: string; type: string; payload?: unknown }> }
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected'

export interface Proposal {
  id: string
  typeId: string
  moduleId: string
  status: ProposalStatus
  input: unknown
  createdAt: string
  updatedAt: string
}

export interface ProposalOperationRequest {
  operation: 'create' | 'edit' | 'approve' | 'reject' | 'get' | 'list'
  id?: string
  typeId?: string
  input?: unknown
  baseRevision?: number
  roomId?: string
  status?: ProposalStatus
}

export interface EffectHandlerDefinition {
  id: string
  handle(input: unknown): unknown | Promise<unknown>
}

export interface PromptFragment {
  id?: string
  kind: string
  content: unknown
  metadata?: Record<string, unknown>
}

export interface PromptContributorDefinition {
  id: string
  priority?: number
  contribute(input: unknown): PromptFragment | PromptFragment[]
}

export interface ViewContribution {
  id?: string
  kind: string
  value: unknown
  metadata?: Record<string, unknown>
}

export interface ViewContributorDefinition {
  id: string
  priority?: number
  contribute(input: unknown): ViewContribution | ViewContribution[]
}

export interface CoreExtensionPort {
  registerRecordCollection(definition: RecordCollectionDefinition): Disposable
  operateRecord(request: RecordOperationRequest): RecordOperationResult
  registerProposalType(definition: ProposalTypeDefinition): Disposable
  operateProposal(request: ProposalOperationRequest): Proposal | Proposal[] | undefined
  registerEffectHandler(definition: EffectHandlerDefinition): Disposable
  invokeEffect(id: string, input: unknown): Promise<unknown>
  registerPromptContributor(definition: PromptContributorDefinition): Disposable
  composePrompt(input: unknown): PromptFragment[]
  registerViewContributor(definition: ViewContributorDefinition): Disposable
  composeView(input: unknown): ViewContribution[]
}

export interface Disposable {
  dispose(): void | Promise<void>
}
