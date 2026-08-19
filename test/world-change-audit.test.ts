import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import { fakeWorkers } from '../src/workers.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-world-audit-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  return { store, roomId }
}

test('批准的导演世界变更关联叙述场景和 NPC 结构化记忆', async () => {
  const { store, roomId } = fixture()
  const runtime = new RoomRuntime(store, {
    ...fakeWorkers,
    directorChat: async () => ({ reply: '已整理。', worldChange: { sceneTime: '深夜', sceneLocation: '城门下' }, narration: '夜色沉下，众人抵达城门。' }),
    digest: async () => ({ entries: [{ kind: 'observation', text: '城门已经关闭。', subjects: [], salience: 4, confidence: 1 }] }),
  })
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  await runtime.directorChat(roomId, '去城门。')
  await runtime.approveWorldChange(roomId)

  const record = store.listWorldChanges(roomId).at(-1)!
  const room = runtime.get(roomId)
  const narration = room.scenes.at(-1)!
  assert.equal(record.status, 'approved')
  assert.equal(record.source, 'director')
  assert.equal(record.beforeSceneTime, '夜晚')
  assert.equal(record.afterSceneTime, '深夜')
  assert.equal(record.narrationSceneId, narration.id)
  assert.equal(narration.kind, 'narration')
  assert.equal(narration.worldChangeId, record.id)
  assert.ok(room.roles.find(role => role.id === 'aria')?.memories.some(memory => memory.worldChangeId === record.id && memory.sceneId === narration.id))
})

test('无叙述正文的世界变更仍审计，但不会凭空生成 NPC 记忆', async () => {
  const { store, roomId } = fixture()
  const runtime = new RoomRuntime(store, { ...fakeWorkers, directorChat: async () => ({ reply: '已整理。', worldChange: { sceneTime: '深夜' } }) })
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  await runtime.directorChat(roomId, '入夜。')
  await runtime.approveWorldChange(roomId)

  const record = store.listWorldChanges(roomId).at(-1)!
  assert.equal(record.status, 'approved')
  assert.equal(record.narrationSceneId, undefined)
  assert.equal(runtime.get(roomId).roles.some(role => role.memories.some(memory => memory.worldChangeId === record.id)), false)
})

test('附带世界变更的已批准台词与其 digest 共享审计 ID', async () => {
  const { store, roomId } = fixture()
  const runtime = new RoomRuntime(store, {
    ...fakeWorkers,
    speak: async () => ({ text: '「城门已经关闭。」', worldChange: { sceneLocation: '城门下' } }),
    digest: async () => ({ entries: [{ kind: 'fact', text: '城门已关闭。', subjects: [], salience: 4, confidence: 1 }] }),
  })
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  await runtime.speak(roomId, 'aria')
  await runtime.approveSpeech(roomId, '「城门已经关闭。」')

  const record = store.listWorldChanges(roomId).at(-1)!
  const room = runtime.get(roomId)
  const scene = room.scenes.at(-1)!
  assert.equal(record.source, 'speech')
  assert.equal(record.status, 'approved')
  assert.equal(scene.worldChangeId, record.id)
  assert.ok(room.roles.find(role => role.id === 'aria')?.memories.some(memory => memory.sceneId === scene.id && memory.worldChangeId === record.id))
})
