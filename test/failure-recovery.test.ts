import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import { fakeWorkers, type WorkerSet } from '../src/workers.ts'
import type { Decision } from '../src/types.ts'

function fixture(workers: WorkerSet = fakeWorkers) {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-failure-'))
  const path = join(root, 'app.sqlite')
  const store = new Store(path)
  const roomId = store.seed()
  return { runtime: new RoomRuntime(store, workers), roomId, store, path }
}

function workersWith(decide: WorkerSet['decide'], draft: WorkerSet['draft'] = fakeWorkers.draft): WorkerSet {
  return { decide, draft }
}

test('required worker failure blocks Director and preserves collecting phase', async () => {
  const workers = workersWith(async (role, participation) => {
    if (role.id === 'aria') throw new Error('role transport offline')
    return fakeWorkers.decide(role, participation, 'test')
  })
  const { runtime, roomId } = fixture(workers)
  await runtime.submitTurn(roomId, { text: '需要 Aria 决策。', requiredRoleIds: ['aria'] })
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'collecting-decisions')
  assert.equal(room.draft, undefined)
  assert.match(room.lastError ?? '', /aria/)
  assert.equal(room.decisions.find(item => item.roleId === 'aria')?.status, 'unavailable')
})

test('optional worker failure does not block Director', async () => {
  const workers = workersWith(async (role, participation) => {
    if (role.id === 'mira') throw new Error('optional transport offline')
    return fakeWorkers.decide(role, participation, 'test')
  })
  const { runtime, roomId } = fixture(workers)
  await runtime.submitTurn(roomId, { text: '只要求 Aria。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-approval')
  assert.equal(room.decisions.find(item => item.roleId === 'mira')?.status, 'unavailable')
  assert.ok(room.draft)
})

test('Director failure never creates an approvable draft', async () => {
  const workers = workersWith(fakeWorkers.decide, async () => { throw new Error('director offline') })
  const { runtime, roomId } = fixture(workers)
  await runtime.submitTurn(roomId, { text: '导演需要起草。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'drafting')
  assert.equal(room.draft, undefined)
  assert.match(room.lastError ?? '', /Director failed/)
})

test('malformed worker decision is rejected as unavailable', async () => {
  const malformed: Decision = { roleId: 'mira', participation: 'optional', status: 'completed', brief: 'wrong role result' }
  const workers = workersWith(async () => malformed)
  const { runtime, roomId } = fixture(workers)
  await runtime.submitTurn(roomId, { text: '验证返回值。', requiredRoleIds: ['aria'] })
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'collecting-decisions')
  assert.equal(room.decisions.find(item => item.roleId === 'aria')?.status, 'unavailable')
  assert.equal(room.draft, undefined)
})

test('startup recovery releases interrupted collection and drafting rooms', () => {
  const { store, roomId, path } = fixture()
  store.createTurn(roomId, 'interrupted-collection', '未完成的回合', [
    { roleId: 'aria', participation: 'required', status: 'pending' },
  ])
  assert.equal(store.getRoom(roomId)?.phase, 'collecting-decisions')
  assert.equal(store.getRoom(roomId)?.scenes.some(scene => scene.speaker === 'player'), false, '提交阶段玩家发言不落盘')
  const recovered = new Store(path)
  assert.equal(recovered.recoverInterruptedRooms(), 1)
  assert.equal(recovered.getRoom(roomId)?.phase, 'awaiting-player-input')
})

test('cancelling an active turn ignores late worker results', async () => {
  let releaseRole!: () => void
  const roleGate = new Promise<void>(resolve => { releaseRole = resolve })
  const workers = workersWith(async (role, participation) => {
    await roleGate
    return fakeWorkers.decide(role, participation, 'late result')
  })
  const { runtime, roomId } = fixture(workers)
  const pending = runtime.submitTurn(roomId, { text: '这回合随后被取消。', requiredRoleIds: ['aria'] })
  while (runtime.get(roomId).phase !== 'collecting-decisions') await new Promise(resolve => setTimeout(resolve, 5))
  runtime.cancelTurn(roomId)
  releaseRole()
  await pending
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.draft, undefined)
  assert.equal(room.scenes.length, 1, '取消回合不发布正文：玩家发言只在正式成稿发布时落盘，开局 scene 外无残留')
})

test('a second submission cannot overlap an active Room turn', async () => {
  let releaseRole!: () => void
  const roleGate = new Promise<void>(resolve => { releaseRole = resolve })
  const workers = workersWith(async (role, participation) => {
    await roleGate
    return fakeWorkers.decide(role, participation, 'first')
  })
  const { runtime, roomId } = fixture(workers)
  const pending = runtime.submitTurn(roomId, { text: '第一回合。', requiredRoleIds: ['aria'] })
  while (runtime.get(roomId).phase !== 'collecting-decisions') await new Promise(resolve => setTimeout(resolve, 5))
  await assert.rejects(runtime.submitTurn(roomId, { text: '第二回合。', requiredRoleIds: ['aria'] }), /already being processed/)
  runtime.cancelTurn(roomId)
  releaseRole()
  await pending
})
