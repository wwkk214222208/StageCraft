import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:http'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { HttpHumanCorePlugin } from '../src/core/http-human-plugin.ts'
import { LocalCoreConnection, RemoteCoreConnection, type CoreConnectionMessage } from '../src/core/connection.ts'
import type { HumanCommand } from '../src/core/protocol.ts'

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function openCoreServer(plugin: HttpHumanCorePlugin): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (request, response) => {
    try {
      const handled = await plugin.handle(request, response, new URL(request.url ?? '/', `http://${request.headers.host}`))
      if (!handled) { response.writeHead(404); response.end() }
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as { port: number }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.() })
}

const command = (): HumanCommand => ({ id: 'connection-command', actor: 'player', type: 'role-management', payload: { operation: 'test' } })

test('LocalCoreConnection and RemoteCoreConnection expose the same defensive protocol', async () => {
  const core = new CoreRuntimeSkeleton()
  const received: HumanCommand[] = []
  core.dispatch = async value => { received.push(structuredClone(value)) }
  const local = new LocalCoreConnection(core)
  const plugin = new HttpHumanCorePlugin()
  const installation = plugin.install(core)
  const { server, baseUrl } = await openCoreServer(plugin)
  const remote = new RemoteCoreConnection({ baseUrl, session: 'test-session' })
  try {
    const localView = await local.getView()
    const remoteView = await remote.getView()
    assert.deepEqual(remoteView, localView)
    ;(localView.state as any).mutated = true
    assert.equal((core.getView().state as any).mutated, undefined)

    const localResult = await local.dispatch(command())
    const remoteResult = await remote.dispatch({ ...command(), id: 'remote-command' })
    assert.equal(localResult.ok, true)
    assert.equal(remoteResult.ok, true)
    assert.equal(received.length, 2)

    const localMessages: CoreConnectionMessage[] = []
    const release = local.subscribe(message => localMessages.push(message))
    await local.reconnect()
    assert.ok(localMessages.some(message => message.type === 'core.resync'))
    release(); release()
  } finally {
    remote.dispose(); local.dispose()
    await installation.dispose()
    await closeServer(server)
  }
})

test('RemoteCoreConnection buffers the stream before resync, reconnects, and never replays commands', async () => {
  const encoder = new TextEncoder()
  const messages: CoreConnectionMessage[] = []
  const order: string[] = []
  let eventRequests = 0
  let viewRequests = 0
  let commandRequests = 0
  const streamAborts = new Set<number>()
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer secret-session')
    if (input.endsWith('/api/core/events')) {
      eventRequests++
      order.push(`events:${eventRequests}`)
      const sequence = eventRequests
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener('abort', () => { streamAborts.add(sequence); try { controller.close() } catch {} }, { once: true })
          if (sequence === 1) {
            // Split the field name, JSON, and every CRLF boundary across chunks.
            for (const part of [
              'da', 'ta: {\r', '\nda', 'ta: "type": "model.thinking.delta",\r', '\ndata: "revision": 1,\r',
              '\ndata: "requestId": "gap",\r', '\ndata: "text": "x"\r', '\ndata: }\r', '\n\r', '\n',
            ]) controller.enqueue(encoder.encode(part))
            controller.enqueue(encoder.encode('data: {"type":"state.changed","revision":1,"source":"carriage-return"}\r\r'))
            controller.close()
          } else controller.enqueue(encoder.encode(': connected\n\n'))
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (input.endsWith('/api/core/view')) {
      viewRequests++
      order.push(`view:${viewRequests}`)
      return Response.json({ protocolVersion: '1.0', revision: viewRequests, state: {}, workflows: [], interactions: [], actions: [], availableCommands: [], recentEvents: [] })
    }
    if (input.endsWith('/api/core/commands')) {
      commandRequests++
      return Response.json({ ok: true, view: { protocolVersion: '1.0', revision: 2, state: {}, workflows: [], interactions: [], actions: [], availableCommands: [], recentEvents: [] } })
    }
    return new Response(null, { status: 404 })
  }
  const connection = new RemoteCoreConnection({
    baseUrl: 'http://remote.test', session: 'secret-session', fetch: fetchImpl,
    reconnectInitialMs: 1, reconnectMaxMs: 2, delay: async () => undefined,
  })
  connection.subscribe(message => messages.push(message))
  await waitFor(() => messages.filter(message => message.type === 'core.resync').length >= 2)
  assert.deepEqual(order.slice(0, 4), ['events:1', 'view:1', 'events:2', 'view:2'])
  const firstResync = messages.findIndex(message => message.type === 'core.resync')
  const gapEvent = messages.findIndex(message => message.type === 'core.event' && message.event.type === 'model.thinking.delta')
  assert.ok(firstResync >= 0 && gapEvent > firstResync)
  assert.ok(messages.some(message => message.type === 'core.event' && message.event.type === 'state.changed' && message.event.source === 'carriage-return'))
  assert.deepEqual(messages.slice(0, firstResync).filter(message => message.type === 'connection.state').map(message => message.state), ['connecting', 'connected'])
  assert.ok(messages.some(message => message.type === 'core.resync' && message.reason === 'reconnect' && message.revision === 2))
  await connection.dispatch(command())
  assert.equal(commandRequests, 1)

  const manualStart = messages.length
  await connection.reconnect()
  const manualMessages = messages.slice(manualStart)
  const manualResync = manualMessages.findIndex(message => message.type === 'core.resync' && message.reason === 'manual')
  assert.ok(manualResync >= 0)
  assert.deepEqual(manualMessages.slice(0, manualResync).filter(message => message.type === 'connection.state').map(message => message.state), ['disconnected', 'connecting', 'connected'])
  assert.ok(streamAborts.has(2))

  connection.dispose(); connection.dispose()
  await waitFor(() => streamAborts.has(3))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(commandRequests, 1)
  assert.equal(connection.state, 'disposed')
})
