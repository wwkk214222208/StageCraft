/**
 * Optional, deliberately small runtime for Cores using the StageCraft authoring
 * SDK.  This is a convenience implementation, not part of the Host-Core ABI.
 */
import type { ComponentManifest, ComponentSelection } from './component-contract.ts'
import type { CoreBootContext, HostCoreEntry, LoadedCoreComponent } from './host-core-abi.ts'
import { createAuthoringLlmSystemHarness, type AuthoringContext, type AuthoringPlugin, type CorePlugin, type LlmSystemHarness, type LlmSystemPlugin, type ProviderDriver, type SolutionPlugin, type ToolPlugin, type UiPlugin, type UiSurface, type UiView } from '../sdk/authoring.ts'
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

function orderComponents(components: readonly LoadedCoreComponent[], selected: readonly ComponentSelection[]): LoadedCoreComponent[] {
  const byKey = new Map(components.map(component => [selectionKey({ id: component.manifest.id, version: component.manifest.version, manifestHash: '' }), component]))
  const requested = new Map(selected.map(selection => [selectionKey(selection), selection]))
  const ordered: LoadedCoreComponent[] = []; const visiting = new Set<string>(); const visited = new Set<string>()
  const visit = (component: LoadedCoreComponent) => {
    const key = `${component.manifest.id}@${component.manifest.version}`
    if (visited.has(key)) return
    if (visiting.has(key)) fail(`component dependency cycle at ${key}`)
    visiting.add(key)
    for (const dependency of [...(component.manifest.dependencies ?? [])].sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version))) {
      const depKey = `${dependency.id}@${dependency.version}`; const dep = byKey.get(depKey)
      if (!dep) { if (!dependency.optional) fail(`missing required component dependency: ${depKey}`); continue }
      visit(dep)
    }
    visiting.delete(key); visited.add(key); ordered.push(component)
  }
  for (const selection of [...selected].sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version))) {
    const component = byKey.get(selectionKey(selection))
    if (!component) fail(`selected component is not loaded: ${selectionKey(selection)}`)
    visit(component)
    requested.delete(selectionKey(selection))
  }
  return ordered
}

function context(pluginId: string, config: Readonly<Record<string, unknown>>, host: CoreBootContext['host']): AuthoringContext {
  return { apiVersion: '0.1', pluginId, config, log: (level, message, details) => { void host.call('host.log', { level, message, details }).catch(() => {}) } }
}

export interface OfficialCoreRuntimeOptions {
  readonly config?: Readonly<Record<string, unknown>>
}

export interface OfficialCoreRuntime extends HostCoreEntry, OfficialCorePluginApi {
  readonly status: 'pending' | 'ready' | 'stopped' | 'failed'
}

/** Creates an authoring-SDK Core entry that can be passed directly to HostCoreSession.boot. */
export function createOfficialCoreRuntime(coreComponent: LoadedCoreComponent, options: OfficialCoreRuntimeOptions = {}): OfficialCoreRuntime {
  let bootContext: CoreBootContext | undefined
  let core: CorePlugin | undefined
  let coreCommands = new Map<string, (input: unknown) => unknown | Promise<unknown>>()
  let loaded: LoadedCoreComponent[] = []; let pluginValues = new Map<string, AnyPlugin>(); let active = new Set<string>(); let disposedUi = new Set<string>(); let llm = new Map<string, LlmSystemHarness>(); let stopped = false; let coreStarted = false; let state: OfficialCoreRuntime['status'] = 'pending'
  const descriptors = () => loaded.filter(c => active.has(selectionKey({ id: c.manifest.id, version: c.manifest.version, manifestHash: '' }))).map(c => ({ id: c.manifest.id, version: c.manifest.version, pluginCategory: c.manifest.pluginCategory! as OfficialCorePluginDescriptor['pluginCategory'] }))
  const api: OfficialCoreRuntime = {
    profile: 'stagecraft.core-plugin/0.1', get status() { return state },
    listPlugins: () => Object.freeze(descriptors()),
    async loadPlugin(descriptor) { const key = `${descriptor.id}@${descriptor.version}`; const component = loaded.find(c => `${c.manifest.id}@${c.manifest.version}` === key); if (!component || component.manifest.componentType !== 'plugin') fail(`plugin is not selected: ${key}`); active.add(key) },
    async unloadPlugin(id) { const keys = [...active].filter(key => key === id || key.startsWith(`${id}@`)); const errors: unknown[] = []; for (const key of keys.reverse()) { const plugin = pluginValues.get(key); try { if (plugin?.kind === 'llm-system') { await llm.get(key)?.stop(); llm.delete(key) }; if (plugin?.kind === 'ui' && !disposedUi.has(key)) { await (plugin as UiPlugin).dispose?.(context(plugin.manifest.id, options.config ?? {}, bootContext!.host)); disposedUi.add(key) } } catch (error) { errors.push(error) } active.delete(key) } if (errors.length) throw new AggregateError(errors, `failed to unload plugin ${id}`) },
    async boot(context) {
      if (state !== 'pending') fail(`official Core boot is only valid from pending (state=${state})`)
      bootContext = context
      try {
        if (coreComponent.manifest.id !== context.request.selectedCore.id || coreComponent.manifest.version !== context.request.selectedCore.version) fail(`selected Core identity mismatch: expected ${context.request.selectedCore.id}@${context.request.selectedCore.version}, got ${coreComponent.manifest.id}@${coreComponent.manifest.version}`)
        core = validateIdentity(coreComponent) as CorePlugin
        const selected = context.request.pluginSelections
        const ordered = orderComponents(context.components, selected)
        loaded = ordered; for (const component of ordered) pluginValues.set(`${component.manifest.id}@${component.manifest.version}`, validateIdentity(component))
        const drivers = ordered.map(c => pluginValues.get(`${c.manifest.id}@${c.manifest.version}`)).filter((p): p is ProviderDriver => p?.kind === 'provider-driver')
        for (const component of ordered) {
          const plugin = pluginValues.get(`${component.manifest.id}@${component.manifest.version}`)!
          if (plugin.kind === 'llm-system') llm.set(`${component.manifest.id}@${component.manifest.version}`, await createAuthoringLlmSystemHarness(plugin as LlmSystemPlugin, options.config ?? {}, { drivers }))
          await api.loadPlugin({ id: component.manifest.id, version: component.manifest.version, pluginCategory: component.manifest.pluginCategory! as OfficialCorePluginDescriptor['pluginCategory'] })
        }
        let innerReady = false
        const authoringContext = { ...contextForCore(context, () => { if (innerReady) fail('Core ready() called more than once'); innerReady = true }), components: context.components.map(c => ({ manifest: c.manifest as unknown as Readonly<Record<string, unknown>>, defaultExport: c.defaultExport, module: c.module })) }
        coreStarted = true
        await core.start(authoringContext)
        if (!innerReady) fail('official Core did not call ready()')
        context.ready(); state = 'ready'
      } catch (error) { state = 'failed'; try { await api.shutdown() } catch {} ; context.failed('official_core_boot_error', error instanceof Error ? error.message : String(error)); throw error }
    },
    async invoke(operation, input) {
      if (state !== 'ready') fail(`official Core invoke unavailable (state=${state})`)
      const value = input as Record<string, any> ?? {}
      if (operation === 'plugins/list' || operation === 'plugins/status') return api.listPlugins()
      if (operation === 'solution/assemble') { const solution = select<SolutionPlugin>('solution', value.solutionId); const assembled = await solution.assemblePrompt({ user: String(value.user ?? ''), state: value.state, history: value.history }, context(solution.manifest.id, options.config ?? {}, bootContext!.host)); const messages = [...(solution.systemPrompt ? [{ role: 'system', content: solution.systemPrompt }] : []), { role: 'user', content: assembled }]; return { systemPrompt: solution.systemPrompt, assembled, messages } }
      if (operation === 'solution/command') { const solution = select<SolutionPlugin>('solution', value.solutionId); if (!solution.handleCommand) fail(`solution ${solution.manifest.id} has no command handler`); return solution.handleCommand(value.command, context(solution.manifest.id, options.config ?? {}, bootContext!.host)) }
      if (operation === 'llm/complete' || operation === 'llm/stream') { const harness = selectLlm(value.llmSystemId); const chunks = []; for await (const chunk of harness.complete({ requestId: String(value.requestId), messages: value.messages ?? [], providerId: value.providerId, model: value.model, credentialProfileId: value.credentialProfileId, credential: value.credential, metadata: value.metadata })) chunks.push(chunk); return chunks }
      if (operation === 'llm/cancel') { await selectLlm(value.llmSystemId).cancel(String(value.requestId)); return { ok: true } }
      if (operation === 'llm/usage/query') return selectLlm(value.llmSystemId).queryUsage(value.filter)
      if (operation === 'llm/usage/aggregate') return selectLlm(value.llmSystemId).aggregateUsage(value.filter)
      if (operation === 'tool/execute') { const tool = select<ToolPlugin>('tool', value.toolId); return tool.execute(value.input, { ...context(tool.manifest.id, options.config ?? {}, bootContext!.host), signal: value.signal }) }
      if (operation === 'ui/render') { const ui = select<UiPlugin>('ui', value.uiId); const surface = value.surface as UiSurface; return ui.render({ surface, view: value.view as UiView | undefined }, context(ui.manifest.id, options.config ?? {}, bootContext!.host)) }
      if (operation === 'ui/dispose') { const ui = select<UiPlugin>('ui', value.uiId); const key = `${ui.manifest.id}@${ui.manifest.version}`; if (!disposedUi.has(key)) { await ui.dispose?.(context(ui.manifest.id, options.config ?? {}, bootContext!.host)); disposedUi.add(key) }; return { ok: true } }
      if (operation === 'core/command') { const command = coreCommands.get(String(value.name)); if (!command) fail(`unknown Core command: ${value.name}`); return command(value.input) }
      fail(`unknown official Core operation: ${operation}`)
    },
    async shutdown() {
      if (stopped) return; stopped = true
      const errors: unknown[] = []
      for (const key of [...active].reverse()) { const plugin = pluginValues.get(key); try { if (plugin?.kind === 'llm-system') { await llm.get(key)?.stop(); llm.delete(key) }; if (plugin?.kind === 'ui' && !disposedUi.has(key)) { await (plugin as UiPlugin).dispose?.(context(plugin.manifest.id, options.config ?? {}, bootContext!.host)); disposedUi.add(key) } } catch (e) { errors.push(e) } active.delete(key) }
      llm.clear(); try { if (coreStarted) await core?.stop?.(contextForCore(bootContext!)) } catch (e) { errors.push(e) }
      state = 'stopped'; if (errors.length) throw new AggregateError(errors, 'one or more official Core plugins failed to stop')
    },
  }
  function select<T extends AnyPlugin>(kind: string, id: string | undefined): T { const matches = [...pluginValues.entries()].filter(([key, p]) => active.has(key) && p.kind === kind).map(([, p]) => p); if (id) { const value = matches.find(p => p.manifest.id === id || `${p.manifest.id}@${p.manifest.version}` === id); if (!value) fail(`no ${kind} plugin selected: ${id}`); return value as T }; if (matches.length !== 1) fail(`${kind} selection is required when ${matches.length} plugins are available`); return matches[0] as T }
  function selectLlm(id: string | undefined): LlmSystemHarness { const p = select<LlmSystemPlugin>('llm-system', id); return llm.get(`${p.manifest.id}@${p.manifest.version}`)! }
  function contextForCore(c: CoreBootContext, ready: () => void = () => {}): any { return { apiVersion: '0.1', pluginId: core?.manifest.id ?? c.request.selectedCore.id, config: options.config ?? {}, log(level: string, message: string, details?: unknown) { void c.host.call('host.log', { level, message, details }).catch(() => {}) }, registerCommand(name: string, handler: any) { if (coreCommands.has(name)) fail(`duplicate core command: ${name}`); coreCommands.set(name, handler) }, ready } }
  return api
}
