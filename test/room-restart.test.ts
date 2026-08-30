// R13：/api/restart 必须走业务 room.restart（重开剧本），不触发宿主重启
import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreBusinessPortableHandler, CORE_BUSINESS_ROUTES } from '../src/portable/core-business-handlers.ts'
import { API_ROUTES } from '../src/api-route-registry.ts'

function apiRequest(method, path, body) {
  return {
    method,
    url: path,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body)),
    signal: AbortSignal.timeout(5000),
  }
}
async function bodyText(response) { return new TextDecoder().decode(response.body) }

test('R13：/api/restart 注册为 core 业务路由（room.restart，非 host.restart）', () => {
  const route = API_ROUTES.find(r => r.method === 'POST' && r.pattern === '/api/restart')
  assert.ok(route, '/api/restart 必须注册')
  assert.equal(route.owner, 'core', '必须是 core owner（业务语义）')
  assert.equal(route.handlerId, 'room.restart', '必须指向业务 room.restart')
})

test('R13：/api/host/restart 保留宿主重启（main-host + host.restart）', () => {
  const route = API_ROUTES.find(r => r.method === 'POST' && r.pattern === '/api/host/restart')
  assert.ok(route, '/api/host/restart 必须注册')
  assert.equal(route.owner, 'main-host', '必须是 main-host owner')
  assert.equal(route.handlerId, 'host.restart', '必须指向 host.restart')
})

test('R13：room.restart 按 storyId 重开剧本（调 facade.restart + 返回 ok）', async () => {
  const calls = []
  const story = { id: 'eldoria', title: 'Eldoria' }
  const facade = {
    story: async (id) => { calls.push('story:' + id); return story },
    restart: (s, options) => { calls.push('restart:' + s.id + ':' + JSON.stringify(options)) },
    invokeSync: () => null,
  }
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('POST', '/api/restart', { storyId: 'eldoria', mode: 'chat', autoPublish: true }))
  assert.equal(response.status, 200)
  const body = JSON.parse(await bodyText(response))
  assert.equal(body.ok, true)
  assert.ok(calls.some(c => c === 'story:eldoria'), '必须读取剧本')
  assert.ok(calls.some(c => c.startsWith('restart:eldoria:')), '必须调 facade.restart')
  const restartCall = calls.find(c => c.startsWith('restart:'))
  assert.ok(restartCall.includes('"mode":"chat"'), 'mode 必须传递')
  assert.ok(restartCall.includes('"autoPublish":true'), 'autoPublish 必须传递')
})

test('R13：room.restart 缺失 storyId 返回 400', async () => {
  const facade = { story: async () => null, restart: () => {}, invokeSync: () => null }
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('POST', '/api/restart', {}))
  assert.equal(response.status, 400)
})
