import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.ts'
import { RoomRuntime } from '../src/room-runtime.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-impressions-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store, {
    decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed', brief: '意图。', privateReaction: '反应。' }),
    draft: async (turnId) => ({ id: 'draft-x', turnId, text: '正文。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], createdAt: new Date().toISOString() }),
  })
  return { store, runtime, roomId }
}

test('applyRoleImpressions merges, updates and deletes impressions', () => {
  const { store, runtime, roomId } = fixture()
  runtime.interveneRole(roomId, 'aria', 'x', {}, { impressions: { 米拉: '直率好奇。', 诺尔: '谨慎寡言。' } })
  let room = runtime.get(roomId)
  assert.deepEqual(room.roles.find(r => r.id === 'aria')!.impressions, { 米拉: '直率好奇。', 诺尔: '谨慎寡言。' })
  // 新增 + 更新
  store.applyRoleImpressions(roomId, 'aria', { 米拉: '直率且擅长缓和气氛。', 玩家: '值得观察的来访者。' })
  room = runtime.get(roomId)
  assert.deepEqual(room.roles.find(r => r.id === 'aria')!.impressions, { 米拉: '直率且擅长缓和气氛。', 诺尔: '谨慎寡言。', 玩家: '值得观察的来访者。' })
  // 删除（null / 空串）
  store.applyRoleImpressions(roomId, 'aria', { 诺尔: null, 玩家: '   ' })
  room = runtime.get(roomId)
  assert.deepEqual(room.roles.find(r => r.id === 'aria')!.impressions, { 米拉: '直率且擅长缓和气氛。' })
  // 无变化不写库
  const before = runtime.get(roomId).revision
  store.applyRoleImpressions(roomId, 'aria', { 米拉: '直率且擅长缓和气氛。' })
  assert.equal(runtime.get(roomId).revision, before)
})

test('impressions survive archive round-trip and story restart', () => {
  const { store, runtime, roomId } = fixture()
  runtime.interveneRole(roomId, 'mira', 'x', {}, { impressions: { 艾莉娅: '克制敏锐。' } })
  const archive = runtime.exportArchive(roomId)
  runtime.importArchive(roomId, archive)
  assert.deepEqual(runtime.get(roomId).roles.find(r => r.id === 'mira')!.impressions, { 艾莉娅: '克制敏锐。' })
  // 重开剧本回到剧本文件的 impressions（seed 角色无 impressions → 空）
  const story = {
    id: 'demo', title: 'Demo', opening: '开场。', sceneTime: '夜晚', sceneLocation: '大厅',
    playerCharacter: { name: '玩家', persona: 'p', currentState: 'c' },
    roles: [{ id: 'mira', name: 'Mira', portraitRef: '/x.svg', currentState: 's', presence: 'present' as const, impressions: { 艾莉娅: '旧印象。' }, selfModel: 'm' }],
    lore: [],
  }
  runtime.restart(roomId, story)
  assert.deepEqual(runtime.get(roomId).roles.find(r => r.id === 'mira')!.impressions, { 艾莉娅: '旧印象。' })
})

test('decide with impressions updates role card after turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-impressions-turn-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store, {
    decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed', brief: '意图。', privateReaction: '反应。', impressions: { 米拉: '更新后的印象。' } }),
    draft: async (turnId) => ({ id: 'draft-x', turnId, text: '正文。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], createdAt: new Date().toISOString() }),
  })
  await runtime.submitTurn(roomId, { text: '玩家行动。', requiredRoleIds: [] })
  const room = runtime.get(roomId)
  assert.deepEqual(room.roles.find(r => r.id === 'aria')!.impressions, { 米拉: '更新后的印象。' })
})
