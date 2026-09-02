import assert from 'node:assert/strict'
import test from 'node:test'
import { createDefaultLlmSystemService, defineCore, defineLlmSystem, defineProviderDriver, defineSolution, defineToolPlugin, defineUiPlugin } from '../src/sdk/index.ts'
import { createOfficialCoreRuntime } from '../src/v2/official-core-runtime.ts'
import { HostCoreSession, type LoadedCoreComponent } from '../src/v2/host-core-abi.ts'

const sel = (id: string, version = '1.0.0') => ({ id, version, manifestHash: 'hash' })
function component(defaultExport: any, category: any, dependencies: any[] = []): LoadedCoreComponent {
  const manifest: any = { schemaVersion: '0.1', id: defaultExport.manifest.id, version: defaultExport.manifest.version, title: defaultExport.manifest.title, componentType: category === 'core' ? 'core' : 'plugin', ...(category === 'core' ? {} : { pluginCategory: category }), entrypoints: { runtime: 'index.mjs' }, ...(category === 'core' ? { hostApi: { version: '0.1' } } : {}), dependencies, integrity: { runtime: 'x' } }
  return { manifest, defaultExport }
}
function plan() { return { planVersion: '0.1' as const, hostApiVersion: '0.1', core: sel('example.core'), plugins: [sel('example.driver'), sel('example.llm'), sel('example.solution'), sel('example.tool'), sel('example.ui')], stateSchemaVersion: '1', planHash: 'plan' } }

test('official runtime boots through HostCoreSession and exposes generic operations', async () => {
  const events: string[] = []
  const driver = defineProviderDriver({ id: 'example.driver', version: '1.0.0', title: 'Driver', providerId: 'demo', models: ['demo-1'], async *request(request) { events.push(`request:${request.messages[0].content}`); yield { type: 'text', text: 'ok' }; yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } } } })
  const llm = defineLlmSystem({ id: 'example.llm', version: '1.0.0', title: 'LLM', async start(context) { events.push('llm:start'); const service = await createDefaultLlmSystemService(context); return { ...service, async stop() { events.push('llm:stop'); await service.stop() } } } })
  const solution = defineSolution({ id: 'example.solution', version: '1.0.0', title: 'Solution', systemPrompt: 'KEEP', assemblePrompt: ({ user }) => `assembled:${user}` })
  const hostCalls: string[] = []
  const tool = defineToolPlugin({ id: 'example.tool', version: '1.0.0', title: 'Tool', execute(input, ctx) { ctx.log('info', 'tool'); return { input } } })
  const ui = defineUiPlugin({ id: 'example.ui', version: '1.0.0', title: 'UI', render({ surface, view }) { return surface.render(view ?? { type: 'text', text: 'empty' }) }, dispose() { events.push('ui:dispose') } })
  const core = defineCore({ id: 'example.core', version: '1.0.0', title: 'Core', start(ctx) { ctx.registerCommand('ping', () => 'pong'); ctx.ready() }, stop() { events.push('core:stop') } })
  const components = [component(core, 'core'), component(driver, 'provider-driver'), component(llm, 'llm-system', [{ id: 'example.driver', version: '1.0.0' }]), component(solution, 'solution'), component(tool, 'tool'), component(ui, 'ui')]
  const runtime = createOfficialCoreRuntime(components[0])
  const session = new HostCoreSession(plan(), { call: async (operation) => { hostCalls.push(operation); return null } }, components.slice(1))
  await session.boot(runtime)
  assert.equal(session.state, 'ready')
  assert.equal(await session.invoke('core/command', { name: 'ping' }), 'pong')
  assert.deepEqual(await session.invoke('solution/assemble', { solutionId: 'example.solution', user: 'hi' }), { systemPrompt: 'KEEP', assembled: 'assembled:hi', messages: [{ role: 'system', content: 'KEEP' }, { role: 'user', content: 'assembled:hi' }] })
  assert.deepEqual(await session.invoke('llm/complete', { llmSystemId: 'example.llm', requestId: 'r1', messages: [{ role: 'user', content: 'assembled:hi' }] }), [{ type: 'text', text: 'ok' }, { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }])
  assert.deepEqual(await session.invoke('llm/usage/aggregate', { llmSystemId: 'example.llm' }), { inputTokens: 2, outputTokens: 3, requests: 1 })
  assert.deepEqual(await session.invoke('tool/execute', { toolId: 'example.tool', input: 7 }), { input: 7 })
  await new Promise(resolve => setTimeout(resolve, 0)); assert.deepEqual([...hostCalls].sort(), ['host.log', 'host.storage.read', 'host.storage.read', 'host.storage.write'])
  assert.deepEqual(await session.invoke('ui/render', { uiId: 'example.ui', surface: { id: 's', render: (view: any) => ({ surfaceId: 's', view }) }, view: { type: 'text', text: 'x' } }), { surfaceId: 's', view: { type: 'text', text: 'x' } })
  await session.invoke('ui/dispose', { uiId: 'example.ui' })
  await runtime.shutdown!(); assert.equal(runtime.status, 'stopped'); assert.deepEqual(events, ['llm:start', 'request:assembled:hi', 'ui:dispose', 'llm:stop', 'core:stop'])
})

test('official runtime only injects host.secrets when the LLM manifest declares the granted capability', async () => {
  const core = defineCore({ id: 'example.secret-core', version: '1.0.0', title: 'Core', start(ctx) { ctx.ready() } })
  const seen: boolean[] = []
  const llm = defineLlmSystem({ id: 'example.secret-llm', version: '1.0.0', title: 'LLM', start(context) { seen.push(Boolean(context.secrets)); return createDefaultLlmSystemService(context) } })
  const componentWithCapability = component(llm, 'llm-system'); componentWithCapability.manifest.capabilities = { required: ['host.secrets'] }
  const hostValues = new Map<string, string>()
  const host = { capabilities: ['host.log', 'host.storage', 'host.secrets'], call: async (operation: string, input: any) => { if (operation === 'host.secrets.set') hostValues.set(input.key, input.value); if (operation === 'host.secrets.get') return { value: hostValues.get(input.key) }; if (operation === 'host.secrets.has') return { found: hostValues.has(input.key) }; return { value: undefined } } }
  const runtime = createOfficialCoreRuntime(component(core, 'core'))
  await new HostCoreSession({ ...plan(), core: sel('example.secret-core'), plugins: [sel('example.secret-llm')] } as any, host as any, [componentWithCapability]).boot(runtime)
  assert.deepEqual(seen, [true]); await runtime.shutdown!()

  const noCapabilitySeen: boolean[] = []
  const noCapabilityLlm = defineLlmSystem({ id: 'example.no-secret-llm', version: '1.0.0', title: 'LLM', start(context) { noCapabilitySeen.push(Boolean(context.secrets)); return createDefaultLlmSystemService(context) } })
  const noCapability = component(noCapabilityLlm, 'llm-system'); const noSecretRuntime = createOfficialCoreRuntime(component(core, 'core'))
  await new HostCoreSession({ ...plan(), core: sel('example.secret-core'), plugins: [sel('example.no-secret-llm')] } as any, host as any, [noCapability]).boot(noSecretRuntime)
  assert.deepEqual(noCapabilitySeen, [false]); await noSecretRuntime.shutdown!()
})

test('official runtime quarantines missing, cyclic and identity-invalid plugins instead of failing boot', async () => {
  const core = defineCore({ id: 'example.core2', version: '1.0.0', title: 'Core', start(ctx) { ctx.ready() } })
  const base = component(core, 'core')
  const missing = createOfficialCoreRuntime(base)
  await new HostCoreSession({ ...plan(), core: sel('example.core2'), plugins: [sel('example.missing')] } as any, { call: async () => null }, []).boot(missing)
  assert.equal(missing.status, 'ready'); assert.equal(missing.listPlugins().length, 0)
  assert.match(missing.listQuarantined()[0].reason, /selected component is not loaded/)
  const a = defineToolPlugin({ id: 'example.a', version: '1.0.0', title: 'A', execute: () => 1 }); const b = defineToolPlugin({ id: 'example.b', version: '1.0.0', title: 'B', execute: () => 1 })
  const ca = component(a, 'tool', [{ id: 'example.b', version: '1.0.0' }]); const cb = component(b, 'tool', [{ id: 'example.a', version: '1.0.0' }]); const cycle = createOfficialCoreRuntime(base)
  await new HostCoreSession({ ...plan(), core: sel('example.core2'), plugins: [sel('example.a'), sel('example.b')] } as any, { call: async () => null }, [ca, cb]).boot(cycle)
  assert.equal(cycle.listQuarantined().length, 2, 'both cycle members must be quarantined')
  const bad: any = component(a, 'solution'); const invalid = createOfficialCoreRuntime(base)
  await new HostCoreSession({ ...plan(), core: sel('example.core2'), plugins: [sel('example.a')] } as any, { call: async () => null }, [bad]).boot(invalid)
  assert.equal(invalid.listPlugins().length, 0)
  assert.match(invalid.listQuarantined()[0].reason, /category mismatch/)
})

test('official runtime isolates required dependents after identity or LLM init failure and hides them from Core', async () => {
  const seen: string[] = []
  const core = defineCore({ id: 'example.closure-core', version: '1.0.0', title: 'Core', start(ctx) { seen.push(...(ctx.components ?? []).map(component => String(component.manifest.id))); ctx.ready() } })
  const badIdentityPlugin = defineToolPlugin({ id: 'example.identity-export', version: '1.0.0', title: 'Bad identity', execute: () => 1 })
  const badIdentity = component(badIdentityPlugin, 'tool'); badIdentity.manifest.id = 'example.identity-bad'
  const identityDependentPlugin = defineToolPlugin({ id: 'example.identity-dependent', version: '1.0.0', title: 'Dependent', execute: () => 1 })
  const identityDependent = component(identityDependentPlugin, 'tool', [{ id: 'example.identity-bad', version: '1.0.0' }])
  const identityRuntime = createOfficialCoreRuntime(component(core, 'core'))
  await new HostCoreSession({ ...plan(), core: sel('example.closure-core'), plugins: [sel('example.identity-bad'), sel('example.identity-dependent')] } as any, { call: async () => null }, [badIdentity, identityDependent]).boot(identityRuntime)
  assert.deepEqual(seen, [], 'identity-quarantined plugin and required dependent must not reach Core')
  assert.deepEqual(identityRuntime.listPlugins(), [])
  assert.equal(identityRuntime.listQuarantined().length, 2)
  assert.match(identityRuntime.listQuarantined().find(entry => entry.id === 'example.identity-dependent')!.reason, /required dependency/)

  const failingLlm = defineLlmSystem({ id: 'example.failing-llm', version: '1.0.0', title: 'Failing LLM', start() { throw new Error('llm init failed') } })
  const llmDependentPlugin = defineToolPlugin({ id: 'example.llm-dependent', version: '1.0.0', title: 'LLM dependent', execute: () => 1 })
  const failingLlmComponent = component(failingLlm, 'llm-system')
  const llmDependent = component(llmDependentPlugin, 'tool', [{ id: 'example.failing-llm', version: '1.0.0' }])
  const llmSeen: string[] = []
  const llmCore = defineCore({ id: 'example.llm-closure-core', version: '1.0.0', title: 'Core', start(ctx) { llmSeen.push(...(ctx.components ?? []).map(component => String(component.manifest.id))); ctx.ready() } })
  const llmRuntime = createOfficialCoreRuntime(component(llmCore, 'core'))
  await new HostCoreSession({ ...plan(), core: sel('example.llm-closure-core'), plugins: [sel('example.failing-llm'), sel('example.llm-dependent')] } as any, { call: async () => null }, [failingLlmComponent, llmDependent]).boot(llmRuntime)
  assert.deepEqual(llmSeen, [])
  assert.equal(llmRuntime.listPlugins().length, 0)
  assert.equal(llmRuntime.listQuarantined().length, 2)
  assert.match(llmRuntime.listQuarantined().find(entry => entry.id === 'example.llm-dependent')!.reason, /required dependency/)
})

test('selection is explicit when multiple plugins share a category', async () => {
  const core = defineCore({ id: 'example.core3', version: '1.0.0', title: 'Core', start(ctx) { ctx.ready() } })
  const make = (id: string) => defineSolution({ id, version: '1.0.0', title: id, assemblePrompt: () => id })
  const components = [component(core, 'core'), component(make('example.s1'), 'solution'), component(make('example.s2'), 'solution')]
  const runtime = createOfficialCoreRuntime(components[0]); await new HostCoreSession({ ...plan(), core: sel('example.core3'), plugins: [sel('example.s1'), sel('example.s2')] } as any, { call: async () => null }, components.slice(1)).boot(runtime)
  await assert.rejects(() => runtime.invoke!('solution/assemble', { user: 'x' }), /selection is required/)
})

test('inner Core must signal ready and unloading removes plugin capabilities', async () => {
  let notReadyStopped = false
  const notReady = defineCore({ id: 'example.not-ready', version: '1.0.0', title: 'Core', start() {}, stop() { notReadyStopped = true } })
  const notReadyComponent = component(notReady, 'core')
  const runtime = createOfficialCoreRuntime(notReadyComponent)
  await assert.rejects(() => new HostCoreSession({ ...plan(), core: sel('example.not-ready'), plugins: [] } as any, { call: async () => null }, []).boot(runtime), /did not call ready/)
  assert.equal(notReadyStopped, true)

  const good = defineCore({ id: 'example.good', version: '1.0.0', title: 'Core', start(ctx) { ctx.ready() } })
  const solution = defineSolution({ id: 'example.unloadable', version: '1.0.0', title: 'S', assemblePrompt: () => 'x' })
  const goodComponent = component(good, 'core'); const solutionComponent = component(solution, 'solution')
  const activeRuntime = createOfficialCoreRuntime(goodComponent)
  await new HostCoreSession({ ...plan(), core: sel('example.good'), plugins: [sel('example.unloadable')] } as any, { call: async () => null }, [solutionComponent]).boot(activeRuntime)
  assert.equal(activeRuntime.listPlugins().length, 1)
  await activeRuntime.unloadPlugin('example.unloadable')
  assert.equal(activeRuntime.listPlugins().length, 0)
  await assert.rejects(() => activeRuntime.invoke!('solution/assemble', { solutionId: 'example.unloadable', user: 'x' }), /no solution plugin selected/)
})

test('shutdown disposes UI and continues after a disposal failure', async () => {
  const events: string[] = []
  const core = defineCore({ id: 'example.cleanup-core', version: '1.0.0', title: 'Core', start(ctx) { ctx.ready() }, stop() { events.push('core-stop') } })
  const badUi = defineUiPlugin({ id: 'example.bad-ui', version: '1.0.0', title: 'Bad', render: ({ surface, view }) => surface.render(view!), dispose() { events.push('bad-ui'); throw new Error('dispose failed') } })
  const goodUi = defineUiPlugin({ id: 'example.good-ui', version: '1.0.0', title: 'Good', render: ({ surface, view }) => surface.render(view!), dispose() { events.push('good-ui') } })
  const cc = component(core, 'core'); const bu = component(badUi, 'ui'); const gu = component(goodUi, 'ui')
  const runtime = createOfficialCoreRuntime(cc); await new HostCoreSession({ ...plan(), core: sel('example.cleanup-core'), plugins: [sel('example.bad-ui'), sel('example.good-ui')] } as any, { call: async () => null }, [bu, gu]).boot(runtime)
  await assert.rejects(() => runtime.shutdown!(), /failed to stop/)
  assert.deepEqual(events, ['good-ui', 'bad-ui', 'core-stop'])
})
