/**
 * W1 Gate B：ApiRouteRegistry 完备性与匹配语义测试（计划 v0.4 §1.4 / §10.1）。
 *
 * 不校验 owner 草案的正确性（那是合流评审的裁决），只校验边界闭合：
 *  - 前端（public/app.js）出现的每个 /api 路径与调用 method 必须在 registry 中有唯一 owner；
 *  - 桌面（src/app-boot.ts）与 Android shim（local-runtime-web-entry.js）登记的路由也必须被覆盖；
 *  - registry JSON 产物确定性生成，供 Java gateway 消费（Q6）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { API_ROUTES, matchApiRoute, generateRegistryJson, validateRoutes } from '../src/api-route-registry.ts'
import { scanFrontend, scanDesktop, scanShim } from '../scripts/scan-api-usage.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]) => readFileSync(path.join(ROOT, ...segments), 'utf8')

function registryCovers(method: string, routePath: string): ApiRouteMatch | null {
  if (method === 'ANY') {
    for (const candidate of ['GET', 'POST', 'PUT', 'DELETE']) {
      const matched = matchApiRoute(candidate, routePath)
      if (matched) return { route: matched, method: candidate }
    }
    return null
  }
  const matched = matchApiRoute(method, routePath)
  return matched ? { route: matched, method } : null
}

interface ApiRouteMatch { route: (typeof API_ROUTES)[number]; method: string }

test('前端实际调用的每个 /api 路径与 method 都有唯一 owner 登记', () => {
  const frontend = scanFrontend(read('public', 'app.js'))
  assert.ok(frontend.length >= 60, `前端扫描应发现足够多的调用点，实际 ${frontend.length}`)
  const uncovered: string[] = []
  for (const hit of frontend) {
    const match = registryCovers(hit.method, hit.path)
    if (!match) uncovered.push(`${hit.method} ${hit.path}`)
  }
  assert.deepEqual(uncovered, [], `以下前端请求未登记（Android 将出现静默 404/503）：${uncovered.join('；')}`)
})

test('桌面路由表全部登记（含 deprecated SSE 与 desktop-only agent）', () => {
  const desktop = scanDesktop(read('src', 'app-boot.ts')).filter(hit => hit.kind !== 'prefix-guard')
  assert.ok(desktop.length >= 90, `桌面扫描应发现全部路由，实际 ${desktop.length}`)
  const uncovered: string[] = []
  for (const hit of desktop) {
    if (!registryCovers(hit.method, hit.path)) uncovered.push(`${hit.method} ${hit.path}`)
  }
  assert.deepEqual(uncovered, [], `桌面已实现但未登记：${uncovered.join('；')}`)
})

test('Android shim 路由全部登记（删除 shim 前的行为权威对照）', () => {
  const shim = scanShim(read('android', 'app', 'src', 'main', 'assets', 'web', 'local-runtime-web-entry.js'))
  assert.ok(shim.length >= 60, `shim 扫描应发现全部路由，实际 ${shim.length}`)
  const uncovered: string[] = []
  for (const hit of shim) {
    if (!registryCovers(hit.method, hit.path)) uncovered.push(`${hit.method} ${hit.path}`)
  }
  assert.deepEqual(uncovered, [], `shim 已手抄但未登记：${uncovered.join('；')}`)
})

test('registry 自检：重复登记、歧义 pattern、缺字段使构建失败', () => {
  assert.doesNotThrow(() => validateRoutes(API_ROUTES))
  assert.throws(() => validateRoutes([
    { method: 'GET', pattern: '/api/x', owner: 'core', capability: 'c', auth: 'none', handlerId: 'h1' },
    { method: 'GET', pattern: '/api/x', owner: 'main-host', capability: 'c', auth: 'none', handlerId: 'h2' },
  ]), /重复登记/)
  assert.throws(() => validateRoutes([
    // 参数段名不同但形状相同 → 歧义（匹配行为无法区分）
    { method: 'POST', pattern: '/api/a/{}', owner: 'core', capability: 'c', auth: 'none', handlerId: 'h1' },
    { method: 'POST', pattern: '/api/a/{id}', owner: 'core', capability: 'c', auth: 'none', handlerId: 'h2' },
  ]), /歧义/)
})

test('匹配语义：method 精确、静态优先于参数、更具体优先（Q6）', () => {
  assert.equal(matchApiRoute('get', '/api/room')?.handlerId, 'room.snapshot')
  assert.equal(matchApiRoute('GET', '/api/room?x=1')?.handlerId, 'room.snapshot', 'query 不参与匹配')
  assert.equal(matchApiRoute('DELETE', '/api/room'), null, '未登记的 method 不得命中')
  assert.equal(matchApiRoute('GET', '/api/not-registered'), null)
  // 参数路由与静态路由同形状时，静态段更多者胜；无法区分形状的歧义在 validateRoutes 已失败
  const table = [
    { method: 'GET' as const, pattern: '/api/a/{}', owner: 'core' as const, capability: 'c', auth: 'none' as const, handlerId: 'param' },
    { method: 'GET' as const, pattern: '/api/a/{}/fixed', owner: 'core' as const, capability: 'c', auth: 'none' as const, handlerId: 'specific' },
    { method: 'GET' as const, pattern: '/api/a/fixed', owner: 'core' as const, capability: 'c', auth: 'none' as const, handlerId: 'static' },
  ]
  validateRoutes(table)
  assert.equal(matchApiRoute('GET', '/api/a/fixed', table)?.handlerId, 'static')
  assert.equal(matchApiRoute('GET', '/api/a/x/fixed', table)?.handlerId, 'specific')
  assert.equal(matchApiRoute('GET', '/api/a/x', table)?.handlerId, 'param')
})

test('registry JSON 产物确定性生成且结构完整（Java gateway 消费）', () => {
  const first = generateRegistryJson()
  assert.equal(first, generateRegistryJson(), '两次生成必须逐字节一致')
  const parsed = JSON.parse(first) as { registryVersion: string; routes: Array<{ order: number; method: string; pattern: string; owner: string; handlerId: string; capability: string; stream: unknown; note: string | null }> }
  assert.equal(parsed.routes.length, API_ROUTES.length)
  for (const [index, route] of parsed.routes.entries()) {
    assert.equal(route.order, index, '生成序必须稳定')
    assert.ok(['core', 'main-host', 'desktop-only', 'deprecated'].includes(route.owner))
    assert.ok(route.capability && route.handlerId)
  }
  const sseRoutes = parsed.routes.filter(route => route.stream)
  assert.ok(sseRoutes.some(route => route.pattern === '/api/core/events'), 'core SSE 必须登记流契约')
})

test('deprecated 与 desktop-only 路由必须写明裁决依据（Q2/Q5）', () => {
  for (const route of API_ROUTES) {
    if (route.owner === 'deprecated' || route.owner === 'desktop-only') {
      assert.ok(route.note, `${route.method} ${route.pattern} 缺少 note 裁决说明`)
    }
  }
  assert.equal(API_ROUTES.find(route => route.pattern === '/api/stream')?.owner, 'deprecated', '/api/stream 按 Q5 为迁移期 deprecated 路由')
})

test('owner 草案覆盖计划 §1.4 的判定标准', () => {
  for (const route of API_ROUTES) {
    assert.ok(['core', 'main-host', 'desktop-only', 'deprecated'].includes(route.owner), `${route.pattern} owner 非法`)
  }
  // 抽样锚点：计划与答疑中的明确裁决不得漂移
  assert.equal(API_ROUTES.find(route => route.pattern === '/api/turn')?.owner, 'core')
  assert.equal(API_ROUTES.find(route => route.pattern === '/api/remote/sync')?.owner, 'main-host')
  assert.equal(API_ROUTES.find(route => route.pattern === '/api/agent/message')?.owner, 'desktop-only')
  assert.equal(API_ROUTES.find(route => route.pattern === '/api/providers/save')?.owner, 'core', 'provider 凭据经 Core secret 端口（Q10）')
  assert.equal(API_ROUTES.find(route => route.pattern === '/api/archive/load')?.owner, 'core', '写入 Core state 必须由 Core 串行执行（§7.1）')
})
