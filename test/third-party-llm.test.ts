import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import plugin from '../examples/v2/llm-third-party/src/index.ts'
import { createAuthoringLlmSystemHarness, defineProviderDriver } from '../src/sdk/index.ts'
import { createOfficialCoreRuntime } from '../src/v2/official-core-runtime.ts'
import { HostCoreSession, type LoadedCoreComponent } from '../src/v2/host-core-abi.ts'
import { defineCore } from '../src/sdk/index.ts'
import { startV2DesktopHost } from '../src/v2/desktop-host.ts'
import { createInMemoryComponentStorage } from '../src/v2/component-storage.ts'
import { buildComponentLaunchPlan } from '../src/v2/launch-plan.ts'

const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'))

function installExampleComponent(base: string, example: string): any {
  const project = join(repoRoot, 'examples', 'v2', example)
  const packageManifest = JSON.parse(readFileSync(join(project, 'stagecraft.plugin.json'), 'utf8'))
  const runtimeBytes = readFileSync(join(project, packageManifest.output))
  const componentDir = join(base, 'components', packageManifest.id, packageManifest.version); const runtimePath = join(componentDir, packageManifest.output)
  mkdirSync(dirname(runtimePath), { recursive: true }); writeFileSync(runtimePath, runtimeBytes)
  const manifest = { schemaVersion: '0.1', id: packageManifest.id, version: packageManifest.version, title: packageManifest.title, componentType: packageManifest.category === 'core' ? 'core' : 'plugin', ...(packageManifest.category === 'core' ? { hostApi: { version: '0.1' } } : { pluginCategory: packageManifest.category }), entrypoints: { runtime: packageManifest.output }, ...(packageManifest.capabilities ? { capabilities: packageManifest.capabilities } : {}), integrity: { runtime: `sha256-${createHash('sha256').update(runtimeBytes).digest('hex')}` } }
  writeFileSync(join(componentDir, 'manifest.json'), JSON.stringify(manifest, null, 2)); return manifest
}

test('independent LLM system owns CRUD, routing, exact messages, stream and usage', async () => {
  let seen: readonly { role: string; content: string }[] = []
  const driver = defineProviderDriver({ id: 'test.third-party.driver', version: '1.0.0', title: 'Test', providerId: 'test-driver', models: ['test-model'], async *request(request) { seen = request.messages; yield { type: 'text', text: 'answer' }; yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }; yield { type: 'done' } } })
  const service = await createAuthoringLlmSystemHarness(plugin, {}, { drivers: [driver] })
  await service.upsertCredentialProfile({ id: 'profile', providerId: 'test-driver', driverId: 'test-driver', name: 'Profile', models: ['test-model'], selectedModel: 'test-model' })
  await service.setCredentialSecret('profile', 'secret-not-public')
  await service.setRouteDefault('role', { profileId: 'profile', model: 'test-model' })
  await service.setRouteDefault('director', { profileId: 'profile', driverId: 'test-driver', model: 'test-model' })
  assert.equal((await service.route({ purpose: 'director' })).profileId, 'profile')
  const messages = [{ role: 'system', content: 'Solution system' }, { role: 'user', content: 'assembled' }]
  const chunks: any[] = []; for await (const chunk of service.complete({ requestId: 'third-party-1', role: 'aria', messages })) chunks.push(chunk)
  assert.deepEqual(seen, messages); assert.deepEqual(chunks.map(chunk => chunk.type), ['text', 'usage', 'done']); assert.equal((await service.aggregateUsage()).requests, 1); assert.equal(JSON.stringify(service.listCredentialProfiles()).includes('secret-not-public'), false)
  await service.deleteCredentialProfile('profile'); assert.equal(service.listCredentialProfiles().length, 0); await service.stop()
})

test('independent LLM system rejects duplicate request IDs', async () => {
  const driver = defineProviderDriver({ id: 'test.third-party.slow', version: '1.0.0', title: 'Slow', providerId: 'slow', models: ['m'], async *request(request) { while (!request.signal?.aborted) await new Promise(resolve => setTimeout(resolve, 1)); yield { type: 'done' } } })
  const service = await createAuthoringLlmSystemHarness(plugin, {}, { drivers: [driver] }); await service.upsertCredentialProfile({ id: 'p', providerId: 'slow', models: ['m'] })
  const first = service.complete({ requestId: 'same', messages: [{ role: 'user', content: 'x' }] }); const consume = (async () => { for await (const _ of first) {} })(); await new Promise(resolve => setTimeout(resolve, 0)); assert.throws(() => service.complete({ requestId: 'same', messages: [] }), /already active/); await service.cancel('same'); await consume; await service.stop()
})

test('route failure releases request ID so configuration can retry it', async () => {
  const driver = defineProviderDriver({ id: 'test.third-party.retry', version: '1.0.0', title: 'Retry', providerId: 'retry', models: ['m'], async *request() { yield { type: 'done' } } })
  const service = await createAuthoringLlmSystemHarness(plugin, {}, { drivers: [driver] })
  const request = () => (async () => { for await (const _chunk of service.complete({ requestId: 'retry-id', messages: [] })) {} })()
  await assert.rejects(request(), /provider profile/)
  await service.upsertCredentialProfile({ id: 'p', providerId: 'retry', driverId: 'retry', models: ['m'] })
  await request()
  await service.stop()
})

test('independent LLM system stop cancels an active request through its driver', async () => {
  let cancelled = ''
  const driver = defineProviderDriver({ id: 'test.third-party.stop', version: '1.0.0', title: 'Stop', providerId: 'stop', models: ['m'], async *request(request) { while (!request.signal?.aborted) await new Promise(resolve => setTimeout(resolve, 1)); yield { type: 'done' } }, cancel: id => { cancelled = id } })
  const service = await createAuthoringLlmSystemHarness(plugin, {}, { drivers: [driver] }); await service.upsertCredentialProfile({ id: 'p', providerId: 'stop', driverId: 'stop', models: ['m'] })
  const task = (async () => { for await (const _chunk of service.complete({ requestId: 'stop-active', providerId: 'stop', model: 'm', messages: [] })) {} })()
  await new Promise(resolve => setTimeout(resolve, 0)); await service.stop(); await task
  assert.equal(cancelled, 'stop-active'); assert.equal(service.status, 'stopped')
})

test('independent dist plugin boots through the official v2 runtime', async () => {
  const dist = (await import('../examples/v2/llm-third-party/dist/index.js')).default
  const driver = defineProviderDriver({ id: 'test.runtime.driver', version: '1.0.0', title: 'Runtime driver', providerId: 'runtime-driver', models: ['runtime-model'], async *request() { yield { type: 'text', text: 'runtime-ok' }; yield { type: 'done' } } })
  const core = defineCore({ id: 'test.runtime.core', version: '1.0.0', title: 'Runtime core', start(context) { context.ready() } })
  const component = (value: any, category: string, dependencies: any[] = []): LoadedCoreComponent => ({ defaultExport: value, manifest: { schemaVersion: '0.1', id: value.manifest.id, version: value.manifest.version, title: value.manifest.title, componentType: category === 'core' ? 'core' : 'plugin', ...(category === 'core' ? { hostApi: { version: '0.1' } } : { pluginCategory: category }), entrypoints: { runtime: 'dist/index.js' }, dependencies, integrity: { runtime: 'test' } } as any })
  const coreComponent = component(core, 'core'); const driverComponent = component(driver, 'provider-driver'); const llmComponent = component(dist, 'llm-system', [{ id: driver.manifest.id, version: driver.manifest.version }])
  const runtime = createOfficialCoreRuntime(coreComponent)
  const session = new HostCoreSession({ planVersion: '0.1', hostApiVersion: '0.1', core: { id: core.manifest.id, version: core.manifest.version, manifestHash: 'core' }, plugins: [{ id: driver.manifest.id, version: driver.manifest.version, manifestHash: 'driver' }, { id: dist.manifest.id, version: dist.manifest.version, manifestHash: 'llm' }], stateSchemaVersion: '1', planHash: 'plan' }, { call: async (operation: string, input: any) => operation === 'host.storage.read' && input.area === 'third-party-llm' ? { value: { profiles: [{ id: 'runtime-profile', providerId: 'runtime-driver', driverId: 'runtime-driver', models: ['runtime-model'], selectedModel: 'runtime-model' }], routes: {}, usage: [] } } : undefined }, [driverComponent, llmComponent])
  await session.boot(runtime)
  const chunks = await session.invoke('llm/complete', { llmSystemId: dist.manifest.id, requestId: 'runtime-request', profileId: 'runtime-profile', model: 'runtime-model', messages: [{ role: 'system', content: 'unchanged' }, { role: 'user', content: 'hello' }] })
  assert.deepEqual(chunks, [{ type: 'text', text: 'runtime-ok' }, { type: 'done' }]); await runtime.shutdown!()
})

test('independent package loads through the real desktop Host capability handshake', async () => {
  const base = mkdtempSync(join(repoRoot, '.tmp-third-party-host-')); let host: Awaited<ReturnType<typeof startV2DesktopHost>> | undefined
  try {
    const core = installExampleComponent(base, 'core'); const driver = installExampleComponent(base, 'driver'); const llm = installExampleComponent(base, 'llm-third-party'); const solution = installExampleComponent(base, 'solution'); const tool = installExampleComponent(base, 'tool')
    const storage = createInMemoryComponentStorage()
    await storage.write({ pluginId: llm.id, version: llm.version }, 'third-party-llm', { profiles: [{ id: 'real-profile', providerId: 'demo', driverId: 'demo', models: ['demo-1'], selectedModel: 'demo-1' }], routes: {}, usage: [] })
    const plan = buildComponentLaunchPlan({ core, plugins: [driver, llm, solution, tool], hostApiVersion: '0.1', stateSchemaVersion: 'third-party-test' })
    mkdirSync(join(base, 'data'), { recursive: true }); writeFileSync(join(base, 'data', 'component-launch-plan.v2.json'), JSON.stringify(plan, null, 2))
    host = await startV2DesktopHost({ userDataRoot: base, port: 0, storage })
    assert.equal(host.quarantinedPlugins.some(plugin => plugin.id === llm.id), false)
    assert.equal(host.effectivePlan.plugins.some(plugin => plugin.id === llm.id), true)
    const messages = [{ role: 'system', content: 'Solution system' }, { role: 'user', content: 'assembled' }]
    const chunks = await host.session.invoke('llm/complete', { llmSystemId: llm.id, requestId: 'real-host-request', profileId: 'real-profile', model: 'demo-1', messages }) as any[]
    assert.equal(chunks[0].text, 'echo:Solution system|assembled')
    assert.deepEqual(chunks.at(-1), { type: 'done' })
  } finally { await host?.close(); rmSync(base, { recursive: true, force: true }) }
})
