import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import test from 'node:test'
import { startTavern } from '../src/app-boot.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { coreRuntimeCordisPlugin, createStageCraftService, stageCraftServicePlugin } from '../src/core/cordis-plugins.ts'

const root = new URL('..', import.meta.url)
const repositoryRoot = fileURLToPath(root)

function isolatedData(prefix: string): string {
  const dataDir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dataDir, 'providers.json'), JSON.stringify({ providers: [] }), 'utf8')
  return dataDir
}

test('production built-ins are Cordis fibers and inject the stable stagecraft service', async () => {
  const dataDir = isolatedData('stagecraft-cordis-app-')
  const ctx = new Context()
  let injected: unknown
  const probe = {
    name: 'stagecraft.test.probe',
    inject: ['stagecraft'],
    apply(probeCtx: Context) {
      injected = probeCtx.stagecraft
      probeCtx.effect(() => () => {})
    },
  }
  try {
    const app = await startTavern({ root: repositoryRoot, dataDir, port: 0, ctx })
    try {
      assert.equal(app.ctx, ctx)
      assert.equal((injected as undefined), undefined)
      const probeFiber = ctx.plugin(probe)
      await probeFiber
      assert.equal((injected as { core: unknown }).core, app.core)
      await probeFiber.dispose()
      const names = [...ctx.registry.values()].map(value => value.name)
      assert.ok(names.includes('stagecraft.service'))
      assert.ok(names.includes('stagecraft.core'))
      assert.ok(names.includes('stagecraft.state-repository'))
      assert.ok(names.includes('stagecraft.human.http'))
      assert.ok(names.includes('stagecraft.solution'))
      await app.close()
      assert.equal(app.container.corePlugins.length, 0)
      assert.equal(app.container.human.length, 0)
      assert.equal(app.container.solutions.length, 0)
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('external DSH context is not nested or disposed by TavernApp', async () => {
  const dataDir = isolatedData('stagecraft-cordis-external-')
  const ctx = new Context()
  try {
    const app = await startTavern({ root: repositoryRoot, dataDir, port: 0, ctx })
    await app.close()
    const fiber = ctx.plugin({ name: 'stagecraft.external.context.probe', apply() {} })
    await fiber
    await fiber.dispose()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('app-boot production boundary delegates built-in installation to Cordis plugins', () => {
  const source = readFileSync(new URL('../src/app-boot.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /container\.add(?:Core|Human|Llm|Solution)\(/)
})

test('a built-in Cordis plugin waits for stagecraft injection before activating', async () => {
  const ctx = new Context()
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const service = createStageCraftService(core, 'room-1', container, repository => core.attachStateRepository(repository))
  const pending = ctx.plugin(coreRuntimeCordisPlugin())
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(container.corePlugins.length, 0)
  const serviceFiber = ctx.plugin(stageCraftServicePlugin(service))
  await serviceFiber
  await pending
  assert.equal(container.corePlugins.length, 1)
  await pending.dispose()
  await serviceFiber.dispose()
  await container.dispose()
})

test('Cordis bridge plugins register generic state and leave committed data after unload', async () => {
  const ctx = new Context()
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const service = createStageCraftService(core, 'room-1', container, repository => core.attachStateRepository(repository))
  const plugin = {
    name: 'state.synthetic',
    inject: ['stagecraft'],
    apply(pluginCtx: Context) {
      const module = pluginCtx.stagecraft.state.registerModule({ id: 'synthetic', version: '1' })
      const schema = pluginCtx.stagecraft.state.registerSchema({ id: 'synthetic.schema', moduleId: 'synthetic', validate: () => undefined })
      const reducer = pluginCtx.stagecraft.state.registerReducer({ id: 'synthetic.reducer', moduleId: 'synthetic', listensTo: ['increment'], reduce: () => ({ patches: [{ op: 'delta', path: '/modules/synthetic/count', value: 1 }] }) })
      pluginCtx.effect(() => () => { reducer.dispose(); schema.dispose(); module.dispose() })
    },
  }
  const serviceFiber = ctx.plugin(stageCraftServicePlugin(service))
  await serviceFiber
  const stateFiber = ctx.plugin(plugin)
  await stateFiber
  const result = service.state.transact({ roomId: 'room-1', moduleId: 'synthetic', events: [{ id: 'inc', type: 'increment' }], patches: [{ op: 'set', path: '/modules/synthetic/count', value: 0 }] })
  assert.equal((result.after.modules as any).synthetic.count, 1)
  await stateFiber.dispose()
  assert.throws(() => service.state.transact({ roomId: 'room-1', moduleId: 'synthetic', patches: [{ op: 'set', path: '/modules/synthetic/count', value: 2 }] }), /not registered/)
  assert.equal((core.getView().state.modules as any).synthetic.count, 1)
  await serviceFiber.dispose()
  await container.dispose()
})

test('provider mutations keep the single Cordis LLM fiber and refresh workers', async () => {
  const dataDir = isolatedData('stagecraft-cordis-provider-')
  const app = await startTavern({ root: repositoryRoot, dataDir, port: 0 })
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const endpoint = `http://127.0.0.1:${address.port}/api/providers/save`
    const save = (id: string) => fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: id, baseUrl: 'http://model.test', apiKey: 'key', models: ['model'], selectedModel: 'model', responseFormat: 'none' }),
    })
    assert.equal((await save('first')).status, 200)
    const first = app.container.llm[0]
    assert.ok(first)
    assert.equal((await save('second')).status, 200)
    assert.equal(app.container.llm[0], first)
    assert.equal(app.container.llm.length, 1)
    assert.equal([...app.ctx.registry.values()].filter(value => value.name === 'stagecraft.llm.model-gateway').length, 1)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('state repository Fiber cleanup is owner-safe across replacement', () => {
  const core = new CoreRuntimeSkeleton()
  let firstCalls = 0
  let secondCalls = 0
  const first = { commit() {}, restore() { firstCalls += 1; return undefined } }
  const second = { commit() {}, restore() { secondCalls += 1; return undefined } }
  const firstRelease = core.attachStateRepository(first)
  const secondRelease = core.attachStateRepository(second)
  firstRelease.dispose()
  core.restoreState('room-1')
  assert.equal(firstCalls, 0)
  assert.equal(secondCalls, 1)
  secondRelease.dispose()
  core.restoreState('room-1')
  assert.equal(secondCalls, 1)
})

test('a throwing Cordis-owned disposer does not stop remaining app cleanup', async () => {
  const dataDir = isolatedData('stagecraft-cordis-dispose-error-')
  const app = await startTavern({ root: repositoryRoot, dataDir, port: 0 })
  const throwing = app.ctx.plugin({
    name: 'stagecraft.test.throwing-adapter',
    inject: ['stagecraft'],
    apply(ctx: Context) {
      ctx.effect(() => () => { throw new Error('cordis adapter dispose boom') })
    },
  })
  await throwing
  try {
    // Cordis unloads dependent fibers with all-settled semantics; the throwing
    // adapter must not prevent the application's own cleanup from completing.
    await app.close()
    assert.equal(app.container.corePlugins.length, 0)
    assert.equal(app.container.human.length, 0)
    assert.equal(app.container.solutions.length, 0)
    assert.throws(() => app.runtime.get(app.roomId), /closed|open/i)
  } finally {
    await app.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('story initialization failure closes Store and permits a later restart on the same path', async () => {
  const dataDir = isolatedData('stagecraft-cordis-start-failure-')
  try {
    await assert.rejects(startTavern({ root: repositoryRoot, dataDir, storyId: 'missing-story', port: 0 }))
    const app = await startTavern({ root: repositoryRoot, dataDir, port: 0 })
    await app.close()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
