import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.ts'
import { RoomRuntime } from '../src/room-runtime.ts'
import type { RoleProposal } from '../src/types.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-roles-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store, {
    decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed', brief: '意图。', privateReaction: '反应。' }),
    draft: async (turnId) => ({ id: 'draft-x', turnId, text: '正文。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], createdAt: new Date().toISOString() }),
  })
  return { store, runtime, roomId }
}

test('player can create and delete a role', () => {
  const { store, runtime, roomId } = fixture()
  runtime.createRole(roomId, { id: 'new-guy', name: '新人', portraitRef: '/assets/default.svg', currentState: '站在门口。', presence: 'present', selfModel: '沉默寡言。', memories: [{ text: '刚出场。', occurredAt: '过去' }] })
  const room = runtime.get(roomId)
  const role = room.roles.find(item => item.id === 'new-guy')
  assert.ok(role, '新角色应存在')
  assert.equal(role!.name, '新人')
  assert.deepEqual(store.listNpcMemories(roomId, 'new-guy').map(m => ({ text: m.text, occurredAt: m.occurredAt })), [{ text: '刚出场。', occurredAt: '过去' }])
  assert.throws(() => runtime.createRole(roomId, { id: 'new-guy', name: '重复', portraitRef: '/x.svg', currentState: 'x', presence: 'present', selfModel: 'x', memories: [] }), /角色已存在/)
  runtime.deleteRole(roomId, 'new-guy')
  assert.ok(!runtime.get(roomId).roles.some(item => item.id === 'new-guy'))
  runtime.deleteRole(roomId, 'noel')
  runtime.deleteRole(roomId, 'mira')
  // 允许删到空角色（互动式小说：无 NPC，玩家直接与导演交互）
  runtime.deleteRole(roomId, 'aria')
  assert.equal(runtime.get(roomId).roles.length, 0, '允许删空所有角色')
})

test('presence toggle updates role and participation roster', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRolePresence(roomId, 'noel', 'present')
  const room = runtime.get(roomId)
  assert.equal(room.roles.find(role => role.id === 'noel')!.presence, 'present')
  // 离场角色不参与决策
  runtime.setRolePresence(roomId, 'noel', 'absent')
  await runtime.submitTurn(roomId, { text: '测试。', requiredRoleIds: ['aria'] })
  const decisions = runtime.get(roomId).decisions
  const noelDecision = decisions.find(d => d.roleId === 'noel')
  assert.equal(noelDecision?.participation, 'excluded')
})

test('director roleProposals create roles on approve', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-roleprop-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store, {
    decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed', brief: '意图。', privateReaction: '反应。' }),
    draft: async (turnId) => {
      const proposal: RoleProposal = { id: 'maid', name: '女仆', portraitRef: '/assets/maid.svg', currentState: '端着茶盘站在一旁。', presence: 'present', selfModel: '安静、周到。', memories: [{ text: '在祭典主厅侍奉。', occurredAt: '过去' }] }
      return { id: 'draft-prop', turnId, text: '女仆端茶走来。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], roleProposals: [proposal], createdAt: new Date().toISOString() }
    },
  })
  await runtime.submitTurn(roomId, { text: '叫侍者。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const draft = runtime.get(roomId).draft!
  assert.deepEqual(draft.roleProposals, [{ id: 'maid', name: '女仆', portraitRef: '/assets/maid.svg', currentState: '端着茶盘站在一旁。', presence: 'present', selfModel: '安静、周到。', memories: [{ text: '在祭典主厅侍奉。', occurredAt: '过去' }] }])
  runtime.approve(roomId, draft.id, draft.text, draft.stateUpdates)
  const room = runtime.get(roomId)
  const maid = room.roles.find(role => role.id === 'maid')
  assert.ok(maid, '批准后女仆角色应创建')
  assert.equal(maid!.presence, 'present')
  assert.ok(room.scenes.some(scene => scene.text.includes('女仆端茶走来')))
})

test('director roleProposal with conflicting id is rejected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-roleprop-bad-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store, {
    decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed', brief: '意图。', privateReaction: '反应。' }),
    draft: async (turnId) => ({ id: 'draft-bad', turnId, text: '正文。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], roleProposals: [{ id: 'aria', name: '冒名', portraitRef: '/x.svg', currentState: 'x', presence: 'present', selfModel: 'x', memoryTimeline: {} }], createdAt: new Date().toISOString() }),
  })
  await runtime.submitTurn(roomId, { text: '测试。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const room = runtime.get(roomId)
  assert.ok(room.lastError?.includes('Role proposal conflicts with existing role'), `应有冲突错误: ${room.lastError}`)
})
