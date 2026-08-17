import assert from 'node:assert/strict'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import { fakeWorkers, type WorkerSet } from '../src/workers.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixture(workers: WorkerSet) {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-draft-validation-'))
  const store = new Store(join(root, 'app.sqlite'))
  return { runtime: new RoomRuntime(store, workers), roomId: store.seed() }
}

test('malformed Director drafts never become approvable', async () => {
  const workers: WorkerSet = {
    decide: fakeWorkers.decide,
    draft: async (turnId, _contribution, _decisions, _roles) => ({
      id: 'bad-draft', turnId: `${turnId}-wrong`, text: '', stateUpdates: { unknown: 'forbidden' }, createdAt: new Date().toISOString(),
    }),
  }
  const { runtime, roomId } = fixture(workers)
  await runtime.submitTurn(roomId, { text: '验证 Director 输出。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'drafting')
  assert.equal(room.draft, undefined)
  assert.match(room.lastError ?? '', /Director failed/)
})
