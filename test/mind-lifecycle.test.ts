import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-mind-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  return { runtime: new RoomRuntime(store), store, roomId }
}

test('private reactions stay pending until the player approves the scene', async () => {
  const { runtime, store, roomId } = fixture()
  const memoryTexts = () => JSON.stringify(store.listNpcMemories(roomId, 'aria').map(memory => memory.text))
  const before = memoryTexts()
  await runtime.submitTurn(roomId, { text: '我注视 Aria。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const draft = runtime.get(roomId).draft!
  assert.equal(memoryTexts(), before, '未批准前私有反应不应写入结构化记忆')
  assert.equal(store.listPendingMindUpdates(roomId, draft.turnId).length, 2)
  runtime.approve(roomId, draft.id, draft.text, draft.stateUpdates)
  const after = runtime.get(roomId).roles.find(role => role.id === 'aria')!
  assert.ok(after.memories.some(memory => memory.source === 'role_reaction' && memory.text.includes('需要继续观察')), `expected structured reaction, got: ${JSON.stringify(after.memories)}`)
  assert.equal(store.listPendingMindUpdates(roomId, draft.turnId).length, 0)
})

test('consultation and redraft do not promote pending private reactions', async () => {
  const { runtime, store, roomId } = fixture()
  const memoryTexts = () => JSON.stringify(store.listNpcMemories(roomId, 'aria').map(memory => memory.text))
  const before = memoryTexts()
  await runtime.submitTurn(roomId, { text: '我停在原地。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const draft = runtime.get(roomId).draft!
  await runtime.consult(roomId, draft.id, '我想确认一下。')
  await runtime.redraft(roomId, draft.id)
  assert.equal(memoryTexts(), before, '咨询与重写不应提升待定私有反应')
  assert.ok(store.listPendingMindUpdates(roomId, draft.turnId).length > 0)
})
