import { randomUUID } from 'node:crypto'
import { diffStoryPackages, type CreatorApplyRequest, type CreatorExtractionPreview, type CreatorSourceKind } from './creator-contracts.ts'
import { createStoryExtractService, type StoryExtractResult } from './story-extract.ts'
import { importStCard } from './st-card-import.ts'
import { validateStoryPackage, type StoryPackage } from './story-packages.ts'

export interface CreatorWorkbenchRepository {
  read(): StoryPackage
  write(next: StoryPackage, previous: StoryPackage): void
}

interface StoredPreview { preview: CreatorExtractionPreview; baseline: StoryPackage; used: boolean }

function clone<T>(value: T): T { return structuredClone(value) }
function pointer(path: string): string[] {
  if (!path.startsWith('/') || path.includes('//')) throw new Error(`Invalid creator field path: ${path}`)
  return path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
}
function readAt(root: unknown, path: string): unknown { let current = root; for (const part of pointer(path)) current = Array.isArray(current) ? current[Number(part)] : (current as Record<string, unknown> | undefined)?.[part]; return current }
function setAt(root: unknown, path: string, value: unknown): void { const parts = pointer(path); if (!parts.length) throw new Error('Creator field root cannot be applied.'); let current: any = root; for (const part of parts.slice(0, -1)) current = Array.isArray(current) ? current[Number(part)] : current[part]; const last = parts[parts.length - 1]; if (Array.isArray(current)) current[Number(last)] = clone(value); else current[last] = clone(value) }
function sourceKind(value: string): CreatorSourceKind { return value === 'st-card-json' || value === 'st-card-png' || value === 'text' ? value : 'unknown' }

/** Server-side workbench session. Candidates are never written until apply(). */
export class CreatorWorkbenchService {
  private readonly previews = new Map<string, StoredPreview>()
  private readonly extractService
  private readonly repository: CreatorWorkbenchRepository
  private readonly owner: string
  private readonly now: () => Date
  private readonly ttlMs: number
  constructor(repository: CreatorWorkbenchRepository, owner: string, now = () => new Date(), ttlMs = 15 * 60_000) {
    this.repository = repository
    this.owner = owner
    this.now = now
    this.ttlMs = ttlMs
    if (!owner.trim()) throw new Error('Creator Workbench owner is required.')
    this.extractService = createStoryExtractService()
  }
  dispose(): void { this.extractService.dispose(); this.previews.clear() }
  async preview(input: { kind: CreatorSourceKind; name?: string; content: string; contentType?: string }): Promise<CreatorExtractionPreview> {
    const base = clone(this.repository.read()); validateStoryPackage(base)
    const kind = sourceKind(input.kind)
    let extracted: StoryExtractResult
    if (kind === 'st-card-json' || kind === 'st-card-png') {
      const imported = importStCard(input.content, input.name ?? (kind === 'st-card-png' ? 'card.png' : 'card.json'))
      extracted = { roles: [{ ...imported.role, candidate: true }], lore: imported.lore.map(item => ({ ...item, candidate: true })), warnings: imported.mapped.warnings, diagnostics: [], source: 'st-card', applied: false }
    } else {
      extracted = await this.extractService.extract({ text: input.content })
    }
    const candidate = clone(base)
    if (extracted.roles.length) candidate.roles = [...candidate.roles, ...extracted.roles.map(({ candidate: _candidate, ...role }) => role)]
    if (extracted.lore.length) candidate.lore = [...(candidate.lore ?? []), ...extracted.lore.map(({ candidate: _candidate, ...lore }) => lore)]
    const id = `creator-${randomUUID()}`
    const createdAt = this.now().toISOString()
    const preview: CreatorExtractionPreview = { contractVersion: '1.0.0', extractionVersion: '1.0.0', id, createdAt, expiresAt: new Date(this.now().getTime() + this.ttlMs).toISOString(), source: { kind, ...(input.name ? { name: input.name } : {}), ...(input.contentType ? { contentType: input.contentType } : {}), byteLength: Buffer.byteLength(input.content), summary: `${kind} input (${Buffer.byteLength(input.content)} bytes)` }, candidate, diffs: diffStoryPackages(base, candidate), warnings: extracted.warnings.map(message => ({ code: 'mapping-loss', message, severity: 'warning' })), diagnostics: extracted.diagnostics.map(item => ({ code: 'internal', message: item.message, severity: item.severity, recoverable: item.severity !== 'error' })), valid: true }
    this.previews.set(id, { preview, baseline: base, used: false })
    return clone(preview)
  }
  apply(request: CreatorApplyRequest): { previewId: string; applied: boolean; story?: StoryPackage; accepted: string[]; rejected: string[]; warnings: string[] } {
    const stored = this.previews.get(request.previewId)
    if (!stored) throw new Error('Unknown or foreign creator preview.')
    if (stored.used) throw new Error('Creator preview has already been used.')
    if (Date.parse(stored.preview.expiresAt) <= this.now().getTime()) throw new Error('Creator preview has expired.')
    const paths = new Map(stored.preview.diffs.map(diff => [diff.path, diff]))
    const accepted: string[] = []; const rejected: string[] = []
    for (const item of request.accept) { if (!paths.has(item.path)) throw new Error(`Creator acceptance path is not in preview: ${item.path}`); (item.decision === 'accept' ? accepted : rejected).push(item.path) }
    stored.used = true
    if (!accepted.length) return { previewId: request.previewId, applied: false, accepted, rejected, warnings: rejected.length ? ['No accepted fields were applied.'] : [] }
    const current = clone(this.repository.read())
    if (JSON.stringify(current) !== JSON.stringify(stored.baseline)) throw new Error('Creator preview conflict: StoryPackage changed since preview.')
    const next = clone(current)
    for (const path of accepted) setAt(next, path, readAt(stored.preview.candidate, path))
    validateStoryPackage(next); this.repository.write(next, current)
    return { previewId: request.previewId, applied: true, story: clone(next), accepted, rejected, warnings: [] }
  }
  revert(previewId: string): StoryPackage { const stored = this.previews.get(previewId); if (!stored) throw new Error('Unknown or foreign creator preview.'); const current = clone(this.repository.read()); this.repository.write(clone(stored.baseline), current); return clone(stored.baseline) }
}
