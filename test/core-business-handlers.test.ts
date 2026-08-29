/**
 * W6：Core 业务 handler 挂载测试（计划 §1.4 / 阶段 4；registry 驱动，防漂移）。
 *
 * 验证：
 * 1. CORE_BUSINESS_ROUTES 与 registry core 业务路由一一对应（不复制 app-boot.ts 路由串）；
 * 2. 挂载覆盖：已实现的 handlerId 调组合根 facade；未挂载的返回稳定 handler_not_mounted；
 * 3. 分发：room.snapshot / turn.start / workflow.approve 等经 handlePortableApi 正确路由；
 * 4. 参数 pattern 匹配与路径参数提取。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { API_ROUTES } from '../src/api-route-registry.ts'
import { handlePortableApi, type ApiRequest } from '../src/portable/api-handler.ts'
import {
  CORE_BUSINESS_HANDLERS,
  CORE_BUSINESS_ROUTES,
  CoreBusinessPortableHandler,
  buildBusinessCoverage,
  matchPattern,
  extractParams,
  type CoreFacade,
} from '../src/portable/core-business-handlers.ts'

/** 记录 facade 调用的假组合根。 */
function makeFacade(): CoreFacade & { calls: string[] } {
  const calls: string[] = []
  const secrets = new Map<string, string>()
  const record = (name: string) => (...args: unknown[]) => { calls.push(name + ':' + args.map(arg => JSON.stringify(arg)).join(',')); return Promise.resolve({ ok: true }) }
  return {
    calls,
    invokeSync: (operation: string, input?: Record<string, unknown>) => {
      calls.push('invokeSync:' + operation + ':' + JSON.stringify(input ?? {}))
      if (operation === 'story.create') return { ok: true, id: 'story-created', title: input?.title }
      if (operation === 'archive.list') return { files: ['存档A'] }
      if (operation === 'preset.list') return { presets: [{ id: 'p1' }] }
      if (operation === 'secret.get') return secrets.has(String(input?.key)) ? { found: true, value: secrets.get(String(input?.key)) } : { found: false }
      if (operation === 'secret.set') { secrets.set(String(input?.key), String(input?.value)); return { ok: true } }
      if (operation === 'archive.export') return { ok: true, url: 'archive://x' }
      return { ok: true }
    },
    getRoom: () => ({ revision: 3, roomId: 'r1' }),
    getView: () => ({ revision: 3 }),
    submitTurn: record('submitTurn'),
    cancelTurn: () => { calls.push('cancelTurn') },
    speak: record('speak'),
    speakAll: record('speakAll'),
    directorDecide: record('directorDecide'),
    rejectSpeech: record('rejectSpeech'),
    retrySpeak: record('retrySpeak'),
    approveSpeech: record('approveSpeech'),
    directorChat: record('directorChat'),
    approveWorldChange: record('approveWorldChange'),
    rejectWorldChange: record('rejectWorldChange'),
    proceedToDraft: record('proceedToDraft'),
    rejectDraft: record('rejectDraft'),
    retryDirector: record('retryDirector'),
    reconsiderReaction: record('reconsiderReaction'),
    consult: record('consult'),
    finishConsultation: () => { calls.push('finishConsultation') },
    redraft: record('redraft'),
    approve: record('approve'),
    setRoomConfig: record('setRoomConfig'),
    updatePlayerCharacter: record('updatePlayerCharacter'),
    setPlayerAvatar: record('setPlayerAvatar'),
    updateScene: record('updateScene'),
    saveLore: record('saveLore'),
    setDirectorSetting: record('setDirectorSetting'),
    createRole: record('createRole'),
    deleteRole: record('deleteRole'),
    setRolePresence: record('setRolePresence'),
    setRoleThinking: record('setRoleThinking'),
    reorderRoles: record('reorderRoles'),
    setRoleAvatar: record('setRoleAvatar'),
    setRoleCurrentState: record('setRoleCurrentState'),
    interveneRole: record('interveneRole'),
    storeNpcMemories: record('storeNpcMemories'),
    retractNpcMemory: record('retractNpcMemory'),
    updateNpcMemory: record('updateNpcMemory'),
    reorderNpcMemories: record('reorderNpcMemories'),
    supersedeNpcMemory: record('supersedeNpcMemory'),
    getProvider: () => ({ configured: false }),
    setProvider: record('setProvider'),
    stories: () => [{ id: 's1' }],
    story: async id => ({ id }),
    restart: record('restart'),
  }
}

function apiRequest(method: string, path: string, body?: unknown): ApiRequest {
  return {
    method,
    url: path,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body)),
    signal: AbortSignal.timeout(5000),
  }
}

async function bodyText(response: { status: number; body?: Uint8Array | AsyncIterable<Uint8Array> }): Promise<string> {
  if (response.body instanceof Uint8Array) return new TextDecoder().decode(response.body)
  if (response.body) {
    let text = ''
    for await (const chunk of response.body) text += new TextDecoder().decode(chunk)
    return text
  }
  return ''
}

test('W6：CORE_BUSINESS_ROUTES 与 registry core 业务路由一一对应（registry 驱动，不复制 app-boot 路由串）', () => {
  const registryBusiness = API_ROUTES
    .filter(route => route.owner === 'core' && !route.pattern.startsWith('/api/core/'))
    .map(route => `${route.method} ${route.pattern}`)
    .sort()
  const derived = CORE_BUSINESS_ROUTES.map(route => `${route.method} ${route.pattern}`).sort()
  assert.deepEqual(derived, registryBusiness, '业务路由必须由 registry 派生，不得手写')
  // 每个 handlerId 唯一
  const ids = CORE_BUSINESS_ROUTES.map(route => route.handlerId)
  assert.equal(new Set(ids).size, ids.length, 'handlerId 必须唯一')
})

test('W6：挂载覆盖——已实现 handlerId 有实现，未挂载返回稳定 handler_not_mounted', () => {
  const coverage = buildBusinessCoverage(API_ROUTES)
  const mounted = coverage.filter(item => item.mounted)
  assert.ok(mounted.length > 0, '必须已有业务 handler 挂载')
  // 全部 core 业务路由要么挂载要么未挂载（覆盖清单完整）
  assert.equal(coverage.length, API_ROUTES.filter(r => r.owner === 'core' && !r.pattern.startsWith('/api/core/')).length)
})

test('W6：room.snapshot 经分发返回组合根快照', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handlePortableApi([handler], apiRequest('GET', '/api/room'))
  assert.equal(response.status, 200)
  const body = JSON.parse(await bodyText(response))
  assert.equal(body.revision, 3)
  assert.equal(body.roomId, 'r1')
})

test('W6：turn.start 调 submitTurn 并回 view', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('POST', '/api/turn', { text: 'hello', requiredRoleIds: ['r1'] }))
  assert.equal(response.status, 200)
  assert.ok(facade.calls.some(call => call.startsWith('submitTurn:')), '必须调用 submitTurn')
  const body = JSON.parse(await bodyText(response))
  assert.equal(body.ok, true)
})

test('W6：workflow.approve 调 approve（draftId/text/stateUpdates）', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('POST', '/api/approve', { draftId: 'd1', text: 'ok', stateUpdates: { mood: 'happy' } }))
  assert.equal(response.status, 200)
  const call = facade.calls.find(call => call.startsWith('approve:'))
  assert.ok(call, '必须调用 approve')
  assert.ok(call.includes('d1') && call.includes('happy'), 'draftId 与 stateUpdates 必须传入')
})

test('W6：chat.speak 调 speak（roleId/feedback）', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  await handler.handle(apiRequest('POST', '/api/chat/speak', { roleId: 'role-a', feedback: 'good' }))
  assert.ok(facade.calls.some(call => call.startsWith('speak:') && call.includes('role-a')), '必须调用 speak(roleId)')
})

test('W6：角色记忆路由调组合根方法', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  await handler.handle(apiRequest('POST', '/api/roles/memories', { roleId: 'role-x', entries: [{ id: 'm1', text: 'note' }] }))
  assert.ok(facade.calls.some(call => call.startsWith('storeNpcMemories:')), '必须调用 storeNpcMemories')
})

test('W6-1：全部 81 条 core 业务路由已挂载（无 handler_not_mounted）', () => {
  const coverage = buildBusinessCoverage(API_ROUTES)
  const unmounted = coverage.filter(item => !item.mounted)
  assert.equal(unmounted.length, 0, `必须全部挂载，未挂载: ${unmounted.map(item => item.handlerId).join(', ')}`)
  assert.equal(coverage.length, 81, '必须覆盖全部 81 条 core 业务路由')
})

test('W6-1：逐条裁决的 unsupported 路由返回稳定 unsupported_capability', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  for (const path of ['/api/state/rollback', '/api/state/branch', '/api/creator/preview', '/api/st-cards/import', '/api/providers/discover', '/api/prompts/import-st']) {
    const response = await handler.handle(apiRequest('POST', path, {}))
    assert.equal(response.status, 503, `${path} 必须 503`)
    const body = JSON.parse(await bodyText(response))
    assert.equal(body.error.code, 'unsupported_capability', `${path} 必须稳定 unsupported_capability`)
  }
})

test('W6-1：story.create 经原生端口真实调用并返回响应形状', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('POST', '/api/stories', { title: '新剧本', opening: '开场' }))
  assert.equal(response.status, 200)
  assert.ok(facade.calls.some(call => call.startsWith('invokeSync:story.create:')), '必须调用原生 story.create')
  const body = JSON.parse(await bodyText(response))
  assert.equal(body.id, 'story-created')
  assert.equal(body.title, '新剧本')
})

test('W6-1：archive.list 经原生端口返回文件清单', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('GET', '/api/archive/list'))
  assert.equal(response.status, 200)
  assert.ok(facade.calls.some(call => call.startsWith('invokeSync:archive.list:')), '必须调用原生 archive.list')
  const body = JSON.parse(await bodyText(response))
  assert.deepEqual(body.files, ['存档A'])
})

test('W6-1：prompt.presets.list 经原生端口返回预设', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('GET', '/api/prompts/presets'))
  assert.equal(response.status, 200)
  assert.ok(facade.calls.some(call => call.startsWith('invokeSync:preset.list:')), '必须调用原生 preset.list')
  const body = JSON.parse(await bodyText(response))
  assert.equal(body.presets[0].id, 'p1')
})

test('W6-1：billing.summary 返回 R3-2 桌面契约形状 {prices, stats}（secret 兜底空态）', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('GET', '/api/billing'))
  assert.equal(response.status, 200)
  const body = JSON.parse(await bodyText(response))
  assert.ok('prices' in body && 'stats' in body, 'billing.summary 必须返回 {prices, stats}')
  assert.ok('rates' in body.prices && 'totalCost' in body.stats, 'prices.rates 与 stats.totalCost 必须存在')
})

test('W6-1：原生端口失败 → 400 {error: string}（R3-2 桌面错误契约）', async () => {
  const facade = makeFacade()
  facade.invokeSync = () => { throw new Error('database write failed') }
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('POST', '/api/stories', { title: 'x' }))
  assert.equal(response.status, 400)
  const body = JSON.parse(await bodyText(response))
  assert.equal(body.error, 'database write failed')
})

test('R3-2：providers 返回桌面契约 {providers, defaults}（含 hasApiKey）', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('GET', '/api/providers'))
  assert.equal(response.status, 200)
  const body = JSON.parse(await bodyText(response))
  assert.ok(Array.isArray(body.providers), 'providers 必须是数组')
  assert.ok('defaults' in body, 'defaults 必须存在')
  assert.ok('defaultRoleProviderId' in body.defaults, 'defaults.defaultRoleProviderId 必须存在')
})

test('R3-2：roles/memories 按 roleId 返回 {memories}（未知 roleId → 空数组）', async () => {
  const facade = makeFacade()
  facade.getRoom = () => ({ revision: 3, roles: [{ id: 'seraphina', memories: [{ id: 'm1', text: '记忆' }] }] })
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const found = await handler.handle(apiRequest('GET', '/api/roles/memories?roleId=seraphina'))
  assert.equal(found.status, 200)
  const foundBody = JSON.parse(await bodyText(found))
  assert.deepEqual(foundBody.memories, [{ id: 'm1', text: '记忆' }])
  const missing = await handler.handle(apiRequest('GET', '/api/roles/memories?roleId=nobody'))
  const missingBody = JSON.parse(await bodyText(missing))
  assert.deepEqual(missingBody.memories, [])
})

test('R3-2：stories 返回裸数组；story/get?id= 返回裸 StoryPackage', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const list = await handler.handle(apiRequest('GET', '/api/stories'))
  const listBody = JSON.parse(await bodyText(list))
  assert.ok(Array.isArray(listBody), 'stories 必须是裸数组')
  const get = await handler.handle(apiRequest('GET', '/api/story/get?id=s1'))
  assert.equal(get.status, 200)
  const getBody = JSON.parse(await bodyText(get))
  assert.equal(getBody.id, 's1', 'story.get 必须返回裸 StoryPackage')
})

test('R3-2：private-toggles GET 读持久化值（PUT 写后 GET 可读）', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  await handler.handle(apiRequest('PUT', '/api/prompts/private-toggles', { presetId: 'p1', nodeId: 'n1', enabled: true }))
  const get = await handler.handle(apiRequest('GET', '/api/prompts/private-toggles'))
  const body = JSON.parse(await bodyText(get))
  assert.deepEqual(body, { p1: { n1: true } }, 'GET 必须读回 PUT 写入的值')
})

test('R3-2：billing/prices PUT 返回 {prices, stats}（前端保存后 renderBilling）', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('PUT', '/api/billing/prices', { prices: { version: 1, rates: [] } }))
  assert.equal(response.status, 200)
  const body = JSON.parse(await bodyText(response))
  assert.ok('prices' in body && 'stats' in body, '必须返回 {prices, stats}')
})

test('R3-1：query 参数并入 body（story/get?id= 命中 story.get handler）', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('GET', '/api/story/get?id=story-42'))
  assert.equal(response.status, 200)
  const body = JSON.parse(await bodyText(response))
  assert.equal(body.id, 'story-42', 'query id 必须到达 handler')
})

test('W6：参数 pattern 匹配与路径参数提取', () => {
  assert.equal(matchPattern('/api/roles/memories/{roleId}', '/api/roles/memories/role-a'), true)
  assert.equal(matchPattern('/api/roles/memories/{roleId}', '/api/roles/memories'), false)
  assert.equal(matchPattern('/api/roles/memories/{roleId}', '/api/roles/other'), false)
  const params = extractParams('/api/roles/memories/{roleId}', '/api/roles/memories/role-a')
  assert.deepEqual(params, { roleId: 'role-a' })
})

test('W6：未知业务路径返回 404', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('GET', '/api/not-a-core-route'))
  assert.equal(response.status, 404)
})

test('R3-2 空态：providers 未配置时返回 {providers:[], defaults}（前端下拉 disabled 依赖）', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('GET', '/api/providers'))
  assert.equal(response.status, 200)
  const body = JSON.parse(await bodyText(response))
  assert.deepEqual(body.providers, [], '未配置时必须空数组')
  assert.ok('defaultRoleProviderId' in body.defaults, 'defaults 键必须齐全（空值）')
})

test('R3-2 空态：stories 无剧本时返回裸空数组', async () => {
  const facade = makeFacade()
  facade.stories = () => []
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('GET', '/api/stories'))
  assert.equal(response.status, 200)
  const body = JSON.parse(await bodyText(response))
  assert.deepEqual(body, [], '空剧本库必须返回 []')
})

test('R3-2 空态：billing 未初始化时 {prices.rates:[], stats.totalCost:0}', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('GET', '/api/billing'))
  assert.equal(response.status, 200)
  const body = JSON.parse(await bodyText(response))
  assert.deepEqual(body.prices.rates, [], 'prices.rates 空态必须 []')
  assert.equal(body.stats.totalCost, 0, 'stats.totalCost 空态必须 0')
})

test('R3-2 错误态：story.delete 无 id → 400 {error}', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('DELETE', '/api/stories'))
  assert.equal(response.status, 400)
  const body = JSON.parse(await bodyText(response))
  assert.equal(typeof body.error, 'string', '错误必须 400 {error: string}')
})

test('R3-2 错误态：archive.delete 不存在 → 400 {error}', async () => {
  const facade = makeFacade()
  facade.invokeSync = (operation, input) => {
    if (operation === 'archive.delete') return { ok: false, error: { message: '存档不存在或已删除。' } }
    if (operation === 'archive.list') return { files: [] }
    return { ok: true }
  }
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('POST', '/api/archive/delete', { name: '不存在' }))
  assert.equal(response.status, 400)
  const body = JSON.parse(await bodyText(response))
  assert.equal(body.error, '存档不存在或已删除。')
})

test('R3-3：story.import/export 返回稳定 unsupported（SAF 原生通道裁决）', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const cases = [
    ['POST', '/api/story/import'],
    ['GET', '/api/story/export'],
    ['POST', '/api/archive/import'],
    ['GET', '/api/archive/export'],
  ] as const
  for (const [method, path] of cases) {
    const response = await handler.handle(apiRequest(method, path, {}))
    assert.equal(response.status, 503, `${method} ${path} 必须 503`)
    const body = JSON.parse(await bodyText(response))
    assert.equal(body.error.code, 'unsupported_capability', `${path} 必须稳定 unsupported`)
  }
})

test('R5-2：story.save-as 无新 ID 时生成新 ID（源 ID 只作复制来源，不覆盖）', async () => {
  const facade = makeFacade()
  const saved = new Map<string, unknown>()
  facade.invokeSync = (operation, input) => {
    if (operation === 'story.saveAs') {
      saved.set(String((input as Record<string, unknown>).id), (input as Record<string, unknown>).story)
      return { ok: true, id: (input as Record<string, unknown>).id }
    }
    return { ok: true }
  }
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('POST', '/api/story/save-as', { story: { id: 'story-source', title: '源故事' }, title: '副本' }))
  assert.equal(response.status, 200)
  const body = JSON.parse(await bodyText(response))
  assert.ok(body.id, '必须返回新 id')
  assert.notEqual(body.id, 'story-source', '新 id 不得等于源 id')
  // 源故事未被动过：只有新 id 被写入（saveAs 只写新键）
  assert.ok(saved.has(body.id), '新 id 必须写入')
  assert.ok(!saved.has('story-source') || (saved.get('story-source') as { id?: string })?.id === 'story-source', '源 id 不得被覆盖为新 id')
})

test('R5-3：prompt active scope 统一走 preset.active-scope.set（合并更新 + 持久化可读）', async () => {
  const facade = makeFacade()
  const activeStore = new Map<string, string>()
  facade.invokeSync = (operation, input) => {
    if (operation === 'preset.list') return { presets: [{ id: 'p1' }], activeByScope: Object.fromEntries(activeStore) }
    if (operation === 'preset.active-scope.set') {
      const active = (input as { activeByScope: Record<string, string> }).activeByScope
      for (const [k, v] of Object.entries(active)) activeStore.set(k, v)
      return { ok: true }
    }
    if (operation === 'preset.save') return { ok: true }
    return { ok: true }
  }
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  // 设置 director scope
  const put1 = await handler.handle(apiRequest('PUT', '/api/prompts/presets', { scope: 'director', activePresetId: 'p-director' }))
  assert.equal(put1.status, 200)
  // 再设置 chat scope（合并，不覆盖 director）
  const put2 = await handler.handle(apiRequest('PUT', '/api/prompts/presets', { scope: 'chat', activePresetId: 'p-chat' }))
  assert.equal(put2.status, 200)
  // GET 必须从同一存储读到两个 scope（模拟重启后仍可读）
  const get = await handler.handle(apiRequest('GET', '/api/prompts/presets'))
  const body = JSON.parse(await bodyText(get))
  assert.equal(body.activeByScope.director, 'p-director', 'director scope 必须保留')
  assert.equal(body.activeByScope.chat, 'p-chat', 'chat scope 必须保留（合并更新）')
})
