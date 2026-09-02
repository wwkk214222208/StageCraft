import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'

// 用共享库的安全快照（VACUUM INTO，只读源库）验证新代码完整读写
// 不依赖具体剧本数据：动态取第一个角色验证结构化记忆读写与回合流程
test('migrated live DB works with new code end-to-end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-migrated-'))
  const snapshot = join(root, 'snapshot.sqlite')
  // live 库可能仍是旧名（更名前的运行实例尚未重启迁移）
  const live = ['data/stagecraft.sqlite', 'data/character-tavern.sqlite'].find(path => existsSync(path))
  assert.ok(live, 'data/ 下应有 live 数据库（stagecraft.sqlite 或 character-tavern.sqlite）')
  const src = new DatabaseSync(live, { readOnly: true })
  src.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`)
  src.close()
  const store = new Store(snapshot)
  const roomId = (store as any).db.prepare('SELECT id FROM rooms ORDER BY rowid').all()
    .map((row: { id: string }) => row.id)
    .map((id: string) => ({ id, room: store.getRoom(id) }))
    .find((entry: { room?: ReturnType<Store['getRoom']> }) => {
      const candidate = entry.room
      return candidate && candidate.roles.length >= 3 && candidate.roles.some(role => role.memories.length > 0 && Boolean(role.selfModel?.length))
    })?.id
  assert.ok(roomId, 'live snapshot should contain a room with roles and structured memory')
  const room = store.getRoom(roomId)!
  assert.ok(room.roles.length >= 3, `roles >= 3, got ${room.roles.length}`)
  const sourceRole = room.roles.find(role => role.presence === 'present') ?? room.roles[0]
  assert.ok(sourceRole, 'at least one role')
  assert.ok(Array.isArray(sourceRole.memories), 'memories is an array')
  assert.ok(sourceRole.memories.length > 0, 'memories has at least one record')
  assert.ok(sourceRole.selfModel?.length > 0, 'selfModel non-empty')

  // 快照副本可能处于任意 phase（如 live 服务器正在 drafting）——restart 到最小剧本保证 idle，
  // 只在 VACUUM INTO 的临时快照上进行，不影响真实数据库。
  store.restartRoom(roomId, {
    id: 'migrated', title: 'migrated', opening: '开局。', sceneTime: '夜晚', sceneLocation: '大厅',
    playerCharacter: { name: '玩家', persona: 'p', currentState: 'c' },
    roles: [{ id: sourceRole.id, name: sourceRole.name, portraitRef: sourceRole.portraitRef ?? '/assets/default.svg', currentState: sourceRole.currentState, presence: 'present' as const, memories: sourceRole.memories, selfModel: sourceRole.selfModel }],
    lore: [],
  })
  const testRole = store.getRoom(roomId)!.roles[0]
  assert.equal(store.getRoom(roomId)!.phase, 'awaiting-player-input')

  // intervene 更新自我模型；记忆以结构化记录写入
  const runtime = new RoomRuntime(store)
  runtime.interveneRole(roomId, testRole.id, '新自我模型。')
  runtime.storeNpcMemories(roomId, testRole.id, [{ text: '初始记忆 v2。', occurredAt: '过去' }, { text: '她笑了。', occurredAt: '正午' }])
  const after = store.getRoom(roomId)!.roles.find(role => role.id === testRole.id)!
  assert.equal(after.selfModel, '新自我模型。')
  const afterMemories = store.listNpcMemories(roomId, testRole.id)
  assert.ok(afterMemories.some(memory => memory.text === '初始记忆 v2。' && memory.occurredAt === '过去'), `expected intervention memory, got: ${JSON.stringify(afterMemories)}`)
  assert.ok(afterMemories.some(memory => memory.text === '她笑了。' && memory.occurredAt === '正午'), `expected intervention memory, got: ${JSON.stringify(afterMemories)}`)

  // 回合流程
  await runtime.submitTurn(roomId, { text: '正午时分，我们回到主厅。', requiredRoleIds: [testRole.id] })
  await runtime.proceedToDraft(roomId)
  const draft = runtime.get(roomId).draft!
  runtime.approve(roomId, draft.id, draft.text, draft.stateUpdates)
  assert.ok(store.listNpcMemories(roomId, testRole.id).some(memory => memory.occurredAt === '过去'))
})
