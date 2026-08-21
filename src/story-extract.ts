import type { Plugin, Context } from '@deepseek-ai/cordis'
import type { CoreRuntimePort, ModelRequest, ModelResult } from './core/protocol.ts'
import type { LoreEntry, PlayerCharacter, Role } from './types.ts'
import type { StoryPackage } from './story-packages.ts'
import { mapStCardToRole, parseStCharacterCard, type StCardParsed } from './st-card-import.ts'

export const STORY_EXTRACT_PLUGIN_ID = 'story.extract'
export const STORY_EXTRACT_CONTRACT = { id: 'story.extract', version: '1.0.0' } as const

export interface StoryExtractDiagnostic { code: string; message: string; path?: string; severity: 'warning' | 'error' }
export interface RoleCandidate extends Role { candidate: true }
export interface LoreCandidate extends LoreEntry { candidate: true }
export interface StoryPackageCandidate extends Omit<StoryPackage, 'roles' | 'lore'> { candidate: true; roles: RoleCandidate[]; lore: LoreCandidate[] }
export interface StoryExtractResult {
  roles: RoleCandidate[]
  lore: LoreCandidate[]
  storyPackage?: StoryPackageCandidate
  warnings: string[]
  diagnostics: StoryExtractDiagnostic[]
  source: 'text' | 'st-card' | 'worldbook' | 'story-package' | 'model'
  applied: false
}

export interface StoryExtractInput {
  text?: string
  /** Parsed ST CardPackage/card or worldbook; raw JSON and binary inputs are intentionally unsupported. */
  parsed?: unknown
  title?: string
  opening?: string
  requestModel?: (request: ModelRequest) => Promise<ModelResult>
  core?: Pick<CoreRuntimePort, 'requestModel' | 'cancel'>
  worker?: { requestModel?: (request: ModelRequest) => Promise<ModelResult>; cancel?: (requestId?: string) => void }
  timeoutMs?: number
  maxChars?: number
  maxEntries?: number
}

export interface StoryExtractService {
  readonly id: typeof STORY_EXTRACT_PLUGIN_ID
  extract(input: StoryExtractInput): Promise<StoryExtractResult>
  cancel(requestId?: string): Promise<void>
  dispose(): void
}

const MAX_CHARS = 120_000
const MAX_ENTRIES = 64
const UNSAFE = /(?:<script\b|javascript\s*:|data:text\/html|\b(?:import|require)\s*\(|\b(?:eval|Function|process\.|child_process|fs\.)\b|__proto__|constructor\s*\[)/i

function diagnostic(code: string, message: string, severity: StoryExtractDiagnostic['severity'] = 'warning', path?: string): StoryExtractDiagnostic { return { code, message, severity, ...(path ? { path } : {}) } }
function safeText(text: unknown, max: number): { text: string; diagnostics: StoryExtractDiagnostic[] } {
  if (typeof text !== 'string') return { text: '', diagnostics: [diagnostic('input.type', 'Text input must be a string.', 'error')] }
  const diagnostics: StoryExtractDiagnostic[] = []
  if (UNSAFE.test(text)) diagnostics.push(diagnostic('unsafe.content', 'Scripts, imports, and unsafe capabilities are blocked.', 'error'))
  const normalized = text.slice(0, max)
  if (normalized.length < text.length) diagnostics.push(diagnostic('input.truncated', `Input was bounded to ${max} characters.`))
  return { text: normalized, diagnostics }
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function stringField(value: unknown, key: string): string | undefined { return isRecord(value) && typeof value[key] === 'string' ? value[key] as string : undefined }
function candidateRole(role: Role): RoleCandidate { return { ...role, candidate: true } }
function candidateLore(lore: LoreEntry): LoreCandidate { return { ...lore, candidate: true } }
function validateRole(value: unknown, path: string): RoleCandidate {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.portraitRef !== 'string' || typeof value.currentState !== 'string' || typeof value.selfModel !== 'string' || !['present', 'absent', 'unavailable'].includes(String(value.presence))) throw new Error(`Invalid role candidate at ${path}.`)
  if (value.memories !== undefined && !Array.isArray(value.memories)) throw new Error(`Invalid role memories at ${path}.`)
  return candidateRole(value as unknown as Role)
}
function validateLore(value: unknown, path: string): LoreCandidate {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.content !== 'string') throw new Error(`Invalid lore candidate at ${path}.`)
  return candidateLore(value as unknown as LoreEntry)
}
function validateOutput(value: unknown): { roles: RoleCandidate[]; lore: LoreCandidate[]; storyPackage?: StoryPackageCandidate } {
  if (!isRecord(value)) throw new Error('Model output must be an object.')
  const roles = Array.isArray(value.roles) ? value.roles.map((item, i) => validateRole(item, `roles[${i}]`)) : []
  const lore = Array.isArray(value.lore) ? value.lore.map((item, i) => validateLore(item, `lore[${i}]`)) : []
  let storyPackage: StoryPackageCandidate | undefined
  if (value.storyPackage !== undefined) {
    const pkg = value.storyPackage
    if (!isRecord(pkg) || typeof pkg.id !== 'string' || typeof pkg.title !== 'string' || typeof pkg.opening !== 'string' || !isRecord(pkg.playerCharacter) || typeof pkg.playerCharacter.name !== 'string' || typeof pkg.playerCharacter.persona !== 'string' || typeof pkg.playerCharacter.currentState !== 'string') throw new Error('Invalid story package candidate.')
    storyPackage = { ...pkg, candidate: true, roles: roles.length ? roles : (Array.isArray(pkg.roles) ? pkg.roles.map((item, i) => validateRole(item, `storyPackage.roles[${i}]`)) : []), lore: lore.length ? lore : (Array.isArray(pkg.lore) ? pkg.lore.map((item, i) => validateLore(item, `storyPackage.lore[${i}]`)) : []) } as StoryPackageCandidate
  }
  return { roles, lore, ...(storyPackage ? { storyPackage } : {}) }
}

function fromText(text: string, maxEntries: number): StoryExtractResult {
  const diagnostics: StoryExtractDiagnostic[] = []
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const roleLine = lines.find(line => /^(?:角色|人物|character)\s*[:：]/i)
  const name = roleLine?.replace(/^(?:角色|人物|character)\s*[:：]\s*/i, '').trim() || '未命名角色'
  const role = candidateRole({ id: `extract-${name.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 32) || 'role'}`, name, portraitRef: '/assets/default.svg', currentState: '待确认的初始状态。', presence: 'present', selfModel: text.trim() || '待补充角色设定。' })
  const lore = lines.filter(line => /^(?:世界书|设定|lore)\s*[:：]/i.test(line)).slice(0, maxEntries).map((line, i) => candidateLore({ name: `提取设定 ${i + 1}`, content: line.replace(/^(?:世界书|设定|lore)\s*[:：]\s*/i, '') }))
  if (!roleLine) diagnostics.push(diagnostic('text.heuristic', 'No explicit role label was found; a reviewable role candidate was synthesized.'))
  if (lines.length > maxEntries) diagnostics.push(diagnostic('entries.bounded', `Text extraction is bounded to ${maxEntries} lore candidates.`))
  return { roles: [role], lore, warnings: diagnostics.filter(d => d.severity === 'warning').map(d => d.message), diagnostics, source: 'text', applied: false }
}

function fromParsed(parsed: unknown, maxEntries: number): StoryExtractResult {
  if (!isRecord(parsed)) throw new Error('Parsed input must be a plain object; raw files are not accepted.')
  if (UNSAFE.test(JSON.stringify(parsed))) throw new Error('Unsafe scripts/imports/capabilities in parsed input are blocked.')
  if (Array.isArray(parsed.roles) && typeof parsed.id === 'string' && typeof parsed.title === 'string') {
    const roles = parsed.roles.slice(0, maxEntries).map((r, i) => validateRole(r, `roles[${i}]`))
    const lore = Array.isArray(parsed.lore) ? parsed.lore.slice(0, maxEntries).map((l, i) => validateLore(l, `lore[${i}]`)) : []
    return { roles, lore, source: 'story-package', warnings: [], diagnostics: [], applied: false }
  }
  const card: StCardParsed = parseStCharacterCard(parsed)
  if (card.name !== '未命名角色' || card.description || card.personality || card.bookEntries) {
    const mapped = mapStCardToRole(card)
    return { roles: [candidateRole(mapped.role)], lore: mapped.lore.slice(0, maxEntries).map(candidateLore), source: 'st-card', warnings: mapped.warnings, diagnostics: [], applied: false }
  }
  const entries = Array.isArray(parsed.entries) ? parsed.entries.slice(0, maxEntries).map((entry, i) => validateLore(entry, `entries[${i}]`)) : []
  if (!entries.length) throw new Error('Parsed input is neither an ST CardPackage, worldbook, nor StoryPackage.')
  return { roles: [], lore: entries, source: 'worldbook', warnings: [], diagnostics: [], applied: false }
}

export function createStoryExtractService(options: { core?: Pick<CoreRuntimePort, 'requestModel' | 'cancel'>; worker?: StoryExtractInput['worker']; maxChars?: number; maxEntries?: number } = {}): StoryExtractService {
  const active = new Set<string>(); let disposed = false
  const cancel = async (requestId?: string) => { if (requestId) active.delete(requestId); if (options.core) await options.core.cancel(requestId); else options.worker?.cancel?.(requestId) }
  return { id: STORY_EXTRACT_PLUGIN_ID, async extract(input) {
    if (disposed) throw new Error('story.extract service is disposed.')
    const maxChars = Math.max(1, Math.min(input.maxChars ?? options.maxChars ?? MAX_CHARS, MAX_CHARS)); const maxEntries = Math.max(1, Math.min(input.maxEntries ?? options.maxEntries ?? MAX_ENTRIES, MAX_ENTRIES))
    if (input.parsed !== undefined) { const result = fromParsed(input.parsed, maxEntries); if (input.requestModel || input.core || input.worker) return modelExtract(result, input, active, maxChars, maxEntries); return result }
    const checked = safeText(input.text ?? '', maxChars); if (checked.diagnostics.some(d => d.severity === 'error')) return { roles: [], lore: [], warnings: [], diagnostics: checked.diagnostics, source: 'text', applied: false }
    const result = fromText(checked.text, maxEntries); result.diagnostics.push(...checked.diagnostics); result.warnings.push(...checked.diagnostics.filter(d => d.severity === 'warning').map(d => d.message));
    if (input.requestModel || input.core || input.worker) return modelExtract(result, input, active, maxChars, maxEntries); return result
  }, cancel, dispose() { disposed = true; active.clear() } }
}

async function modelExtract(base: StoryExtractResult, input: StoryExtractInput, active: Set<string>, maxChars: number, maxEntries: number): Promise<StoryExtractResult> {
  const requestId = `story-extract:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`; active.add(requestId)
  const requester = input.requestModel ?? input.core?.requestModel ?? input.worker?.requestModel
  if (!requester) return base
  const request: ModelRequest = { requestId, capability: STORY_EXTRACT_PLUGIN_ID, prompt: { system: 'Extract reviewable candidates only. Never execute scripts, imports, tools, filesystem, network, or state changes. Return JSON matching the contract.', user: JSON.stringify({ text: input.text?.slice(0, maxChars), parsed: input.parsed, seed: base }) }, contract: { id: STORY_EXTRACT_CONTRACT.id, version: STORY_EXTRACT_CONTRACT.version, schema: { type: 'object', additionalProperties: false, properties: { roles: { type: 'array' }, lore: { type: 'array' }, storyPackage: { type: 'object' } } } }, stream: false, metadata: { capability: STORY_EXTRACT_PLUGIN_ID, maxChars, maxEntries } }
  try { const result = await withTimeout(requester(request), input.timeoutMs ?? 15_000); const validated = validateOutput(result.output); return { ...base, ...validated, source: 'model', diagnostics: base.diagnostics, warnings: [...base.warnings, ...(result.error ? [result.error] : [])], applied: false } } catch (error) { return { ...base, diagnostics: [...base.diagnostics, diagnostic('model.failed', error instanceof Error ? error.message : String(error))], warnings: [...base.warnings, 'Model extraction failed; deterministic candidates were retained.'], applied: false } } finally { active.delete(requestId) }
}
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Model request timed out.')), ms); promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) }) }) }

export function storyExtractCordisPlugin(service: StoryExtractService): Plugin {
  return { name: STORY_EXTRACT_PLUGIN_ID, apply(ctx: Context) { ctx.provide('storyExtract', service); ctx.effect(() => () => service.dispose()) } }
}
declare module '@deepseek-ai/cordis' { interface Context { storyExtract: StoryExtractService } }
export function standaloneStoryExtractPlugin(options: Parameters<typeof createStoryExtractService>[0] = {}): { service: StoryExtractService; plugin: Plugin } { const service = createStoryExtractService(options); return { service, plugin: storyExtractCordisPlugin(service) } }
export const storyExtractSchema = { role: { required: ['id', 'name', 'portraitRef', 'currentState', 'presence', 'selfModel'] }, lore: { required: ['name', 'content'] }, storyPackage: { required: ['id', 'title', 'opening', 'playerCharacter', 'roles', 'lore'] } } as const
export type { PlayerCharacter }
