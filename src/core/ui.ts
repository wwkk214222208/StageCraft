import type { CoreEvent, CoreView, StateEvent } from './protocol.ts'

export type UiPrimitive = string | number | boolean | null
export type UiValue = UiPrimitive | UiValue[] | { [key: string]: UiValue }

export interface UiBinding {
  path: string
  fallback?: UiValue
}

export interface UiAssetReference {
  type: 'asset' | 'https'
  id?: string
  url?: string
  alt?: string
}

export interface UiThemeTokens {
  color?: Record<string, string>
  spacing?: Record<string, number>
  radius?: Record<string, number>
  typography?: Record<string, string | number>
}

export interface UiCapabilityRequirement {
  id: string
  optional?: boolean
}

export type UiNode =
  | { type: 'text'; id?: string; text: string | UiBinding; tone?: string }
  | { type: 'image'; id?: string; source: UiAssetReference; alt?: string; width?: number; height?: number }
  | { type: 'tabs'; id?: string; tabs: Array<{ id: string; label: string; content: UiNode[] }>; selected?: UiBinding | string }
  | { type: 'text-input'; id?: string; label?: string; value?: UiBinding; placeholder?: string; multiline?: boolean; action?: string }
  | { type: 'number-input'; id?: string; label?: string; value?: UiBinding; min?: number; max?: number; step?: number; action?: string }
  | { type: 'select'; id?: string; label?: string; value?: UiBinding; options: Array<{ id: string; label: string; value: UiValue }>; action?: string }
  | { type: 'list'; id?: string; items: UiBinding; item: UiNode; emptyText?: string }
  | { type: 'table'; id?: string; rows: UiBinding; columns: Array<{ id: string; label: string; value: UiBinding }> }
  | { type: 'progress'; id?: string; value: UiBinding; max?: number; label?: string }
  | { type: 'collapse'; id?: string; title: string; content: UiNode[]; open?: boolean | UiBinding }
  | { type: 'modal'; id?: string; title: string; content: UiNode[]; open?: boolean | UiBinding }
  | { type: 'button'; id?: string; label: string; action: string; disabled?: boolean | UiBinding }
  | { type: 'confirm-action'; id?: string; label: string; confirmText: string; action: string; disabled?: boolean | UiBinding }
  | { type: 'markdown'; id?: string; source: string | UiBinding }
  | { type: 'stack'; id?: string; direction?: 'row' | 'column'; children: UiNode[] }

export interface UiPanel {
  id: string
  title: string
  content: UiNode[]
  priority?: number
  visible?: UiBinding
}

export interface UiActionDefinition {
  id: string
  label: string
  input?: UiValue
  output?: UiValue
  capability?: UiCapabilityRequirement
  confirmation?: string
}

export interface UiManifest {
  id: string
  version: string
  owner: string
  title?: string
  panels: UiPanel[]
  actions?: UiActionDefinition[]
  assets?: UiAssetReference[]
  theme?: UiThemeTokens
  capabilities?: UiCapabilityRequirement[]
  priority?: number
}

export interface UiActionContext {
  readonly owner: string
  readonly view: CoreView
  readonly event?: StateEvent
}

export interface UiActionHandler {
  readonly definition: UiActionDefinition
  validateInput?(input: unknown): void | string[]
  execute(input: unknown, context: UiActionContext): unknown | Promise<unknown>
}

export interface UiRendererHost<T = UiRenderResult> {
  render(view: CoreView): T
  invoke(actionId: string, input: unknown, owner?: string): Promise<unknown>
}

export interface UiRenderResult {
  revision: number
  panels: UiRenderedPanel[]
  theme: UiThemeTokens[]
}

export interface UiRenderedPanel {
  manifestId: string
  owner: string
  panel: UiPanel
  visible: boolean
}

const forbidden = new Set(['__proto__', 'prototype', 'constructor'])

export function readJsonPointer(root: unknown, pointer: string): unknown {
  if (typeof pointer !== 'string' || (!pointer.startsWith('/') && pointer !== '')) throw new Error(`Invalid JSON Pointer: ${pointer}`)
  if (pointer === '') return structuredClone(root)
  let current = root
  for (const raw of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(raw)) throw new Error(`Invalid JSON Pointer escape: ${pointer}`)
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (forbidden.has(segment)) throw new Error(`Forbidden JSON Pointer segment: ${segment}`)
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment) || Number(segment) >= current.length) return undefined
      current = current[Number(segment)]
    } else if (current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[segment]
    } else return undefined
  }
  return structuredClone(current)
}

export function resolveUiBinding(binding: UiBinding, state: unknown): unknown {
  const value = readJsonPointer(state, binding.path)
  return value === undefined ? structuredClone(binding.fallback) : value
}

export function assertUiJsonSafe(value: unknown, label = 'UI value', seen = new Set<object>()): void {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error(`${label} must be JSON-safe.`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${label} must be JSON-safe.`)
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) throw new Error(`${label} must not contain cycles.`)
  const prototype = Object.getPrototypeOf(value)
  if (value instanceof Date || value instanceof Map || value instanceof Set || value instanceof RegExp || value instanceof URL || ArrayBuffer.isView(value) || (prototype !== Object.prototype && prototype !== null && !Array.isArray(value))) throw new Error(`${label} must be JSON-safe.`)
  seen.add(value)
  if (Array.isArray(value)) for (const item of value) assertUiJsonSafe(item, label, seen)
  else for (const [key, item] of Object.entries(value)) { if (forbidden.has(key)) throw new Error(`${label} contains a forbidden key: ${key}`); assertUiJsonSafe(item, label, seen) }
  seen.delete(value)
}

function assertId(value: unknown, label: string): asserts value is string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`) }

export function validateUiAsset(asset: UiAssetReference): void {
  assertUiJsonSafe(asset, 'UI asset')
  if (asset.type === 'asset') { assertId(asset.id, 'UI asset id'); if (asset.url !== undefined) throw new Error('Asset references cannot contain a URL.') ; return }
  if (asset.type !== 'https' || typeof asset.url !== 'string') throw new Error('UI asset must be an asset id or HTTPS URL.')
  let url: URL
  try { url = new URL(asset.url) } catch { throw new Error('Invalid UI asset URL.') }
  if (url.protocol !== 'https:' || url.username || url.password || asset.url.split(/[\\/]+/).includes('..') || url.href.toLowerCase().startsWith('javascript:')) throw new Error('Unsafe UI asset URL.')
}

export function validateUiManifest(manifest: UiManifest): void {
  assertUiJsonSafe(manifest, 'UI manifest')
  assertId(manifest.id, 'UI manifest id'); assertId(manifest.version, 'UI manifest version'); assertId(manifest.owner, 'UI manifest owner')
  if (!Array.isArray(manifest.panels)) throw new Error('UI manifest panels are required.')
  const ids = new Set<string>()
  for (const panel of manifest.panels) { assertId(panel.id, 'UI panel id'); if (ids.has(panel.id)) throw new Error(`Duplicate UI panel id: ${panel.id}`); ids.add(panel.id); validateUiNodes(panel.content) }
  for (const action of manifest.actions ?? []) { assertId(action.id, 'UI action id'); if (ids.has(action.id)) throw new Error(`Duplicate UI id: ${action.id}`); ids.add(action.id) }
  for (const asset of manifest.assets ?? []) validateUiAsset(asset)
  for (const capability of [...(manifest.capabilities ?? []), ...(manifest.actions ?? []).flatMap(action => action.capability ? [action.capability] : [])]) assertId(capability.id, 'UI capability id')
}

function validateUiNodes(nodes: UiNode[]): void {
  if (!Array.isArray(nodes)) throw new Error('UI node children must be an array.')
  for (const node of nodes) {
    assertId(node.type, 'UI node type')
    if (node.type === 'image') validateUiAsset(node.source)
    if ('content' in node) validateUiNodes(node.content)
    if ('children' in node) validateUiNodes(node.children)
    if ('tabs' in node) for (const tab of node.tabs) { assertId(tab.id, 'UI tab id'); validateUiNodes(tab.content) }
    if ('item' in node) validateUiNodes([node.item])
    if ('action' in node) assertId(node.action, 'UI action reference')
    if ('items' in node) validateUiBinding(node.items)
    for (const key of ['text', 'value', 'visible', 'open', 'disabled', 'selected']) { const value = (node as Record<string, unknown>)[key]; if (value && typeof value === 'object' && !Array.isArray(value)) validateUiBinding(value as UiBinding) }
  }
}

function validateUiBinding(binding: UiBinding): void { assertId(binding.path, 'UI binding path'); readJsonPointer({}, binding.path) }

type RegisteredAction = UiActionHandler & { owner: string }

export class UiExtensionRegistry {
  private readonly manifests = new Map<string, UiManifest>()
  private readonly actions = new Map<string, RegisteredAction>()
  private readonly owners = new Map<string, object>()
  private readonly listeners = new Set<(event: CoreEvent) => void>()
  private eventSequence = 0
  private readonly getView: () => CoreView
  private readonly emitEvent?: (event: CoreEvent) => void

  constructor(getView: () => CoreView, emitEvent?: (event: CoreEvent) => void) {
    this.getView = getView
    this.emitEvent = emitEvent
  }
  subscribe(listener: (event: CoreEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  register(manifest: UiManifest, handlers: UiActionHandler[] = []): { dispose(): void } {
    validateUiManifest(manifest)
    if (this.manifests.has(manifest.id)) throw new Error(`UI manifest already registered: ${manifest.id}`)
    const owner = {}
    const actions = manifest.actions ?? []
    if (handlers.length !== actions.length || handlers.some(handler => !actions.some(action => action.id === handler.definition.id))) throw new Error('UI action handlers must exactly match manifest actions.')
    for (const action of actions) if (this.actions.has(action.id)) throw new Error(`UI action already registered: ${action.id}`)
    for (const handler of handlers) { assertUiJsonSafe(handler.definition, 'UI action definition'); if (handler.definition.id !== actions.find(action => action.id === handler.definition.id)!.id) throw new Error('UI action definition mismatch.') }
    this.manifests.set(manifest.id, structuredClone(manifest)); this.owners.set(manifest.id, owner)
    for (const handler of handlers) this.actions.set(handler.definition.id, { ...handler, definition: structuredClone(handler.definition), owner: manifest.owner })
    this.changed('registered', manifest.id)
    let active = true
    return { dispose: () => { if (!active || this.owners.get(manifest.id) !== owner) return; active = false; this.manifests.delete(manifest.id); this.owners.delete(manifest.id); for (const action of actions) { const registered = this.actions.get(action.id); if (registered?.owner === manifest.owner) this.actions.delete(action.id) } this.changed('unregistered', manifest.id) } }
  }
  list(): UiManifest[] { return [...this.manifests.values()].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.owner.localeCompare(b.owner) || a.id.localeCompare(b.id)).map(manifest => structuredClone(manifest)) }
  compose(state: unknown): UiRenderedPanel[] { return this.list().flatMap(manifest => manifest.panels.map(panel => ({ manifestId: manifest.id, owner: manifest.owner, panel: structuredClone(panel), visible: panel.visible ? Boolean(resolveUiBinding(panel.visible, state)) : true }))) }
  async invoke(actionId: string, input: unknown, owner: string): Promise<unknown> { const action = this.actions.get(actionId); if (!action) throw new Error(`UI action is not registered: ${actionId}`); if (action.owner !== owner) throw new Error(`UI action belongs to another extension: ${actionId}`); assertUiJsonSafe(input, 'UI action input'); const validation = action.validateInput?.(structuredClone(input)); if (Array.isArray(validation) && validation.length) throw new Error(`UI action input validation failed: ${validation.join('; ')}`); const output = await action.execute(structuredClone(input), { owner, view: structuredClone(this.getView()) }); assertUiJsonSafe(output, 'UI action output'); return structuredClone(output) }
  render(view: CoreView): UiRenderResult { return { revision: view.revision, panels: this.compose(view.state), theme: this.list().filter(manifest => manifest.theme).map(manifest => structuredClone(manifest.theme!)) } }
  private changed(operation: 'registered' | 'unregistered', manifestId: string): void { const event = { type: 'ui.manifest.changed' as const, revision: this.getView().revision, manifestId, operation, sequence: ++this.eventSequence }; for (const listener of this.listeners) listener(event); this.emitEvent?.(event) }
}

export type UiManifestEvent = Extract<CoreEvent, { type: 'ui.manifest.changed' }>
