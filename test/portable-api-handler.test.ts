/**
 * W4：可移植 handler 对等性测试（计划 §1.4：可移植 handler 在桌面与 harness 上
 * 产生同构响应；桌面与 Android 对同一协议 fixture 产生相同结果）。
 *
 * 验证：
 * 1. CoreProtocolPortableHandler 不依赖 node:http，直接以 ApiRequest 调用；
 * 2. 同一请求 fixture，portable handler 输出与桌面 HTTP 端点（HttpHumanCorePlugin）
 *    输出同构（1.1 receipt / 1.0 旧形状 / cancel / capabilities / ui-action）；
 * 3. handlePortableApi 分发：未命中 404。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { HttpHumanCorePlugin } from '../src/core/http-human-plugin.ts'
import { CoreProtocolPortableHandler, handlePortableApi, buildPortableCoverage, unhandledPortableRoutes, type ApiRequest, type ApiResponse } from '../src/portable/api-handler.ts'

function makeCore(dispatchError?: Error): CoreRuntimeSkeleton {
  const core = new CoreRuntimeSkeleton()
  // 覆盖 dispatch：测试核心逻辑不需要完整 Cordis 装配（与 core-connection-contract 同法）
  core.dispatch = dispatchError ? async () => { throw dispatchError } : async () => undefined
  core.getHealth = () => ({
    protocolVersion: '1.1', minSupportedProtocolVersion: '1.0', maxSupportedProtocolVersion: '1.1',
    bridgeVersion: 'test', coreBundleVersion: 'test', coreBundleHash: 'h', pluginSetHash: 'p', stateSchemaVersion: 's', status: 'ready', startedAt: new Date(0).toISOString(),
  })
  core.getCapabilities = () => [{ id: 'core.protocol', supported: true, mode: 'full' }]
  return core
}

function apiRequest(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): ApiRequest {
  return {
    method,
    url: path,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body)),
    signal: AbortSignal.timeout(5000),
  }
}

async function bodyText(response: ApiResponse): Promise<string> {
  if (response.body instanceof Uint8Array) return new TextDecoder().decode(response.body)
  if (response.body) {
    let text = ''
    for await (const chunk of response.body) text += new TextDecoder().decode(chunk)
    return text
  }
  return ''
}

/** 桌面 HTTP 端点：起真实 node:http server，请求后返回 (status, body)。 */
async function httpEndpoint(core: CoreRuntimeSkeleton, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const plugin = new HttpHumanCorePlugin({ roomId: () => 'room-1' })
  plugin.install(core)
  const server = createServer(async (request, response) => {
    try {
      if (await plugin.handle(request, response, new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`))) return
      response.writeHead(404); response.end()
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
  server.listen(0, '127.0.0.1')
  const address = await new Promise<{ port: number }>((resolve, reject) => {
    const deadline = Date.now() + 5000
    const tick = (): void => {
      const value = server.address()
      if (value && typeof value === 'object') resolve(value as { port: number })
      else if (Date.now() > deadline) reject(new Error('server did not start'))
      else setTimeout(tick, 5)
    }
    tick()
  })
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.text() }
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.() })
  }
}

test('portable handler：1.1 receipt 与桌面 HTTP 端点同构', async () => {
  const core = makeCore()
  const portable = new CoreProtocolPortableHandler(core, { roomId: () => 'room-1' })
  const command = { id: 'cmd-1', actor: 'player' as const, type: 'role-management' as const, payload: { operation: 'test' } }

  const portableResponse = await portable.handle(apiRequest('POST', '/api/core/commands', command, { 'x-core-protocol-version': '1.1' }))
  const httpResponse = await httpEndpoint(core, 'POST', '/api/core/commands', command, { 'x-core-protocol-version': '1.1' })

  assert.equal(portableResponse.status, 200)
  assert.equal(httpResponse.status, 200)
  const portableBody = JSON.parse(await bodyText(portableResponse)) as { requestId: string; status: string; revision: number; view: { revision: number } }
  const httpBody = JSON.parse(httpResponse.body) as { requestId: string; status: string; revision: number; view: { revision: number } }
  assert.equal(portableBody.status, 'accepted')
  assert.equal(portableBody.requestId, 'cmd-1')
  assert.deepEqual(
    { status: portableBody.status, requestId: portableBody.requestId, revision: portableBody.revision },
    { status: httpBody.status, requestId: httpBody.requestId, revision: httpBody.revision },
    'portable 与桌面 HTTP 的 receipt 必须同构',
  )
})

test('portable handler：1.0 旧形状 {ok:true,view} 与桌面一致；rejected 回执一致', async () => {
  const core = makeCore()
  const portable = new CoreProtocolPortableHandler(core, { roomId: () => 'room-1' })
  const command = { id: 'cmd-legacy', actor: 'player' as const, type: 'role-management' as const, payload: { operation: 'test' } }

  const portable1_0 = await portable.handle(apiRequest('POST', '/api/core/commands', command))
  const http1_0 = await httpEndpoint(core, 'POST', '/api/core/commands', command)
  const portableBody = JSON.parse(await bodyText(portable1_0)) as { ok: boolean }
  const httpBody = JSON.parse(http1_0.body) as { ok: boolean }
  assert.equal(portableBody.ok, true, '1.0 client 收 {ok:true,view}')
  assert.deepEqual(portableBody, httpBody, '1.0 形状必须与桌面一致')

  // rejected：dispatch 抛错 → 1.1 receipt rejected + error
  const failing = makeCore(new Error('boom'))
  const portableFail = new CoreProtocolPortableHandler(failing, { roomId: () => 'room-1' })
  const rejected = await portableFail.handle(apiRequest('POST', '/api/core/commands', command, { 'x-core-protocol-version': '1.1' }))
  const rejectedBody = JSON.parse(await bodyText(rejected)) as { status: string; error: { code: string; message: string } }
  assert.equal(rejectedBody.status, 'rejected')
  assert.equal(rejectedBody.error.code, 'command_failed')
  assert.equal(rejectedBody.error.message, 'boom')
})

test('portable handler：health/capabilities/cancel/view 与桌面一致', async () => {
  const core = makeCore()
  const portable = new CoreProtocolPortableHandler(core, { roomId: () => 'room-1' })

  for (const [method, path] of [['GET', '/api/core/health'], ['GET', '/api/core/capabilities'], ['GET', '/api/core/view']] as const) {
    const portableResponse = await portable.handle(apiRequest(method, path))
    const httpResponse = await httpEndpoint(core, method, path)
    assert.equal(portableResponse.status, httpResponse.status, `${method} ${path} 状态一致`)
    const portableBody = JSON.parse(await bodyText(portableResponse))
    const httpBody = JSON.parse(httpResponse.body)
    assert.deepEqual(portableBody, httpBody, `${method} ${path} 响应必须同构`)
  }

  const cancelResponse = await portable.handle(apiRequest('POST', '/api/core/cancel', { requestId: 'req-1' }))
  assert.equal(cancelResponse.status, 200)
  const cancelBody = JSON.parse(await bodyText(cancelResponse)) as { ok: boolean; requestId: string }
  assert.equal(cancelBody.ok, true)
  assert.equal(cancelBody.requestId, 'req-1')
})

test('portable handler：未命中返回 404（与桌面 404 语义一致）', async () => {
  const core = makeCore()
  const portable = new CoreProtocolPortableHandler(core)
  const response = await portable.handle(apiRequest('GET', '/api/core/definitely-not'))
  assert.equal(response.status, 404)
  const body = JSON.parse(await bodyText(response)) as { error: { code: string } }
  assert.equal(body.error.code, 'not_found')
})

test('handlePortableApi 分发：按 matches 路由，未命中 404', async () => {
  const core = makeCore()
  const handler = new CoreProtocolPortableHandler(core)
  const hit = await handlePortableApi([handler], apiRequest('GET', '/api/core/view'))
  assert.equal(hit.status, 200)
  const miss = await handlePortableApi([handler], apiRequest('GET', '/api/room'))
  assert.equal(miss.status, 404)
  const body = JSON.parse(await bodyText(miss)) as { error: { code: string } }
  assert.equal(body.error.code, 'not_found')
})

test('portable handler：ui/action 委托与桌面一致', async () => {
  const core = makeCore()
  ;(core as { invokeUiAction?: unknown }).invokeUiAction = async (actionId: string, input: unknown) => ({ actionId, echoed: input })
  const portable = new CoreProtocolPortableHandler(core)
  const response = await portable.handle(apiRequest('POST', '/api/core/ui/action', { actionId: 'a1', input: { x: 1 }, owner: 'test' }))
  assert.equal(response.status, 200)
  const body = JSON.parse(await bodyText(response)) as { ok: boolean; actionId: string; output: { actionId: string; echoed: unknown } }
  assert.equal(body.ok, true)
  assert.equal(body.actionId, 'a1')
  assert.deepEqual(body.output, { actionId: 'a1', echoed: { x: 1 } })
})

test('W4 抽取边界：portable matches 与 registry core owner /api/core/* 非流路由一致', async () => {
  const { API_ROUTES } = await import('../src/api-route-registry.ts')
  const core = makeCore()
  const portable = new CoreProtocolPortableHandler(core)
  const registryCoreRoutes = API_ROUTES.filter(route => route.owner === 'core' && route.pattern.startsWith('/api/core/'))
  assert.ok(registryCoreRoutes.length >= 6, 'registry 必须登记 core 协议路由')

  for (const route of registryCoreRoutes) {
    const path = route.pattern.replace(/[{}]/g, 'x') // 参数 pattern 取形状
    const matched = portable.matches(route.method, path)
    if (route.stream) {
      // SSE 路由由 HTTP 层承载（流式响应），不要求 portable matches——但必须被 registry 登记
      assert.equal(route.handlerId, 'core.events', 'core SSE 路由必须登记')
    } else {
      assert.ok(matched, `portable 必须覆盖 registry 登记的非流 core 路由：${route.method} ${route.pattern}`)
    }
  }
  // 反例：portable 不得覆盖未登记的 core 路径
  assert.equal(portable.matches('GET', '/api/core/not-registered'), false)
})

test('W4 合流契约：buildPortableCoverage 覆盖清单与 registry handlerId 对应（回应 W5-5）', async () => {
  const { API_ROUTES } = await import('../src/api-route-registry.ts')
  const core = makeCore()
  const portable = new CoreProtocolPortableHandler(core)
  const registrations = buildPortableCoverage(API_ROUTES, [portable])

  // 全部 111 条路由都有 registration 条目（handlerId 一一对应）
  assert.equal(registrations.length, API_ROUTES.length)
  for (const registration of registrations) {
    assert.ok(registration.handlerId, '每条路由必须有 handlerId')
  }

  // core owner /api/core/* 非流端点已挂载（handlerId 精确对应）
  const coreProtocol = registrations.filter(registration =>
    registration.handlerId.startsWith('core.') && registration.pattern.startsWith('/api/core/'))
  const mounted = coreProtocol.filter(registration => registration.handler !== null)
  assert.equal(mounted.length, 6, '6 个 core 协议非流端点必须挂载')
  assert.deepEqual(
    mounted.map(registration => registration.handlerId).sort(),
    ['core.cancel', 'core.capabilities', 'core.commands', 'core.health', 'core.ui.action', 'core.view'],
    '已挂载 handlerId 必须与 registry 一致',
  )

  // SSE 路由由 HTTP 层承载：登记为未挂载但明确存在
  const sse = registrations.find(registration => registration.handlerId === 'core.events')
  assert.ok(sse, 'core.events 必须在清单中')
  assert.equal(sse.handler, null, 'SSE 由 HTTP 层承载，portable 不挂载')

  // 未挂载清单：其余业务路由（room/turn/role/...）稳定列出，供 W5/W6 挂载或提供稳定结果
  const unhandled = unhandledPortableRoutes(registrations)
  assert.ok(unhandled.length > 80, '未挂载路由必须稳定存在（业务路由由 W6 接入）')
  assert.ok(unhandled.some(registration => registration.handlerId === 'room.snapshot'), 'room.snapshot 必须列入未挂载清单')
  assert.ok(unhandled.some(registration => registration.handlerId === 'turn.start'), 'turn.start 必须列入未挂载清单')
})
