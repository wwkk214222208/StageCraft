import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import { type WorkerSet } from '../src/workers.ts'

function fixture(workers?: WorkerSet) {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-ooc-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  return { runtime: new RoomRuntime(store, workers), roomId }
}

test('private OOC intervention updates role context without creating world facts', () => {
  const { runtime, roomId } = fixture()
  runtime.interveneRole(roomId, 'aria', '对玩家更坦诚，但仍谨慎。', { '未标注时间': ['玩家曾替她隐瞒伤势。'], '夜晚': ['她注视了我很久。'] })
  const room = runtime.get(roomId)
  const aria = room.roles.find(role => role.id === 'aria')!
  assert.equal(aria.selfModel, '对玩家更坦诚，但仍谨慎。')
  assert.deepEqual(aria.memoryTimeline, { '过去': ['玩家曾替她隐瞒伤势。'], '夜晚': ['她注视了我很久。'] })
  assert.equal(room.scenes.length, 1, '干预不产生世界事实，只有开局 scene')
})

test('private OOC intervention is rejected while a turn is active', async () => {
  const workers: WorkerSet = {
    decide: async (role, participation) => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return { roleId: role.id, participation, status: 'completed', brief: '等待。', privateReaction: '等待。' }
    },
    draft: async () => { throw new Error('not reached') },
  }
  const { runtime, roomId } = fixture(workers)
  const pending = runtime.submitTurn(roomId, { text: '开始。', requiredRoleIds: ['aria'] })
  while (runtime.get(roomId).phase !== 'collecting-decisions') await new Promise(resolve => setTimeout(resolve, 5))
  assert.throws(() => runtime.interveneRole(roomId, 'aria', 'x', {}), /idle room/)
  await pending
})
