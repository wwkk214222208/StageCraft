import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'

// 用共享库的安全快照（VACUUM INTO，只读源库）验证新代码完整读写
// 不依赖具体剧本数据：动态取第一个角色验证 memoryTimeline 读写与回合流程
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
  const room = store.getRoom('festival-room')!
  assert.ok(room.roles.length >= 3, `roles >= 3, got ${room.roles.length}`)
  const sourceRole = room.roles.find(role => role.presence === 'present') ?? room.roles[0]
  assert.ok(sourceRole, 'at least one role')
  assert.ok(sourceRole.memoryTimeline && typeof sourceRole.memoryTimeline === 'object', 'memoryTimeline is an object')
  assert.ok(Object.keys(sourceRole.memoryTimeline).length > 0, 'memoryTimeline has at least one bucket')
  assert.ok(sourceRole.selfModel?.length > 0, 'selfModel non-empty')

  // 快照副本可能处于任意 phase（如 live 服务器正在 drafting）——restart 到最小剧本保证 idle，
  // 只在 VACUUM INTO 的临时快照上进行，不影响真实数据库。
  store.restartRoom('festival-room', {
    id: 'migrated', title: 'migrated', opening: '开局。', sceneTime: '夜晚', sceneLocation: '大厅',
    playerCharacter: { name: '玩家', persona: 'p', currentState: 'c' },
    roles: [{ id: sourceRole.id, name: sourceRole.name, portraitRef: sourceRole.portraitRef ?? '/assets/default.svg', currentState: sourceRole.currentState, presence: 'present' as const, memoryTimeline: sourceRole.memoryTimeline, selfModel: sourceRole.selfModel }],
    lore: [],
  })
  const testRole = store.getRoom('festival-room')!.roles[0]
  assert.equal(store.getRoom('festival-room')!.phase, 'awaiting-player-input')

  // intervene 保存时间线
  const runtime = new RoomRuntime(store)
  runtime.interveneRole('festival-room', testRole.id, '新自我模型。', { '未标注时间': ['初始记忆 v2。'], '正午': ['她笑了。'] })
  const after = store.getRoom('festival-room')!.roles.find(role => role.id === testRole.id)!
  assert.deepEqual(after.memoryTimeline, { '过去': ['初始记忆 v2。'], '正午': ['她笑了。'] })

  // 回合流程
  await runtime.submitTurn('festival-room', { text: '正午时分，我们回到主厅。', requiredRoleIds: [testRole.id] })
  await runtime.proceedToDraft('festival-room')
  const draft = runtime.get('festival-room').draft!
  runtime.approve('festival-room', draft.id, draft.text, draft.stateUpdates, draft.sceneUpdates)
  const finalRoom = runtime.get('festival-room')
  const testRole2 = finalRoom.roles.find(role => role.id === testRole.id)!
  assert.ok(Object.keys(testRole2.memoryTimeline ?? {}).includes('过去'))
})
