import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'

function fixture(): { runtime: RoomRuntime; roomId: string; databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'character-tavern-'))
  const databasePath = join(root, 'app.sqlite')
  const store = new Store(databasePath)
  return { runtime: new RoomRuntime(store), roomId: store.seed(), databasePath }
}

test('required and optional roles resolve before drafting', async () => {
  const { runtime, roomId } = fixture()
  await runtime.submitTurn(roomId, { text: '我向 Aria 举起酒杯。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-approval')
  assert.equal(room.decisions.find(item => item.roleId === 'aria')?.participation, 'required')
  assert.equal(room.decisions.find(item => item.roleId === 'aria')?.status, 'completed')
  assert.equal(room.decisions.find(item => item.roleId === 'mira')?.participation, 'optional')
  assert.equal(room.decisions.find(item => item.roleId === 'noel')?.participation, 'excluded')
  assert.ok(room.draft?.text.includes('Aria'))
})

test('approval publishes edited canonical text and changed state', async () => {
  const { runtime, roomId } = fixture()
  await runtime.submitTurn(roomId, { text: '我看向 Aria。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const draft = runtime.get(roomId).draft
  assert.ok(draft)
  runtime.approve(roomId, draft.id, '玩家最终批准的正文。', { aria: '位于祭典主厅，在场。她的注意力已经平静下来。' })
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.scenes.at(-1)?.text, '玩家最终批准的正文。')
  assert.equal(room.roles.find(role => role.id === 'aria')?.currentState, '位于祭典主厅，在场。她的注意力已经平静下来。')
  assert.equal(room.draft, undefined)
})

test('required roles must exist and be present', async () => {
  const { runtime, roomId } = fixture()
  await assert.rejects(
    runtime.submitTurn(roomId, { text: '我寻找 Noel。', requiredRoleIds: ['noel'] }),
    /Required roles must be present: noel/,
  )
  assert.equal(runtime.get(roomId).phase, 'awaiting-player-input')
})

test('approval rejects state updates for unknown roles', async () => {
  const { runtime, roomId } = fixture()
  await runtime.submitTurn(roomId, { text: '我看向 Aria。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const draft = runtime.get(roomId).draft
  assert.ok(draft)
  assert.throws(
    () => runtime.approve(roomId, draft.id, '不应发布。', { ghost: '不存在。' }),
    /Unknown role state updates: ghost/,
  )
  assert.equal(runtime.get(roomId).phase, 'awaiting-approval')
})

test('an awaiting-approval draft survives runtime reconstruction', async () => {
  const { runtime, roomId, databasePath } = fixture()
  await runtime.submitTurn(roomId, { text: '我等候 Aria 回应。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const before = runtime.get(roomId)
  const recovered = new RoomRuntime(new Store(databasePath)).get(roomId)
  assert.equal(recovered.phase, 'awaiting-approval')
  assert.equal(recovered.draft?.id, before.draft?.id)
  assert.equal(recovered.draft?.text, before.draft?.text)
})
