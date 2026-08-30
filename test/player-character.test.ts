import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'

test('story package player character is persisted and can be hot-edited while idle', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-player-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store)
  assert.equal(runtime.get(roomId).playerCharacter.name, '玩家')
  runtime.updatePlayerCharacter(roomId, { name: '林', persona: '谨慎的旅人。', currentState: '站在入口观察人群。' })
  assert.deepEqual(runtime.get(roomId).playerCharacter, { name: '林', persona: '谨慎的旅人。', currentState: '站在入口观察人群。' })
})

test('player character hot-edit is allowed during an active turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-player-busy-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store)
  const pending = runtime.submitTurn(roomId, { text: '测试', requiredRoleIds: ['aria'] })
  // 回合进行中（collecting-decisions 等）允许编辑玩家角色——审批阶段改玩家设定是正常需求
  runtime.updatePlayerCharacter(roomId, { name: '林', persona: '新设定', currentState: '新状态' })
  assert.deepEqual(runtime.get(roomId).playerCharacter, { name: '林', persona: '新设定', currentState: '新状态' })
  await pending
})
