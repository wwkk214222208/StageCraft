import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuthoringCoreHarness, defineCore, defineProviderDriver, defineSolution, defineToolPlugin, defineUiPlugin, inspectAuthoringPlugin, STAGECRAFT_AUTHORING_API } from '../src/sdk/index.ts'

const context = { apiVersion: STAGECRAFT_AUTHORING_API, pluginId: 'example.test', config: {}, log() {} }

test('authoring SDK creates immutable, browser-compatible Tool and Solution plugins', async () => {
  const tool = defineToolPlugin({ id: 'example.tool', version: '0.1.0', title: 'Tool', execute: input => ({ input }) })
  assert.equal(tool.kind, 'tool')
  assert.equal(tool.manifest.category, 'tool')
  assert.deepEqual(Object.keys(tool.manifest).sort(), ['apiVersion', 'category', 'id', 'title', 'version'])
  assert.equal(JSON.parse(JSON.stringify(tool.manifest)).execute, undefined)
  assert.deepEqual(await tool.execute(3, context), { input: 3 })
  assert.equal(Object.isFrozen(tool), true)
  const solution = defineSolution({ id: 'example.solution', version: '0.1.0', title: 'Solution', systemPrompt: 'system', assemblePrompt: ({ user }) => user })
  assert.equal(await solution.assemblePrompt({ user: 'hi' }, context), 'hi')
  assert.deepEqual(inspectAuthoringPlugin(solution), [])
})

test('Provider Driver, UI and Core definitions expose lifecycle boundaries', async () => {
  const provider = defineProviderDriver({ id: 'example.provider', version: '0.1.0', title: 'Provider', providerId: 'example', models: ['m'], async *request() { yield { type: 'done' } } })
  assert.deepEqual([...provider.models], ['m'])
  const chunks = []; for await (const chunk of provider.request({ requestId: 'req-1', model: 'm', messages: [] }, context)) chunks.push(chunk.type)
  assert.deepEqual(chunks, ['done'])
  let cancelled = ''
  const cancellable = defineProviderDriver({ id: 'example.cancel', version: '0.1.0', title: 'Cancelable', providerId: 'example', models: ['m'], request: provider.request, cancel: requestId => { cancelled = requestId } })
  await cancellable.cancel?.('req-1', context)
  assert.equal(cancelled, 'req-1')
  const ui = defineUiPlugin({ id: 'example.ui', version: '0.1.0', title: 'UI', render: ({ surface }) => surface.render({ type: 'text', text: 'Hello StageCraft' }) })
  assert.deepEqual(await ui.render({ surface: { id: 'main', render: view => ({ surfaceId: 'main', view }) } }, context), { surfaceId: 'main', view: { type: 'text', text: 'Hello StageCraft' } })
  let started = false
  const core = defineCore({ id: 'example.core', version: '0.1.0', title: 'Core', start: coreContext => { started = true; coreContext.registerCommand('echo', input => ({ ok: true, input })); coreContext.ready() } })
  const harness = await createAuthoringCoreHarness(core)
  assert.equal(started, true)
  assert.deepEqual(await harness.dispatch('echo', 'hello'), { ok: true, input: 'hello' })
})

test('manifest metadata is defensively copied and nested public values cannot mutate it', () => {
  const entry = { desktop: 'dist/index.js', android: 'dist/index.js' }
  const capabilities = ['network']
  const plugin = defineToolPlugin({ id: 'example.copy', version: '0.1.0', title: 'Copy', entry, capabilities, inputSchema: { type: 'string' }, execute() {} })
  entry.desktop = 'evil.js'; capabilities.push('native')
  assert.equal(plugin.manifest.entry?.desktop, 'dist/index.js')
  assert.deepEqual(plugin.manifest.capabilities, ['network'])
  assert.equal(Object.isFrozen(plugin.manifest.entry), true)
  assert.equal(Object.isFrozen(plugin.manifest.capabilities), true)
})

test('authoring SDK rejects malformed public definitions', () => {
  assert.throws(() => defineToolPlugin({ id: 'bad', version: '0.1.0', title: 'x', execute() {} }), /invalid plugin id/)
  assert.throws(() => defineProviderDriver({ id: 'example.provider', version: '0.1.0', title: 'x', providerId: '', models: ['m'], request() { return [] as never } }), /providerId/)
})
