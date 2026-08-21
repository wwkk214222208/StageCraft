import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.ts'
import { RoomRuntime } from '../src/room-runtime.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ct-rollback-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store, {
    decide: async (role) => ({ roleId: role.id, participation: 'required', status: 'completed', brief: 'b', privateReaction: 'r' }),
    draft: async (turnId) => ({ id: `d-${turnId}`, turnId, text: '正文。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], createdAt: new Date().toISOString() }),
  })
  return { store, runtime, roomId }
}

test('rollback truncates scenes, turns, memories, and snapshots beyond the revision', () => {
  const { store, runtime, roomId } = fixture()
  // 玩家消息不构成状态记录点：不递增 revision
  const before = store.currentRevision(roomId)
  store.addPlayerScene(roomId, '玩家消息。')
  assert.equal(store.currentRevision(roomId), before, '玩家消息不递增 revision')
  // 两轮真实发布（群聊链：贡献 → 台词 → 批准发布）
  store.setContribution(roomId, '第一轮行动。')
  store.saveSpeech(roomId, { roleId: 'aria', text: '第一轮台词。', turnId: 't1' })
  store.approveSpeech(roomId, '第一轮台词。')
  const firstRoundScene = runtime.get(roomId).scenes.find(s => s.text.includes('第一轮'))
  assert.ok(firstRoundScene)
  const rev1 = store.sceneRevisionOf(roomId, firstRoundScene.id)
  assert.equal(typeof rev1, 'number', '第一轮发布点有 revision')
  store.setContribution(roomId, '第二轮行动。')
  store.saveSpeech(roomId, { roleId: 'aria', text: '第二轮台词。', turnId: 't2' })
  store.approveSpeech(roomId, '第二轮台词。')
  // 记忆关联第二轮场景
  const scenes = runtime.get(roomId).scenes
  const scene2 = scenes.find(s => s.text.includes('第二轮'))
  assert.ok(scene2)
  runtime.storeNpcMemories(roomId, 'aria', [{ text: '第二轮的记忆。', occurredAt: '过去' }])
  assert.ok(runtime.get(roomId).roles.find(r => r.id === 'aria')!.memories?.some(m => m.text === '第二轮的记忆。'))
  // 剧情关联记忆（带 turnId，模拟 digest 产物）——回滚应删除
  store.insertNpcMemories(roomId, 'aria', [{ id: 'digest-2', turnId: scene2.turnId, occurredAt: '过去', source: 'role_reaction', text: '第二轮剧情记忆。' }])

  // 回滚到第一轮（revision rev1）
  store.rollbackToRevision(roomId, rev1)
  const after = runtime.get(roomId)
  assert.equal(after.scenes.length, 3, '回滚后只剩 seed 开场 + 玩家消息 + 第一轮正文')
  assert.ok(after.scenes.every(s => !s.text.includes('第二轮')), '第二轮正文被删除')
  assert.equal(after.phase, 'awaiting-player-input')
  assert.equal(store.currentRevision(roomId), rev1)
  assert.ok(!after.roles.find(r => r.id === 'aria')!.memories?.some(m => m.text === '第二轮剧情记忆。'), '剧情关联记忆被删除')
  assert.ok(after.roles.find(r => r.id === 'aria')!.memories?.some(m => m.text === '第二轮的记忆。'), '手动记忆保留')
  // 快照历史截断
  const snapshotCount = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db.prepare('SELECT COUNT(*) AS n FROM core_state_snapshots WHERE room_id = ? AND revision > ?').get(roomId, rev1) as { n: number }
  assert.equal(Number(snapshotCount.n), 0, '> rev1 的快照被截断')
})
