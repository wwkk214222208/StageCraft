import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { ModelGateway, createRealWorkers } from '../src/model-gateway.ts'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store, mergeTimelineEvent } from '../src/store.ts'

function fixture(seedScene = true) {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-scene-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  return { runtime: new RoomRuntime(store), store, roomId, root }
}

test('mergeTimelineEvent deduplicates by containment and overlap', () => {
  const timeline: Record<string, string[]> = {}
  assert.equal(mergeTimelineEvent(timeline, '夜晚', 'Aria 收下胸针并警觉起来。'), true)
  assert.equal(mergeTimelineEvent(timeline, '夜晚', 'Aria 收下胸针并警觉起来。'), false, 'identical rejected')
  assert.equal(mergeTimelineEvent(timeline, '夜晚', 'Aria 收下胸针并警觉起来，她决定之后查清来人的来历。'), false, 'containment rejected')
  assert.deepEqual(timeline['夜晚'], ['Aria 收下胸针并警觉起来。'])
  assert.equal(mergeTimelineEvent(timeline, '黎明', '新的早晨。'), true)
  assert.deepEqual(Object.keys(timeline).sort(), ['夜晚', '黎明'].sort())
})

test('approved scene reaction lands in the memory timeline under the current scene time', async () => {
  const { runtime, store, roomId } = fixture()
  assert.equal(runtime.get(roomId).sceneTime, '夜晚')
  await runtime.submitTurn(roomId, { text: '我把胸针递给她。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const draft = runtime.get(roomId).draft!
  runtime.approve(roomId, draft.id, draft.text, draft.stateUpdates)
  const aria = runtime.get(roomId).roles.find(role => role.id === 'aria')!
  assert.ok(aria.memories.some(memory => memory.occurredAt === '夜晚' && memory.text.includes('需要继续观察')), JSON.stringify(aria.memories))
  // 初始记忆保留在「过去」桶，不再被追加
  assert.deepEqual(aria.memoryTimeline?.['过去'], ['玩家的举动值得留意。'])
  assert.equal(store.listPendingMindUpdates(roomId, draft.turnId).length, 0)
})

test('director sceneUpdates propose time/location; approval applies them and re-buckets later reactions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-scene-upd-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store, {
    decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed', brief: '意图。', privateReaction: `${role.name} 记得此刻。` }),
    draft: async (turnId, _c, _d, _r, _consult, _player) => ({
      id: 'draft-scene', turnId, text: '夜色渐深，众人移步回廊。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [],
      sceneUpdates: { time: '深夜', location: '宫殿回廊' }, createdAt: new Date().toISOString(),
    }),
  })
  await runtime.submitTurn(roomId, { text: '我们走吧。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const draft = runtime.get(roomId).draft!
  assert.deepEqual(draft.sceneUpdates, { time: '深夜', location: '宫殿回廊' })
  runtime.approve(roomId, draft.id, draft.text, draft.stateUpdates, draft.sceneUpdates)
  const room = runtime.get(roomId)
  assert.equal(room.sceneTime, '深夜')
  assert.equal(room.sceneLocation, '宫殿回廊')
  const aria = room.roles.find(role => role.id === 'aria')!
  assert.ok(aria.memories.some(memory => memory.occurredAt === '深夜' && memory.text.includes('记得此刻')), JSON.stringify(aria.memories))
})

test('worker prompts inject scene context and memory timeline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-prompt-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const prompts: string[] = []
  const gateway = new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_object', toolCalling: false }, {
    onSummary: () => {},
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }
      prompts.push(body.messages.map(m => m.content).join('\n'))
      const response = new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ brief: '意图。', privateReaction: '反应。' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      return response
    },
  })
  const runtime = new RoomRuntime(store, createRealWorkers(gateway))
  await runtime.submitTurn(roomId, { text: '我在夜晚的祭典主厅开口。', requiredRoleIds: ['aria'] })
  const rolePrompt = prompts[0]
  assert.match(rolePrompt, /【当前时间】夜晚/)
  assert.match(rolePrompt, /【当前地点】皇家祭典主厅/)
  assert.match(rolePrompt, /【过去】/)
  assert.match(rolePrompt, /- 玩家的举动值得留意。/)
  const directorPrompt = prompts[prompts.length - 1]
  assert.match(directorPrompt, /【当前时间】夜晚/)
})

test('legacy databases migrate scene and memory timeline columns', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-migrate-'))
  const db = new DatabaseSync(join(root, 'legacy.sqlite'))
  db.exec(`CREATE TABLE rooms (id TEXT PRIMARY KEY, title TEXT NOT NULL, player_name TEXT NOT NULL DEFAULT '玩家', player_persona TEXT NOT NULL DEFAULT '由玩家自由定义的参与者。', player_state TEXT NOT NULL DEFAULT '刚刚进入当前场景。', phase TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, player_contribution TEXT, last_error TEXT) STRICT; CREATE TABLE roles (room_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, portrait_ref TEXT NOT NULL, current_state TEXT NOT NULL, presence TEXT NOT NULL, private_memory TEXT NOT NULL, self_model TEXT NOT NULL, PRIMARY KEY (room_id, id)) STRICT; CREATE TABLE drafts (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, turn_id TEXT NOT NULL, text TEXT NOT NULL, state_updates TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;`)
  db.exec("INSERT INTO rooms (id, title, phase) VALUES ('r1', '旧房', 'awaiting-player-input')")
  db.exec("INSERT INTO roles (room_id, id, name, portrait_ref, current_state, presence, private_memory, self_model) VALUES ('r1', 'aria', 'Aria', '/a.svg', '在场', 'present', '旧记忆。', '克制。')")
  db.close()
  const store = new Store(join(root, 'legacy.sqlite'))
  const room = store.getRoom('r1')!
  assert.equal(room.sceneTime, undefined)
  // 旧 private_memory 并入「过去」桶，列已删除
  assert.deepEqual(room.roles[0].memoryTimeline, { '过去': ['旧记忆。'] })
  const roleColumns = new Set(store['db'].prepare('PRAGMA table_info(roles)').all().map((row: any) => row.name as string))
  assert.ok(!roleColumns.has('private_memory'), 'private_memory column should be dropped')
})

test('each published scene snapshots the scene time/location at approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-scene-snapshot-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store, {
    decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed', brief: '意图。', privateReaction: '反应。' }),
    draft: async (turnId, _c, _d, _r, _consult, _player, scene) => ({
      id: `draft-${turnId}`, turnId, text: `正文（场景：${scene?.time ?? '?'}/${scene?.location ?? '?'}）。`, stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [],
      sceneUpdates: scene?.time === '夜晚' ? { time: '深夜', location: '宫殿回廊' } : undefined, createdAt: new Date().toISOString(),
    }),
  })
  // 第一回合：夜晚 → 批准后场景变为深夜
  await runtime.submitTurn(roomId, { text: '走吧。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const draft1 = runtime.get(roomId).draft!
  runtime.approve(roomId, draft1.id, draft1.text, draft1.stateUpdates, draft1.sceneUpdates)
  let room = runtime.get(roomId)
  assert.equal(room.sceneTime, '深夜')
  // 第一段正文快照：批准当时的有效场景是深夜（合并 sceneUpdates 后）
  assert.equal(room.scenes.at(-1)!.sceneTime, '深夜')
  assert.equal(room.scenes.at(-1)!.sceneLocation, '宫殿回廊')
  // 第二回合：场景已是深夜，导演不再提议变化
  await runtime.submitTurn(roomId, { text: '继续。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const draft2 = runtime.get(roomId).draft!
  runtime.approve(roomId, draft2.id, draft2.text, draft2.stateUpdates, draft2.sceneUpdates)
  room = runtime.get(roomId)
  // 第二段正文快照保持深夜/宫殿回廊（当时的场景状态）
  assert.equal(room.scenes.at(-1)!.sceneTime, '深夜')
  assert.equal(room.scenes.at(-1)!.sceneLocation, '宫殿回廊')
})
