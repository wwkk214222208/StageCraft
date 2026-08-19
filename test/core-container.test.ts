import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import type { CoreLlmRouterPlugin, CoreRuntimePlugin, HumanCoreInteractionPlugin } from '../src/core/plugins.ts'
import type { CoreEvent, CoreRuntimePort } from '../src/core/protocol.ts'
import { startTavern } from '../src/app-boot.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

function corePlugin(core: CoreRuntimePort, id: string, log: string[]): CoreRuntimePlugin {
  return { id, runtime: core, install: () => ({ dispose: () => { log.push(`${id}:dispose`) } }) }
}

function humanPlugin(id: string, log: string[]): HumanCoreInteractionPlugin {
  return { id, install: () => ({ dispose: () => { log.push(`${id}:dispose`) } }), dispatch: async () => {}, publish: () => {} }
}

function llmPlugin(id: string, log: string[], onHost?: (host: Parameters<CoreLlmRouterPlugin['install']>[0]) => void, onRequest?: () => void): CoreLlmRouterPlugin {
  return { id, install: host => { onHost?.(host); return { dispose: () => { log.push(`${id}:dispose`) } } }, request: async () => { onRequest?.() }, cancel: async () => {} }
}

test('Core plugin container rejects duplicate IDs and disposes in reverse installation order', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const log: string[] = []
  let observed = 0
  container.subscribe(() => { observed += 1 })
  container.addCore(corePlugin(core, 'test.core', log))
  container.addHuman(humanPlugin('test.human', log))
  let publishAfterDispose: ((event: CoreEvent) => void) | undefined
  container.addLlm(llmPlugin('test.llm', log, host => { publishAfterDispose = host.publishModelEvent }))
  assert.throws(() => container.addLlm(llmPlugin('test.llm', log)), /already registered/)
  await container.dispose()
  assert.deepEqual(log, ['test.llm:dispose', 'test.human:dispose', 'test.core:dispose'])
  publishAfterDispose?.({ type: 'model.thinking.delta', revision: 0, requestId: 'after-close', text: 'x' })
  assert.equal(observed, 0)
  assert.equal(container.llm.length, 0)
  assert.throws(() => container.addHuman(humanPlugin('after-close', log)), /disposed/)
})

test('LLM model events are published through the core event stream and a disposed route can be replaced', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const events: CoreEvent[] = []
  core.subscribe(event => events.push(event))
  const log: string[] = []
  let publish: ((event: CoreEvent) => void) | undefined
  let submit: ((result: import('../src/core/protocol.ts').ModelResult) => Promise<void>) | undefined
  let firstRequests = 0
  const first = container.addLlm(llmPlugin('test.route', log, host => { publish = host.publishModelEvent; submit = host.submitModelResult }, () => { firstRequests += 1 }))
  publish?.({ type: 'model.thinking.delta', revision: 0, requestId: 'r1', text: '流' })
  assert.equal(events.at(-1)?.type, 'model.thinking.delta')
  await core.requestModel({ requestId: 'r1', capability: 'test', prompt: { system: '', user: '' }, contract: { id: 'test', version: '1', schema: {} }, stream: false })
  assert.equal(firstRequests, 1)
  await first.dispose()
  const eventsBeforeLateResult = events.length
  publish?.({ type: 'model.thinking.delta', revision: 0, requestId: 'late', text: '迟到' })
  assert.equal(events.length, eventsBeforeLateResult)
  await assert.rejects(submit?.({ requestId: 'late', output: { ok: true } }), /host is disposed/)
  assert.equal(events.some(event => event.type === 'model.completed' && event.result.requestId === 'late'), false)
  let secondRequests = 0
  const second = container.addLlm(llmPlugin('test.route', log, undefined, () => { secondRequests += 1 }))
  // 旧 handle 的重复释放不能解绑后来安装的同 ID 路由。
  await first.dispose()
  await core.requestModel({ requestId: 'r2', capability: 'test', prompt: { system: '', user: '' }, contract: { id: 'test', version: '1', schema: {} }, stream: false })
  assert.equal(secondRequests, 1)
  assert.deepEqual(log, ['test.route:dispose'])
  await second.dispose()
  assert.deepEqual(log, ['test.route:dispose', 'test.route:dispose'])
  await assert.rejects(core.requestModel({ requestId: 'r3', capability: 'test', prompt: { system: '', user: '' }, contract: { id: 'test', version: '1', schema: {} }, stream: false }), /no LLM router/)
})

test('startTavern installs the initial provider synchronously and closes Store after a plugin release error', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rp-container-provider-test-'))
  writeFileSync(join(dataDir, 'providers.json'), JSON.stringify({ providers: [{ id: 'local', name: '本地', baseUrl: 'http://model.test', apiKey: 'key', models: ['model'], selectedModel: 'model', responseFormat: 'none' }], directorProviderId: 'local', directorModel: 'model' }))
  const app = startTavern({ root, dataDir, port: 0, host: '127.0.0.1' })
  assert.equal(app.container.llm.length, 1)
  assert.equal(app.gateway?.usage().model, 'model')
  app.container.addHuman({ id: 'test.throwing', install: () => ({ dispose: () => { throw new Error('dispose boom') } }), dispatch: async () => {}, publish: () => {} })
  await assert.rejects(app.close(), /dispose boom/)
  assert.throws(() => app.runtime.get(app.roomId), /closed|open/i)
  rmSync(dataDir, { recursive: true, force: true })
})

test('startTavern close releases installed container plugins before the Store', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rp-container-test-'))
  const app = startTavern({ root, dataDir, port: 0, host: '127.0.0.1' })
  let disposed = false
  app.container.addHuman({ id: 'test.app-human', install: () => ({ dispose: () => { disposed = true } }), dispatch: async () => {}, publish: () => {} })
  await app.close()
  assert.equal(disposed, true)
  assert.equal(app.container.human.length, 0)
  rmSync(dataDir, { recursive: true, force: true })
})
