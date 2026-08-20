import type { StoryPackage } from './story-packages.ts'
import { validateStoryPackage } from './story-packages.ts'
import {
  CREATOR_CONTRACT_VERSION,
  type CreatorApplyRequest,
  type CreatorExtractionPreview,
  type CreatorFieldAcceptance,
  type CreatorFieldDiff,
  validateCreatorApplyRequest,
  validateCreatorPreview,
} from './creator-contracts.ts'
import type { CoreExtensionPort, Proposal } from './core/extensions.ts'
import type { StatePatch, StateTransactionResult } from './core/state-transaction.ts'

export const CREATOR_PREVIEW_MODULE = 'creator.preview'
export const CREATOR_PREVIEW_PROPOSAL = 'creator.preview.apply'

export interface CreatorPreviewRepository {
  read(): StoryPackage
  /** The callback must commit the package atomically, or throw without changing it. */
  write(next: StoryPackage, previous: StoryPackage): void
}

export interface CreatorPreviewAuditEvent {
  id: string
  type: 'creator.extracted' | 'creator.application.requested' | 'creator.application.applied' | 'creator.application.rejected' | 'creator.application.rolled-back'
  previewId: string
  owner: string
  paths: string[]
}

export interface CreatorPreviewApplyOptions {
  owner: string
  repository: CreatorPreviewRepository
  now?: () => Date
  audit?: (event: CreatorPreviewAuditEvent) => void
}

interface StoredPreview {
  preview: CreatorExtractionPreview
  owner: string
  baseline: StoryPackage
  used: boolean
}

export interface CreatorPreviewApplyResult {
  previewId: string
  status: 'pending' | 'applied' | 'rejected' | 'noop' | 'rolled-back'
  proposal?: Proposal
  story?: StoryPackage
  accepted: string[]
  rejected: string[]
  transaction?: StateTransactionResult
}

function clone<T>(value: T): T { return structuredClone(value) }
function eventId(type: string, previewId: string): string { return `${type}:${previewId}:${Date.now().toString(36)}` }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function pointer(path: string): string[] {
  if (!path.startsWith('/') || path.includes('//')) throw new Error(`Invalid creator field path: ${path}`)
  return path.slice(1).split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
}
function readAt(root: unknown, path: string): unknown {
  let current = root
  for (const segment of pointer(path)) {
    if (Array.isArray(current)) current = current[Number(segment)]
    else if (isRecord(current)) current = current[segment]
    else return undefined
  }
  return current
}
function setAt(root: unknown, path: string, value: unknown): void {
  const segments = pointer(path)
  if (!segments.length) throw new Error('Creator field root cannot be applied.')
  let current: any = root
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) current = current[Number(segment)]
    else current = current[segment]
  }
  const last = segments[segments.length - 1]
  if (Array.isArray(current)) current[Number(last)] = clone(value)
  else current[last] = clone(value)
}

function diagnostics(message: string): never { throw new Error(message) }

export class CreatorPreviewApplyAdapter {
  private readonly previews = new Map<string, StoredPreview>()
  private readonly registrations: Disposable[] = []
  private readonly now: () => Date
  private readonly core: CoreExtensionPort
  private readonly options: CreatorPreviewApplyOptions

  constructor(core: CoreExtensionPort, options: CreatorPreviewApplyOptions) {
    this.core = core
    this.options = options
    if (!options.owner.trim()) throw new Error('Creator preview owner is required.')
    this.now = options.now ?? (() => new Date())
    this.registrations.push(core.registerProposalType({
      id: CREATOR_PREVIEW_PROPOSAL,
      moduleId: CREATOR_PREVIEW_MODULE,
      path: '/proposals',
      validate: input => this.validateProposalInput(input),
      apply: input => this.applyProposal(input),
    }))
  }

  dispose(): void { for (const registration of this.registrations.splice(0)) registration.dispose(); this.previews.clear() }

  preview(preview: CreatorExtractionPreview): CreatorExtractionPreview {
    validateCreatorPreview(preview, this.now())
    const baseline = clone(this.options.repository.read())
    validateStoryPackage(baseline)
    const stored = { preview: clone(preview), owner: this.options.owner, baseline, used: false }
    this.previews.set(preview.id, stored)
    this.audit('creator.extracted', preview.id, [])
    return clone(preview)
  }

  request(request: CreatorApplyRequest): CreatorPreviewApplyResult {
    validateCreatorApplyRequest(request)
    const stored = this.requirePreview(request.previewId)
    this.assertAvailable(stored)
    const accepted = this.acceptedDiffs(stored.preview, request.accept)
    const rejected = request.accept.filter(item => item.decision === 'reject').map(item => item.path)
    this.audit('creator.application.requested', request.previewId, accepted)
    if (accepted.length === 0) {
      stored.used = true
      this.audit('creator.application.rejected', request.previewId, rejected)
      return { previewId: request.previewId, status: rejected.length ? 'rejected' : 'noop', accepted, rejected }
    }
    const proposal = this.core.operateProposal({ operation: 'create', id: `creator-preview:${request.previewId}`, typeId: CREATOR_PREVIEW_PROPOSAL, roomId: this.options.owner, input: { previewId: request.previewId, owner: this.options.owner, accepted, rejected } }) as Proposal
    return { previewId: request.previewId, status: 'pending', proposal, accepted, rejected }
  }

  approve(previewId: string, baseRevision?: number): CreatorPreviewApplyResult {
    const stored = this.requirePreview(previewId)
    this.assertAvailable(stored)
    try {
      const proposal = this.core.operateProposal({ operation: 'approve', id: `creator-preview:${previewId}`, roomId: this.options.owner, baseRevision }) as Proposal
      const story = clone(this.options.repository.read())
      stored.used = true
      this.audit('creator.application.applied', previewId, this.pathsFromProposal(proposal))
      return { previewId, status: 'applied', proposal, story, accepted: this.pathsFromProposal(proposal), rejected: [] }
    } catch (error) {
      const current = clone(this.options.repository.read())
      if (JSON.stringify(current) !== JSON.stringify(stored.baseline)) {
        this.options.repository.write(clone(stored.baseline), current)
        this.audit('creator.application.rolled-back', previewId, [])
      }
      throw error
    }
  }

  reject(previewId: string): CreatorPreviewApplyResult {
    const stored = this.requirePreview(previewId)
    this.assertAvailable(stored)
    const proposal = this.core.operateProposal({ operation: 'reject', id: `creator-preview:${previewId}`, roomId: this.options.owner }) as Proposal
    stored.used = true
    this.audit('creator.application.rejected', previewId, this.pathsFromProposal(proposal))
    return { previewId, status: 'rejected', proposal, accepted: [], rejected: this.pathsFromProposal(proposal) }
  }

  rollback(previewId: string): CreatorPreviewApplyResult {
    const stored = this.previews.get(previewId)
    if (!stored) throw new Error(`Unknown creator preview: ${previewId}`)
    const current = clone(this.options.repository.read())
    validateStoryPackage(stored.baseline)
    this.options.repository.write(clone(stored.baseline), current)
    this.audit('creator.application.rolled-back', previewId, [])
    return { previewId, status: 'rolled-back', story: clone(stored.baseline), accepted: [], rejected: [] }
  }

  private validateProposalInput(input: unknown): void | string[] {
    if (!isRecord(input) || input.owner !== this.options.owner || typeof input.previewId !== 'string' || !Array.isArray(input.accepted)) return ['foreign or malformed creator preview proposal']
    if (!input.accepted.every(path => typeof path === 'string' && path.startsWith('/'))) return ['creator proposal paths must be JSON pointers']
  }

  private applyProposal(input: unknown): { patches: StatePatch[]; events: Array<{ id: string; type: string; payload: unknown }> } {
    const value = input as { previewId: string; owner: string; accepted: string[]; rejected: string[] }
    const stored = this.requirePreview(value.previewId)
    this.assertAvailable(stored)
    const current = clone(this.options.repository.read())
    validateStoryPackage(current)
    if (JSON.stringify(current) !== JSON.stringify(stored.baseline)) throw new Error('Creator preview conflict: StoryPackage changed since preview.')
    const next = clone(current)
    for (const path of value.accepted) setAt(next, path, readAt(stored.preview.candidate, path))
    validateStoryPackage(next)
    this.options.repository.write(next, current)
    this.lastWrittenPreviewId = value.previewId
    return {
      patches: [{ op: 'set', path: `/modules/${CREATOR_PREVIEW_MODULE.replace(/~/g, '~0').replace(/\//g, '~1')}/applied`, value: { previewId: value.previewId, paths: value.accepted } }],
      events: [{ id: eventId('creator.application.applied', value.previewId), type: 'creator.application.applied', payload: { previewId: value.previewId, paths: value.accepted } }],
    }
  }

  private requirePreview(id: string): StoredPreview {
    if (!id.trim()) diagnostics('Creator preview ID is required.')
    const stored = this.previews.get(id)
    if (!stored) diagnostics(`Unknown or foreign creator preview: ${id}`)
    return stored!
  }

  private assertAvailable(stored: StoredPreview): void {
    validateCreatorPreview(stored.preview, this.now())
    if (stored.owner !== this.options.owner) diagnostics('Foreign creator preview.')
    if (stored.used) diagnostics('Creator preview has already been used.')
  }

  private acceptedDiffs(preview: CreatorExtractionPreview, accept: CreatorFieldAcceptance[]): string[] {
    const diffs = new Map(preview.diffs.map(diff => [diff.path, diff]))
    const accepted: string[] = []
    for (const item of accept) {
      const diff = diffs.get(item.path)
      if (!diff) diagnostics(`Creator acceptance path is not in preview: ${item.path}`)
      if (item.decision === 'accept') accepted.push(item.path)
    }
    return accepted
  }

  private pathsFromProposal(proposal: Proposal): string[] { return isRecord(proposal.input) && Array.isArray(proposal.input.accepted) ? proposal.input.accepted.filter((path): path is string => typeof path === 'string') : [] }
  private audit(type: CreatorPreviewAuditEvent['type'], previewId: string, paths: string[]): void { this.options.audit?.({ id: eventId(type, previewId), type, previewId, owner: this.options.owner, paths: [...paths] }) }
}

export function creatorPreviewModuleRegistration(core: { registerStateModule(manifest: { id: string; version: string; label?: string }): Disposable; registerStateSchema(schema: { id: string; moduleId: string; validate(state: unknown): void | string[] }): Disposable }): Disposable[] {
  return [
    core.registerStateModule({ id: CREATOR_PREVIEW_MODULE, version: '1.0.0', label: 'Creator previews' }),
    core.registerStateSchema({ id: 'creator.preview.schema', moduleId: CREATOR_PREVIEW_MODULE, validate: state => {
      if (!isRecord(state)) return ['creator preview state must be an object']
      if (state.proposals !== undefined && !Array.isArray(state.proposals)) return ['creator preview proposals must be an array']
      if (state.applied !== undefined && !isRecord(state.applied)) return ['applied metadata must be an object']
      return undefined
    } }),
  ]
}

type Disposable = { dispose(): void | Promise<void> }