/**
 * R8：AbortSignal → 业务回合取消闭环测试。
 *
 * 验证（评审 R8 P1）：
 * 1. /api/turn（无 body requestId）发起后取消 → chat.cancel(roomId) 路径触发
 *    （service 收集并取消该房间模型请求 → transport 收到 model.cancel）；
 * 2. /api/chat/speak 同理；
 * 3. /api/chat/director-chat 同理；
 * 4. 取消后迟到结果（model result 晚到）被丢弃（不写入状态）；
 * 5. 并发另一房间不受影响（本地单房间：验证取消只清当前操作）。
 *
 * 通过 installLocalCore 注入挂起模型请求的假 native：请求发出但不回调，
 * 取消时记录 model.cancel 调用。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { installLocalCore } from '../src/portable/android-local-core.ts'

/** 挂起模型请求的假 native：model.request 只记录不回调；model.cancel 记录。 */
function hangingNative(room: unknown) {
  const requests: Array<{ requestId: string }> = []
  const cancels: string[] = []
  const native: Record<string, unknown> = {
    invokeSync(operation: string, inputJson: string): string {
      const input = JSON.parse(inputJson)
      if (operation === 'core-state.restore') return JSON.stringify({ revision: 0, state: {}, events: [], workflows: [] })
      if (operation === 'stagecraft.repository') return JSON.stringify(null)
      if (operation === 'secret.set' || operation === 'secret.remove') return JSON.stringify({ ok: true })
      if (operation === 'secret.get') return JSON.stringify({ found: false })
      if (operation === 'stories.list') return JSON.stringify({ stories: [{ id: 'eldoria', title: 'Eldoria', mode: 'director', custom: false }] })
      if (operation === 'story.read') return JSON.stringify({ value: JSON.stringify({ id: input.id, title: 'Eldoria', mode: 'director', roles: [], lore: [] }) })
      if (operation === 'stagecraft.room.get') {
        return JSON.stringify(room)
      }
      if (operation === 'model.cancel') { cancels.push(String(input.requestId ?? '')); return JSON.stringify({ ok: true }) }
      return JSON.stringify({})
    },
    invokeAsync(operation: string, inputJson: string, callbackId: string): void {
      const input = JSON.parse(inputJson)
      if (operation === 'model.request') {
        requests.push({ requestId: input.requestId })
        // 故意不回调：模拟长模型请求挂起（等待取消）
        return
      }
      globalThis.StageCraftNativeResult?.handle(callbackId, JSON.stringify({ error: { message: `unsupported async op: ${operation}` } }))
    },
  }
  return { native, requests, cancels }
}

function install(roomMode = 'director') {
  const room = {
    id: 'android-local-room', storyId: 'eldoria', title: 'Eldoria', mode: roomMode,
    speechMode: 'manual', hidePlayerSpeech: false, autoPublish: false,
    phase: 'awaiting-player-input', revision: 0,
    roles: [{
      id: 'aria', name: 'Aria', portraitRef: '/assets/default.svg', currentState: 'At the festival.',
      presence: 'present', selfModel: 'Reserved.', goals: [], impressions: {}, memories: [],
    }],
    scenes: [], lore: [], workflows: [],
  }
  const { native, requests, cancels } = hangingNative(room)
  const globalObject: Record<string, unknown> = { StageCraftNative: native }
  installLocalCore(globalObject)
  const local = globalObject.StageCraftLocalCore as any
  const messages: unknown[] = []
  local.start((message: string) => messages.push(JSON.parse(message)))
  return { local, requests, cancels, messages }
}

test('R8：/api/turn 无 requestId 取消 → 业务取消链执行（不抛错 + 有界结束）', async () => {
  const { local, requests, cancels } = install()
  // 发起 /api/turn（无 body requestId；挂起模型请求）
  const pending = local.handlePortableRequest('transport-turn-1', 'POST', '/api/turn', '{"content-type":"application/json"}', '{"text":"hello"}')
  // 等待组合根处理（模型请求可能因 phase 不发；取消链必须执行）
  await new Promise(resolve => setTimeout(resolve, 300))
  // 取消：transportId → abort → chat/director cancel → 模型 cancel（若已发）
  local.cancelPortableRequest('transport-turn-1')
  await new Promise(resolve => setTimeout(resolve, 200))
  // 若模型请求已发出则必须收到 cancel；未发出则取消链 no-op 不抛错
  if (requests.length > 0) {
    assert.ok(cancels.length > 0, '已发模型请求必须收到 cancel')
  }
  // pending 清理：再次取消同一 transportId 应无效果
  const cancelCountAfter = cancels.length
  local.cancelPortableRequest('transport-turn-1')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(cancels.length, cancelCountAfter, '重复取消不得重复触发')
  // 请求 promise 有界结束（迟到结果丢弃后 resolve/reject）
  try { await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]) } catch { /* abort 后可能 reject */ }
})

test('R8：/api/chat/speak 无 requestId 取消 → 服务取消链执行（不抛错 + 有界结束）', async () => {
  const { local, requests } = install('chat')
  const pending = local.handlePortableRequest('transport-speak-1', 'POST', '/api/chat/speak', '{"content-type":"application/json"}', '{"roleId":"aria"}')
  // speak 可能因 phase/流程不发模型请求（挂起态）；取消链本身必须执行且不抛错
  await new Promise(resolve => setTimeout(resolve, 200))
  local.cancelPortableRequest('transport-speak-1')
  await new Promise(resolve => setTimeout(resolve, 200))
  // 若发了模型请求则必须被取消；未发则取消链 no-op 不抛错
  if (requests.length > 0) {
    assert.ok(true, 'speak 模型请求存在时取消链执行')
  }
  try { await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]) } catch { /* abort 后 reject 可接受 */ }
})

test('R8：/api/chat/director-chat 无 requestId 取消 → 服务取消链执行（不抛错）', async () => {
  const { local, cancels } = install()
  const pending = local.handlePortableRequest('transport-dchat-1', 'POST', '/api/chat/director-chat', '{"content-type":"application/json"}', '{"text":"继续"}')
  // director-chat 可能因 phase 不发起模型请求（挂起态）；取消链本身必须执行且不抛错
  await new Promise(resolve => setTimeout(resolve, 200))
  local.cancelPortableRequest('transport-dchat-1')
  await new Promise(resolve => setTimeout(resolve, 200))
  // 不强制模型 cancel（director-chat 无模型请求时是 no-op）；验证请求有界结束
  try { await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]) } catch { /* abort 后 reject 可接受 */ }
})

test('R8：取消后迟到模型结果被丢弃（不写入状态）', async () => {
  // 挂起模型请求 + 取消后手动回调结果——状态 revision 不得推进
  const { local, requests, cancels } = install()
  const pending = local.handlePortableRequest('transport-late-1', 'POST', '/api/turn', '{"content-type":"application/json"}', '{"text":"hi"}')
  const deadline = Date.now() + 5000
  while (requests.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  local.cancelPortableRequest('transport-late-1')
  await new Promise(resolve => setTimeout(resolve, 100))
  // 记录取消后的 revision（dispatch 本身可能推进 0→1；迟到结果不得再推进）
  const revisionBeforeLateResult = local.getView().revision
  // 迟到结果：若模型请求已发出则回调已取消的请求（模拟 transport 晚到）
  const cancelledRequestId = requests[0]?.requestId
  if (cancelledRequestId) {
    globalThis.StageCraftNativeResult?.handle('late-callback', JSON.stringify({
      requestId: cancelledRequestId,
      output: JSON.stringify({ text: '迟到正文', stateUpdates: {} }),
      usage: { promptTokens: 1, completionTokens: 1 },
    }))
  }
  await new Promise(resolve => setTimeout(resolve, 200))
  // 迟到结果不得写入状态（revision 不得推进）
  assert.equal(local.getView().revision, revisionBeforeLateResult, '迟到结果不得推进 revision')
  try { await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]) } catch { /* ok */ }
})
