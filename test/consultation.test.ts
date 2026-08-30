import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import { fakeWorkers, type WorkerSet } from '../src/workers.ts'

function fixture(workers: WorkerSet = fakeWorkers) {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-consult-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  return { runtime: new RoomRuntime(store, workers), roomId }
}

test('consultation is persisted separately and never publishes a scene', async () => {
  const { runtime, roomId } = fixture()
  await runtime.submitTurn(roomId, { text: '我询问烛火的来源。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const draft = runtime.get(roomId).draft!
  await runtime.consult(roomId, draft.id, '这盏烛火是不是新的设定？')
  const consulting = runtime.get(roomId)
  assert.equal(consulting.phase, 'consulting-director')
  assert.equal(consulting.scenes.length, 1, '咨询不发布 scene：玩家发言只在正式成稿发布时落盘')
  assert.equal(consulting.consultations[0].role, 'player')
  assert.equal(consulting.consultations[1].role, 'director')
  runtime.finishConsultation(roomId)
  assert.equal(runtime.get(roomId).phase, 'awaiting-approval')
  assert.equal(runtime.get(roomId).draft?.id, draft.id)
})

test('redraft replaces the draft without creating a canonical scene', async () => {
  const seen: string[] = []
  const workers: WorkerSet = {
    decide: fakeWorkers.decide,
    draft: async (turnId, contribution, decisions, roles, consultations = []) => {
      seen.push(consultations.map(item => item.text).join('|'))
      const draft = await fakeWorkers.draft(turnId, contribution, decisions, roles, consultations)
      return { ...draft, id: `draft-${seen.length}`, text: `${draft.text}\n修订版` }
    },
    consult: fakeWorkers.consult,
  }
  const { runtime, roomId } = fixture(workers)
  await runtime.submitTurn(roomId, { text: '我提出一个问题。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const original = runtime.get(roomId).draft!
  await runtime.consult(roomId, original.id, '请把这个问题写得更明确。')
  await runtime.redraft(roomId, original.id)
  const revised = runtime.get(roomId)
  assert.equal(revised.phase, 'awaiting-approval')
  assert.notEqual(revised.draft?.id, original.id)
  assert.match(revised.draft?.text ?? '', /修订版/)
  assert.equal(revised.scenes.length, 1, '重写不发布 scene：玩家发言只在正式成稿发布时落盘')
  assert.match(seen[1], /请把这个问题写得更明确/) 
})
