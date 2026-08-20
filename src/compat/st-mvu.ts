import { createHash } from 'node:crypto'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { applyStatePatches, type StatePatch } from '../core/state-transaction.ts'
import { validateUiManifest, type UiActionHandler, type UiBinding, type UiManifest, type UiNode, type UiValue } from '../core/ui.ts'

export interface CompatDiagnostic {
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
}

export interface CardWorldbookEntry {
  id: string
  content: string
  keys: string[]
  secondaryKeys: string[]
  enabled: boolean
  constant: boolean
  selective: boolean
  caseSensitive?: boolean
  wholeWords?: boolean
  position?: string | number
  order?: number
  [key: string]: unknown
}

export interface CardPackage {
  raw: Record<string, unknown>
  card: Record<string, unknown>
  metadata: { filename: string; sha256: string; spec?: string }
  texts: Record<string, string>
  worldbook: CardWorldbookEntry[]
  alternateGreetings: string[]
  scripts: { path: string; source: string; metadata?: Record<string, unknown> }[]
  regexScripts: { path: string; source: string; metadata?: Record<string, unknown> }[]
  extensions: Record<string, unknown>
  diagnostics: CompatDiagnostic[]
}

export interface CompileReport {
  moduleId: string
  manifest: { id: string; version: string }
  imports: Array<{ url: string; version?: string; capability: 'blocked' | 'unsupported' }>
  diagnostics: CompatDiagnostic[]
}

export interface StUiCompileResult {
  manifest?: UiManifest
  handlers: UiActionHandler[]
  diagnostics: CompatDiagnostic[]
  recognized: number
  unsupported: number
}

export interface InitVarResult {
  state: Record<string, unknown>
  diagnostics: CompatDiagnostic[]
}

export interface WorldbookSelectionQuery {
  text: string
  caseSensitive?: boolean
  wholeWord?: boolean
  secondaryMode?: 'and' | 'or'
}

export interface DecodedMvuPatch {
  patches: StatePatch[]
  diagnostics: CompatDiagnostic[]
}

function uniqueDiagnostics(diagnostics: CompatDiagnostic[]): CompatDiagnostic[] {
  const seen = new Set<string>()
  return diagnostics.filter(diagnostic => {
    const key = `${diagnostic.level}\u0000${diagnostic.code}\u0000${diagnostic.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const clone = <T>(value: T): T => structuredClone(value)

function jsonSafe(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error(`${label} must be JSON-safe.`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${label} must be JSON-safe.`)
  if (value === null || typeof value !== 'object') return
  if (value instanceof Date || value instanceof RegExp || value instanceof URL || value instanceof Map || value instanceof Set || ArrayBuffer.isView(value)) throw new Error(`${label} must be JSON-safe.`)
  if (seen.has(value)) throw new Error(`${label} must not contain cycles.`)
  seen.add(value)
  if (Array.isArray(value)) for (const item of value) jsonSafe(item, label, seen)
  else for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new Error(`${label} contains a forbidden key.`)
    jsonSafe(item, label, seen)
  }
  seen.delete(value)
}

function rootCard(raw: Record<string, unknown>): Record<string, unknown> {
  const data = raw.data
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : raw
}

function collectStrings(value: unknown, path = '', output: Record<string, string> = {}): Record<string, string> {
  if (typeof value === 'string') output[path] = value
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) collectStrings(child, path ? `${path}.${key}` : key, output)
  return output
}

function collectScripts(value: unknown, path = '', output: { path: string; source: string; metadata?: Record<string, unknown> }[] = []): { path: string; source: string; metadata?: Record<string, unknown> }[] {
  if (!value || typeof value !== 'object') return output
  for (const [key, child] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key
    if (key === 'tavern_helper' && child && typeof child === 'object') {
      const scripts = (child as any).scripts
      if (Array.isArray(scripts)) {
        for (const [index, script] of scripts.entries()) if (script && typeof script === 'object') output.push({ path: `${next}.scripts.${index}`, source: String((script as any).content ?? (script as any).script ?? (script as any).source ?? ''), metadata: clone(script) })
      } else if (typeof (child as any).script === 'string') output.push({ path: `${next}.script`, source: (child as any).script, metadata: clone(child as any) })
    } else if (/^(?:regex_scripts|regexScripts)$/.test(key) && Array.isArray(child)) {
      for (const [index, script] of child.entries()) if (script && typeof script === 'object') output.push({ path: `${next}.${index}`, source: String((script as any).content ?? (script as any).script ?? (script as any).source ?? ''), metadata: clone(script) })
    } else if (child && typeof child === 'object') collectScripts(child, next, output)
  }
  return output
}

function normalizeEntry(value: unknown, index: number): CardWorldbookEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  const extension = entry.extensions && typeof entry.extensions === 'object' ? entry.extensions as Record<string, unknown> : {}
  const keys = Array.isArray(entry.keys) ? entry.keys.filter(item => typeof item === 'string') as string[] : typeof entry.key === 'string' ? [entry.key] : []
  const secondarySource = entry.secondary_keys ?? extension.secondary_keys
  const secondaryKeys = Array.isArray(secondarySource) ? secondarySource.filter(item => typeof item === 'string') as string[] : []
  const selective = entry.selective === true || extension.selective === true
  return {
    ...clone(entry), id: String(entry.id ?? entry.uid ?? index), content: typeof entry.content === 'string' ? entry.content : '', keys, secondaryKeys,
    enabled: entry.enabled !== false, constant: entry.constant === true || extension.constant === true, selective,
    caseSensitive: typeof (entry.case_sensitive ?? extension.case_sensitive) === 'boolean' ? (entry.case_sensitive ?? extension.case_sensitive) as boolean : undefined,
    wholeWords: typeof (entry.match_whole_words ?? extension.match_whole_words) === 'boolean' ? (entry.match_whole_words ?? extension.match_whole_words) as boolean : undefined,
    position: typeof (entry.position ?? extension.position) === 'string' || typeof (entry.position ?? extension.position) === 'number' ? entry.position ?? extension.position as string | number : undefined,
    order: typeof (entry.insertion_order ?? entry.order ?? extension.insertion_order ?? extension.order ?? extension.display_index) === 'number' ? Number(entry.insertion_order ?? entry.order ?? extension.insertion_order ?? extension.order ?? extension.display_index) : index,
  }
}

export function parseCardPackage(content: string, filename = 'card.json'): CardPackage {
  if (!content.trim()) throw new Error('Card JSON is empty.')
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(content) as Record<string, unknown> } catch { throw new Error('Card JSON parsing failed.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Card JSON root must be an object.')
  jsonSafe(parsed, 'Card')
  const card = rootCard(parsed)
  const book = card.character_book && typeof card.character_book === 'object' ? card.character_book as Record<string, unknown> : {}
  const rawEntries = Array.isArray(book.entries) ? book.entries : []
  const worldbook = rawEntries.map(normalizeEntry).filter((entry): entry is CardWorldbookEntry => Boolean(entry))
  const allScripts = collectScripts(parsed)
  const scripts = allScripts.filter(script => script.path.toLowerCase().includes('tavern_helper'))
  const regexScripts = allScripts.filter(script => /regex[_]?scripts/i.test(script.path))
  const diagnostics: CompatDiagnostic[] = []
  for (const script of [...scripts, ...regexScripts]) diagnostics.push({ level: 'warning', code: 'script.blocked', message: `Script capability blocked at ${script.path}.` })
  const raw = content
  return {
    raw: clone(parsed), card: clone(card), metadata: { filename, sha256: createHash('sha256').update(raw).digest('hex'), spec: typeof parsed.spec === 'string' ? parsed.spec : undefined },
    texts: collectStrings(card), worldbook, alternateGreetings: Array.isArray(card.alternate_greetings) ? card.alternate_greetings.filter(item => typeof item === 'string') as string[] : [], scripts, regexScripts, extensions: clone(card.extensions && typeof card.extensions === 'object' ? card.extensions as Record<string, unknown> : {}), diagnostics,
  }
}

export function compileCardPackage(pkg: CardPackage, moduleId = `card.${pkg.metadata.sha256.slice(0, 16)}`): CompileReport {
  const imports: CompileReport['imports'] = []
  const seenImports = new Set<string>()
  for (const script of [...pkg.scripts, ...pkg.regexScripts]) {
    const found = new Set<string>()
    for (const match of script.source.matchAll(/(?:import\s+|from\s+|require\s*\(\s*)['"]([^'"]+)['"]|\bhttps?:\/\/[^\s'"`<>)]*/g)) found.add(match[1] ?? match[0])
    for (const url of found) {
      if (seenImports.has(url)) continue
      seenImports.add(url)
      const version = url.match(/@((?:\d+\.){1,2}\d+(?:[-+][^/\s]+)?)(?:\/|$)/)?.[1]
      imports.push({ url, version, capability: 'blocked' })
    }
  }
  return { moduleId, manifest: { id: moduleId, version: pkg.metadata.sha256.slice(0, 12) }, imports, diagnostics: [...pkg.diagnostics, ...imports.map(item => ({ level: 'warning' as const, code: 'import.blocked', message: `Import capability blocked: ${item.url}.` }))] }
}

function scalar(value: string): unknown {
  const rawText = value.trim()
  let commentAt = -1
  let quote = ''
  for (let index = 0; index < rawText.length; index++) {
    const char = rawText[index]
    if (quote) { if (char === quote && rawText[index - 1] !== '\\') quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '#' && (index === 0 || /\s/.test(rawText[index - 1]))) { commentAt = index; break }
  }
  const text = (commentAt >= 0 ? rawText.slice(0, commentAt) : rawText).trim()
  if (!text) return null
  if (/^(?:[&*!]|\||>)|\s[&*!]/.test(text)) throw new Error('YAML anchors/tags and executable scalar forms are not supported.')
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1)
  if (text === 'true' || text === 'false') return text === 'true'
  if (text === 'null' || text === '~') return null
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return Number(text)
  if (text.startsWith('[') || text.startsWith('{')) {
    if (text.startsWith('[') && text.endsWith(']')) {
      const parts = splitFlow(text.slice(1, -1))
      if (parts.some(part => !part)) throw new Error('Unsupported YAML flow array.')
      return parts.map(scalar)
    }
    if (text.startsWith('{') && text.endsWith('}')) {
      const object: Record<string, unknown> = {}
      const seen = new Set<string>()
      for (const part of splitFlow(text.slice(1, -1))) {
        const index = part.indexOf(':')
        if (index <= 0) throw new Error('Unsupported YAML flow object.')
        const key = part.slice(0, index).trim().replace(/^['"]|['"]$/g, '')
        if (seen.has(key)) throw new Error(`Duplicate YAML key: ${key}.`)
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`Unsafe YAML key: ${key}.`)
        seen.add(key)
        object[key] = scalar(part.slice(index + 1))
      }
      return object
    }
  }
  return text
}

function splitFlow(text: string): string[] {
  const parts: string[] = []; let start = 0; let depth = 0; let quote = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) { if (char === quote && text[index - 1] !== '\\') quote = ''; continue }
    if (char === '"' || char === "'") quote = char
    else if (char === '[' || char === '{') depth++
    else if (char === ']' || char === '}') depth--
    else if (char === ',' && depth === 0) { parts.push(text.slice(start, index).trim()); start = index + 1 }
  }
  if (quote || depth !== 0) throw new Error('Unsupported YAML flow value.')
  if (text.trim()) parts.push(text.slice(start).trim())
  return parts
}

export function parseSafeYaml(text: string): Record<string, unknown> {
  const root: any = {}
  const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])
  const assign = (target: Record<string, unknown>, key: string, value: unknown): void => {
    if (unsafeKeys.has(key)) throw new Error(`Unsafe YAML key: ${key}.`)
    if (Object.prototype.hasOwnProperty.call(target, key)) throw new Error(`Duplicate YAML key: ${key}.`)
    target[key] = value
  }
  const stack: Array<{ indent: number; value: any }> = [{ indent: -1, value: root }]
  const lines = text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))
  lines.forEach((line, index) => {
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    const trimmed = line.trim()
    while (stack.length > 1 && indent <= stack.at(-1)!.indent) stack.pop()
    const parent = stack.at(-1)!.value
    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(parent)) throw new Error(`Invalid YAML list indentation at line ${index + 1}.`)
      const item = trimmed.slice(2).trim()
      const separator = item.indexOf(':')
      if (separator > 0) {
        const object: Record<string, unknown> = {}
        const key = item.slice(0, separator).trim(); const rest = item.slice(separator + 1).trim()
        assign(object, key.replace(/^['"]|['"]$/g, ''), rest ? scalar(rest) : {})
        parent.push(object)
        stack.push({ indent, value: rest ? object : object[Object.keys(object)[0]] })
      } else parent.push(scalar(item))
      return
    }
    const separator = trimmed.indexOf(':')
    if (separator <= 0) throw new Error(`Invalid YAML mapping at line ${index + 1}.`)
    const key = trimmed.slice(0, separator).trim()
    const rest = trimmed.slice(separator + 1).trim()
    const normalizedKey = key.replace(/^['"]|['"]$/g, '')
    if (rest) assign(parent, normalizedKey, scalar(rest))
    else {
      const next = lines[index + 1]
      const nextIsList = next && (next.match(/^\s*/)?.[0].length ?? 0) > indent && next.trim().startsWith('- ')
      const child = nextIsList ? [] : {}
      assign(parent, normalizedKey, child)
      stack.push({ indent, value: child })
    }
  })
  jsonSafe(root, 'InitVar YAML')
  return root
}

export function extractInitVars(pkg: CardPackage): InitVarResult {
  const diagnostics: CompatDiagnostic[] = []
  const state: Record<string, unknown> = {}
  const sources: Array<[string, string, boolean]> = []
  for (const entry of pkg.worldbook) {
    const marker = /\[InitVar\]/i.test(String(entry.comment ?? entry.name ?? ''))
    if (marker) sources.push([`worldbook.${entry.id}`, entry.content, true])
  }
  for (const [path, text] of Object.entries(pkg.texts)) if (/^(?:first_mes|first_message|system_prompt|post_history_instructions|alternate_greetings)/i.test(path)) sources.push([path, text, false])
  for (const [path, text, whole] of sources) {
    const matches = whole ? [[text]] : [...text.matchAll(/(?:\[InitVar\]|<initvar>)([\s\S]*?)(?:\[\/InitVar\]|<\/initvar>|$)/gi)]
    for (const match of matches) {
      const body = (whole ? match[0] : match[1]).trim()
      try {
        const parsed = body.startsWith('{') || body.startsWith('[') ? JSON.parse(body) : parseSafeYaml(body)
        jsonSafe(parsed, 'InitVar')
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(state, parsed)
      } catch (error) { diagnostics.push({ level: 'error', code: 'initvar.invalid', message: `${path}: ${error instanceof Error ? error.message : String(error)}` }) }
    }
  }
  return { state: clone(state), diagnostics }
}

function matches(text: string, keyword: string, caseSensitive: boolean, wholeWord: boolean): boolean {
  const source = caseSensitive ? text : text.toLocaleLowerCase()
  const target = caseSensitive ? keyword : keyword.toLocaleLowerCase()
  if (!wholeWord) return source.includes(target)
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}\\p{N}_])`, 'u').test(source)
}

export function selectWorldbook(entries: CardWorldbookEntry[], query: WorldbookSelectionQuery): CardWorldbookEntry[] {
  return entries.filter(entry => {
    if (!entry.enabled) return false
    if (entry.constant) return true
    const caseSensitive = query.caseSensitive ?? entry.caseSensitive ?? false
    const wholeWord = query.wholeWord ?? entry.wholeWords ?? false
    const primary = entry.keys.some(key => matches(query.text, key, caseSensitive, wholeWord))
    if (!entry.selective) return primary
    const rawLogic = (entry.extensions as any)?.selectiveLogic ?? (entry as any).selectiveLogic ?? query.secondaryMode ?? 0
    const logic = typeof rawLogic === 'number' ? rawLogic : String(rawLogic).trim().toLowerCase().replace(/[\s-]+/g, '_')
    const matched = entry.secondaryKeys.map(key => matches(query.text, key, caseSensitive, wholeWord))
    const any = matched.some(Boolean)
    const all = matched.length > 0 && matched.every(Boolean)
    const secondary = entry.secondaryKeys.length === 0 ? false : logic === 0 || logic === 'and_any' || logic === 'or' || logic === 'or_any' ? any
      : logic === 1 || logic === 'not_all' ? !all
        : logic === 2 || logic === 'not_any' ? !any
          : logic === 3 || logic === 'and_all' || logic === 'and' ? all
            : all
    return primary && secondary
  }).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
}

export function worldbookDiagnostics(entries: CardWorldbookEntry[]): CompatDiagnostic[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const extensions = entry.extensions && typeof entry.extensions === 'object' ? entry.extensions as Record<string, unknown> : {}
    for (const capability of ['probability', 'cooldown', 'sticky', 'group', 'recursive', 'prevent_recursion', 'exclude_recursion', 'delay_until_recursion', 'delay', 'useProbability', 'group_weight', 'group_override', 'use_group_scoring', 'scan_depth', 'depth', 'triggers', 'vectorized', 'use_regex']) if (entry[capability] !== undefined || extensions[capability] !== undefined) counts.set(capability, (counts.get(capability) ?? 0) + 1)
  }
  return [...counts.entries()].map(([capability, count]) => ({ level: 'warning' as const, code: `worldbook.${capability}.unsupported`, message: `${capability} is not implemented for ${count} worldbook entr${count === 1 ? 'y' : 'ies'}.` }))
}

function mapMvuPath(path: string, moduleId: string): string {
  if (!path.startsWith('/')) throw new Error('MVU path must be a JSON Pointer.')
  const segments = path.slice(1).split('/').map(segment => { if (/~(?![01])/.test(segment)) throw new Error('MVU path has an invalid JSON Pointer escape.'); const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~'); if (['__proto__', 'prototype', 'constructor'].includes(decoded)) throw new Error('MVU path contains a forbidden segment.'); return decoded })
  const first = segments[0]
  if (first === 'modules' || first === 'state') throw new Error('MVU path escapes the compatibility namespace.')
  const suffix = path === '/' ? '' : path
  return `/modules/${moduleId.replace(/~/g, '~0').replace(/\//g, '~1')}/state/stat_data${first === 'stat_data' ? suffix.slice('/stat_data'.length) : suffix}`
}

export function decodeMvuUpdates(text: string, moduleId: string): DecodedMvuPatch {
  const blocks = [...text.matchAll(/<UpdateVariable\b[^>]*>([\s\S]*?)<\/UpdateVariable>/gi)]
  if (blocks.length !== 1) throw new Error(blocks.length === 0 ? 'MVU JSONPatch block not found.' : 'Multiple MVU JSONPatch blocks are ambiguous.')
  const jsonBlocks = [...blocks[0][1].matchAll(/<JSONPatch\b[^>]*>([\s\S]*?)<\/JSONPatch>/gi)]
  if (jsonBlocks.length !== 1) throw new Error(jsonBlocks.length === 0 ? 'MVU JSONPatch block not found.' : 'Multiple MVU JSONPatch blocks are ambiguous.')
  const body = jsonBlocks[0][1].replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, '').trim()
  let raw: unknown
  try { raw = JSON.parse(body) } catch { throw new Error('MVU JSONPatch is invalid JSON.') }
  if (!Array.isArray(raw)) throw new Error('MVU JSONPatch must be an array.')
  const allowed = new Set(['replace', 'set', 'delta', 'insert', 'remove', 'move', 'merge', 'test'])
  const patches = raw.map((item: any) => {
    if (!item || typeof item !== 'object' || !allowed.has(item.op) || typeof item.path !== 'string') throw new Error('MVU JSONPatch contains an invalid operation.')
    const requiredValue = new Set(['replace', 'set', 'delta', 'insert', 'merge', 'test'])
    if (requiredValue.has(item.op) && !Object.prototype.hasOwnProperty.call(item, 'value')) throw new Error(`MVU ${item.op} requires value.`)
    if (item.op === 'delta' && (typeof item.value !== 'number' || !Number.isFinite(item.value))) throw new Error('MVU delta value must be finite.')
    if (item.op === 'merge' && (!item.value || typeof item.value !== 'object' || Array.isArray(item.value))) throw new Error('MVU merge value must be an object.')
    const patch: any = { ...item, path: mapMvuPath(item.path, moduleId) }
    if (item.op === 'move') { if (typeof item.from !== 'string') throw new Error('MVU move requires from.'); patch.from = mapMvuPath(item.from, moduleId) }
    delete patch.extra
    jsonSafe(patch, 'MVU patch')
    return patch as StatePatch
  })
  return { patches, diagnostics: [] }
}

export class StateOverlay {
  private readonly base: Record<string, unknown>
  private current: Record<string, unknown>
  private patches: StatePatch[] = []
  constructor(base: Record<string, unknown>) { jsonSafe(base, 'Overlay base'); this.base = clone(base); this.current = clone(base) }
  apply(patches: StatePatch[]): this { const result = applyStatePatches(this.current, patches); this.current = result.after; this.patches.push(...clone(patches)); return this }
  get(path: string): unknown {
    if (path === '') return clone(this.current)
    if (!path.startsWith('/')) throw new Error('Overlay path must be a JSON Pointer.')
    let value: any = this.current
    for (const raw of path.slice(1).split('/')) {
      if (/~(?![01])/.test(raw)) throw new Error('Overlay path has an invalid JSON Pointer escape.')
      const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~')
      if (segment === '__proto__' || segment === 'prototype' || segment === 'constructor') throw new Error('Forbidden overlay path.')
      if (Array.isArray(value)) { if (!/^(?:0|[1-9]\d*)$/.test(segment) || Number(segment) >= value.length) throw new Error('Overlay array index is out of bounds.'); value = value[Number(segment)] }
      else if (value && typeof value === 'object') value = value[segment]
      else return undefined
    }
    return clone(value)
  }
  preview(): Record<string, unknown> { return clone(this.current) }
  toPatches(): StatePatch[] { return clone(this.patches) }
  discard(): void { this.current = clone(this.base); this.patches = [] }
}

type UiMetadata = Record<string, unknown>

function uiMetadata(pkg: CardPackage): UiMetadata | undefined {
  const candidates = [pkg.extensions.ui, pkg.extensions.mvu_ui, pkg.extensions.mvuUi, pkg.extensions.interface, pkg.extensions.display]
  for (const candidate of candidates) if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate as UiMetadata
  return undefined
}

function uiPointer(path: string, moduleId: string): UiBinding {
  if (!path.startsWith('/')) throw new Error(`UI binding path must be a JSON Pointer: ${path}`)
  const segments = path.slice(1).split('/').map(segment => {
    if (/~(?![01])/.test(segment)) throw new Error(`UI binding path has an invalid escape: ${path}`)
    const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (['__proto__', 'prototype', 'constructor'].includes(decoded)) throw new Error(`UI binding path contains a forbidden segment: ${decoded}`)
    return decoded
  })
  const suffix = path === '/' ? '' : path
  const first = segments[0]
  return { path: `/modules/${moduleId.replace(/~/g, '~0').replace(/\//g, '~1')}/state/stat_data${first === 'stat_data' ? suffix.slice('/stat_data'.length) : suffix}` }
}

function uiValue(value: unknown): UiValue {
  jsonSafe(value, 'ST UI value')
  return clone(value) as UiValue
}

function compileUiNode(value: unknown, moduleId: string, diagnostics: CompatDiagnostic[], count: { recognized: number; unsupported: number }): UiNode | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { count.unsupported++; return undefined }
  const raw = value as UiMetadata
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : ''
  const path = typeof raw.path === 'string' ? uiPointer(raw.path, moduleId) : undefined
  const label = typeof raw.label === 'string' ? raw.label : undefined
  try {
    if (type === 'text' || type === 'label' || type === 'value') { count.recognized++; return { type: 'text', ...(raw.id ? { id: String(raw.id) } : {}), text: path ?? String(raw.text ?? raw.value ?? ''), ...(raw.tone ? { tone: String(raw.tone) } : {}) } }
    if (type === 'markdown') { count.recognized++; return { type: 'markdown', ...(raw.id ? { id: String(raw.id) } : {}), source: path ?? String(raw.source ?? raw.text ?? '') } }
    if (type === 'image') {
      const source = raw.source && typeof raw.source === 'object' ? clone(raw.source) as any : typeof raw.asset === 'string' ? { type: 'asset', id: raw.asset } : typeof raw.url === 'string' ? { type: 'https', url: raw.url } : undefined
      if (!source) throw new Error('image requires an asset or HTTPS source')
      count.recognized++; return { type: 'image', ...(raw.id ? { id: String(raw.id) } : {}), source, ...(raw.alt ? { alt: String(raw.alt) } : {}) }
    }
    if (type === 'progress' && path) { count.recognized++; return { type: 'progress', ...(raw.id ? { id: String(raw.id) } : {}), value: path, ...(raw.max !== undefined ? { max: Number(raw.max) } : {}), ...(label ? { label } : {}) } }
    if (type === 'button' || type === 'action') { if (typeof raw.action !== 'string') throw new Error('button requires an action') ; count.recognized++; return { type: 'button', ...(raw.id ? { id: String(raw.id) } : {}), label: label ?? String(raw.text ?? raw.action), action: `${moduleId}.ui.${raw.action}` } }
    if (type === 'stack') {
      const children = Array.isArray(raw.children) ? raw.children.map(child => compileUiNode(child, moduleId, diagnostics, count)).filter((child): child is UiNode => Boolean(child)) : []
      count.recognized++; return { type: 'stack', ...(raw.id ? { id: String(raw.id) } : {}), direction: raw.direction === 'row' ? 'row' : 'column', children }
    }
    throw new Error(`unsupported node type ${type || '(missing)'}`)
  } catch (error) { count.unsupported++; diagnostics.push({ level: 'warning', code: 'ui.node.unsupported', message: `${type || 'node'}: ${error instanceof Error ? error.message : String(error)}` }); return undefined }
}

export function compileStCardUi(pkg: CardPackage, moduleId: string): StUiCompileResult {
  const diagnostics: CompatDiagnostic[] = [], count = { recognized: 0, unsupported: 0 }, metadata = uiMetadata(pkg)
  if (!metadata) return { handlers: [], diagnostics, recognized: 0, unsupported: 0 }
  const rawPanels = Array.isArray(metadata.panels) ? metadata.panels : Array.isArray(metadata.views) ? metadata.views : []
  if (!Array.isArray(metadata.panels) && !Array.isArray(metadata.views)) { count.unsupported++; diagnostics.push({ level: 'warning', code: 'ui.panels.unsupported', message: 'UI metadata requires a panels or views array.' }) }
  for (const key of Object.keys(metadata)) if (!['title', 'panels', 'views', 'actions', 'theme'].includes(key)) { count.unsupported++; diagnostics.push({ level: 'warning', code: 'ui.metadata.unsupported', message: `Unsupported UI metadata field: ${key}.` }) }
  const panels = rawPanels.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { count.unsupported++; diagnostics.push({ level: 'warning', code: 'ui.panel.unsupported', message: `Panel ${index + 1} is not an object.` }); return undefined }
    const panel = value as UiMetadata, rawNodes = Array.isArray(panel.nodes) ? panel.nodes : Array.isArray(panel.content) ? panel.content : []
    const content = rawNodes.map(node => compileUiNode(node, moduleId, diagnostics, count)).filter((node): node is UiNode => Boolean(node))
    if (!content.length) { count.unsupported++; diagnostics.push({ level: 'warning', code: 'ui.panel.empty', message: `Panel ${String(panel.id ?? index + 1)} has no supported nodes.` }) }
    return { id: String(panel.id ?? `panel-${index + 1}`), title: String(panel.title ?? panel.name ?? `Card panel ${index + 1}`), content, ...(typeof panel.priority === 'number' ? { priority: panel.priority } : {}), ...(typeof panel.visible === 'string' ? { visible: uiPointer(panel.visible, moduleId) } : {}) }
  }).filter((panel): panel is NonNullable<typeof panel> => Boolean(panel))
  const actions = (Array.isArray(metadata.actions) ? metadata.actions : []).flatMap((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { count.unsupported++; return [] }
    const action = value as UiMetadata
    if (typeof action.id !== 'string' || typeof action.path !== 'string') { count.unsupported++; diagnostics.push({ level: 'warning', code: 'ui.action.unsupported', message: `Action ${index + 1} requires id and path.` }); return [] }
    try { count.recognized++; return [{ id: `${moduleId}.ui.${action.id}`, label: String(action.label ?? action.id), input: { op: String(action.op ?? 'set'), path: uiPointer(action.path, moduleId).path, ...(Object.prototype.hasOwnProperty.call(action, 'value') ? { value: uiValue(action.value) } : {}) }, ...(action.confirmation ? { confirmation: String(action.confirmation) } : {}) }] }
    catch (error) { count.unsupported++; diagnostics.push({ level: 'warning', code: 'ui.action.unsupported', message: `${action.id}: ${error instanceof Error ? error.message : String(error)}` }); return [] }
  })
  const manifest: UiManifest = { id: `${moduleId}.ui`, version: pkg.metadata.sha256.slice(0, 12), owner: moduleId, ...(typeof metadata.title === 'string' ? { title: metadata.title } : {}), panels, actions, ...(metadata.theme && typeof metadata.theme === 'object' ? { theme: clone(metadata.theme) as any } : {}) }
  try { validateUiManifest(manifest) } catch (error) { diagnostics.push({ level: 'error', code: 'ui.manifest.invalid', message: error instanceof Error ? error.message : String(error) }); return { handlers: [], diagnostics, recognized: count.recognized, unsupported: count.unsupported + 1 } }
  return { manifest, handlers: [], diagnostics, recognized: count.recognized, unsupported: count.unsupported }
}

export interface StCompatPluginOptions { moduleId?: string; package: CardPackage; report?: CompileReport }

export function stMvuCompatPlugin(options: StCompatPluginOptions): Plugin {
  const report = options.report ?? compileCardPackage(options.package)
  const moduleId = options.moduleId ?? report.moduleId
  const init = extractInitVars(options.package)
  const ui = compileStCardUi(options.package, moduleId)
  const diagnostics = uniqueDiagnostics([...options.package.diagnostics, ...report.diagnostics, ...init.diagnostics, ...worldbookDiagnostics(options.package.worldbook), ...ui.diagnostics])
  const statePrefix = `/modules/${moduleId.replace(/~/g, '~0').replace(/\//g, '~1')}/state/stat_data`
  const validateProposal = (input: unknown): void | string[] => {
    const patches = (input as any)?.patches
    if (!Array.isArray(patches)) return ['patches required']
    const allowedPath = (path: unknown): path is string => typeof path === 'string' && (path === statePrefix || path.startsWith(`${statePrefix}/`))
    const allowed = new Set(['replace', 'set', 'delta', 'insert', 'remove', 'move', 'merge', 'test'])
    const requiresValue = new Set(['replace', 'set', 'delta', 'insert', 'merge', 'test'])
    for (const patch of patches) {
      if (!patch || typeof patch !== 'object' || !allowed.has(patch.op) || !allowedPath(patch.path)) return ['invalid proposal patch']
      if (requiresValue.has(patch.op) && !Object.prototype.hasOwnProperty.call(patch, 'value')) return [`${patch.op} requires value`]
      if (patch.op === 'move' && !allowedPath(patch.from)) return ['patch escapes module state namespace']
      if (patch.op === 'delta' && (typeof patch.value !== 'number' || !Number.isFinite(patch.value))) return ['delta value must be finite']
      try { jsonSafe(patch, 'proposal patch') } catch (error) { return [error instanceof Error ? error.message : String(error)] }
    }
  }
  return {
    name: `compat.${moduleId}`,
    inject: ['stagecraft'],
    apply(ctx: Context) {
      const service = ctx.stagecraft
      const registrations: Array<{ dispose(): void | Promise<void> }> = []
      try {
        registrations.push(service.state.registerModule({ id: moduleId, version: report.manifest.version }))
        registrations.push(service.state.registerSchema({ id: `${moduleId}.schema`, moduleId, validate: state => state === undefined || (state && typeof state === 'object') ? undefined : ['state must be an object'] }))
        registrations.push(service.extensions.registerProposalType({ id: `${moduleId}.mvu-patch`, moduleId, path: '/runtime/proposals', validate: validateProposal, apply: input => (input as any).patches }))
        registrations.push(service.extensions.registerPromptContributor({ id: `${moduleId}.worldbook`, priority: 0, contribute: input => ({ kind: 'compat.worldbook', content: selectWorldbook(options.package.worldbook, { text: String((input as any)?.text ?? '') }).map(entry => ({ id: entry.id, content: entry.content, position: entry.position, order: entry.order })) }) }))
        if (ui.manifest) {
          const handlers = (ui.manifest.actions ?? []).map(action => ({ definition: action, validateInput: (input: unknown) => {
            const payload = input && typeof input === 'object' ? input as Record<string, unknown> : {}
            if (payload.op !== action.input?.['op'] || payload.path !== action.input?.['path']) return ['action payload does not match its declaration']
          }, execute: (input: unknown) => {
            const payload = input && typeof input === 'object' ? input as Record<string, unknown> : {}
            const patch = { op: payload.op, path: payload.path, ...(Object.prototype.hasOwnProperty.call(payload, 'value') ? { value: payload.value } : {}) } as StatePatch
            return service.extensions.operateProposal({ operation: 'create', typeId: `${moduleId}.mvu-patch`, input: { patches: [patch] }, roomId: service.roomId })
          } }))
          registrations.push(service.extensions.registerUiManifest(ui.manifest, handlers))
        }
        registrations.push(service.extensions.registerViewContributor({ id: `${moduleId}.summary`, priority: 0, contribute: input => {
          const source = input && typeof input === 'object' ? input as any : {}
          const state = source.state
          const revision = typeof source.revision === 'number' ? source.revision : 0
          const modules = (state && typeof state === 'object' ? state.modules : undefined)
          const moduleState = modules && typeof modules === 'object' ? modules[moduleId]?.state?.stat_data : undefined
          const statePresent = moduleState !== undefined
          const topLevelKeys = statePresent && moduleState && typeof moduleState === 'object' && !Array.isArray(moduleState) ? Object.keys(moduleState).sort() : []
          return { kind: 'compat.summary', value: { moduleId, manifest: report.manifest, worldbookCount: options.package.worldbook.length, statePresent, revision, topLevelKeys, diagnostics: diagnostics.map(item => ({ level: item.level, code: item.code, message: item.message })) } }
        } }))
        const existing = (service.core.getView().state as any)?.modules?.[moduleId]?.state?.stat_data
        if (existing === undefined && Object.keys(init.state).length > 0) service.state.transact({ roomId: service.roomId, moduleId, patches: [{ op: 'set', path: `${statePrefix}`, value: init.state }] })
        ctx.effect(() => () => { for (const registration of registrations.reverse()) registration.dispose() })
      } catch (error) {
        for (const registration of registrations.reverse()) { try { registration.dispose() } catch { /* preserve original installation error */ } }
        throw error
      }
    },
  }
}
