import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ModelGateway, createRealWorkers } from '../src/model-gateway.ts'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import { fakeWorkers } from '../src/workers.ts'

test('群聊 digest 只写入规范化的结构化记忆，并使用已批准场景快照', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-structured-digest-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store, {
    ...fakeWorkers,
    digest: async () => ({ entries: [
      { text: '  玩家交出了银钥匙。  ' },
      { text: '不应写入。' },
      { text: '   ' },
    ] } as any),
  })
  runtime.setRoomConfig(roomId, { mode: 'chat' })

  await runtime.speak(roomId, 'aria')
  await runtime.approveSpeech(roomId, '「银钥匙在这里。」')

  const room = runtime.get(roomId)
  const scene = room.scenes.at(-1)!
  const aria = room.roles.find(role => role.id === 'aria')!
  const memory = aria.memories.find(item => item.text === '玩家交出了银钥匙。')!
  assert.ok(memory)
  assert.equal(memory.sceneId, scene.id)
  assert.equal(memory.turnId, scene.turnId)
  assert.equal(memory.occurredAt, scene.sceneTime)
  assert.equal(memory.occurredLocation, scene.sceneLocation)
  assert.equal(memory.source, 'role_reaction')
  assert.equal(aria.memories.some(item => item.text === '不应写入。'), true)
  assert.equal(Object.values(aria.memoryTimeline).flat().some(item => item.includes('银钥匙')), false)
})

test('结构化 digest 以场景、类型和文本去重', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-structured-dedupe-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const entry = { id: 'memory-one', sceneId: 'scene-one', turnId: 'turn-one', occurredAt: '夜晚', source: 'role_reaction' as const, kind: 'fact' as const, text: 'Aria 记住了钟声。', subjects: [], salience: 3, confidence: 1 }
  store.insertNpcMemories(roomId, 'aria', [entry])
  store.insertNpcMemories(roomId, 'aria', [{ ...entry, id: 'memory-two' }])
  assert.equal(store.listNpcMemories(roomId, 'aria').filter(memory => memory.text === entry.text).length, 1)
})

test('结构化记忆的拖动顺序会持久化，并影响后续读取顺序', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-structured-order-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  store.insertNpcMemories(roomId, 'aria', [
    { id: 'memory-first', occurredAt: '第一日清晨', source: 'manual', text: '先发生的事。' },
    { id: 'memory-last', occurredAt: '第一日夜晚', source: 'manual', text: '后发生的事。' },
  ])
  const before = store.listNpcMemories(roomId, 'aria').map(memory => memory.id)
  const reordered = [...before].reverse()
  store.reorderNpcMemories(roomId, 'aria', reordered)
  assert.deepEqual(store.listNpcMemories(roomId, 'aria').map(memory => memory.id), reordered)
})

test('真实 digest Worker 请求 entries schema，不接受旧 events 协议', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-digest-schema-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const role = store.getRoom(roomId)!.roles.find(item => item.id === 'aria')!
  let request: any
  const gateway = new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_schema', toolCalling: false }, {
    onSummary: () => {},
    fetchImpl: async (_input, init) => {
      request = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ entries: [{ text: 'Aria 看见了银钥匙。' }] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const digest = await createRealWorkers(gateway).digest!(role, { id: 'scene-1', turnId: 'turn-1', text: '玩家展示了银钥匙。', sceneTime: '夜晚', sceneLocation: '大厅', source: 'role_reaction' })
  assert.deepEqual(digest.entries, [{ text: 'Aria 看见了银钥匙。' }])
  assert.ok(request.response_format.json_schema.schema.properties.entries)
  assert.equal(request.response_format.json_schema.schema.properties.events, undefined)
  assert.equal(request.response_format.json_schema.schema.properties.entries.items.properties.kind, undefined)
  assert.equal(request.response_format.json_schema.schema.properties.entries.items.properties.subjects, undefined)
  assert.equal(request.response_format.json_schema.schema.properties.entries.items.properties.salience, undefined)
  assert.equal(request.response_format.json_schema.schema.properties.entries.items.properties.confidence, undefined)
})
