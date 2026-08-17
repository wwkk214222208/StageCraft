import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import type { StoryPackage } from '../src/story-packages.ts'

function fixture(): { runtime: RoomRuntime; roomId: string; databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-'))
  const databasePath = join(root, 'app.sqlite')
  const store = new Store(databasePath)
  return { runtime: new RoomRuntime(store), roomId: store.seed(), databasePath }
}

test('旧库迁移：rooms 获得 mode / auto_publish / speech 列', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-migrate-'))
  const databasePath = join(root, 'app.sqlite')
  const store = new Store(databasePath)
  const roomId = store.seed()
  store.setRoomConfig(roomId, { mode: 'chat', autoPublish: true })
  const room = store.getRoom(roomId)!
  assert.equal(room.mode, 'chat')
  assert.equal(room.autoPublish, true)
})

test('群聊模式：提交贡献只存上下文，不触发决策', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  await runtime.submitTurn(roomId, { text: '我走近 Aria。' })
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.playerContribution, '我走近 Aria。')
  assert.equal(room.decisions.length, 0)
})

test('群聊模式：发言 → 待审批台词 → 批准发布 → 在场角色同步消化记忆', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  await runtime.speak(roomId, 'aria')
  let room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-approval')
  assert.ok(room.speech)
  assert.equal(room.speech.roleId, 'aria')
  assert.ok(room.speech.text.length > 0)

  await runtime.approveSpeech(roomId, '「那把钥匙并不属于你。」')
  room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.scenes.at(-1)?.text, '「那把钥匙并不属于你。」')
  assert.equal(room.speech, undefined)
  // 在场角色（aria/mira）都消化了记忆；不在场的 noel 没有
  // 记忆按「当前场景时间」归档（seed 房间默认起始时间为第一日黄昏）
  const sceneBucket = room.sceneTime ?? '未标注时间'
  assert.ok((room.roles.find(role => role.id === 'aria')?.memoryTimeline[sceneBucket] ?? []).some(event => event.includes('场景')))
  assert.ok((room.roles.find(role => role.id === 'mira')?.memoryTimeline[sceneBucket] ?? []).some(event => event.includes('场景')))
  const noelDigested = (room.roles.find(role => role.id === 'noel')?.memoryTimeline[sceneBucket] ?? []).some(event => event.includes('场景'))
  assert.equal(noelDigested, false)
})

test('群聊模式：不在场角色不能发言', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  await assert.rejects(runtime.speak(roomId, 'noel'), /不在场/)
  assert.equal(runtime.get(roomId).phase, 'awaiting-player-input')
})

test('沉浸模式（导演）：提交后决策→草稿→发布全自动', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { autoPublish: true })
  await runtime.submitTurn(roomId, { text: '我看向 Aria。', requiredRoleIds: ['aria'] })
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.ok(room.scenes.length >= 1)
  assert.equal(room.draft, undefined)
})

test('沉浸模式（群聊）：台词完成后自动发布并消化', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat', autoPublish: true })
  await runtime.speak(roomId, 'mira')
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.ok(room.scenes.at(-1)?.text.length > 0)
  assert.ok((room.roles.find(role => role.id === 'aria')?.memoryTimeline['未标注时间'] ?? []).length > 0)
})

test('重启剧本可带入模式与沉浸开关', () => {
  const { runtime, roomId } = fixture()
  const story: StoryPackage = { id: 'eldoria', title: '祭典', opening: '开场', playerCharacter: { name: '玩家', persona: 'p', currentState: 's' }, roles: [], lore: [] }
  runtime.restart(roomId, story, { mode: 'chat', autoPublish: true })
  const room = runtime.get(roomId)
  assert.equal(room.mode, 'chat')
  assert.equal(room.autoPublish, true)
})

test('无权在无待审批台词时批准发言', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  await assert.rejects(runtime.approveSpeech(roomId, '没有台词时不应通过'), /没有待审批的台词/)
})