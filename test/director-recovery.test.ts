import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ModelGateway, createRealWorkers } from '../src/model-gateway.ts'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import { fakeWorkers, type WorkerSet } from '../src/workers.ts'

test('incomplete Director JSON is rejected with an actionable error', async () => {
  let calls = 0
  const gateway = new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' }, { fetchImpl: async () => {
    calls += 1
    const content = calls === 1 ? JSON.stringify({ brief: '意图。', privateReaction: '反应。' }) : JSON.stringify({ stateUpdates: {} })
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  } })
  const workers = createRealWorkers(gateway)
  await assert.rejects(workers.draft('t', '玩家输入', [], []), /missing non-empty text/)
})

test('Director failure can be retried without rerunning role decisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-director-retry-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  let attempts = 0
  const workers: WorkerSet = {
    decide: fakeWorkers.decide,
    draft: async (...args) => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary provider failure')
      return fakeWorkers.draft(...args)
    },
  }
  const runtime = new RoomRuntime(store, workers)
  await runtime.submitTurn(roomId, { text: '重试导演。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  assert.equal(runtime.get(roomId).phase, 'drafting')
  assert.match(runtime.get(roomId).lastError ?? '', /Director failed/)
  await runtime.retryDirector(roomId)
  assert.equal(runtime.get(roomId).phase, 'awaiting-approval')
  assert.ok(runtime.get(roomId).draft)
  assert.equal(attempts, 2)
})
