import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuthoringLlmSystemHarness, defineCore, defineLlmSystem, defineProviderDriver } from '../src/sdk/index.ts'
import type { LlmHarnessSnapshot, LlmHarnessStore } from '../src/sdk/index.ts'
import { createOfficialCoreRuntime } from '../src/v2/official-core-runtime.ts'
import { HostCoreSession, type LoadedCoreComponent } from '../src/v2/host-core-abi.ts'

/** In-memory host.storage backing shared across "restarts". */
function createHostBacking() {
  const areas = new Map<string, unknown>()
  return {
    areas,
    read(caller: string, area: string): unknown | undefined { return areas.has(`${caller}/${area}`) ? structuredClone(areas.get(`${caller}/${area}`)) : undefined },
    write(caller: string, area: string, value: unknown): void { areas.set(`${caller}/${area}`, structuredClone(value)) },
  }
}

function hostPort(backing: ReturnType<typeof createHostBacking>) {
  return { async call(operation: string, input: any, caller?: { pluginId: string; version?: string }) {
    if (!caller?.pluginId) throw new Error(`Host operation ${operation} requires a caller identity`)
    if (operation === 'host.log') return { ok: true }
    if (operation === 'host.storage.read') return { ok: true, value: backing.read(caller.pluginId, String(input?.area ?? '')) ?? null }
    if (operation === 'host.storage.write') { backing.write(caller.pluginId, String(input?.area ?? ''), input?.value); return { ok: true } }
    throw new Error(`Host operation denied: ${operation}`)
  } }
}

const sel = (id: string, version = '1.0.0') => ({ id, version, manifestHash: 'hash' })
function component(defaultExport: any, category: any): LoadedCoreComponent {
  const manifest: any = { schemaVersion: '0.1', id: defaultExport.manifest.id, version: defaultExport.manifest.version, title: defaultExport.manifest.title, componentType: category === 'core' ? 'core' : 'plugin', ...(category === 'core' ? { hostApi: { version: '0.1' } } : { pluginCategory: category }), entrypoints: { runtime: 'index.mjs' }, integrity: { runtime: 'x' } }
  return { manifest, defaultExport }
}
function plan(coreId: string, plugins: string[]) {
  return { planVersion: '0.1' as const, hostApiVersion: '0.1', core: sel(coreId), plugins: plugins.map(id => sel(id)), stateSchemaVersion: '1', planHash: 'plan' }
}

test('harness persists credential profiles, secrets and usage through the store', async () => {
  const snapshots: LlmHarnessSnapshot[] = []
  const store: LlmHarnessStore = {
    async read() { return snapshots.at(-1) ? structuredClone(snapshots.at(-1)) : undefined },
    async write(snapshot) { snapshots.push(structuredClone(snapshot)) },
  }
  const driver = defineProviderDriver({ id: 'example.driver', version: '1.0.0', title: 'Driver', providerId: 'demo', models: ['demo-1'], async *request(request) { yield { type: 'text', text: `secret=${request.credential?.secret ?? 'none'}` }; yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } } } })
  const llm = defineLlmSystem({ id: 'example.llm', version: '1.0.0', title: 'LLM', start(context) { context.registerDriver(driver); context.upsertCredentialProfile({ id: 'main', providerId: 'demo' }) }, route: () => ({ providerId: 'demo', model: 'demo-1', credentialProfileId: 'main' }) })

  const first = await createAuthoringLlmSystemHarness(llm, {}, { store })
  first.setCredentialSecret('main', 'sk-demo')
  first.recordUsage({ requestId: 'r0', providerId: 'demo', model: 'demo-1', inputTokens: 1, outputTokens: 1 })
  await first.stop()
  assert.ok(snapshots.length > 0)

  const second = await createAuthoringLlmSystemHarness(llm, {}, { store })
  assert.equal(second.hasCredentialSecret('main'), true, 'restored harness must know the stored secret')
  assert.equal(second.aggregateUsage().requests, 1, 'usage must survive restart')
  const chunks = []; for await (const chunk of second.complete({ requestId: 'r1', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
  assert.equal((chunks[0] as any).text, 'secret=sk-demo', 'complete() must inject the stored secret when the caller passes none')
  await second.stop()
})

test('LLM harness stop waits for queued writes before reporting shutdown', async () => {
  const snapshots: LlmHarnessSnapshot[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const store: LlmHarnessStore = {
    async read() { return undefined },
    async write(snapshot) { await gate; snapshots.push(structuredClone(snapshot)) },
  }
  const llm = defineLlmSystem({ id: 'example.slow-llm', version: '1.0.0', title: 'Slow LLM', start() {}, route: () => ({ providerId: 'demo', model: 'demo-1' }) })
  const harness = await createAuthoringLlmSystemHarness(llm, {}, { store })
  harness.recordUsage({ requestId: 'slow', providerId: 'demo', model: 'demo-1', inputTokens: 2, outputTokens: 1 })
  const stopping = harness.stop()
  await Promise.resolve()
  assert.equal(snapshots.length, 0, 'shutdown must still be waiting on the store')
  release()
  await stopping
  assert.equal(harness.status, 'stopped')
  assert.equal(snapshots.at(-1)?.usage[0]?.requestId, 'slow')
})

test('LLM harness flushes slow persistence and becomes stopped when plugin stop throws', async () => {
  const snapshots: LlmHarnessSnapshot[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const store: LlmHarnessStore = {
    async read() { return undefined },
    async write(snapshot) { await gate; snapshots.push(structuredClone(snapshot)) },
  }
  const llm = defineLlmSystem({ id: 'example.throwing-stop-llm', version: '1.0.0', title: 'Throwing stop LLM', start() {}, stop() { throw new Error('plugin stop failed') }, route: () => ({ providerId: 'demo', model: 'demo-1' }) })
  const harness = await createAuthoringLlmSystemHarness(llm, {}, { store })
  harness.recordUsage({ requestId: 'throwing-stop', providerId: 'demo', model: 'demo-1', inputTokens: 4, outputTokens: 2 })
  const stopping = harness.stop()
  await Promise.resolve()
  assert.equal(snapshots.length, 0, 'the throwing stop must not bypass a pending write')
  release()
  await assert.rejects(stopping, /plugin stop failed/)
  assert.equal(harness.status, 'stopped')
  assert.equal(snapshots.at(-1)?.usage[0]?.requestId, 'throwing-stop')
  await harness.stop()
})

test('official runtime restores config and LLM usage from host storage across restarts', async () => {
  const backing = createHostBacking()
  const makeRuntime = async () => {
    const driver = defineProviderDriver({ id: 'example.driver', version: '1.0.0', title: 'Driver', providerId: 'demo', models: ['demo-1'], async *request() { yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } } } })
    const llm = defineLlmSystem({ id: 'example.llm', version: '1.0.0', title: 'LLM', start(context) { context.upsertCredentialProfile({ id: 'main', providerId: 'demo' }) }, route: () => ({ providerId: 'demo', model: 'demo-1', credentialProfileId: 'main' }) })
    const core = defineCore({ id: 'example.core', version: '1.0.0', title: 'Core', start(ctx) { ctx.registerCommand('config', () => (ctx as any).config); ctx.ready() } })
    const coreComponent = component(core, 'core')
    const runtime = createOfficialCoreRuntime(coreComponent)
    const session = new HostCoreSession(plan('example.core', ['example.driver', 'example.llm']), hostPort(backing), [component(driver, 'provider-driver'), component(llm, 'llm-system')])
    await session.boot(runtime)
    return { runtime, session }
  }

  const first = await makeRuntime()
  assert.deepEqual(await first.session.invoke('config/update', { temperature: 0.7 }), { temperature: 0.7 })
  await first.session.invoke('llm/credential/set', { llmSystemId: 'example.llm', profileId: 'main', secret: 'sk-live' })
  await first.session.invoke('llm/complete', { llmSystemId: 'example.llm', requestId: 'r1', messages: [{ role: 'user', content: 'hi' }] })
  await first.runtime.shutdown!()

  const second = await makeRuntime()
  assert.deepEqual(await second.session.invoke('config/get'), { temperature: 0.7 }, 'core config must survive restart')
  assert.deepEqual(await second.session.invoke('llm/usage/aggregate', { llmSystemId: 'example.llm' }), { inputTokens: 3, outputTokens: 4, requests: 1 }, 'usage must survive restart')
  const profiles = await second.session.invoke('llm/credential/list', { llmSystemId: 'example.llm' }) as any[]
  assert.deepEqual(profiles, [{ id: 'main', providerId: 'demo', hasSecret: true }])
  const command = await second.session.invoke('core/command', { name: 'config' })
  assert.deepEqual(command, { temperature: 0.7 }, 'core start() must see the persisted config')
  assert.ok(backing.areas.has('example.llm/llm-harness'), 'llm harness state must be namespaced per component')
  await second.runtime.shutdown!()
})
