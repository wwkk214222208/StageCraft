import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadStoryPackage, saveStoryPackage } from '../src/story-packages.ts'
import { Store } from '../src/store.ts'
import { RoomRuntime } from '../src/room-runtime.ts'

test('sync roles to story: 运行中角色卡写回初始剧本，重开即用新角色', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-sync-story-'))
  const story = {
    id: 'demo', title: 'Demo', opening: '开场。', sceneTime: '夜晚', sceneLocation: '大厅',
    playerCharacter: { name: '玩家', persona: '人设。', currentState: '状态。' },
    roles: [{ id: 'aria', name: 'Aria', portraitRef: '/a.svg', currentState: '在场。', presence: 'present', memories: [{ text: '原始记忆。', occurredAt: '过去' }], selfModel: '原始人设。', impressions: { 旅人: '剧本里已有的印象。' } }],
  }
  writeFileSync(join(root, 'demo.json'), JSON.stringify(story))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store)
  // 运行中：修改人设 + 更新印象 + 追加记忆 + 新建角色
  runtime.interveneRole(roomId, 'aria', '修改后的人设。', undefined, { impressions: { 旅人: '运行中更新的印象。' } })
  runtime.storeNpcMemories(roomId, 'aria', [{ text: '修改后记忆。', occurredAt: '过去' }])
  runtime.createRole(roomId, { id: 'newbie', name: '新人', portraitRef: '/n.svg', currentState: '站在门口。', presence: 'present', selfModel: '新人设。', memories: [{ text: '刚出场。', occurredAt: '过去' }] })
  // 模拟 /api/story/sync-roles：用 room.roles 覆盖 story.roles（room 有印象时采用运行中印象；room 无印象时回退到剧本原有印象）
  const room = runtime.get(roomId)
  const synced = loadStoryPackage(root, 'demo')
  const storyImpressions = new Map(synced.roles.map(item => [item.id, item.impressions]))
  synced.roles = room.roles.map(role => ({
    id: role.id, name: role.name, portraitRef: role.portraitRef, currentState: role.currentState, presence: role.presence,
    memories: (role.memories ?? []).map(memory => ({ text: memory.text, occurredAt: memory.occurredAt })), selfModel: role.selfModel,
    ...(role.impressions && Object.keys(role.impressions).length ? { impressions: role.impressions } : storyImpressions.get(role.id) ? { impressions: storyImpressions.get(role.id) } : {}),
  }))
  saveStoryPackage(root, synced)
  const reloaded = JSON.parse(readFileSync(join(root, 'demo.json'), 'utf8'))
  assert.equal(reloaded.roles.length, 4, '同步后剧本应有 4 个角色（seed 3 + 新建 1）')
  assert.equal(reloaded.roles.find(r => r.id === 'aria').selfModel, '修改后的人设。')
  assert.deepEqual(reloaded.roles.find(r => r.id === 'aria').memories, store.listNpcMemories(roomId, 'aria').map(memory => ({ text: memory.text, occurredAt: memory.occurredAt })), '同步后角色记忆应等于运行中记忆列表')
  assert.ok(reloaded.roles.find(r => r.id === 'aria').memories.some(memory => memory.text === '修改后记忆。'), '运行中追加的记忆应写回剧本')
  assert.equal(reloaded.roles.find(r => r.id === 'newbie').name, '新人')
  assert.equal(reloaded.title, 'Demo', '剧本元数据保持不变')
  assert.deepEqual(reloaded.roles.find(r => r.id === 'aria').impressions, { 旅人: '运行中更新的印象。' }, '同步后采用运行中的他人印象')
  assert.deepEqual(reloaded.roles.find(r => r.id === 'newbie').impressions, undefined, '无印象的新角色不产生空 impressions 字段')
})

test('sync role to story: 单角色同步保留印象；room 印象为空时保留剧本原印象', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-sync-role-impression-'))
  const story = {
    id: 'demo2', title: 'Demo2', opening: '开场。', sceneTime: '夜晚', sceneLocation: '大厅',
    playerCharacter: { name: '玩家', persona: '人设。', currentState: '状态。' },
    roles: [{ id: 'aria', name: 'Aria', portraitRef: '/a.svg', currentState: '在场。', presence: 'present', memories: [{ text: '原始记忆。', occurredAt: '过去' }], selfModel: '原始人设。', impressions: { 旅人: '剧本里已有的印象。' } }],
  }
  writeFileSync(join(root, 'demo2.json'), JSON.stringify(story))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store)
  // room 角色没有印象（例如重开后未更新）→ 同步不应抹掉剧本里已有的印象
  runtime.interveneRole(roomId, 'aria', '修改后的人设。', undefined)
  const room = runtime.get(roomId)
  const synced = loadStoryPackage(root, 'demo2')
  const index = synced.roles.findIndex(item => item.id === 'aria')
  const role = room.roles.find(item => item.id === 'aria')!
  const updated = { id: role.id, name: role.name, portraitRef: role.portraitRef, currentState: role.currentState, presence: role.presence, memories: (role.memories ?? []).map(memory => ({ text: memory.text, occurredAt: memory.occurredAt })), selfModel: role.selfModel, ...(role.impressions && Object.keys(role.impressions).length ? { impressions: role.impressions } : index >= 0 && synced.roles[index].impressions ? { impressions: synced.roles[index].impressions } : {}) }
  if (index >= 0) synced.roles[index] = updated; else synced.roles.push(updated)
  saveStoryPackage(root, synced)
  const reloaded = JSON.parse(readFileSync(join(root, 'demo2.json'), 'utf8'))
  assert.deepEqual(reloaded.roles.find(r => r.id === 'aria').impressions, { 旅人: '剧本里已有的印象。' }, 'room 印象为空时保留剧本原印象')
})
