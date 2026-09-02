/**
 * Optional, deliberately small runtime for Cores using the StageCraft authoring
 * SDK.  This is a convenience implementation, not part of the Host-Core ABI.
 */
import type { ComponentManifest, ComponentSelection } from './component-contract.ts'
import type { CoreBootContext, HostCoreEntry, LoadedCoreComponent } from './host-core-abi.ts'
import { validateLlmSystemService, type AuthoringContext, type AuthoringPlugin, type CorePlugin, type LlmSystemService, type LlmSystemStartContext, type LlmSystemPlugin, type ProviderDriver, type SolutionPlugin, type ToolPlugin, type UiPlugin, type UiSurface, type UiView } from '../sdk/authoring.ts'
import type { OfficialCorePluginApi, OfficialCorePluginDescriptor } from './official-core-plugin-api.ts'

type AnyPlugin = AuthoringPlugin & { kind: string }

const KIND_BY_CATEGORY: Record<string, string> = {
  'llm-system': 'llm-system', 'provider-driver': 'provider-driver', solution: 'solution',
  tool: 'tool', effect: 'tool', ui: 'ui', composite: 'composite', core: 'core',
}

function fail(message: string): never { throw new Error(message) }

function validateIdentity(component: LoadedCoreComponent): AnyPlugin {
  const manifest = component.manifest
  const plugin = component.defaultExport as AnyPlugin | undefined
  if (!plugin || typeof plugin !== 'object' || typeof plugin.kind !== 'string') fail(`component ${manifest.id}@${manifest.version} default export is not an authoring plugin`)
  const authoring = plugin.manifest
  if (!authoring || authoring.id !== manifest.id || authoring.version !== manifest.version) fail(`component identity mismatch: ${manifest.id}@${manifest.version}`)
  const expected = manifest.componentType === 'core' ? 'core' : KIND_BY_CATEGORY[manifest.pluginCategory ?? '']
  if (plugin.kind !== expected || authoring.category !== expected) fail(`component category mismatch: ${manifest.id} expected ${expected}, got ${plugin.kind}/${authoring.category}`)
  return plugin
}

function selectionKey(selection: ComponentSelection): string { return `${selection.id}@${selection.version}` }

/** Once a component is quarantined, isolate every selected component with a
 * required edge to it as well. Repeat to reach the complete transitive
 * dependent closure (optional edges intentionally do not propagate failure). */
function quarantineRequiredDependents(components: readonly LoadedCoreComponent[], quarantined: Map<string, string>): void {
  let changed = true
  while (changed) {
    changed = false
    for (const component of components) {
      const key = `${component.manifest.id}@${component.manifest.version}`
      if (quarantined.has(key)) continue
      const dependency = (component.manifest.dependencies ?? []).find(dep => !dep.optional && quarantined.has(`${dep.id}@${dep.version}`))
      if (!dependency) continue
      const dependencyKey = `${dependency.id}@${dependency.version}`
      quarantined.set(key, `required dependency ${dependencyKey} is quarantined: ${quarantined.get(dependencyKey)}`)
      changed = true
    }
  }
}

/** Dependency-ordered load with plugin-level isolation: a component whose
 * dependency chain fails is quarantined with a reason instead of failing the
 * whole boot. The Core itself is validated separately by the caller. */
function orderComponents(components: readonly LoadedCoreComponent[], selected: readonly ComponentSelection[]): { ordered: LoadedCoreComponent[]; quarantined: Map<string, string> } {
  const byKey = new Map(components.map(component => [selectionKey({ id: component.manifest.id, version: component.manifest.version, manifestHash: '' }), component]))
  const requested = new Map(selected.map(selection => [selectionKey(selection), selection]))
  const ordered: LoadedCoreComponent[] = []; const quarantined = new Map<string, string>(); const visiting = new Set<string>(); const visited = new Set<string>()
  const visit = (component: LoadedCoreComponent) => {
    const key = `${component.manifest.id}@${component.manifest.version}`
    if (visited.has(key)) return
    if (visiting.has(key)) fail(`component dependency cycle at ${key}`)
    visiting.add(key)
    try {
      for (const dependency of [...(component.manifest.dependencies ?? [])].sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version))) {
        const depKey = `${dependency.id}@${dependency.version}`; const dep = byKey.get(depKey)
        if (!dep) { if (!dependency.optional) fail(`missing required component dependency: ${depKey}`); continue }
        visit(dep)
      }
      visiting.delete(key); visited.add(key); ordered.push(component)
    } catch (error) { visiting.delete(key); throw error }
  }
  for (const selection of [...selected].sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version))) {
    const key = selectionKey(selection)
    const component = byKey.get(key)
    if (!component) { quarantined.set(key, 'selected component is not loaded'); requested.delete(key); continue }
    try { visit(component); requested.delete(key) } catch (error) { quarantined.set(key, error instanceof Error ? error.message : String(error)) }
  }
  // Selected components that never reached a complete visit (cycle members or
  // dependents of a quarantined dependency) are quarantined as well.
  for (const [key, selection] of requested) quarantined.set(key, quarantined.get(key) ?? `dependency chain failed for ${selection.id}@${selection.version}`)
  return { ordered, quarantined }
}

function makeAuthoringContext(manifest: { id: string; version: string }, config: Readonly<Record<string, unknown>>, host: CoreBootContext['host']): AuthoringContext {
  return { apiVersion: '0.1', pluginId: manifest.id, config, log: (level, message, details) => { void host.call('host.log', { level, message, details }, { pluginId: manifest.id, version: manifest.version }).catch(() => {}) } }
}

async function readHostArea(host: CoreBootContext['host'], caller: { pluginId: string; version: string }, area: string): Promise<unknown | undefined> {
  const result = await host.call('host.storage.read', { area }, caller) as { value?: unknown } | undefined
  return result?.value === null || result?.value === undefined ? undefined : result.value
}

export interface OfficialCoreRuntimeOptions {
  readonly config?: Readonly<Record<string, unknown>>
}

export interface OfficialCorePluginQuarantine {
  readonly id: string
  readonly version: string
  readonly reason: string
}

export interface OfficialCoreRuntime extends HostCoreEntry, OfficialCorePluginApi {
  readonly status: 'pending' | 'ready' | 'stopped' | 'failed'
  /** Ordinary plugins excluded during boot, with the isolation reason. */
  listQuarantined(): readonly OfficialCorePluginQuarantine[]
}

/** Creates an authoring-SDK Core entry that can be passed directly to HostCoreSession.boot. */
export function createOfficialCoreRuntime(coreComponent: LoadedCoreComponent, options: OfficialCoreRuntimeOptions = {}): OfficialCoreRuntime {
  let bootContext: CoreBootContext | undefined
  let core: CorePlugin | undefined
  let coreCommands = new Map<string, (input: unknown) => unknown | Promise<unknown>>()
  let loaded: LoadedCoreComponent[] = []; let pluginValues = new Map<string, AnyPlugin>(); let active = new Set<string>(); let disposedUi = new Set<string>(); let llm = new Map<string, LlmSystemService>(); let stopped = false; let coreStarted = false; let state: OfficialCoreRuntime['status'] = 'pending'; const quarantinedPlugins: { id: string; version: string; reason: string }[] = []
  /** options.config merged with the persisted core config area once boot loads it. */
  let resolvedConfig: Record<string, unknown> = { ...(options.config ?? {}) }
  const descriptors = () => loaded.filter(c => active.has(selectionKey({ id: c.manifest.id, version: c.manifest.version, manifestHash: '' }))).map(c => ({ id: c.manifest.id, version: c.manifest.version, pluginCategory: c.manifest.pluginCategory! as OfficialCorePluginDescriptor['pluginCategory'] }))
  const api: OfficialCoreRuntime = {
    profile: 'stagecraft.core-plugin/0.1', get status() { return state },
    listPlugins: () => Object.freeze(descriptors()),
    listQuarantined: () => Object.freeze([...quarantinedPlugins.map(entry => ({ ...entry }))]),
    async loadPlugin(descriptor) { const key = `${descriptor.id}@${descriptor.version}`; const component = loaded.find(c => `${c.manifest.id}@${c.manifest.version}` === key); if (!component || component.manifest.componentType !== 'plugin') fail(`plugin is not selected: ${key}`); active.add(key) },
    async unloadPlugin(id) { const keys = [...active].filter(key => key === id || key.startsWith(`${id}@`)); const errors: unknown[] = []; for (const key of keys.reverse()) { const plugin = pluginValues.get(key); try { if (plugin?.kind === 'llm-system') { await llm.get(key)?.stop(); llm.delete(key) }; if (plugin?.kind === 'ui' && !disposedUi.has(key)) { await (plugin as UiPlugin).dispose?.(makeAuthoringContext(plugin.manifest, resolvedConfig, bootContext!.host)); disposedUi.add(key) } } catch (error) { errors.push(error) } active.delete(key) } if (errors.length) throw new AggregateError(errors, `failed to unload plugin ${id}`) },
    async boot(context) {
      if (state !== 'pending') fail(`official Core boot is only valid from pending (state=${state})`)
      bootContext = context
      try {
        if (coreComponent.manifest.id !== context.request.selectedCore.id || coreComponent.manifest.version !== context.request.selectedCore.version) fail(`selected Core identity mismatch: expected ${context.request.selectedCore.id}@${context.request.selectedCore.version}, got ${coreComponent.manifest.id}@${coreComponent.manifest.version}`)
        const coreIdentity = { pluginId: coreComponent.manifest.id, version: coreComponent.manifest.version }
        const persistedConfig = await readHostArea(context.host, coreIdentity, 'config').catch(() => undefined)
        if (persistedConfig && typeof persistedConfig === 'object' && !Array.isArray(persistedConfig)) resolvedConfig = { ...(options.config ?? {}), ...(persistedConfig as Record<string, unknown>) }
        core = validateIdentity(coreComponent) as CorePlugin
        const selected = context.request.pluginSelections
        const { ordered, quarantined: chainFailures } = orderComponents(context.components, selected)
        const quarantined = new Map(chainFailures)
        pluginValues = new Map()
        for (const component of ordered) {
          const key = `${component.manifest.id}@${component.manifest.version}`
          try { pluginValues.set(key, validateIdentity(component)) } catch (error) { quarantined.set(key, error instanceof Error ? error.message : String(error)) }
        }
        quarantineRequiredDependents(ordered, quarantined)
        const drivers = [...pluginValues.entries()].filter(([key, p]) => !quarantined.has(key) && p?.kind === 'provider-driver').map(([, p]) => p as ProviderDriver)
        for (const component of ordered) {
          const key = `${component.manifest.id}@${component.manifest.version}`
          const plugin = pluginValues.get(key)
          if (!plugin || quarantined.has(key)) continue
          if (plugin.kind === 'llm-system') {
            try {
              const caller = { pluginId: plugin.manifest.id, version: plugin.manifest.version }
              const startContext: LlmSystemStartContext = {
                ...makeAuthoringContext(plugin.manifest, resolvedConfig, context.host),
                drivers: Object.freeze([...drivers]),
                state: { read: async key => (await context.host.call('host.storage.read', { area: key }, caller) as { value?: unknown } | undefined)?.value, write: async (key, value) => { await context.host.call('host.storage.write', { area: key, value }, caller) }, delete: async key => { await context.host.call('host.storage.write', { area: key, value: undefined }, caller) } },
              }
              const service = validateLlmSystemService(await plugin.start(startContext), true)
              llm.set(key, service)
            }
            catch (error) { quarantined.set(key, `llm system init failed: ${error instanceof Error ? error.message : String(error)}`); continue }
          }
        }
        quarantineRequiredDependents(ordered, quarantined)
        loaded = ordered.filter(component => !quarantined.has(`${component.manifest.id}@${component.manifest.version}`))
        // Only the final viable set is reachable through the official API or
        // the Core handoff. This also prevents a dependency's failed LLM
        // initialization from leaving its dependents addressable.
        for (const component of loaded) {
          const key = `${component.manifest.id}@${component.manifest.version}`
          active.add(key)
        }
        quarantinedPlugins.splice(0, quarantinedPlugins.length, ...[...quarantined].map(([key, reason]) => { const separator = key.lastIndexOf('@'); return { id: key.slice(0, separator), version: key.slice(separator + 1), reason } }))
        let innerReady = false
        const authoringContext = { ...contextForCore(context, () => { if (innerReady) fail('Core ready() called more than once'); innerReady = true }), components: loaded.map(c => ({ manifest: c.manifest as unknown as Readonly<Record<string, unknown>>, defaultExport: c.defaultExport, module: c.module })), llmSystems: Object.freeze([...llm.entries()].filter(([key]) => active.has(key)).map(([key, service]) => ({ id: key.slice(0, key.lastIndexOf('@')), service }))) }
        coreStarted = true
        await core.start(authoringContext)
        if (!innerReady) fail('official Core did not call ready()')
        context.ready(); state = 'ready'
      } catch (error) { state = 'failed'; try { await api.shutdown() } catch {} ; context.failed('official_core_boot_error', error instanceof Error ? error.message : String(error)); throw error }
    },
    async *stream(operation, input) {
      const value = (input as Record<string, any>) ?? {}
      if (state !== 'ready') return yield* (async function* () { fail(`official Core stream unavailable (state=${state})`) })()
      if (operation === 'llm/stream') return yield* selectLlm(value.llmSystemId).complete({ requestId: String(value.requestId), messages: value.messages ?? [], providerId: value.providerId, model: value.model, credentialProfileId: value.credentialProfileId, credential: value.credential, metadata: value.metadata })
      return yield* (async function* () { fail(`official Core does not stream operation: ${operation}`) })()
    },
    async invoke(operation, input) {
      if (state !== 'ready') fail(`official Core invoke unavailable (state=${state})`)
      const value = input as Record<string, any> ?? {}
      if (operation === 'plugins/list') return api.listPlugins()
      if (operation === 'plugins/status') return { plugins: api.listPlugins(), quarantined: api.listQuarantined() }
      if (operation === 'solution/assemble') { const solution = select<SolutionPlugin>('solution', value.solutionId); const assembled = await solution.assemblePrompt({ user: String(value.user ?? ''), state: value.state, history: value.history }, makeAuthoringContext(solution.manifest, resolvedConfig, bootContext!.host)); const messages = [...(solution.systemPrompt ? [{ role: 'system', content: solution.systemPrompt }] : []), { role: 'user', content: assembled }]; return { systemPrompt: solution.systemPrompt, assembled, messages } }
      if (operation === 'solution/command') { const solution = select<SolutionPlugin>('solution', value.solutionId); if (!solution.handleCommand) fail(`solution ${solution.manifest.id} has no command handler`); return solution.handleCommand(value.command, makeAuthoringContext(solution.manifest, resolvedConfig, bootContext!.host)) }
      if (operation === 'llm/complete' || operation === 'llm/stream') { const service = selectLlm(value.llmSystemId); const chunks = []; for await (const chunk of service.complete({ requestId: String(value.requestId), messages: value.messages ?? [], providerId: value.providerId, model: value.model, credentialProfileId: value.credentialProfileId, credential: value.credential, metadata: value.metadata })) chunks.push(chunk); return chunks }
      if (operation === 'llm/cancel') { await selectLlm(value.llmSystemId).cancel(String(value.requestId)); return { ok: true } }
      if (operation === 'llm/usage/query') return selectLlm(value.llmSystemId).queryUsage(value.filter)
      if (operation === 'llm/usage/aggregate') return selectLlm(value.llmSystemId).aggregateUsage(value.filter)
      if (operation === 'llm/credential/set') { const service = selectLlm(value.llmSystemId); await service.setCredentialSecret(String(value.profileId), value.secret === undefined || value.secret === null ? undefined : String(value.secret)); return { ok: true } }
      if (operation === 'llm/credential/list') { const service = selectLlm(value.llmSystemId); const profiles = service.listCredentialProfiles(); return Promise.all(profiles.map(async profile => ({ ...profile, hasSecret: await service.hasCredentialSecret(profile.id) }))) }
      if (operation === 'config/get') return { ...resolvedConfig }
      if (operation === 'config/update') { const patch = value as Record<string, unknown>; if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('config/update input must be an object'); Object.assign(resolvedConfig, patch); const coreCaller = { pluginId: coreComponent.manifest.id, version: coreComponent.manifest.version }; await bootContext!.host.call('host.storage.write', { area: 'config', value: { ...resolvedConfig } }, coreCaller); return { ...resolvedConfig } }
      if (operation === 'tool/execute') { const tool = select<ToolPlugin>('tool', value.toolId); return tool.execute(value.input, { ...makeAuthoringContext(tool.manifest, resolvedConfig, bootContext!.host), signal: value.signal }) }
      if (operation === 'ui/render') { const ui = select<UiPlugin>('ui', value.uiId); const surface = value.surface as UiSurface; return ui.render({ surface, view: value.view as UiView | undefined }, makeAuthoringContext(ui.manifest, resolvedConfig, bootContext!.host)) }
      if (operation === 'ui/dispose') { const ui = select<UiPlugin>('ui', value.uiId); const key = `${ui.manifest.id}@${ui.manifest.version}`; if (!disposedUi.has(key)) { await ui.dispose?.(makeAuthoringContext(ui.manifest, resolvedConfig, bootContext!.host)); disposedUi.add(key) }; return { ok: true } }
      if (operation === 'core/command') { const command = coreCommands.get(String(value.name)); if (!command) fail(`unknown Core command: ${value.name}`); return command(value.input) }
      // M2 authoring Core commands are also exposed as direct operations by
      // the desktop v2 compatibility surface.
      const directCommand = coreCommands.get(operation); if (directCommand) return directCommand(value)
      fail(`unknown official Core operation: ${operation}`)
    },
    async shutdown() {
      if (stopped) return; stopped = true
      const errors: unknown[] = []
      for (const key of [...active].reverse()) { const plugin = pluginValues.get(key); try { if (plugin?.kind === 'llm-system') { await llm.get(key)?.stop(); llm.delete(key) }; if (plugin?.kind === 'ui' && !disposedUi.has(key)) { await (plugin as UiPlugin).dispose?.(makeAuthoringContext(plugin.manifest, resolvedConfig, bootContext!.host)); disposedUi.add(key) } } catch (e) { errors.push(e) } active.delete(key) }
      llm.clear(); try { if (coreStarted) await core?.stop?.(contextForCore(bootContext!)) } catch (e) { errors.push(e) }
      state = 'stopped'; if (errors.length) throw new AggregateError(errors, 'one or more official Core plugins failed to stop')
    },
  }
  function select<T extends AnyPlugin>(kind: string, id: string | undefined): T { const matches = [...pluginValues.entries()].filter(([key, p]) => active.has(key) && p.kind === kind).map(([, p]) => p); if (id) { const value = matches.find(p => p.manifest.id === id || `${p.manifest.id}@${p.manifest.version}` === id); if (!value) fail(`no ${kind} plugin selected: ${id}`); return value as T }; if (matches.length !== 1) fail(`${kind} selection is required when ${matches.length} plugins are available`); return matches[0] as T }
  function selectLlm(id: string | undefined): LlmSystemService { const p = select<LlmSystemPlugin>('llm-system', id); const service = llm.get(`${p.manifest.id}@${p.manifest.version}`); if (!service) fail(`llm-system ${p.manifest.id} is not initialized`); return service }
  function contextForCore(c: CoreBootContext, ready: () => void = () => {}): any { const coreManifest = { id: core?.manifest.id ?? c.request.selectedCore.id, version: core?.manifest.version ?? c.request.selectedCore.version }; return { apiVersion: '0.1', pluginId: coreManifest.id, config: resolvedConfig, log(level: string, message: string, details?: unknown) { void c.host.call('host.log', { level, message, details }, { pluginId: coreManifest.id, version: coreManifest.version }).catch(() => {}) }, registerCommand(name: string, handler: any) { if (coreCommands.has(name)) fail(`duplicate core command: ${name}`); coreCommands.set(name, handler) }, ready } }
  return api
}
