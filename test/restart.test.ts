import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import { parsePort } from '../src/app-boot.ts'

const stories = join(import.meta.dirname, '..', 'stories')
const fixtures = join(import.meta.dirname, 'fixtures')

test('ports are validated before server setup', () => {
  for (const value of ['0', '8787', 65535]) assert.doesNotThrow(() => parsePort(value))
  for (const value of ['', '-1', '1.5', '65536', 'abc']) assert.throws(() => parsePort(value), /0 to 65535/)
})

test('restart atomically clears the current room and applies the selected story package', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-restart-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store)
  await runtime.submitTurn(roomId, { text: '旧回合。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const oldDraft = runtime.get(roomId).draft
  assert.ok(oldDraft)
  runtime.approve(roomId, oldDraft.id, oldDraft.text, oldDraft.stateUpdates)
  runtime.restart(roomId, loadStoryPackage(fixtures, 'royal-festival'))
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.scenes.length, 1, '重开后开局文本成为第一条历史 scene')
  assert.equal(room.scenes[0].text, loadStoryPackage(fixtures, 'royal-festival').opening)
  assert.equal(room.draft, undefined)
  assert.equal(room.consultations.length, 0)
})

test('restart completely resets room state: memories, world changes and events are cleared like a new room', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-restart-reset-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  // 种下运行痕迹：角色记忆 + 世界变更记录
  store.insertNpcMemories(roomId, 'aria', [{ id: 'manual-mem-1', text: '重开前留下的记忆。', occurredAt: '过去', source: 'manual' }])
  const beforeMemories = store.listNpcMemories(roomId, 'aria')
  assert.ok(beforeMemories.some(memory => memory.text === '重开前留下的记忆。'), '前置条件：记忆已写入')
  store.restartRoom(roomId, loadStoryPackage(fixtures, 'royal-festival'))
  const room = store.getRoom(roomId)!
  assert.equal(room.phase, 'awaiting-player-input')
  // 角色记忆被重置：不再包含运行期残留，只保留剧本声明的初始记忆
  const afterMemories = store.listNpcMemories(roomId, 'aria')
  assert.ok(!afterMemories.some(memory => memory.text === '重开前留下的记忆。'), '运行期记忆应被清空')
  // 世界变更记录一并清空
  assert.equal(store.listWorldChanges(roomId).length, 0)
  // 场景只剩开场
  assert.equal(room.scenes.length, 1)
  assert.equal(room.scenes[0].text, loadStoryPackage(fixtures, 'royal-festival').opening)
  assert.equal(room.draft, undefined)
})

test('restart is allowed while the room is awaiting approval and clears the draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-restart-busy-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store)
  await runtime.submitTurn(roomId, { text: '不能误删。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  runtime.restart(roomId, loadStoryPackage(fixtures, 'royal-festival'))
  assert.equal(runtime.get(roomId).phase, 'awaiting-player-input')
  assert.equal(runtime.get(roomId).draft, undefined)
})
