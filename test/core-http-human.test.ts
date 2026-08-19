import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { HttpHumanCorePlugin } from '../src/core/http-human-plugin.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import type { CoreEvent, CoreEventListener, HumanCommand } from '../src/core/protocol.ts'

type RunningServer = { server: Server; base: string }

async function openServer(plugin: HttpHumanCorePlugin): Promise<RunningServer> {
  const server = createServer(async (request, response) => {
    try {
      if (await plugin.handle(request, response, new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`))) return
      response.writeHead(404)
      response.end()
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
  server.listen(0, '127.0.0.1')
  const address = await new Promise<{ port: number }>((resolve, reject) => {
    const deadline = Date.now() + 5_000
    const tick = (): void => {
      const value = server.address()
      if (value && typeof value === 'object') resolve(value as { port: number })
      else if (Date.now() > deadline) reject(new Error('server did not start'))
      else setTimeout(tick, 5)
    }
    tick()
  })
  return { server, base: `http://127.0.0.1:${address.port}` }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => {
    server.close(() => resolve())
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  })
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition did not become true')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function readData(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return ''
    const text = new TextDecoder().decode(chunk.value)
    if (text.includes('data:')) return text
  }
}

function command(): HumanCommand {
  return { id: 'http-command-1', actor: 'player', type: 'role-management', payload: { operation: 'test' } }
}

function event(requestId = 'http-event-1'): CoreEvent {
  return { type: 'model.thinking.delta', revision: 1, requestId, text: '流' }
}

test('HttpHumanCorePlugin handles Core view, commands and SSE broadcast to multiple clients', async () => {
  const core = new CoreRuntimeSkeleton()
  const dispatched: HumanCommand[] = []
  core.dispatch = async value => { dispatched.push(value) }
  let coreListener: CoreEventListener | undefined
  const originalSubscribe = core.subscribe.bind(core)
  core.subscribe = listener => {
    coreListener = listener
    return originalSubscribe(listener)
  }
  const plugin = new HttpHumanCorePlugin()
  const installation = plugin.install(core)
  const { server, base } = await openServer(plugin)
  try {
    const viewResponse = await fetch(`${base}/api/core/view`)
    assert.equal(viewResponse.status, 200)
    assert.equal((await viewResponse.json() as { protocolVersion: string }).protocolVersion, '1.0')

    const commandResponse = await fetch(`${base}/api/core/commands`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command()),
    })
    assert.equal(commandResponse.status, 200)
    assert.equal((await commandResponse.json() as { ok: boolean }).ok, true)
    assert.deepEqual(dispatched, [command()])

    const abortA = new AbortController()
    const abortB = new AbortController()
    const [clientA, clientB] = await Promise.all([
      fetch(`${base}/api/core/events`, { signal: abortA.signal }),
      fetch(`${base}/api/core/events`, { signal: abortB.signal }),
    ])
    assert.equal(clientA.status, 200)
    assert.equal(clientB.status, 200)
    assert.equal(plugin.activeSseCount, 2)
    const readerA = clientA.body!.getReader()
    const readerB = clientB.body!.getReader()
    coreListener?.(event())
    const [chunkA, chunkB] = await Promise.all([readData(readerA), readData(readerB)])
    assert.match(chunkA, /http-event-1/)
    assert.match(chunkB, /http-event-1/)

    await readerA.cancel()
    abortA.abort()
    await waitFor(() => plugin.activeSseCount === 1)
    await readerB.cancel()
    abortB.abort()
    await waitFor(() => plugin.activeSseCount === 0)
  } finally {
    await installation.dispose()
    await closeServer(server)
  }
})

test('HttpHumanCorePlugin dispose ends SSE, unbinds Core and is idempotent', async () => {
  const core = new CoreRuntimeSkeleton()
  const plugin = new HttpHumanCorePlugin()
  const installation = plugin.install(core)
  const { server, base } = await openServer(plugin)
  try {
    const abort = new AbortController()
    const response = await fetch(`${base}/api/core/events`, { signal: abort.signal })
    const reader = response.body!.getReader()
    assert.equal(plugin.activeSseCount, 1)
    await reader.read() // connected 注释块
    await installation.dispose()
    const closed = await reader.read()
    assert.equal(closed.done, true)
    await reader.cancel()
    assert.equal(plugin.activeSseCount, 0)
    await installation.dispose()
    await assert.rejects(plugin.dispatch(command()), /not installed/)
    abort.abort()
  } finally {
    await closeServer(server)
  }
})
