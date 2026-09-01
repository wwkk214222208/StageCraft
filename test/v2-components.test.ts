import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPONENT_SCHEMA_VERSION, HostCoreSession, MemoryComponentStore, buildComponentLaunchPlan, componentManifestHash,
  componentRecord, isOfficialCorePluginApi, negotiateCapabilities,
  validateComponentLaunchPlan, validateComponentManifest,
} from '../src/v2/index.ts'
import { OFFICIAL_CORE_PLUGIN_API_PROFILE } from '../src/v2/official-core-plugin-api.ts'
import { defineToolPlugin } from '../src/sdk/index.ts'
import type { ComponentManifest } from '../src/v2/component-contract.ts'

function manifest(overrides: Partial<ComponentManifest> = {}): ComponentManifest {
  return {
    schemaVersion: COMPONENT_SCHEMA_VERSION, id: 'example.component', version: '1.0.0', title: 'Example', componentType: 'plugin', pluginCategory: 'tool',
    entrypoints: { runtime: 'dist/index.js' }, hostApi: { version: '0.1' }, coreApi: { version: '0.1' },
    capabilities: { required: ['http'], optional: ['clipboard'] }, integrity: { runtime: 'sha256-example' }, ...overrides,
  }
}

const core = manifest({ id: 'example.core', title: 'Core', componentType: 'core', pluginCategory: undefined, capabilities: { required: [], optional: [] } })
const plugin = manifest({ id: 'example.tool', title: 'Tool' })
const minimalCore = { ...core, coreApi: undefined }
const noCoreApiPlugin = { ...plugin, id: 'example.no-core-api', coreApi: undefined }

test('ComponentManifest validates v2 shape and rejects category/path/native errors', () => {
  assert.deepEqual(validateComponentManifest(manifest()), [])
  assert.ok(validateComponentManifest(manifest({ componentType: 'core', pluginCategory: 'tool' })).some(error => error.includes('must not declare pluginCategory')))
  assert.ok(validateComponentManifest(manifest({ entrypoints: { runtime: '../escape.js' } })).some(error => error.includes('root-contained')))
  assert.ok(validateComponentManifest(manifest({ entrypoints: { runtime: 'node:fs' } })).some(error => error.includes('browser ESM')))
  assert.ok(validateComponentManifest(manifest({ entrypoints: { runtime: 'dist/index.ts' } })).some(error => error.includes('.mjs or .js')))
  assert.ok(validateComponentManifest(manifest({ entrypoints: { runtime: 'dist/index.js', ui: 'dist/ui.js' }, integrity: { runtime: 'x' } })).some(error => error.includes('integrity.ui')))
  assert.ok(validateComponentManifest({ ...minimalCore, hostApi: undefined }).some(error => error.includes('core must declare hostApi')))
})

test('ComponentLaunchPlan has an independent core slot, stable hash and identity validation', () => {
  const plan = buildComponentLaunchPlan({ core, plugins: [plugin], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' })
  assert.equal(plan.core.id, core.id); assert.deepEqual(plan.plugins.map(item => item.id), [plugin.id])
  assert.equal(plan.planHash, buildComponentLaunchPlan({ core, plugins: [plugin], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' }).planHash)
  assert.deepEqual(validateComponentLaunchPlan(plan, [core, plugin]), [])
  const bad = { ...plan, core: { ...plan.core, manifestHash: 'wrong' } }
  assert.ok(validateComponentLaunchPlan(bad, [core, plugin]).some(error => error.includes('core manifestHash mismatch')))
  assert.throws(() => buildComponentLaunchPlan({ core: plugin, plugins: [core], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' }), /core slot requires/)
  assert.throws(() => buildComponentLaunchPlan({ core, plugins: [core], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' }), /plugins cannot contain core/)
  assert.throws(() => buildComponentLaunchPlan({ core, plugins: [plugin], hostApiVersion: '9.9', stateSchemaVersion: 'state-1' }), /core hostApi.version.*match/)
  assert.throws(() => buildComponentLaunchPlan({ core, plugins: [manifest({ id: 'example.other', hostApi: { version: '9.9' } })], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' }), /hostApi.version.*match/)
  assert.throws(() => buildComponentLaunchPlan({ core: { ...core, coreApi: { version: '2.0' } }, plugins: [plugin], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' }), /coreApi.version.*match/)
  assert.throws(() => buildComponentLaunchPlan({ core, plugins: [plugin, { ...plugin, version: '2.0.0' }], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' }), /duplicate component id/)
  assert.throws(() => buildComponentLaunchPlan({ core, plugins: [{ ...core, version: '2.0.0' }], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' }), /duplicate component id|plugins cannot contain core/)
  const minimalPlan = buildComponentLaunchPlan({ core: minimalCore, plugins: [noCoreApiPlugin], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' })
  assert.deepEqual(validateComponentLaunchPlan(minimalPlan, [minimalCore, noCoreApiPlugin]), [])
  assert.throws(() => buildComponentLaunchPlan({ core: minimalCore, plugins: [plugin], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' }), /requires the selected Core/)
  assert.throws(() => buildComponentLaunchPlan({ core: { ...minimalCore, hostApi: undefined }, plugins: [], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' }), /core must declare hostApi/)
})

test('MemoryComponentStore reads exact id/version, lists deterministically and protects bundled components', () => {
  const store = new MemoryComponentStore()
  store.install(componentRecord(core.id, core.version, core, 'bundled'))
  store.install(componentRecord(plugin.id, plugin.version, plugin, 'local'))
  assert.equal(store.get(plugin.id, plugin.version)?.origin, 'local')
  assert.equal(store.get(plugin.id, '9.9.9'), undefined)
  assert.deepEqual(store.list().map(record => record.manifest.id), ['example.core', 'example.tool'])
  assert.throws(() => store.remove(core.id, core.version), /bundled component cannot be removed/)
  store.remove(plugin.id, plugin.version); assert.equal(store.get(plugin.id, plugin.version), undefined)
  assert.throws(() => store.install(componentRecord(core.id, core.version, core, 'bundled')), /already installed/)
  const dependencies = [{ id: 'example.dep', version: '1.0.0' }]
  const capabilities = { required: ['http'], optional: ['clipboard'] }
  const nested = manifest({ id: 'example.mutable', dependencies, capabilities, entrypoints: { runtime: 'dist/index.js', ui: 'dist/ui.js' }, integrity: { runtime: 'r', ui: 'u' } })
  const metadata = { nested: { enabled: true } }
  store.install(componentRecord(nested.id, nested.version, nested, 'local', metadata))
  dependencies[0].version = '9.9.9'; capabilities.required?.push('native'); metadata.nested.enabled = false
  const installed = store.get(nested.id, nested.version)!
  assert.equal(installed.manifest.dependencies?.[0].version, '1.0.0')
  assert.deepEqual(installed.manifest.capabilities, { required: ['http'], optional: ['clipboard'] })
  assert.equal(installed.manifest.entrypoints.ui, 'dist/ui.js'); assert.equal((installed.metadata as { nested: { enabled: boolean } }).nested.enabled, true)
  assert.equal(Object.isFrozen(installed.manifest.dependencies), true); assert.equal(Object.isFrozen(installed.manifest.capabilities?.required), true)
  assert.throws(() => store.install(componentRecord('example.bad-core', '1.0.0', { ...minimalCore, id: 'example.bad-core', hostApi: undefined }, 'local')), /core must declare hostApi/)
})

test('capability negotiation is deterministic and distinguishes required failure from optional denial', () => {
  assert.deepEqual(negotiateCapabilities({ required: ['z', 'a'], optional: ['b', 'missing'] }, ['b', 'a']), { ok: false, granted: ['a', 'b'], missingRequired: ['z'], deniedOptional: ['missing'] })
  assert.equal(negotiateCapabilities(undefined, []).ok, true)
})

test('Host-Core ABI requires matching identity, API and plan before host calls', async () => {
  const calls: string[] = []; const host = { call: async (operation: string) => { calls.push(operation); return 'ok' } }
  const plan = buildComponentLaunchPlan({ core, plugins: [plugin], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' })
  const session = new HostCoreSession(plan, host)
  await assert.rejects(() => session.callHost('before-ready', {}), /before Core ready/)
  assert.throws(() => session.accept({ type: 'ready', hostApiVersion: '9.9', selectedCore: plan.core, planHash: plan.planHash }), /host API mismatch/)
  assert.equal(session.state, 'failed')
  const ready = new HostCoreSession(plan, host)
  ready.accept({ type: 'ready', hostApiVersion: plan.hostApiVersion, selectedCore: plan.core, planHash: plan.planHash })
  assert.equal(ready.state, 'ready'); assert.equal(await ready.callHost('ping', {}), 'ok'); assert.deepEqual(calls, ['ping'])
  assert.equal('host' in ready, false)
  const booted = new HostCoreSession(plan, host); let gatedPort: { call(operation: string, input: unknown): Promise<unknown> } | undefined
  await booted.boot({ boot: context => { gatedPort = context.host; context.ready() } })
  assert.equal(booted.state, 'ready'); assert.equal(await gatedPort!.call('boot-ping', {}), 'ok')
  const failed = new HostCoreSession(plan, host)
  await assert.rejects(() => failed.boot({ boot: context => { context.failed('bad_core', 'broken') } }), /broken/)
  assert.equal(failed.state, 'failed')
  assert.throws(() => failed.accept({ type: 'ready', hostApiVersion: plan.hostApiVersion, selectedCore: plan.core, planHash: plan.planHash }), /has failed/)
  await assert.rejects(() => failed.boot({ boot: async () => undefined }), /only valid from pending/)
})

test('Official Core Plugin API is a separately detectable optional profile', () => {
  const api = { profile: OFFICIAL_CORE_PLUGIN_API_PROFILE, listPlugins: () => [], loadPlugin: () => undefined }
  assert.equal(isOfficialCorePluginApi(api), true); assert.equal(isOfficialCorePluginApi({}), false)
  const m2 = defineToolPlugin({ id: 'example.m2', version: '1.0.0', title: 'M2', execute: input => input })
  assert.notEqual(m2.manifest.schemaVersion, COMPONENT_SCHEMA_VERSION)
  assert.ok(validateComponentManifest(m2.manifest as unknown as ComponentManifest).length > 0)
  assert.equal(componentManifestHash(core), componentManifestHash({ ...core }))
})
