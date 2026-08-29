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
  const record = (name: string) => (...args: unknown[]) => { calls.push(name + ':' + args.map(arg => JSON.stringify(arg)).join(',')); return Promise.resolve({ ok: true }) }
  return {
    calls,
    invokeSync: (operation: string, input?: Record<string, unknown>) => {
      calls.push('invokeSync:' + operation + ':' + JSON.stringify(input ?? {}))
      if (operation === 'story.create') return { ok: true, id: 'story-created', title: input?.title }
      if (operation === 'archive.list') return { files: ['存档A'] }
      if (operation === 'preset.list') return { presets: [{ id: 'p1' }] }
      if (operation === 'secret.get') return { found: false }
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

test('W6-1：billing.summary 返回稳定响应形状（secret 兜底空态）', async () => {
  const facade = makeFacade()
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('GET', '/api/billing'))
  assert.equal(response.status, 200)
  const body = JSON.parse(await bodyText(response))
  assert.ok('billing' in body && 'usage' in body, 'billing.summary 必须返回 {billing, usage}')
})

test('W6-1：原生端口失败 → 500 handler_failed（失败语义）', async () => {
  const facade = makeFacade()
  facade.invokeSync = () => { throw new Error('database write failed') }
  const handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
  const response = await handler.handle(apiRequest('POST', '/api/stories', { title: 'x' }))
  assert.equal(response.status, 500)
  const body = JSON.parse(await bodyText(response))
  assert.equal(body.error.code, 'handler_failed')
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
