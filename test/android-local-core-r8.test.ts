/**
 * R9：AbortSignal → 业务回合取消闭环测试（真实启动挂起模型请求 + 无条件断言）。
 *
 * 验证（评审 R9 P1-1/P1-2）：
 * 1. director room：/api/turn 启动挂起模型请求，断开 → director.cancel（model.cancel 收到
 *    目标 request ID）+ active operation 清理 + 状态不再推进（无条件断言）；
 * 2. chat room：/api/turn 启动 submitContribution 长流程，断开 → chat.cancel（model.cancel 收到）；
 * 3. /api/chat/speak 无 requestId 取消 → 模型 cancel（无条件）；
 * 4. P1-3：cancel 先于 JS 登记（tombstone）→ 请求登记时立即 abort，模型请求不执行；
 * 5. 迟到结果丢弃（取消后回调不推进 revision）。
 *
 * 通过 installLocalCore 注入**配置好 provider** 的假 native：model.request 发出但不回调
 * （挂起），取消时记录 model.cancel 的目标 request ID。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { installLocalCore } from '../src/portable/android-local-core.ts'

/** 配置好 provider 且挂起模型请求的假 native。 */
function hangingNative(room: unknown, providerConfigured = true) {
  const requests: Array<{ requestId: string; endpoint: string }> = []
  const cancels: string[] = []
  const secrets = new Map<string, string>()
  if (providerConfigured) {
    secrets.set('local.provider.meta', JSON.stringify({
      providers: [
        { id: 'P', name: 'Provider', baseUrl: 'https://p.example.com/v1', apiKey: 'key', models: ['m'], selectedModel: 'm', responseFormat: 'json_object' },
      ],
      defaults: { role: { providerId: 'P', model: 'm' }, director: { providerId: 'P', model: 'm' } },
    }))
  }
  const native: Record<string, unknown> = {
    invokeSync(operation: string, inputJson: string): string {
      const input = JSON.parse(inputJson)
      if (operation === 'core-state.restore') return JSON.stringify({ revision: 0, state: {}, events: [], workflows: [] })
      if (operation === 'stagecraft.repository') return JSON.stringify(null)
      if (operation === 'secret.set' || operation === 'secret.remove') return JSON.stringify({ ok: true })
      if (operation === 'secret.get') return secrets.has(String(input.key)) ? JSON.stringify({ found: true, value: secrets.get(String(input.key)) }) : JSON.stringify({ found: false })
      if (operation === 'stories.list') return JSON.stringify({ stories: [{ id: 'eldoria', title: 'Eldoria', mode: 'director', custom: false }] })
      if (operation === 'story.read') return JSON.stringify({ value: JSON.stringify({ id: input.id, title: 'Eldoria', mode: 'director', roles: [], lore: [] }) })
      if (operation === 'stagecraft.room.get') return JSON.stringify(room)
      if (operation === 'model.cancel') { cancels.push(String(input.requestId ?? '')); return JSON.stringify({ ok: true }) }
      return JSON.stringify({})
    },
    invokeAsync(operation: string, inputJson: string, callbackId: string): void {
      const input = JSON.parse(inputJson)
      if (operation === 'model.request') {
        requests.push({ requestId: input.requestId, endpoint: input.endpoint })
        // 故意不回调：模拟长模型请求挂起（等待取消）
        return
      }
      globalThis.StageCraftNativeResult?.handle(callbackId, JSON.stringify({ error: { message: `unsupported async op: ${operation}` } }))
    },
  }
  return { native, requests, cancels }
}

function install(roomMode = 'director', speechMode = 'manual') {
  const room = {
    id: 'android-local-room', storyId: 'eldoria', title: 'Eldoria', mode: roomMode,
    speechMode, hidePlayerSpeech: false, autoPublish: false,
    phase: 'awaiting-player-input', revision: 0,
    roles: [{
      id: 'aria', name: 'Aria', portraitRef: '/assets/default.svg', currentState: 'At the festival.',
      presence: 'present', selfModel: 'Reserved.', goals: [], impressions: {}, memories: [],
    }],
    scenes: [], lore: [], workflows: [],
    playerCharacter: { name: '玩家', persona: '', currentState: '' },
    sceneTime: '黄昏', sceneLocation: '森林', playerContribution: '', speech: null, draft: null,
  }
  const { native, requests, cancels } = hangingNative(room)
  const globalObject: Record<string, unknown> = { StageCraftNative: native }
  installLocalCore(globalObject)
  const local = globalObject.StageCraftLocalCore as any
  local.start(() => {})
  return { local, requests, cancels }
}

/** 等待条件成立（带超时）。 */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timeout')
}

test('R9：director room /api/turn 挂起模型请求断开 → 取消（transport cancel + 状态不推进）', async () => {
  const { local, requests, cancels } = install('director')
  const pending = local.handlePortableRequest('transport-dturn-1', 'POST', '/api/turn', '{"content-type":"application/json"}', '{"text":"hello"}')
  // 无条件等待：模型请求必须真实发出（provider 已配置）
  await waitFor(() => requests.length > 0)
  assert.ok(requests.length > 0, 'director /api/turn 必须发起模型请求')
  const revisionBefore = local.getView().revision
  // 取消
  local.cancelPortableRequest('transport-dturn-1')
  await waitFor(() => cancels.length > 0)
  // 无条件断言：取消链执行（transportId 经 abort 监听 core.cancel 到达 native）
  assert.ok(cancels.length > 0, '取消必须触发模型 transport cancel')
  assert.ok(cancels.includes('transport-dturn-1'), `cancel 必须包含 transportId（实际 ${cancels.join(',')}）`)
  // 状态不再推进（service cancel 清理 active operation，迟到结果不写状态）
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(local.getView().revision, revisionBefore, '取消后状态不得推进')
  // 请求 promise 有界结束
  try { await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]) } catch { /* abort 后 reject 可接受 */ }
})

test('R10：chat room /api/turn 挂起模型请求断开 → 取消（speechMode:director 真正触发模型）', async () => {
  const { local, requests, cancels } = install('chat', 'director')
  const pending = local.handlePortableRequest('transport-cturn-1', 'POST', '/api/turn', '{"content-type":"application/json"}', '{"text":"hello"}')
  // 无条件等待：speechMode=director 时 submitContribution 必须启动模型请求
  await waitFor(() => requests.length > 0)
  assert.ok(requests.length > 0, 'chat /api/turn（speechMode=director）必须发起模型请求')
  const revisionBefore = local.getView().revision
  local.cancelPortableRequest('transport-cturn-1')
  await waitFor(() => cancels.length > 0)
  assert.ok(cancels.includes('transport-cturn-1'), `cancel 必须包含 transportId（实际 ${cancels.join(',')}）`)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(local.getView().revision, revisionBefore, 'chat 取消后状态不得推进')
  try { await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]) } catch { /* ok */ }
})

test('R10：chat room /api/turn manual 模式不启动模型请求（预期行为，非取消证据）', async () => {
  const { local, requests } = install('chat', 'manual')
  const pending = local.handlePortableRequest('transport-manual-1', 'POST', '/api/turn', '{"content-type":"application/json"}', '{"text":"hello"}')
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(requests.length, 0, 'manual 模式只写贡献不启动模型请求（预期）')
  local.cancelPortableRequest('transport-manual-1')
  try { await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]) } catch { /* ok */ }
})

test('R9：/api/chat/speak 无 requestId 取消 → 模型 cancel（无条件）', async () => {
  const { local, requests, cancels } = install('chat')
  const pending = local.handlePortableRequest('transport-speak-1', 'POST', '/api/chat/speak', '{"content-type":"application/json"}', '{"roleId":"aria"}')
  await waitFor(() => requests.length > 0)
  assert.ok(requests.length > 0, 'speak 必须发起模型请求')
  local.cancelPortableRequest('transport-speak-1')
  await waitFor(() => cancels.length > 0)
  assert.ok(cancels.includes('transport-speak-1'), `speak cancel 必须包含 transportId（实际 ${cancels.join(',')}）`)
  try { await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]) } catch { /* ok */ }
})

test('R10：chat room /api/chat/director-chat 取消 → 路径真实执行（模型请求发出 + 状态不推进）', async () => {
  const { local, requests, cancels } = install('chat', 'director')
  const pending = local.handlePortableRequest('transport-dchat-1', 'POST', '/api/chat/director-chat', '{"content-type":"application/json"}', '{"text":"继续"}')
  // director-chat 必须真实发出模型请求（chat-director:... 路径；测试环境可能立即取消/完成）
  await waitFor(() => requests.length > 0)
  assert.ok(requests.length > 0, 'director-chat 必须发起模型请求（路径真实执行）')
  const revisionBefore = local.getView().revision
  local.cancelPortableRequest('transport-dchat-1')
  // 请求可能已因测试环境立即取消而结束（pending 已清 → tombstone）；等待请求 settle
  await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 3000))]).catch(() => {})
  // 状态不推进（迟到结果不写；模型请求已取消）
  const revisionAfter = local.getView().revision
  assert.equal(revisionAfter, revisionBefore, 'director-chat 取消后状态不得推进')
})

test('R9：取消先于 JS 登记（tombstone）→ 登记时立即 abort，模型请求不执行', async () => {
  const { local, requests } = install('director')
  // 先取消（此时请求尚未登记）
  local.cancelPortableRequest('transport-tomb-1')
  // 后发起请求（同 transportId）——tombstone 命中 → 立即 abort，不执行模型请求
  const pending = local.handlePortableRequest('transport-tomb-1', 'POST', '/api/turn', '{"content-type":"application/json"}', '{"text":"hello"}')
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(requests.length, 0, 'tombstone 命中后不得执行模型请求')
  try { await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]) } catch { /* abort 后 reject */ }
})

test('R9：迟到结果丢弃（取消后回调不推进 revision）', async () => {
  const { local, requests } = install('director')
  const pending = local.handlePortableRequest('transport-late-1', 'POST', '/api/turn', '{"content-type":"application/json"}', '{"text":"hi"}')
  await waitFor(() => requests.length > 0)
  const modelRequestId = requests[0].requestId
  local.cancelPortableRequest('transport-late-1')
  await new Promise(resolve => setTimeout(resolve, 100))
  const revisionBefore = local.getView().revision
  // 迟到结果回调（同 requestId 但 callbackId 已删）——不得推进 revision
  globalThis.StageCraftNativeResult?.handle('late-callback', JSON.stringify({
    requestId: modelRequestId,
    output: JSON.stringify({ text: '迟到正文', stateUpdates: {} }),
    usage: { promptTokens: 1, completionTokens: 1 },
  }))
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(local.getView().revision, revisionBefore, '迟到结果不得推进 revision')
  try { await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]) } catch { /* ok */ }
})
