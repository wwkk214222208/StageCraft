import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineCore, defineLlmSystem, defineProviderDriver } from '../src/sdk/index.ts'
import { createOfficialCoreRuntime } from '../src/v2/official-core-runtime.ts'
import { startV2DesktopHost } from '../src/v2/desktop-host.ts'
import { buildComponentLaunchPlan } from '../src/v2/launch-plan.ts'
import { HostCoreSession, type LoadedCoreComponent } from '../src/v2/host-core-abi.ts'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'))
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

const sel = (id: string, version = '1.0.0') => ({ id, version, manifestHash: 'hash' })
function component(defaultExport: any, category: any): LoadedCoreComponent {
  const manifest: any = { schemaVersion: '0.1', id: defaultExport.manifest.id, version: defaultExport.manifest.version, title: defaultExport.manifest.title, componentType: category === 'core' ? 'core' : 'plugin', ...(category === 'core' ? { hostApi: { version: '0.1' } } : { pluginCategory: category }), entrypoints: { runtime: 'index.mjs' }, integrity: { runtime: 'x' } }
  return { manifest, defaultExport }
}
function plan(coreId: string, plugins: string[]) {
  return { planVersion: '0.1' as const, hostApiVersion: '0.1', core: sel(coreId), plugins: plugins.map(id => sel(id)), stateSchemaVersion: '1', planHash: 'plan' }
}

test('official runtime streams llm chunks through the Host-Core ABI as they are produced', async () => {
  const driver = defineProviderDriver({ id: 'example.driver', version: '1.0.0', title: 'Driver', providerId: 'demo', models: ['demo-1'], async *request() { for (const part of ['a', 'b', 'c']) { await sleep(10); yield { type: 'text', text: part } } yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } } })
  const llm = defineLlmSystem({ id: 'example.llm', version: '1.0.0', title: 'LLM', start() {}, route: () => ({ providerId: 'demo', model: 'demo-1' }) })
  const core = defineCore({ id: 'example.core', version: '1.0.0', title: 'Core', start(ctx) { ctx.ready() } })
  const runtime = createOfficialCoreRuntime(component(core, 'core'))
  const session = new HostCoreSession(plan('example.core', ['example.driver', 'example.llm']), { call: async () => null }, [component(driver, 'provider-driver'), component(llm, 'llm-system')])
  await session.boot(runtime)
  const chunks: any[] = []
  for await (const chunk of session.stream('llm/stream', { llmSystemId: 'example.llm', requestId: 's1', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.text).filter(Boolean), ['a', 'b', 'c'], 'text chunks must arrive in order as they are produced')
  assert.deepEqual(chunks.at(-1), { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }, 'usage chunk terminates the stream')
  await assert.rejects(() => session.stream('solution/assemble', {}).next(), /does not stream operation/)
  await runtime.shutdown!()
})

test('cancelling a running stream releases the producer and ends iteration', async () => {
  let producerReleased = false
  const driver = defineProviderDriver({ id: 'example.driver', version: '1.0.0', title: 'Driver', providerId: 'demo', models: ['demo-1'], async *request(request) {
    try { let index = 0; while (true) { await sleep(10); if (request.signal?.aborted) break; yield { type: 'text', text: `t${index++}` } } } finally { producerReleased = true }
  } })
  const llm = defineLlmSystem({ id: 'example.llm', version: '1.0.0', title: 'LLM', start() {}, route: () => ({ providerId: 'demo', model: 'demo-1' }) })
  const core = defineCore({ id: 'example.core', version: '1.0.0', title: 'Core', start(ctx) { ctx.ready() } })
  const runtime = createOfficialCoreRuntime(component(core, 'core'))
  const session = new HostCoreSession(plan('example.core', ['example.driver', 'example.llm']), { call: async () => null }, [component(driver, 'provider-driver'), component(llm, 'llm-system')])
  await session.boot(runtime)
  const chunks: any[] = []
  const consuming = (async () => { for await (const chunk of session.stream('llm/stream', { llmSystemId: 'example.llm', requestId: 's2', messages: [] })) chunks.push(chunk) })()
  await sleep(55)
  await session.invoke('llm/cancel', { llmSystemId: 'example.llm', requestId: 's2' })
  await consuming
  assert.ok(chunks.length > 0, 'stream must deliver chunks before cancel')
  assert.ok(chunks.length < 50, 'cancel must stop the stream instead of running forever')
  assert.equal(producerReleased, true, 'driver producer must be released after cancel')
  await runtime.shutdown!()
})

function setupStreamingCore(base: string, source: string): void {
  const dir = join(base, 'components', 'example.desktop-core', '1.0.0'); const runtime = join(dir, 'dist', 'index.js')
  mkdirSync(join(dir, 'dist'), { recursive: true }); writeFileSync(runtime, source)
  const manifest = { schemaVersion: '0.1', id: 'example.desktop-core', version: '1.0.0', title: 'Desktop Core', componentType: 'core', entrypoints: { runtime: 'dist/index.js' }, hostApi: { version: '0.1' }, integrity: { runtime: `sha256-${createHash('sha256').update(readFileSync(runtime)).digest('hex')}` } }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const plan = buildComponentLaunchPlan({ core: manifest, plugins: [], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' })
  mkdirSync(join(base, 'data'), { recursive: true })
  writeFileSync(join(base, 'data', 'component-launch-plan.v2.json'), JSON.stringify(plan, null, 2))
}

test('v2 desktop host forwards transfer-level SSE frames and fails closed for stream-less operations', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-stream-')); try {
    setupStreamingCore(base, `export default {
      boot(context) { context.ready() },
      invoke(operation) { return operation },
      async *stream(operation) {
        if (operation === 'count') { for (let i = 1; i <= 3; i++) yield { i } }
        else if (operation === 'fail') { yield { partial: true }; throw new Error('mid-stream failure') }
        else { throw new Error('not streamable: ' + operation) }
      },
    }`)
    const host = await startV2DesktopHost({ userDataRoot: base, port: 0 })
    const address = host.server.address(); const port = typeof address === 'object' && address ? address.port : 0
    const url = `http://127.0.0.1:${port}/api/v2/core/stream`
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ operation: 'count' }) })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const frames = (await response.text()).split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)))
    assert.deepEqual(frames, [{ ok: true, chunk: { i: 1 } }, { ok: true, chunk: { i: 2 } }, { ok: true, chunk: { i: 3 } }, { ok: true, done: true }])

    const failing = await fetch(url, { method: 'POST', body: JSON.stringify({ operation: 'fail' }) })
    const failureFrames = (await failing.text()).split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)))
    assert.deepEqual(failureFrames, [{ ok: true, chunk: { partial: true } }, { ok: false, error: { code: 'stream_failed', message: 'mid-stream failure' } }])

    const notStreamable = await fetch(url, { method: 'POST', body: JSON.stringify({ operation: 'invoke-only' }) })
    assert.equal(notStreamable.status, 503)
    assert.equal(((await notStreamable.json()) as any).error.code, 'stream_unavailable')

    // Client disconnect: the producer is released and the Host keeps serving.
    const controller = new AbortController()
    const aborted = await fetch(url, { method: 'POST', body: JSON.stringify({ operation: 'count' }), signal: controller.signal })
    const reader = aborted.body!.getReader()
    await reader.read()
    controller.abort()
    await sleep(20)
    const echo = await fetch(`http://127.0.0.1:${port}/api/v2/core/invoke`, { method: 'POST', body: JSON.stringify({ operation: 'echo', input: 1 }) })
    assert.equal(echo.status, 200)
    await host.close()
  } finally { rmSync(base, { recursive: true, force: true }) }
})
