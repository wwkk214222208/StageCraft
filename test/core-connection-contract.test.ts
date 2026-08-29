/**
 * W2 Gate C：Core 协议 1.1 契约测试（计划 §3、§10.1）。
 *
 * 覆盖：
 * - 逐连接整形（Q5）：1.0 client 收旧 CoreEvent 与 {ok:true,view}；1.1 client 收 envelope/receipt；
 * - unknown-after-disconnect（§3.3）：提交后连接丢失 → 明确回执，绝不自动重放；
 * - 版本协商（§3.2）：1.0 legacy（无 health）与 1.1（health 支持范围）；无交集 → protocol_incompatible；
 * - 关联过滤（§3.4）：revision 单调、thinking delta 按 requestId、envelope turnId 回合作用域。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { HttpHumanCorePlugin } from '../src/core/http-human-plugin.ts'
import { CORE_PROTOCOL_VERSION } from '../src/core/protocol.ts'
import type { CoreEvent, CoreEventListener, HumanCommand } from '../src/core/protocol.ts'
import {
  isCoreEventEnvelope,
  LocalCoreConnection,
  RemoteCoreConnection,
  shouldDeliverCoreEvent,
  type CoreConnectionMessage,
} from '../src/core/connection.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { CoreClient } from '../public/core-client.js'

function command(id = 'contract-cmd-1'): HumanCommand {
  return { id, actor: 'player', type: 'role-management', payload: { operation: 'test' } }
}

function thinkingEvent(requestId = 'req-1', revision = 1): CoreEvent {
  return { type: 'model.thinking.delta', revision, requestId, text: '思' }
}

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

async function readData(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const deadline = Date.now() + 2_000
  let buffer = ''
  while (Date.now() < deadline) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += new TextDecoder().decode(chunk.value)
    if (buffer.includes('data:')) return buffer
  }
  return buffer
}

/** 组装一个覆盖 health/events/view/commands 的脚本化远端（1.1 或 1.0 形状）。 */
function scriptedRemote(options: {
  health?: { protocolVersion: string; minSupportedProtocolVersion: string; maxSupportedProtocolVersion: string } | 404
  events?: unknown[]
  view?: { protocolVersion: string; revision: number }
  commandResponse?: unknown
  commandFailure?: boolean
}) {
  const seenUrls: string[] = []
  const seenHeaders: Record<string, string>[] = []
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    seenUrls.push(input)
    seenHeaders.push(init.headers as Record<string, string>)
    if (input.endsWith('/api/core/health')) {
      if (options.health === 404) return new Response(null, { status: 404 })
      return Response.json(options.health!)
    }
    if (input.endsWith('/api/core/events')) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(': connected\n\n'))
          for (const event of options.events ?? []) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (input.endsWith('/api/core/view')) return Response.json(options.view ?? { protocolVersion: '1.1', revision: 7 })
    if (input.endsWith('/api/core/commands')) {
      if (options.commandFailure) return Promise.reject(new Error('connection reset'))
      return Response.json(options.commandResponse ?? { ok: true, view: { protocolVersion: '1.1', revision: 8 } })
    }
    return new Response(null, { status: 404 })
  }
  return { fetchImpl, seenUrls, seenHeaders }
}

test('本地连接：1.1 精确版本，dispatchWithReceipt 的 accepted/rejected 与 health/capabilities', async () => {
  const core = new CoreRuntimeSkeleton()
  core.dispatch = async () => undefined
  const connection = new LocalCoreConnection(core)
  assert.equal(connection.protocolVersion, CORE_PROTOCOL_VERSION)

  const accepted = await connection.dispatchWithReceipt(command())
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.requestId, 'contract-cmd-1')
  assert.equal(accepted.revision, accepted.view?.revision)

  core.dispatch = async () => { throw new Error('boom') }
  const rejected = await connection.dispatchWithReceipt(command('contract-cmd-2'))
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.error?.message, 'boom')

  // 实现 getHealth 的 runtime 提供真实 health；未实现时本地连接返回 null（同进程无需伪造）。
  core.getHealth = () => ({
    protocolVersion: '1.1', minSupportedProtocolVersion: '1.0', maxSupportedProtocolVersion: '1.1',
    bridgeVersion: 'test', coreBundleVersion: 'test', coreBundleHash: 'h', pluginSetHash: 'p', stateSchemaVersion: 's', status: 'ready', startedAt: new Date(0).toISOString(),
  })
  const health = await connection.health()
  assert.equal(health?.status, 'ready')
  assert.equal((await connection.capabilities()).length, 0)
})

test('HTTP 1.0 client（无版本头）收到旧 {ok:true,view} 与 raw CoreEvent', async () => {
  const core = new CoreRuntimeSkeleton()
  const dispatched: HumanCommand[] = []
  core.dispatch = async value => { dispatched.push(value) }
  let coreListener: CoreEventListener | undefined
  const originalSubscribe = core.subscribe.bind(core)
  core.subscribe = listener => { coreListener = listener; return originalSubscribe(listener) }
  const plugin = new HttpHumanCorePlugin({ roomId: () => 'room-legacy' })
  plugin.install(core)
  const { server, base } = await openServer(plugin)
  try {
    const response = await fetch(`${base}/api/core/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command()) })
    const body = await response.json() as { ok?: boolean; requestId?: string }
    assert.equal(body.ok, true, '1.0 client 保持 {ok:true,view} 形状')
    assert.equal(body.requestId, undefined, '1.0 client 不得收到 receipt 字段')

    const sse = await fetch(`${base}/api/core/events`)
    const reader = sse.body!.getReader()
    coreListener?.(thinkingEvent())
    const chunk = await readData(reader)
    const data = JSON.parse(chunk.split('data: ')[1]?.split('\n\n')[0] ?? '{}') as CoreEvent
    assert.equal(data.type, 'model.thinking.delta', '1.0 client 收到 raw CoreEvent 而非 envelope')
    assert.equal((data as { roomId?: string }).roomId, undefined)
    await reader.cancel()
  } finally {
    await closeServer(server)
  }
})

test('HTTP 1.1 client 收到 CommandReceipt 与 envelope，health 暴露支持范围', async () => {
  const core = new CoreRuntimeSkeleton()
  const dispatched: HumanCommand[] = []
  core.dispatch = async value => { dispatched.push(value) }
  let coreListener: CoreEventListener | undefined
  const originalSubscribe = core.subscribe.bind(core)
  core.subscribe = listener => { coreListener = listener; return originalSubscribe(listener) }
  const plugin = new HttpHumanCorePlugin({ roomId: () => 'room-1' })
  plugin.install(core)
  const { server, base } = await openServer(plugin)
  try {
    const health = await (await fetch(`${base}/api/core/health`)).json() as { protocolVersion: string; minSupportedProtocolVersion: string; maxSupportedProtocolVersion: string; status: string }
    assert.equal(health.protocolVersion, '1.1')
    assert.equal(health.minSupportedProtocolVersion, '1.0')
    assert.equal(health.maxSupportedProtocolVersion, '1.1')
    assert.equal(health.status, 'ready')

    const response = await fetch(`${base}/api/core/commands`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-core-protocol-version': '1.1' }, body: JSON.stringify(command()) })
    const receipt = await response.json() as { requestId: string; status: string; revision: number; view: { revision: number } }
    assert.equal(receipt.status, 'accepted')
    assert.equal(receipt.requestId, 'contract-cmd-1')
    assert.equal(typeof receipt.revision, 'number')
    assert.ok(receipt.view, '1.1 receipt 携带权威 view')

    const sse = await fetch(`${base}/api/core/events`, { headers: { 'x-core-protocol-version': '1.1' } })
    const reader = sse.body!.getReader()
    coreListener?.(thinkingEvent())
    const chunk = await readData(reader)
    const envelope = JSON.parse(chunk.split('data: ')[1]?.split('\n\n')[0] ?? '{}') as { protocolVersion: string; roomId: string; type: string; payload: CoreEvent }
    assert.ok(isCoreEventEnvelope(envelope), '1.1 client 收到统一事件包')
    assert.equal(envelope.protocolVersion, '1.1')
    assert.equal(envelope.roomId, 'room-1')
    assert.equal(envelope.type, 'model.thinking.delta')
    assert.equal(envelope.payload.requestId, 'req-1')
    await reader.cancel()
  } finally {
    await closeServer(server)
  }
})

test('RemoteCoreConnection → 1.1 server：版本协商、receipt、envelope 解包与 revision 单调过滤', async () => {
  const envelope = (revision: number) => ({
    protocolVersion: '1.1', roomId: 'room-1', revision, turnId: 'turn-1', requestId: 'req-1',
    type: 'model.thinking.delta', payload: thinkingEvent('req-1', revision), createdAt: new Date(0).toISOString(),
  })
  const remote = scriptedRemote({
    health: { protocolVersion: '1.1', minSupportedProtocolVersion: '1.0', maxSupportedProtocolVersion: '1.1' },
    events: [envelope(5), envelope(4), envelope(6)],
    view: { protocolVersion: '1.1', revision: 3 },
    commandResponse: { requestId: 'contract-cmd-1', status: 'accepted', revision: 8, view: { protocolVersion: '1.1', revision: 8 } },
  })
  const connection = new RemoteCoreConnection({ baseUrl: 'http://core.test', session: 's', fetch: remote.fetchImpl })
  const messages: CoreConnectionMessage[] = []
  const unsubscribe = connection.subscribe(message => messages.push(message))
  await connection.reconnect()
  assert.equal(connection.protocolVersion, '1.1')
  assert.ok(remote.seenHeaders.every(headers => headers['x-core-protocol-version'] === '1.1'), '所有请求携带客户端版本头')

  const receipt = await connection.dispatchWithReceipt(command())
  assert.equal(receipt.status, 'accepted')
  assert.equal(receipt.view?.revision, 8)

  await new Promise(resolve => setTimeout(resolve, 30))
  const events = messages.filter((message): message is Extract<CoreConnectionMessage, { type: 'core.event' }> => message.type === 'core.event')
  assert.deepEqual(events.map(message => message.envelope?.revision), [5, 6], 'revision 4 过期，被单调过滤丢弃（resync 地板 = view.revision 3）')
  assert.equal(events[0].envelope?.turnId, 'turn-1')
  assert.equal(events[0].event.type, 'model.thinking.delta')
  unsubscribe()
})

test('RemoteCoreConnection → 1.0 server：legacy 模式下 {ok,view} 归一化为 accepted，raw 事件无 envelope', async () => {
  const remote = scriptedRemote({
    health: 404,
    events: [thinkingEvent('req-legacy', 2)],
    view: { protocolVersion: '1.0', revision: 1 },
    commandResponse: { ok: true, view: { protocolVersion: '1.0', revision: 2 } },
  })
  const connection = new RemoteCoreConnection({ baseUrl: 'http://legacy.test', session: 's', fetch: remote.fetchImpl })
  const messages: CoreConnectionMessage[] = []
  const unsubscribe = connection.subscribe(message => messages.push(message))
  await connection.reconnect()
  assert.equal(connection.protocolVersion, '1.0', '无 health 的服务端按 1.0 legacy 对待')
  assert.equal((await connection.health()), null)
  assert.deepEqual(await connection.capabilities(), [])

  const receipt = await connection.dispatchWithReceipt(command())
  assert.deepEqual(
    { status: receipt.status, revision: receipt.revision, hasView: Boolean(receipt.view) },
    { status: 'accepted', revision: 2, hasView: true },
    '1.0 {ok:true,view} 归一化为 accepted receipt',
  )
  assert.equal(typeof receipt.requestId, 'string')

  await new Promise(resolve => setTimeout(resolve, 30))
  const events = messages.filter((message): message is Extract<CoreConnectionMessage, { type: 'core.event' }> => message.type === 'core.event')
  assert.equal(events.length, 1)
  assert.equal(events[0].envelope, undefined, '1.0 legacy 不产生 envelope')
  assert.equal(events[0].event.type, 'model.thinking.delta')
  unsubscribe()
})

test('提交后连接丢失 → unknown-after-disconnect，dispatch() 抛错且不重放', async () => {
  const remote = scriptedRemote({ health: 404, commandFailure: true })
  const connection = new RemoteCoreConnection({ baseUrl: 'http://lost.test', session: 's', fetch: remote.fetchImpl })
  const receipt = await connection.dispatchWithReceipt(command('lost-cmd'))
  assert.deepEqual(
    { status: receipt.status, code: receipt.error?.code },
    { status: 'unknown-after-disconnect', code: 'connection_lost' },
  )
  await assert.rejects(connection.dispatch(command('lost-cmd')), /unknown after disconnect/)
})

test('revision 地板 = 权威 view revision：取 view 期间缓存的旧事件必须丢弃（评审修订）', async () => {
  const envelope = (revision: number) => ({
    protocolVersion: '1.1', roomId: 'room-1', revision, turnId: 'turn-9', requestId: 'req-9',
    type: 'model.thinking.delta', payload: thinkingEvent('req-9', revision), createdAt: new Date(0).toISOString(),
  })
  const remote = scriptedRemote({
    health: { protocolVersion: '1.1', minSupportedProtocolVersion: '1.0', maxSupportedProtocolVersion: '1.1' },
    // SSE 先于 view 建立：9/10/11 都在取 view 前入队（view revision = 10）
    events: [envelope(9), envelope(10), envelope(11)],
    view: { protocolVersion: '1.1', revision: 10 },
  })
  const connection = new RemoteCoreConnection({ baseUrl: 'http://floor.test', session: 's', fetch: remote.fetchImpl })
  const messages: CoreConnectionMessage[] = []
  const unsubscribe = connection.subscribe(message => messages.push(message))
  await connection.reconnect()
  await new Promise(resolve => setTimeout(resolve, 30))
  const events = messages.filter((message): message is Extract<CoreConnectionMessage, { type: 'core.event' }> => message.type === 'core.event')
  assert.deepEqual(events.map(message => message.envelope?.revision), [10, 11],
    'revision 9 低于权威 view revision 10，必须丢弃；10/11 才可继续')
  unsubscribe()
})

test('版本支持范围无交集 → protocol_incompatible，不进入事件消费且不自动重试', async () => {
  const remote = scriptedRemote({
    health: { protocolVersion: '1.2', minSupportedProtocolVersion: '1.2', maxSupportedProtocolVersion: '1.2' },
  })
  const connection = new RemoteCoreConnection({ baseUrl: 'http://future.test', session: 's', fetch: remote.fetchImpl })
  const messages: CoreConnectionMessage[] = []
  const unsubscribe = connection.subscribe(message => messages.push(message))
  await assert.rejects(connection.reconnect(), /支持范围/)
  const errors = messages.filter(message => message.type === 'connection.error') as Array<{ type: string; code?: string; message: string }>
  assert.equal(errors[0]?.code, 'protocol_incompatible')
  assert.match(errors[0]?.message ?? '', /\[1\.2, 1\.2\]/)
  assert.ok(!remote.seenUrls.some(url => url.endsWith('/api/core/events')), '版本不兼容时不得订阅事件流')
  // 确定性失败不重连：等待超过重连退避窗口后 health 探测次数不得增长
  const healthCalls = remote.seenUrls.filter(url => url.endsWith('/api/core/health')).length
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.equal(remote.seenUrls.filter(url => url.endsWith('/api/core/health')).length, healthCalls, 'protocol_incompatible 后不得继续重连')
  unsubscribe()
})

test('shouldDeliverCoreEvent 关联规则：revision 单调 / requestId 关联 / turnId 作用域', () => {
  const envelope = (overrides: Record<string, unknown>) => ({
    protocolVersion: '1.1', roomId: 'r', revision: 5, type: 'model.thinking.delta',
    payload: thinkingEvent(), createdAt: new Date(0).toISOString(), ...overrides,
  })
  const event = (overrides: Partial<CoreEvent> = {}) => ({ type: 'core.event' as const, event: { ...thinkingEvent(), ...overrides } })

  assert.equal(shouldDeliverCoreEvent(event(), { revision: 6 }), false, '旧 revision 直接丢弃')
  assert.equal(shouldDeliverCoreEvent(event({ revision: 6 }), { revision: 6 }), true, '等于当前 revision 放行')
  assert.equal(shouldDeliverCoreEvent(event(), { requestId: 'other' }), false, 'thinking delta 只进入对应 requestId')
  assert.equal(shouldDeliverCoreEvent(event({ requestId: 'req-1' }), { requestId: 'req-1' }), true)
  assert.equal(shouldDeliverCoreEvent({ type: 'core.event', event: thinkingEvent(), envelope: envelope({ turnId: 'turn-old' }) }, { turnId: 'turn-new' }), false, 'envelope turnId 不匹配当前回合不渲染')
  assert.equal(shouldDeliverCoreEvent({ type: 'core.event', event: thinkingEvent(), envelope: envelope({ turnId: undefined }) }, { turnId: 'turn-new' }), true, 'envelope 无 turnId 时无法判定，放行')
  assert.equal(shouldDeliverCoreEvent({ type: 'core.resync' } as unknown as Parameters<typeof shouldDeliverCoreEvent>[0], {}), true, '非 core.event 消息不受过滤影响')
})

test('浏览器 CoreClient：1.1 receipt、envelope 解包与 resync 后 revision 地板', async () => {
  const encoder = new TextEncoder()
  const received: Array<Record<string, unknown>> = []
  const envelopeOf = (revision: number) => ({
    protocolVersion: '1.1', roomId: 'room-1', revision, type: 'model.thinking.delta',
    payload: { type: 'model.thinking.delta', revision, requestId: 'req-9', text: 't' }, createdAt: new Date(0).toISOString(),
  })
  let commandCalls = 0
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (input.endsWith('/health')) return Response.json({ protocolVersion: '1.1', minSupportedProtocolVersion: '1.0', maxSupportedProtocolVersion: '1.1' })
    if (input.endsWith('/events')) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelopeOf(4))}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelopeOf(3))}\n\n`))
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (input.endsWith('/view')) return Response.json({ protocolVersion: '1.1', revision: 3, state: {}, workflows: [], interactions: [], actions: [], availableCommands: [], recentEvents: [] })
    if (input.endsWith('/commands')) {
      commandCalls += 1
      assert.equal((init.headers as Record<string, string>)['x-core-protocol-version'], '1.1')
      return Response.json({ requestId: 'browser-cmd', status: 'accepted', revision: 5, view: { protocolVersion: '1.1', revision: 5 } })
    }
    if (input.endsWith('/cancel')) return Response.json({ ok: true })
    return new Response(null, { status: 404 })
  }
  const client = new CoreClient({ viewPath: 'http://b.test/view', eventsPath: 'http://b.test/events', commandPath: 'http://b.test/commands', healthPath: 'http://b.test/health', cancelPath: 'http://b.test/cancel', capabilitiesPath: 'http://b.test/capabilities', fetchImpl })
  const unsubscribe = client.subscribe(message => received.push(message))
  await new Promise(resolve => setTimeout(resolve, 20))

  const receipt = await client.dispatchWithReceipt({ id: 'browser-cmd', actor: 'player', type: 'approve' })
  assert.equal(receipt.status, 'accepted')
  assert.equal(commandCalls, 1)
  assert.equal(await client.cancel('req-9'), true)
  assert.ok(await client.getHealth())

  const events = received.filter(message => message.type === 'core.event')
  assert.deepEqual(events.map(message => (message.envelope as { revision: number }).revision), [4], 'revision 3 低于 resync 地板被丢弃')
  assert.equal((events[0].event as { requestId: string }).requestId, 'req-9', 'envelope 解包后仍投递原始 CoreEvent')
  unsubscribe()
})

test('浏览器 CoreClient：版本支持范围无交集 → protocol_incompatible，不订阅不重试（评审修订）', async () => {
  const seen: string[] = []
  const fetchImpl = async (input: string): Promise<Response> => {
    seen.push(input)
    if (input.endsWith('/health')) return Response.json({ protocolVersion: '1.2', minSupportedProtocolVersion: '1.2', maxSupportedProtocolVersion: '1.2' })
    return new Response(null, { status: 404 })
  }
  const client = new CoreClient({ viewPath: 'http://future.test/view', eventsPath: 'http://future.test/events', commandPath: 'http://future.test/commands', healthPath: 'http://future.test/health', cancelPath: 'http://future.test/cancel', capabilitiesPath: 'http://future.test/capabilities', fetchImpl })
  const received: Array<Record<string, unknown>> = []
  client.subscribe(message => received.push(message))
  await new Promise(resolve => setTimeout(resolve, 600))
  const errors = received.filter(message => message.type === 'connection.error') as Array<{ code?: string; message: string }>
  assert.equal(errors[0]?.code, 'protocol_incompatible', '浏览器端必须报告版本无交集')
  assert.match(errors[0]?.message ?? '', /\[1\.2, 1\.2\]/)
  assert.ok(!seen.some(url => url.endsWith('/events')), '不得订阅事件流')
  assert.ok(!seen.some(url => url.endsWith('/view')), '不得拉取权威 view')
  const healthCalls = seen.filter(url => url.endsWith('/health')).length
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(seen.filter(url => url.endsWith('/health')).length, healthCalls, '不进入重连循环')
  client.close()
})
