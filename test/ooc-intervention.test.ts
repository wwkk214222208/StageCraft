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
  return { runtime: new RoomRuntime(store, workers), store, roomId }
}

test('private OOC intervention updates role context without creating world facts', () => {
  const { runtime, store, roomId } = fixture()
  runtime.interveneRole(roomId, 'aria', '对玩家更坦诚，但仍谨慎。')
  runtime.storeNpcMemories(roomId, 'aria', [{ text: '玩家曾替她隐瞒伤势。', occurredAt: '过去' }, { text: '她注视了我很久。', occurredAt: '夜晚' }])
  const room = runtime.get(roomId)
  const aria = room.roles.find(role => role.id === 'aria')!
  assert.equal(aria.selfModel, '对玩家更坦诚，但仍谨慎。')
  const memories = store.listNpcMemories(roomId, 'aria')
  assert.ok(memories.some(memory => memory.text === '玩家曾替她隐瞒伤势。' && memory.occurredAt === '过去'), `expected intervention memory, got: ${JSON.stringify(memories)}`)
  assert.ok(memories.some(memory => memory.text === '她注视了我很久。' && memory.occurredAt === '夜晚'), `expected intervention memory, got: ${JSON.stringify(memories)}`)
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
  assert.throws(() => runtime.interveneRole(roomId, 'aria', 'x'), /idle room/)
  await pending
})
