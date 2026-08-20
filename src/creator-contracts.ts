import type { StoryPackage } from './story-packages.ts'
import { validateStoryPackage } from './story-packages.ts'
import type { LoreEntry, Role } from './types.ts'

export const CREATOR_CONTRACT_VERSION = '1.0.0'
export const CREATOR_EXTRACTION_VERSION = '1.0.0'

export type CreatorSourceKind = 'st-card-json' | 'st-card-png' | 'story-package-json' | 'text' | 'unknown'
export type CreatorExtractionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired' | 'cancelled'
export type CreatorFieldDecision = 'accept' | 'reject' | 'unchanged'
export type CreatorDiagnosticSeverity = 'info' | 'warning' | 'error'
export type CreatorDiagnosticCode = 'invalid-input' | 'unsupported-format' | 'missing-field' | 'mapping-loss' | 'validation-failed' | 'expired' | 'internal'

export interface CreatorInput {
  source: CreatorSource
  /** Opaque source reference. It must not contain card contents. */
  sourceRef?: string
  contentType?: string
  byteLength?: number
  requestedAt: string
  options?: Record<string, unknown>
}

export interface CreatorSource {
  kind: CreatorSourceKind
  name?: string
  contentType?: string
  byteLength?: number
  /** Human-readable, non-content summary suitable for logs and UI. */
  summary: string
}

export interface CreatorWarning {
  code: CreatorDiagnosticCode
  message: string
  fieldPath?: string
  severity?: 'warning' | 'info'
}

export interface CreatorDiagnostic {
  code: CreatorDiagnosticCode
  message: string
  severity: CreatorDiagnosticSeverity
  fieldPath?: string
  recoverable: boolean
}

export interface CreatorSourceSummary {
  kind: CreatorSourceKind
  name?: string
  contentType?: string
  byteLength?: number
  summary: string
}

export interface CreatorFieldDiff {
  path: string
  before?: unknown
  after?: unknown
  change: 'added' | 'removed' | 'changed'
  decision: CreatorFieldDecision
  required?: boolean
}

export interface CreatorFieldAcceptance {
  path: string
  decision: Exclude<CreatorFieldDecision, 'unchanged'>
}

export interface CreatorExtractionPreview {
  contractVersion: string
  extractionVersion: string
  id: string
  createdAt: string
  expiresAt: string
  source: CreatorSourceSummary
  candidate: StoryPackage
  diffs: CreatorFieldDiff[]
  warnings: CreatorWarning[]
  diagnostics: CreatorDiagnostic[]
  /** True only when the candidate passes authoritative StoryPackage validation. */
  valid: boolean
}

export interface CreatorApplyRequest {
  contractVersion?: string
  previewId: string
  requestedAt: string
  accept: CreatorFieldAcceptance[]
}

export interface CreatorApplyResult {
  contractVersion: string
  previewId: string
  applied: boolean
  story?: StoryPackage
  accepted: string[]
  rejected: string[]
  diagnostics: CreatorDiagnostic[]
}

export interface CreatorExtractionTask {
  id: string
  contractVersion: string
  extractionVersion: string
  status: CreatorExtractionStatus
  createdAt: string
  expiresAt: string
  source: CreatorSourceSummary
}

export interface CreatorExtractionRequest {
  task: CreatorExtractionTask
  input: CreatorInput
}

export interface CreatorExtractionResult {
  task: CreatorExtractionTask
  preview?: CreatorExtractionPreview
  diagnostics: CreatorDiagnostic[]
}

export type ExtractionTask = CreatorExtractionTask
export type ExtractionRequest = CreatorExtractionRequest
export type ExtractionResult = CreatorExtractionResult

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function assertJsonSafe(value: unknown, label = 'value'): void {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error(`${label} must be JSON-safe.`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${label} must be JSON-safe.`)
  if (value === null || typeof value !== 'object') return
  if (value instanceof Date || value instanceof RegExp || value instanceof URL || value instanceof Map || value instanceof Set || ArrayBuffer.isView(value)) throw new Error(`${label} must be JSON-safe.`)
  if (Array.isArray(value)) value.forEach((item, index) => assertJsonSafe(item, `${label}[${index}]`))
  else Object.entries(value).forEach(([key, item]) => assertJsonSafe(item, `${label}.${key}`))
}

export function validateCreatorInput(input: CreatorInput): void {
  assertJsonSafe(input, 'Creator input')
  if (!isRecord(input.source) || !input.source.summary || !input.source.kind) throw new Error('Creator input source summary is required.')
  if (!input.requestedAt || Number.isNaN(Date.parse(input.requestedAt))) throw new Error('Creator input requestedAt must be an ISO date.')
  if (input.byteLength !== undefined && (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0)) throw new Error('Creator input byteLength must be a non-negative safe integer.')
}

export function validateCreatorPreview(preview: CreatorExtractionPreview, now = new Date()): void {
  assertJsonSafe(preview, 'Creator preview')
  if (preview.contractVersion !== CREATOR_CONTRACT_VERSION || preview.extractionVersion !== CREATOR_EXTRACTION_VERSION) throw new Error('Unsupported creator preview version.')
  if (!preview.id || !preview.createdAt || !preview.expiresAt || Number.isNaN(Date.parse(preview.expiresAt))) throw new Error('Creator preview versioning and expiry are required.')
  validateStoryPackage(preview.candidate)
  if (Date.parse(preview.expiresAt) <= now.getTime()) throw new Error('Creator preview has expired.')
}

export function validateCreatorApplyRequest(request: CreatorApplyRequest): void {
  assertJsonSafe(request, 'Creator apply request')
  if (request.contractVersion && request.contractVersion !== CREATOR_CONTRACT_VERSION) throw new Error('Unsupported creator apply version.')
  if (!request.previewId || !request.requestedAt || Number.isNaN(Date.parse(request.requestedAt)) || !Array.isArray(request.accept)) throw new Error('Invalid creator apply request.')
  const paths = new Set<string>()
  for (const item of request.accept) {
    if (!item.path || paths.has(item.path)) throw new Error('Creator apply fields must have unique paths.')
    paths.add(item.path)
  }
}

export function diffStoryPackages(before: StoryPackage | undefined, after: StoryPackage): CreatorFieldDiff[] {
  assertJsonSafe(after, 'Creator candidate')
  const diffs: CreatorFieldDiff[] = []
  const walk = (left: unknown, right: unknown, path: string) => {
    if (JSON.stringify(left) === JSON.stringify(right)) return
    if (isRecord(right) && (left === undefined || isRecord(left))) {
      const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right)])
      for (const key of keys) walk(isRecord(left) ? left[key] : undefined, right[key], `${path}/${key}`)
      return
    }
    if (isRecord(left) && right === undefined) {
      for (const key of Object.keys(left)) walk(left[key], undefined, `${path}/${key}`)
      return
    }
    const change = left === undefined ? 'added' : right === undefined ? 'removed' : 'changed'
    diffs.push({ path: path || '/', ...(left === undefined ? {} : { before: left }), ...(right === undefined ? {} : { after: right }), change, decision: 'unchanged' })
  }
  walk(before, after, '')
  return diffs
}

export function applyFieldAcceptance(preview: CreatorExtractionPreview, request: CreatorApplyRequest): CreatorApplyResult {
  validateCreatorApplyRequest(request)
  const decisions = new Map(request.accept.map(item => [item.path, item.decision]))
  const rejected = preview.diffs.filter(diff => decisions.get(diff.path) === 'reject').map(diff => diff.path)
  const accepted = preview.diffs.filter(diff => decisions.get(diff.path) === 'accept').map(diff => diff.path)
  try {
    validateCreatorPreview(preview)
    if (rejected.length > 0) return { contractVersion: CREATOR_CONTRACT_VERSION, previewId: preview.id, applied: false, accepted, rejected, diagnostics: [{ code: 'validation-failed', message: 'Required story fields were rejected.', severity: 'error', recoverable: true }] }
    return { contractVersion: CREATOR_CONTRACT_VERSION, previewId: preview.id, applied: true, story: preview.candidate, accepted, rejected, diagnostics: [] }
  } catch (error) {
    return { contractVersion: CREATOR_CONTRACT_VERSION, previewId: preview.id, applied: false, accepted, rejected, diagnostics: [{ code: 'validation-failed', message: error instanceof Error ? error.message : String(error), severity: 'error', recoverable: false }] }
  }
}

export type CreatorRoleSummary = Pick<Role, 'id' | 'name'>
export type CreatorLoreSummary = Pick<LoreEntry, 'name'>
