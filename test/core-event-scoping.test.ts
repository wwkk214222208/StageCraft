/**
 * W6：状态作用域与流式一致性测试（计划 §3.4 / 阶段 6；用户必做第 6 项）。
 *
 * 覆盖：
 * 1. 两回合交错事件：turn A 的 thinking delta/reaction/draft 不得进入 turn B 的渲染；
 * 2. 迟到事件丢弃：revision < current 的事件直接丢弃；重连 resync 后地板重置；
 * 3. thinking delta 按 requestId 关联（不同请求的 delta 不串）；
 * 4. 导演模式跨回合隔离：上回合 reaction/decision/draft/thinking 不残留；
 * 5. CoreClient 端到端：SSE 流中交错事件按规则过滤（envelope turnId/revision）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { coreEventShouldDeliver } from '../public/core-client.js'

/** 构造 1.1 envelope 包装的 core.event 消息。 */
function enveloped(type, { revision, turnId, requestId, text } = {}) {
  const event = { type, revision, ...(requestId ? { requestId } : {}), ...(text !== undefined ? { text } : {}) }
  const envelope = { protocolVersion: '1.1', roomId: 'room-1', revision, ...(turnId ? { turnId } : {}), ...(requestId ? { requestId } : {}), type, payload: event, createdAt: new Date().toISOString() }
  return { type: 'core.event', event, envelope }
}

test('W6：两回合交错——turn A 的 thinking delta 不得进入 turn B（turnId 过滤）', () => {
  // 当前回合 turn B；收到 turn A 的 thinking delta（envelope 带 turnId=turn-a）
  const turnADelta = enveloped('model.thinking.delta', { revision: 5, turnId: 'turn-a', requestId: 'req-a', text: 'A 的思考' })
  assert.equal(
    coreEventShouldDeliver(turnADelta, { revision: 4, turnId: 'turn-b' }),
    false,
    'turnId 不匹配的 thinking delta 必须丢弃',
  )
  // turn B 自己的 delta 放行
  const turnBDelta = enveloped('model.thinking.delta', { revision: 6, turnId: 'turn-b', requestId: 'req-b', text: 'B 的思考' })
  assert.equal(
    coreEventShouldDeliver(turnBDelta, { revision: 4, turnId: 'turn-b' }),
    true,
    'turnId 匹配的 delta 必须放行',
  )
})

test('W6：两回合交错——上回合 reaction/decision/draft 不得渲染', () => {
  for (const type of ['state.changed', 'workflow.changed', 'domain.event']) {
    const staleTurn = enveloped(type, { revision: 5, turnId: 'turn-a' })
    assert.equal(
      coreEventShouldDeliver(staleTurn, { revision: 6, turnId: 'turn-b' }),
      false,
      `turn-a 的 ${type} 不得进入 turn-b`,
    )
  }
})

test('W6：迟到事件丢弃——revision < current 直接丢弃', () => {
  const stale = enveloped('state.changed', { revision: 3 })
  assert.equal(coreEventShouldDeliver(stale, { revision: 10 }), false, 'revision 3 < 10 必须丢弃')
  const current = enveloped('state.changed', { revision: 10 })
  assert.equal(coreEventShouldDeliver(current, { revision: 10 }), true, 'revision == current 放行')
  const newer = enveloped('state.changed', { revision: 11 })
  assert.equal(coreEventShouldDeliver(newer, { revision: 10 }), true, 'revision > current 放行')
})

test('W6：thinking delta 按 requestId 关联——不同请求的 delta 不串', () => {
  const deltaForOther = enveloped('model.thinking.delta', { revision: 5, requestId: 'req-other', text: '别的请求' })
  assert.equal(
    coreEventShouldDeliver(deltaForOther, { revision: 4, requestId: 'req-current' }),
    false,
    'requestId 不匹配的 thinking delta 必须丢弃',
  )
  const deltaForCurrent = enveloped('model.thinking.delta', { revision: 5, requestId: 'req-current', text: '当前请求' })
  assert.equal(
    coreEventShouldDeliver(deltaForCurrent, { revision: 4, requestId: 'req-current' }),
    true,
    'requestId 匹配的 delta 放行',
  )
})

test('W6：未携带关联字段的事件放行（无法判定 ≠ 判定失败）', () => {
  // 无 turnId 的 envelope：turnId 过滤不适用 → 放行
  const noTurn = enveloped('state.changed', { revision: 7 })
  assert.equal(coreEventShouldDeliver(noTurn, { revision: 6, turnId: 'turn-b' }), true)
  // 非 thinking delta：requestId 过滤不适用 → 放行
  const notDelta = enveloped('state.changed', { revision: 7, requestId: 'req-x' })
  assert.equal(coreEventShouldDeliver(notDelta, { revision: 6, requestId: 'req-y' }), true)
  // 非 core.event 消息：放行
  assert.equal(coreEventShouldDeliver({ type: 'connection.state', state: 'connected' }, { revision: 6 }), true)
})

test('W6：导演模式跨回合隔离——上回合 draft/reaction 不残留（turnId 作用域）', () => {
  // 导演回合 turn-1 的 draft 事件；当前回合 turn-2
  const draftFromPrevious = enveloped('workflow.changed', { revision: 4, turnId: 'turn-1' })
  assert.equal(coreEventShouldDeliver(draftFromPrevious, { revision: 4, turnId: 'turn-2' }), false)
  // 当前回合 draft 放行
  const currentDraft = enveloped('workflow.changed', { revision: 5, turnId: 'turn-2' })
  assert.equal(coreEventShouldDeliver(currentDraft, { revision: 4, turnId: 'turn-2' }), true)
})

test('W6：revision 单调过滤与 resync 地板（CoreClient 消费规则）', () => {
  // 模拟 SSE 事件序列：resync 后地板=10；事件 9（迟到）丢弃、11/12 放行
  const events = [
    enveloped('state.changed', { revision: 9 }),
    enveloped('state.changed', { revision: 11 }),
    enveloped('model.thinking.delta', { revision: 12, requestId: 'req-1', text: 'x' }),
  ]
  let floor = 10
  const delivered = events.filter(message => coreEventShouldDeliver(message, { revision: floor }))
  assert.equal(delivered.length, 2, 'revision 9 必须被地板 10 丢弃')
  assert.equal(delivered[0].event.revision, 11)
  assert.equal(delivered[1].event.revision, 12)
  // 更新地板后，再来的旧事件也丢弃
  floor = 12
  assert.equal(coreEventShouldDeliver(events[0], { revision: floor }), false)
})
