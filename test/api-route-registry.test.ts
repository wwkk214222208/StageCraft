/**
 * W1-R CP-W1：ApiRouteRegistry method 精确性、完备性与裁决边界测试（计划 §1.4 / §10.1）。
 *
 * 覆盖：
 * - 能静态确定的 fetch/api/postJson/creatorRequest/downloadCurrentFile/SSE 调用必须登记真实 method；
 * - method-unknown 仅表示证据不足：必须落在人工裁决 fixture 内，且不得冒充 Gate B 通过依据；
 * - 反例：registry 缺少真实 method 时测试必须失败（CP-W1 要求）；
 * - 草案条目必须带 adjudication/fixPackage（CP-W1：'待评审'不得流入 W4/W6）；
 * - registry JSON 产物确定性生成且与构建资产一致。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { API_ROUTES, matchApiRoute, generateRegistryJson, validateRoutes, type ApiRoute } from '../src/api-route-registry.ts'
import { scanFrontend, scanDesktop, scanShim } from '../scripts/scan-api-usage.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]) => readFileSync(path.join(ROOT, ...segments), 'utf8')

interface ScanHit { method: string; path: string; kind: string; count: number }
interface Adjudication { path: string; methods: string[]; evidence: string; basis: string }

const ADJUDICATIONS = JSON.parse(read('test', 'fixtures', 'api-method-adjudications.json')) as { adjudications: Adjudication[] }

/** 覆盖检查（纯函数，供反例测试复用）：registry 缺少真实 (method,path) 时返回错误列表。 */
function scanCoverageErrors(routes: readonly ApiRoute[], hits: ScanHit[], adjudications: Adjudication[] = ADJUDICATIONS.adjudications): string[] {
  const errors: string[] = []
  const concretePaths = new Set(hits.filter(hit => hit.method !== 'method-unknown').map(hit => hit.path))
  const adjudicated = new Map(adjudications.map(item => [item.path, item]))
  for (const hit of hits) {
    const key = `${hit.method} ${hit.path}`
    if (hit.method === 'method-unknown') {
      if (concretePaths.has(hit.path)) continue // 同一路径已有具体 method 证据
      const item = adjudicated.get(hit.path)
      if (!item) { errors.push(`${hit.path} 为 method-unknown 且无人工裁决 fixture`); continue }
      for (const method of item.methods) {
        if (!matchApiRoute(method, hit.path, routes)) errors.push(`裁决 method ${method} ${hit.path} 未登记`)
      }
      continue
    }
    if (!matchApiRoute(hit.method, hit.path, routes)) errors.push(key)
  }
  return errors
}

test('前端实际调用的每个 /api 路径都登记，且能静态确定的必须为真实 method', () => {
  const frontend = scanFrontend(read('public', 'app.js'))
  assert.ok(frontend.length >= 100, `前端扫描应发现足够多调用点（含字面量兜底），实际 ${frontend.length}`)
  const concrete = frontend.filter(hit => hit.method !== 'method-unknown')
  assert.ok(concrete.length >= 70, `静态可确定的 method 调用应占绝大多数，实际 ${concrete.length}`)
  const unknownOnly = frontend.filter(hit => hit.method === 'method-unknown' && !concrete.some(other => other.path === hit.path))
  assert.ok(unknownOnly.length <= 10, `method-unknown 应限于变量中转的少数调用，实际 ${unknownOnly.length}：${unknownOnly.map(hit => hit.path).join('、')}`)
  const errors = scanCoverageErrors(API_ROUTES, frontend)
  assert.deepEqual(errors, [], `前端请求未登记或 method 不匹配：${errors.join('；')}`)
})

test('method-unknown 必须有人工裁决 fixture，fixture method 必须已登记（CP-W1）', () => {
  const frontend = scanFrontend(read('public', 'app.js'))
  const concretePaths = new Set(frontend.filter(hit => hit.method !== 'method-unknown').map(hit => hit.path))
  const unknownPaths = [...new Set(frontend.filter(hit => hit.method === 'method-unknown' && !concretePaths.has(hit.path)).map(hit => hit.path))]
  const adjudicatedPaths = new Set(ADJUDICATIONS.adjudications.map(item => item.path))
  assert.deepEqual(
    unknownPaths.filter(item => !adjudicatedPaths.has(item)),
    [],
    '存在无裁决的 method-unknown 调用',
  )
  for (const item of ADJUDICATIONS.adjudications) {
    assert.ok(item.methods.length >= 1 && item.evidence && item.basis, `${item.path} 裁决缺少 evidence/basis`)
    for (const method of item.methods) {
      assert.ok(matchApiRoute(method, item.path), `裁决 ${method} ${item.path} 未登记到 registry`)
    }
  }
})

test('桌面路由表全部登记（含 deprecated SSE 与 desktop-only agent）', () => {
  const desktop = scanDesktop(read('src', 'app-boot.ts')).filter(hit => hit.kind !== 'prefix-guard')
  assert.ok(desktop.length >= 90, `桌面扫描应发现全部路由，实际 ${desktop.length}`)
  assert.ok(desktop.every(hit => hit.method !== 'method-unknown'), '桌面路由 method 全部静态可判定')
  const errors = scanCoverageErrors(API_ROUTES, desktop, [])
  assert.deepEqual(errors, [], `桌面已实现但未登记：${errors.join('；')}`)
})

test('Android shim 路由全部登记（删除 shim 前的行为权威对照）', () => {
  const shim = scanShim(read('android', 'app', 'src', 'main', 'assets', 'web', 'local-runtime-web-entry.js'))
  assert.ok(shim.length >= 60, `shim 扫描应发现全部路由，实际 ${shim.length}`)
  assert.ok(shim.every(hit => hit.method !== 'method-unknown'), 'shim 特判路由 method 已静态判定')
  const errors = scanCoverageErrors(API_ROUTES, shim, [])
  assert.deepEqual(errors, [], `shim 已手抄但未登记：${errors.join('；')}`)
})

test('反例：registry 缺少真实 method 时覆盖测试必须失败（CP-W1 要求）', () => {
  const frontend = scanFrontend(read('public', 'app.js'))
  const withoutTurnPost = API_ROUTES.filter(route => !(route.method === 'POST' && route.pattern === '/api/turn'))
  assert.ok(scanCoverageErrors(withoutTurnPost, frontend, []).some(error => error.includes('POST /api/turn')),
    '删除 POST /api/turn 后覆盖检查必须报错')
  const withoutStream = API_ROUTES.filter(route => route.pattern !== '/api/stream')
  assert.ok(scanCoverageErrors(withoutStream, frontend, []).some(error => error.includes('/api/stream')),
    '删除 GET /api/stream 后覆盖检查必须报错')
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

test('registry JSON 产物确定性生成、结构完整且与构建资产一致（Q6/CP-W1）', () => {
  const first = generateRegistryJson()
  assert.equal(first, generateRegistryJson(), '两次生成必须逐字节一致')
  const parsed = JSON.parse(first) as { registryVersion: string; routes: Array<{ order: number; method: string; pattern: string; owner: string; handlerId: string; capability: string; stream: unknown; note: string | null; adjudication: string | null; authPolicy: { kind: string } | null; dispatchPolicy: { androidLocal: { action: string; auth: string; errorCode?: string }; androidRemote: { action: string; auth: string; errorCode?: string } } | null }> }
  assert.equal(parsed.routes.length, API_ROUTES.length)
  for (const [index, route] of parsed.routes.entries()) {
    assert.equal(route.order, index, '生成序必须稳定')
    assert.ok(['core', 'main-host', 'desktop-only', 'deprecated'].includes(route.owner))
    assert.ok(route.capability && route.handlerId)
    assert.ok(route.authPolicy && ['local-open', 'core-nonce', 'remote-paired'].includes(route.authPolicy.kind), 'authPolicy 必须显式派生（Gate B：不能全部 auth:none）')
    // Gate B 收口：machine-readable dispatchPolicy 必须存在且两个 surface 合法（评审 B-3 P1）
    assert.ok(route.dispatchPolicy, `${route.method} ${route.pattern} 缺少 dispatchPolicy（Gate B 收口）`)
    assert.ok(route.dispatchPolicy!.androidLocal && route.dispatchPolicy!.androidRemote, `${route.method} ${route.pattern} dispatchPolicy 必须覆盖 androidLocal/androidRemote`)
    const surfaces = [route.dispatchPolicy!.androidLocal, route.dispatchPolicy!.androidRemote]
    for (const surface of surfaces) {
      assert.ok(['proxy-core', 'host-handler', 'stable-unsupported', 'deprecated-adapter'].includes(surface.action), `${route.method} ${route.pattern} action 非法`)
      assert.ok(['core-nonce', 'remote-paired', 'local', 'none'].includes(surface.auth), `${route.method} ${route.pattern} auth 非法`)
      if (surface.action === 'stable-unsupported' || surface.action === 'deprecated-adapter') {
        assert.ok(surface.errorCode, `${route.method} ${route.pattern} 稳定错误策略必须带 errorCode`)
      }
    }
  }
  const kindByOwner = (owner: string) => new Set(parsed.routes.filter(r => r.owner === owner).map(r => r.authPolicy!.kind))
  assert.deepEqual([...kindByOwner('core')], ['core-nonce'])
  assert.deepEqual([...kindByOwner('main-host')], ['local-open'])
  // dispatchPolicy 按 owner 派生（评审 B-3：说明文字不是 gateway policy）
  const actionByOwner = (owner: string, surface: 'androidLocal' | 'androidRemote') =>
    new Set(parsed.routes.filter(r => r.owner === owner).map(r => r.dispatchPolicy![surface].action))
  assert.deepEqual([...actionByOwner('core', 'androidLocal')], ['proxy-core'])
  assert.deepEqual([...actionByOwner('main-host', 'androidLocal')], ['host-handler'])
  assert.deepEqual([...actionByOwner('desktop-only', 'androidLocal')], ['stable-unsupported'])
  assert.deepEqual([...actionByOwner('deprecated', 'androidLocal')], ['deprecated-adapter'])
  const sseRoutes = parsed.routes.filter(route => route.stream)
  assert.ok(sseRoutes.some(route => route.pattern === '/api/core/events'), 'core SSE 必须登记流契约')

  const assetPath = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'api-route-registry.json')
  assert.ok(existsSync(assetPath), '构建资产 api-route-registry.json 必须已生成（scripts/generate-api-route-registry.mjs）')
  assert.equal(readFileSync(assetPath, 'utf8'), first, '构建资产与 generateRegistryJson() 逐字节一致（防漂移）')
})

test('deprecated 与 desktop-only 路由必须写明裁决依据（Q2/Q5）', () => {
  for (const route of API_ROUTES) {
    if (route.owner === 'deprecated' || route.owner === 'desktop-only') {
      assert.ok(route.note, `${route.method} ${route.pattern} 缺少 note 裁决说明`)
    }
  }
  assert.equal(API_ROUTES.find(route => route.pattern === '/api/stream')?.owner, 'deprecated', '/api/stream 按 Q5 为迁移期 deprecated 路由')
})

test('CP-W1：草案条目必须带 adjudication 与 fixPackage，不得残留待评审状态', () => {
  const withoutAdjudication = API_ROUTES.filter(route => route.note?.includes('待合流评审'))
  assert.deepEqual(withoutAdjudication.map(route => route.pattern), [], '不得残留待合流评审标记')
  const adjudicated = API_ROUTES.filter(route => route.adjudication)
  assert.ok(adjudicated.length >= 10, `原存疑条目应全部完成裁决，实际 ${adjudicated.length}`)
  for (const route of adjudicated) {
    assert.ok(['accepted', 'revised', 'deferred'].includes(route.adjudication!), `${route.pattern} adjudication 非法`)
    assert.ok(route.fixPackage, `${route.pattern} 缺少 fixPackage`)
    assert.ok(route.fixDeadline, `${route.pattern} 缺少 fixDeadline`)
  }
  // 抽样锚点：计划与答疑中的明确裁决不得漂移
  assert.equal(API_ROUTES.find(route => route.pattern === '/api/turn')?.owner, 'core')
  assert.equal(API_ROUTES.find(route => route.pattern === '/api/remote/sync')?.owner, 'main-host')
  assert.equal(API_ROUTES.find(route => route.pattern === '/api/agent/message')?.owner, 'desktop-only')
  assert.equal(API_ROUTES.find(route => route.pattern === '/api/providers/save')?.owner, 'core', 'provider 凭据经 Core secret 端口（Q10）')
  assert.equal(API_ROUTES.find(route => route.pattern === '/api/archive/load')?.owner, 'core', '写入 Core state 必须由 Core 串行执行（§7.1）')
})
