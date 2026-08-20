import assert from 'node:assert/strict'
import test from 'node:test'
import { commandForInteraction, dispatchInteraction, portraitInitial, summarizeCoreView } from '../android/app/src/main/assets/renderer.js'

test('Android renderer maps generic interactions through a fake native bridge', () => {
  const dispatched: unknown[] = []
  const bridge = { dispatch: (json: string) => dispatched.push(JSON.parse(json)) }
  const role = { id: 'choose-speaker', kind: 'role-select', options: [{ id: 'aria', label: 'Aria' }] }
  const text = { id: 'player-input', kind: 'text' }
  const approval = { id: 'room:decision-approval', kind: 'approval' }

  dispatchInteraction(bridge, role, 'submit', 'aria')
  dispatchInteraction(bridge, text, 'submit', '继续前进')
  dispatchInteraction(bridge, approval, 'approve')
  dispatchInteraction(bridge, approval, 'reject')

  assert.deepEqual(dispatched.map((command: any) => ({ type: command.type, interactionId: command.interactionId, payload: command.payload })), [
    { type: 'select-role', interactionId: 'choose-speaker', payload: { roleId: 'aria' } },
    { type: 'submit-text', interactionId: 'player-input', payload: { text: '继续前进' } },
    { type: 'approve', interactionId: 'room:decision-approval', payload: {} },
    { type: 'reject', interactionId: 'room:decision-approval', payload: {} },
  ])
  assert.ok(dispatched.every((command: any) => command.actor === 'player' && /^android-/.test(command.id)))
  assert.throws(() => commandForInteraction({ id: 'progress', kind: 'progress' }, 'submit'), /Unsupported/)
})

test('Android fake bridge completes editable speech, draft, and world-change approvals from projected CoreView', () => {
  const dispatched: any[] = []
  const bridge = { dispatch: (json: string) => dispatched.push(JSON.parse(json)) }
  const summary = summarizeCoreView({
    revision: 12,
    state: {
      room: { id: 'room-1' },
      entities: { speech: { roleId: 'aria', text: '原始发言', turnId: 'turn-1' } },
      narrative: { draft: { id: 'draft-1', text: '原始草稿', stateUpdates: { aria: '警觉' }, sceneUpdates: { time: '夜晚' } } },
      world: { pendingWorldChange: { sceneLocation: '塔顶' } },
    },
    interactions: [],
  })
  dispatchInteraction(bridge, { id: 'room-1:speech-approval', kind: 'approval' }, 'approve', '编辑后的发言', summary)
  dispatchInteraction(bridge, { id: 'room-1:draft-approval', kind: 'approval' }, 'approve', '编辑后的草稿', summary)
  dispatchInteraction(bridge, { id: 'room-1:world-change-approval', kind: 'approval' }, 'approve', JSON.stringify({ sceneLocation: '庭院' }), summary)
  dispatchInteraction(bridge, { id: 'room-1:speech-approval', kind: 'approval' }, 'reject', '', summary)

  assert.deepEqual(dispatched.map(command => command.payload), [
    { action: 'speech', text: '编辑后的发言' },
    { action: 'draft-approval', draftId: 'draft-1', text: '编辑后的草稿', stateUpdates: { aria: '警觉' }, sceneUpdates: { time: '夜晚' } },
    { action: 'world-change', worldChange: { sceneLocation: '庭院' } },
    { action: 'speech' },
  ])
  assert.equal(summary.speech.text, '原始发言')
  assert.equal(summary.draft.text, '原始草稿')
  dispatched[1].payload.stateUpdates.aria = '已修改'
  assert.equal(summary.draft.stateUpdates.aria, '警觉')
})

test('Android renderer summarizes CoreView without server-private configuration', () => {
  const summary = summarizeCoreView({
    revision: 8,
    state: {
      room: { id: 'room-1', title: '远程房间' },
      world: { time: 'night', location: 'tower' },
      entities: { roles: [{ id: 'aria', name: 'Aria', presence: 'present' }] },
      narrative: { scenes: [{ id: 'scene-1', prose: '公开场景' }] },
    },
    interactions: [{ id: 'player-input', kind: 'text' }],
  })
  assert.equal(summary.revision, 8)
  assert.equal(summary.scene.prose, '公开场景')
  assert.equal(summary.roles[0].id, 'aria')
  assert.equal(summary.interactions[0].id, 'player-input')
  assert.equal('provider' in summary, false)
})

test('Android renderer does not depend on structuredClone in older WebViews', () => {
  const previous = globalThis.structuredClone
  try {
    Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value: undefined })
    const command = commandForInteraction(
      { id: 'room:draft-approval', kind: 'approval' },
      'approve',
      'edited',
      { draft: { id: 'draft-1', stateUpdates: { role: { mood: 'calm' } } } },
    )
    assert.deepEqual(command.payload.stateUpdates, { role: { mood: 'calm' } })
  } finally {
    Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value: previous })
  }
})

test('Android renderer keeps a safe initial fallback for unsupported remote SVG portraits', () => {
  assert.equal(portraitInitial({ name: 'Aria', portraitRef: '/assets/aria.svg' }), 'A')
  assert.equal(portraitInitial({ name: '米拉', portraitRef: '/assets/mira.svg' }), '米')
  assert.equal(portraitInitial({ id: 'role-only' }), 'r')
})
