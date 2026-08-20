import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { createStageCraftService, stageCraftServicePlugin } from '../src/core/cordis-plugins.ts'
import { ReferenceUiRendererHost } from '../src/core/renderer-host.ts'
import { readJsonPointer, validateUiAsset, validateUiManifest, type UiManifest } from '../src/core/ui.ts'

const baseView = (core: CoreRuntimeSkeleton) => core.getView()

function manifest(owner: string, id = `${owner}.ui`): UiManifest {
  return {
    id, version: '1', owner, priority: 2,
    panels: [{ id: `${id}.panel`, title: owner, content: [
      { type: 'text', id: 'label', text: { path: '/modules/ext/name', fallback: 'missing' } },
      { type: 'button', id: 'button', label: 'Run', action: `${id}.run` },
      { type: 'markdown', source: { path: '/modules/ext/markdown' } },
    ] }],
    actions: [{ id: `${id}.run`, label: 'Run', input: { type: 'object' } }],
  }
}

test('UI JSON Pointer is read-only and rejects prototype pollution segments', () => {
  const state = { modules: { ext: { value: { name: 'ok' }, list: ['a'] } } }
  assert.equal(readJsonPointer(state, '/modules/ext/value/name'), 'ok')
  const copy = readJsonPointer(state, '/modules/ext/value') as any
  copy.name = 'changed'
  assert.equal((state.modules.ext.value as any).name, 'ok')
  assert.equal(readJsonPointer(state, '/modules/ext/missing'), undefined)
  for (const segment of ['__proto__', 'constructor', 'prototype']) assert.throws(() => readJsonPointer(state, `/${segment}`), /Forbidden/)
  assert.throws(() => readJsonPointer(state, '/modules/ext/value~2name'), /escape/)
  assert.throws(() => readJsonPointer(state, 'modules/ext'), /Invalid/)
})

test('UI manifest validation rejects dangerous URLs and non-JSON values', () => {
  assert.throws(() => validateUiAsset({ type: 'https', url: 'javascript:alert(1)' }), /HTTPS|Unsafe|Invalid/)
  assert.throws(() => validateUiAsset({ type: 'https', url: 'https://user:pass@example.test/a' }), /Unsafe/)
  assert.throws(() => validateUiAsset({ type: 'https', url: 'https://example.test/../secret' }), /Unsafe/)
  const bad: any = manifest('bad')
  bad.theme = { color: { bad: new Date() } }
  assert.throws(() => validateUiManifest(bad), /JSON-safe/)
  const cyclic: any = manifest('cycle'); cyclic.theme = {}; cyclic.theme.self = cyclic.theme
  assert.throws(() => validateUiManifest(cyclic), /cycles/)
  const unsafe: any = manifest('unsafe'); unsafe.panels[0].content[0].text = { path: '/__proto__' }
  assert.throws(() => validateUiManifest(unsafe), /Forbidden/)
})

test('registry composes stable manifests, clones outputs, and isolates action owners', async () => {
  const core = new CoreRuntimeSkeleton()
  core.registerStateModule({ id: 'ext', version: '1' })
  core.transactState({ roomId: 'room', moduleId: 'ext', patches: [{ op: 'set', path: '/modules/ext/name', value: 'state' }, { op: 'set', path: '/modules/ext/markdown', value: '# safe' }] })
  const events: any[] = []; core.subscribe(event => events.push(event))
  const first = core.registerUiManifest(manifest('owner-b', 'b'), [{ definition: manifest('owner-b', 'b').actions![0], execute: input => ({ input, owner: 'b' }) }])
  const secondManifest = manifest('owner-a', 'a'); secondManifest.priority = 1
  const second = core.registerUiManifest(secondManifest, [{ definition: secondManifest.actions![0], execute: input => ({ input, owner: 'a' }) }])
  assert.deepEqual(core.listUiManifests().map(item => item.id), ['a', 'b'])
  assert.equal(events.filter(event => event.type === 'ui.manifest.changed').length, 2)
  const listed = core.listUiManifests(); listed[0].panels[0].title = 'mutated'
  assert.equal(core.listUiManifests()[0].panels[0].title, 'owner-a')
  await assert.rejects(core.invokeUiAction('a.run', {}, 'owner-b'), /another extension/)
  assert.deepEqual(await core.invokeUiAction('a.run', { ok: true }, 'owner-a'), { input: { ok: true }, owner: 'a' })
  const unsafe = core.registerUiManifest(manifest('unsafe-output', 'unsafe-output'), [{ definition: manifest('unsafe-output', 'unsafe-output').actions![0], execute: () => new Date() }])
  await assert.rejects(core.invokeUiAction('unsafe-output.run', {}, 'unsafe-output'), /output.*JSON-safe/)
  unsafe.dispose()
  const rendered = core.renderUi(); assert.equal(rendered.panels[0].panel.title, 'owner-a')
  rendered.panels[0].panel.title = 'changed'
  assert.equal(core.renderUi().panels[0].panel.title, 'owner-a')
  first.dispose(); second.dispose()
  assert.equal(core.listUiManifests().length, 0)
  assert.equal(events.filter(event => event.type === 'ui.manifest.changed').length, 6)
})

test('reference renderer host resolves the same intermediate tree from CoreView', () => {
  const core = new CoreRuntimeSkeleton()
  core.registerStateModule({ id: 'ext', version: '1' })
  core.transactState({ roomId: 'room', moduleId: 'ext', patches: [{ op: 'set', path: '/modules/ext/name', value: 'same' }] })
  const ui = manifest('web', 'shared')
  const registration = core.registerUiManifest(ui, [{ definition: ui.actions![0], execute: () => true }])
  const host = new ReferenceUiRendererHost(core)
  const first = host.render(baseView(core))
  assert.equal(first.panels[0].nodes[0].properties.text, 'same')
  assert.equal(first.panels[0].nodes[1].properties.action, 'shared.run')
  first.panels[0].nodes[0].properties.text = 'mutated'
  assert.equal(host.render(baseView(core)).panels[0].nodes[0].properties.text, 'same')
  registration.dispose()
})

test('Cordis Fiber unload removes UI manifest and typed action together', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const service = createStageCraftService(core, 'room', container, repository => core.attachStateRepository(repository))
  const root = new Context(); const serviceFiber = root.plugin(stageCraftServicePlugin(service)); await serviceFiber
  const ui = manifest('fiber', 'fiber.ui')
  const fiber = root.plugin({ name: 'fiber.ui.plugin', inject: ['stagecraft'], apply(ctx: Context) {
    const registration = ctx.stagecraft.extensions.registerUiManifest(ui, [{ definition: ui.actions![0], execute: () => 'ok' }])
    ctx.effect(() => () => registration.dispose())
  } })
  await fiber
  assert.equal(service.extensions.listUiManifests()[0].id, 'fiber.ui')
  await fiber.dispose()
  assert.deepEqual(service.extensions.listUiManifests(), [])
  await assert.rejects(service.extensions.invokeUiAction('fiber.ui.run', {}, 'fiber'), /not registered/)
  await serviceFiber.dispose(); await container.dispose()
})
