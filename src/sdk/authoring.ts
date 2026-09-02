/**
 * StageCraft authoring SDK prototype (M2).
 *
 * This module is intentionally browser-compatible and dependency-free. It is an
 * author-facing convenience layer, not the v2 Host ABI. The returned values are
 * plain data + functions so a plugin can be bundled as ESM for desktop and Android.
 */

export const STAGECRAFT_AUTHORING_API = '0.1' as const

export type AuthoringKind = 'tool' | 'provider-driver' | 'llm-system' | 'solution' | 'ui' | 'core'

export interface AuthoringManifest {
  id: string
  version: string
  title: string
  description?: string
  author?: string
  /** Authoring category. Deliberately separate from the current v1 PluginKind. */
  category: AuthoringKind
  apiVersion: typeof STAGECRAFT_AUTHORING_API
  /** Entry names are build metadata and are not consumed by the current v1 launcher. */
  entry?: Readonly<{ desktop: string; android: string }>
  capabilities?: readonly string[]
}

export interface AuthoringContext {
  readonly apiVersion: string
  readonly pluginId: string
  readonly config: Readonly<Record<string, unknown>>
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, details?: unknown): void
}

export interface ToolContext extends AuthoringContext {
  signal?: AbortSignal
}

export interface ToolPluginDefinition extends Omit<AuthoringManifest, 'category' | 'apiVersion'> {
  inputSchema?: unknown
  outputSchema?: unknown
  execute(input: unknown, context: ToolContext): unknown | Promise<unknown>
}

export interface ToolPlugin {
  readonly kind: 'tool'
  readonly manifest: AuthoringManifest
  readonly inputSchema?: unknown
  readonly outputSchema?: unknown
  execute(input: unknown, context: ToolContext): unknown | Promise<unknown>
}

export interface ProviderRequest {
  /** Stable correlation key used by cancel(); the host owns its uniqueness. */
  requestId: string
  model: string
  messages: readonly { role: string; content: string }[]
  signal?: AbortSignal
  metadata?: Readonly<Record<string, unknown>>
  /** Filled by the LLM System; a driver must not select or replace these. */
  providerId?: string
  credentialProfileId?: string
  credential?: Readonly<CredentialMaterial>
}

export interface CredentialProfileMetadata {
  readonly id: string
  readonly providerId: string
  readonly label?: string
  readonly createdAt?: string
  readonly updatedAt?: string
}

/** Runtime-only material. It is deliberately absent from AuthoringManifest. */
export interface CredentialMaterial {
  readonly profileId: string
  readonly secret?: string
  readonly fields?: Readonly<Record<string, string>>
}

export interface ProviderChunk {
  type: 'text' | 'thinking' | 'usage' | 'error' | 'done'
  text?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  error?: string
}

export interface ProviderDriverDefinition extends Omit<AuthoringManifest, 'category' | 'apiVersion'> {
  providerId: string
  models: readonly string[]
  request(request: ProviderRequest, context: AuthoringContext): AsyncIterable<ProviderChunk>
  cancel?(requestId: string, context: AuthoringContext): void | Promise<void>
}

export interface ProviderDriver {
  readonly kind: 'provider-driver'
  readonly manifest: AuthoringManifest
  readonly providerId: string
  readonly models: readonly string[]
  request(request: ProviderRequest, context: AuthoringContext): AsyncIterable<ProviderChunk>
  cancel?(requestId: string, context: AuthoringContext): void | Promise<void>
}

export interface LlmRouteSelection {
  readonly providerId: string
  readonly model: string
  readonly credentialProfileId?: string
}

export interface LlmUsageRecord {
  readonly requestId: string
  readonly providerId: string
  readonly model: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly timestamp?: string
}

/** Persistable harness state. Secrets live here for the reference path only;
 * production deployments should move them to a platform secret store. */
export interface LlmHarnessSnapshot {
  readonly credentialProfiles: readonly CredentialProfileMetadata[]
  readonly usage: readonly LlmUsageRecord[]
  readonly secrets: Readonly<Record<string, string>>
}

/** Persistence seam for credential profiles, usage and secrets. Reads happen
 * once at harness start; writes are best-effort and never break the stream. */
export interface LlmHarnessStore {
  read(): Promise<LlmHarnessSnapshot | undefined>
  write(snapshot: LlmHarnessSnapshot): Promise<void>
}

export interface LlmSystemAuthoringContext extends AuthoringContext {
  registerDriver(driver: ProviderDriver): void
  listDrivers(): readonly ProviderDriver[]
  listModels(providerId?: string): readonly { providerId: string; models: readonly string[] }[]
  upsertCredentialProfile(profile: CredentialProfileMetadata): void
  listCredentialProfiles(): readonly CredentialProfileMetadata[]
}

export interface LlmSystemDefinition extends Omit<AuthoringManifest, 'category' | 'apiVersion'> {
  start(context: LlmSystemAuthoringContext): void | Promise<void>
  stop?(context: LlmSystemAuthoringContext): void | Promise<void>
  route(input: { model?: string; providerId?: string; credentialProfileId?: string; metadata?: Readonly<Record<string, unknown>> }, context: LlmSystemAuthoringContext): LlmRouteSelection | Promise<LlmRouteSelection>
}

export interface LlmSystemPlugin {
  readonly kind: 'llm-system'
  readonly manifest: AuthoringManifest
  readonly start: LlmSystemDefinition['start']
  readonly stop?: LlmSystemDefinition['stop']
  readonly route: LlmSystemDefinition['route']
}

export interface SolutionDefinition extends Omit<AuthoringManifest, 'category' | 'apiVersion'> {
  systemPrompt?: string
  assemblePrompt(input: { user: string; state?: unknown; history?: readonly unknown[] }, context: AuthoringContext): string | Promise<string>
  handleCommand?(command: unknown, context: AuthoringContext): unknown | Promise<unknown>
}

export interface SolutionPlugin {
  readonly kind: 'solution'
  readonly manifest: AuthoringManifest
  readonly systemPrompt?: string
  assemblePrompt: SolutionDefinition['assemblePrompt']
  handleCommand?: SolutionDefinition['handleCommand']
}

export type UiView =
  | { type: 'text'; text: string }
  | { type: 'stack'; children: readonly UiView[] }
  | { type: 'button'; label: string; action: string }

export interface UiSurface {
  readonly id: string
  render(view: UiView): UiRenderResult
}

export interface UiRenderResult {
  readonly surfaceId: string
  readonly view: UiView
}

export interface UiPluginDefinition extends Omit<AuthoringManifest, 'category' | 'apiVersion'> {
  /** A named, platform-neutral surface keeps DOM/Android details in the Host. */
  render(input: { surface: UiSurface; view?: UiView }, context: AuthoringContext): UiRenderResult | Promise<UiRenderResult>
  dispose?(context: AuthoringContext): void | Promise<void>
}

export interface UiPlugin {
  readonly kind: 'ui'
  readonly manifest: AuthoringManifest
  render: UiPluginDefinition['render']
  dispose?: UiPluginDefinition['dispose']
}

export interface CoreDefinition extends Omit<AuthoringManifest, 'category' | 'apiVersion'> {
  /** Provisional authoring harness context; this is not the final Host ABI. */
  start(context: CoreAuthoringContext): void | Promise<void>
  stop?(context: CoreAuthoringContext): void | Promise<void>
}

/** Optional generic handoff supplied by a v2 Host; domain APIs remain Core-owned. */
export interface AuthoringLoadedComponent {
  readonly manifest: Readonly<Record<string, unknown>>
  readonly defaultExport: unknown
  readonly module?: Readonly<Record<string, unknown>>
}

export interface CorePlugin {
  readonly kind: 'core'
  readonly manifest: AuthoringManifest
  start: CoreDefinition['start']
  stop?: CoreDefinition['stop']
}

export type AuthoringPlugin = ToolPlugin | ProviderDriver | LlmSystemPlugin | SolutionPlugin | UiPlugin | CorePlugin

function manifest(definition: Omit<AuthoringManifest, 'category' | 'apiVersion'>, category: AuthoringKind): AuthoringManifest {
  if (!definition || typeof definition !== 'object') throw new TypeError('plugin definition must be an object')
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(definition.id)) throw new Error(`invalid plugin id: ${definition.id}`)
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(definition.version)) throw new Error(`invalid plugin version: ${definition.version}`)
  if (!definition.title?.trim()) throw new Error('plugin title is required')
  const value: AuthoringManifest = {
    id: definition.id,
    version: definition.version,
    title: definition.title,
    category,
    apiVersion: STAGECRAFT_AUTHORING_API,
  }
  if (definition.description !== undefined) value.description = definition.description
  if (definition.author !== undefined) value.author = definition.author
  if (definition.entry !== undefined) value.entry = Object.freeze({ desktop: definition.entry.desktop, android: definition.entry.android })
  if (definition.capabilities !== undefined) value.capabilities = Object.freeze([...definition.capabilities])
  return Object.freeze(value)
}

export function defineToolPlugin(definition: ToolPluginDefinition): ToolPlugin {
  if (typeof definition.execute !== 'function') throw new TypeError('tool execute must be a function')
  const value = { kind: 'tool' as const, manifest: manifest(definition, 'tool'), inputSchema: definition.inputSchema, outputSchema: definition.outputSchema, execute: definition.execute }
  return Object.freeze(value)
}

export function defineProviderDriver(definition: ProviderDriverDefinition): ProviderDriver {
  if (!definition.providerId?.trim()) throw new Error('providerId is required')
  if (!Array.isArray(definition.models) || definition.models.length === 0) throw new Error('provider driver must declare at least one model')
  if (typeof definition.request !== 'function') throw new TypeError('provider request must be a function')
  const value = { kind: 'provider-driver' as const, manifest: manifest(definition, 'provider-driver'), providerId: definition.providerId, models: Object.freeze([...definition.models]), request: definition.request, cancel: definition.cancel }
  return Object.freeze(value)
}

export function defineLlmSystem(definition: LlmSystemDefinition): LlmSystemPlugin {
  if (typeof definition.start !== 'function') throw new TypeError('llm-system start must be a function')
  if (typeof definition.route !== 'function') throw new TypeError('llm-system route must be a function')
  const value = { kind: 'llm-system' as const, manifest: manifest(definition, 'llm-system'), start: definition.start, stop: definition.stop, route: definition.route }
  return Object.freeze(value)
}

export function defineSolution(definition: SolutionDefinition): SolutionPlugin {
  if (typeof definition.assemblePrompt !== 'function') throw new TypeError('solution assemblePrompt must be a function')
  const value = { kind: 'solution' as const, manifest: manifest(definition, 'solution'), systemPrompt: definition.systemPrompt, assemblePrompt: definition.assemblePrompt, handleCommand: definition.handleCommand }
  return Object.freeze(value)
}

export function defineUiPlugin(definition: UiPluginDefinition): UiPlugin {
  if (typeof definition.render !== 'function') throw new TypeError('ui render must be a function')
  const value = { kind: 'ui' as const, manifest: manifest(definition, 'ui'), render: definition.render, dispose: definition.dispose }
  return Object.freeze(value)
}

export function defineCore(definition: CoreDefinition): CorePlugin {
  if (typeof definition.start !== 'function') throw new TypeError('core start must be a function')
  const value = { kind: 'core' as const, manifest: manifest(definition, 'core'), start: definition.start, stop: definition.stop }
  return Object.freeze(value)
}

/** A small authoring diagnostic that can be run by the CLI or a test without a host. */
export function inspectAuthoringPlugin(plugin: AuthoringPlugin): string[] {
  const errors: string[] = []
  if (!plugin || typeof plugin !== 'object') return ['plugin must be an object']
  if (!plugin.manifest || plugin.manifest.apiVersion !== STAGECRAFT_AUTHORING_API) errors.push(`unsupported authoring API: ${plugin?.manifest?.apiVersion ?? 'missing'}`)
  if (plugin.kind !== plugin.manifest?.category) errors.push(`kind/category mismatch: ${plugin.kind}/${plugin.manifest?.category}`)
  if (plugin.kind === 'provider-driver' && plugin.providerId === '') errors.push('providerId is empty')
  return errors
}

export interface CoreAuthoringContext extends AuthoringContext {
  readonly components?: readonly AuthoringLoadedComponent[]
  registerCommand(name: string, handler: (input: unknown) => unknown | Promise<unknown>): void
  ready(): void
}

export interface LlmSystemHarness {
  readonly status: 'ready' | 'stopped'
  listDrivers(): readonly ProviderDriver[]
  listModels(providerId?: string): readonly { providerId: string; models: readonly string[] }[]
  listCredentialProfiles(): readonly CredentialProfileMetadata[]
  upsertCredentialProfile(profile: CredentialProfileMetadata): void
  setCredentialSecret(profileId: string, secret: string | undefined): void
  hasCredentialSecret(profileId: string): boolean
  route(input: Parameters<LlmSystemPlugin['route']>[0]): Promise<LlmRouteSelection>
  complete(input: { requestId: string; messages: readonly { role: string; content: string }[]; providerId?: string; model?: string; credentialProfileId?: string; credential?: CredentialMaterial; metadata?: Readonly<Record<string, unknown>> }): AsyncIterable<ProviderChunk>
  cancel(requestId: string): Promise<void>
  recordUsage(record: LlmUsageRecord): void
  queryUsage(filter?: { providerId?: string; model?: string }): readonly LlmUsageRecord[]
  aggregateUsage(filter?: { providerId?: string; model?: string }): Readonly<{ inputTokens: number; outputTokens: number; requests: number }>
  stop(): Promise<void>
}

export interface LlmSystemHarnessOptions {
  /** Drivers supplied by the Core from selected plugin components. */
  readonly drivers?: readonly ProviderDriver[]
  /** Optional persistence for credential profiles, usage and secrets. */
  readonly store?: LlmHarnessStore
}

/** In-memory authoring harness exercising the complete LLM System/Driver boundary. */
export async function createAuthoringLlmSystemHarness(plugin: LlmSystemPlugin, config: Readonly<Record<string, unknown>> = {}, options: LlmSystemHarnessOptions = {}): Promise<LlmSystemHarness> {
  const drivers = new Map<string, ProviderDriver>(); const profiles = new Map<string, CredentialProfileMetadata>(); const usage: LlmUsageRecord[] = []; const secrets = new Map<string, string>(); const active = new Map<string, { controller: AbortController; driver: ProviderDriver }>(); let stopped = false
  const snapshot = (): LlmHarnessSnapshot => Object.freeze({ credentialProfiles: Object.freeze([...profiles.values()].map(profile => ({ ...profile }))), usage: Object.freeze(usage.map(record => ({ ...record }))), secrets: Object.freeze(Object.fromEntries(secrets)) })
  // Best-effort persistence: writes are serialized per harness and never break
  // plugin start(), profile upserts or the chunk stream.
  let writeChain: Promise<void> = Promise.resolve()
  const persist = (): void => { if (!options.store) return; const state = snapshot(); writeChain = writeChain.then(() => options.store!.write(state)).catch(() => undefined) }
  const store = options.store
  if (store) {
    const restored = await store.read().catch(() => undefined)
    if (restored) {
      for (const profile of restored.credentialProfiles ?? []) profiles.set(profile.id, Object.freeze({ ...profile }))
      for (const record of restored.usage ?? []) usage.push(Object.freeze({ ...record }))
      for (const [profileId, secret] of Object.entries(restored.secrets ?? {})) secrets.set(profileId, secret)
    }
  }
  const context: LlmSystemAuthoringContext = {
    apiVersion: STAGECRAFT_AUTHORING_API, pluginId: plugin.manifest.id, config, log() {},
    registerDriver(driver) { if (driver.kind !== 'provider-driver') throw new TypeError('only provider drivers may be registered'); if (drivers.has(driver.providerId)) throw new Error(`duplicate provider driver: ${driver.providerId}`); drivers.set(driver.providerId, driver) },
    listDrivers: () => Object.freeze([...drivers.values()]),
    listModels: providerId => Object.freeze([...drivers.values()].filter(d => !providerId || d.providerId === providerId).map(d => Object.freeze({ providerId: d.providerId, models: Object.freeze([...d.models]) }))),
    upsertCredentialProfile(profile) { if (!profile?.id || !profile.providerId) throw new Error('credential profile id and providerId are required'); const existing = profiles.get(profile.id); profiles.set(profile.id, Object.freeze({ ...existing, ...profile })); persist() },
    listCredentialProfiles: () => Object.freeze([...profiles.values()]),
  }
  for (const driver of options.drivers ?? []) context.registerDriver(driver)
  await plugin.start(context); let status: 'ready' | 'stopped' = 'ready'
  const route = async input => { if (stopped) throw new Error('llm-system is stopped'); const selected = await plugin.route(input, context); if (!selected?.providerId || !selected.model) throw new Error('llm-system route must select providerId and model'); const driver = drivers.get(selected.providerId); if (!driver) throw new Error(`no provider driver registered for ${selected.providerId}`); if (!driver.models.includes(selected.model)) throw new Error(`driver ${selected.providerId} does not provide model ${selected.model}`); if (selected.credentialProfileId) { const profile = profiles.get(selected.credentialProfileId); if (!profile) throw new Error(`unknown credential profile: ${selected.credentialProfileId}`); if (profile.providerId !== selected.providerId) throw new Error(`credential profile ${selected.credentialProfileId} belongs to ${profile.providerId}`) } return Object.freeze({ ...selected }) }
  const complete = (input: { requestId: string; messages: readonly { role: string; content: string }[]; providerId?: string; model?: string; credentialProfileId?: string; credential?: CredentialMaterial; metadata?: Readonly<Record<string, unknown>> }): AsyncIterable<ProviderChunk> => {
    if (active.has(input.requestId)) throw new Error(`requestId already active: ${input.requestId}`)
    const iterator = (async function* () { const selected = await route({ providerId: input.providerId, model: input.model, credentialProfileId: input.credentialProfileId, metadata: input.metadata }); const driver = drivers.get(selected.providerId)!; if (input.credential && input.credential.profileId !== selected.credentialProfileId) throw new Error('credential material does not match selected profile'); const storedSecret = selected.credentialProfileId ? secrets.get(selected.credentialProfileId) : undefined; const credential = input.credential ?? (storedSecret !== undefined ? { profileId: selected.credentialProfileId!, secret: storedSecret } : undefined); const controller = new AbortController(); active.set(input.requestId, { controller, driver }); try { for await (const chunk of driver.request({ requestId: input.requestId, providerId: selected.providerId, model: selected.model, credentialProfileId: selected.credentialProfileId, credential, messages: input.messages, signal: controller.signal, metadata: input.metadata }, context)) { if (controller.signal.aborted) break; yield chunk; if (chunk.type === 'usage' && chunk.usage) { usage.push(Object.freeze({ requestId: input.requestId, providerId: selected.providerId, model: selected.model, ...chunk.usage, timestamp: new Date().toISOString() })); persist() } } } finally { active.delete(input.requestId) } })(); return iterator
  }
  return { get status() { return status }, listDrivers: context.listDrivers, listModels: context.listModels, listCredentialProfiles: context.listCredentialProfiles, upsertCredentialProfile: context.upsertCredentialProfile, setCredentialSecret(profileId, secret) { if (!profiles.has(profileId)) throw new Error(`unknown credential profile: ${profileId}`); if (secret === undefined) secrets.delete(profileId); else secrets.set(profileId, secret); persist() }, hasCredentialSecret: profileId => secrets.has(profileId), route, complete, async cancel(requestId) { const current = active.get(requestId); if (!current) return; current.controller.abort(); await current.driver.cancel?.(requestId, context) }, recordUsage(record) { usage.push(Object.freeze({ ...record })); persist() }, queryUsage(filter = {}) { return Object.freeze(usage.filter(r => (!filter.providerId || r.providerId === filter.providerId) && (!filter.model || r.model === filter.model))) }, aggregateUsage(filter = {}) { const rows = usage.filter(r => (!filter.providerId || r.providerId === filter.providerId) && (!filter.model || r.model === filter.model)); return Object.freeze({ inputTokens: rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0), outputTokens: rows.reduce((n, r) => n + (r.outputTokens ?? 0), 0), requests: new Set(rows.map(r => r.requestId)).size }) }, async stop() {
    if (stopped) return
    stopped = true
    const errors: unknown[] = []
    // Each cleanup phase is best effort, but all phases run. In particular a
    // failing cancel or plugin.stop must not skip the persistence flush.
    for (const requestId of [...active.keys()]) {
      try { await this.cancel(requestId) } catch (error) { errors.push(error) }
    }
    try { await plugin.stop?.(context) } catch (error) { errors.push(error) }
    try {
      // A persistence write is intentionally queued by each mutation. Do not
      // report a clean stop until every queued snapshot has reached the store.
      await writeChain
    } catch (error) { errors.push(error) }
    status = 'stopped'
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'one or more LLM harness stop operations failed')
  } }
}

export interface AuthoringCoreHarness {
  readonly status: 'ready'
  dispatch(name: string, input?: unknown): Promise<unknown>
  stop(): Promise<void>
}

/**
 * Tiny test harness for Core templates. It supplies only authoring conveniences
 * and deliberately does not claim to model the Host ABI.
 */
export async function createAuthoringCoreHarness(plugin: CorePlugin): Promise<AuthoringCoreHarness> {
  const commands = new Map<string, (input: unknown) => unknown | Promise<unknown>>()
  let isReady = false
  const context: CoreAuthoringContext = {
    apiVersion: STAGECRAFT_AUTHORING_API,
    pluginId: plugin.manifest.id,
    config: {},
    log() {},
    registerCommand(name, handler) {
      if (!name.trim() || typeof handler !== 'function') throw new Error('core command name and handler are required')
      if (commands.has(name)) throw new Error(`duplicate core command: ${name}`)
      commands.set(name, handler)
    },
    ready() { isReady = true },
  }
  await plugin.start(context)
  if (!isReady) throw new Error('core did not call context.ready()')
  return {
    status: 'ready',
    async dispatch(name, input) {
      const handler = commands.get(name)
      if (!handler) throw new Error(`unknown core command: ${name}`)
      return handler(input)
    },
    async stop() { if (plugin.stop) await plugin.stop(context) },
  }
}
