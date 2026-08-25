import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import type { WorkerSet } from '../src/workers.ts'

test('NPC reaction previews are transient and removed after approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-preview-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  let resolveDraft: ((value: any) => void) | undefined
  const workers: WorkerSet = {
    decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed', brief: `${role.name} 的即时反应。`, privateReaction: '' }),
    draft: async (turnId) => await new Promise(resolve => { resolveDraft = resolve; }).then(() => ({ id: 'draft-preview', turnId, text: '导演草稿。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], createdAt: new Date().toISOString() })),
  }
  const runtime = new RoomRuntime(store, workers)
  const turn = runtime.submitTurn(roomId, { text: '玩家行动', requiredRoleIds: ['aria'] })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(runtime.get(roomId).reactions.some(reaction => reaction.roleId === 'aria'))
  await turn
  const proceed = runtime.proceedToDraft(roomId) // draft 被调用后才赋值 resolveDraft
  await new Promise(resolve => setTimeout(resolve, 10))
  resolveDraft!()
  await proceed
  const withDraft = runtime.get(roomId)
  assert.equal(withDraft.phase, 'awaiting-approval')
  assert.ok(withDraft.draft)
  assert.ok(withDraft.reactions.length > 0)
  runtime.approve(roomId, withDraft.draft!.id, withDraft.draft!.text, {})
  const published = runtime.get(roomId)
  assert.equal(published.reactions.length, 0)
  assert.equal(published.scenes.length, 3, '批准后 = 开局 scene + 玩家气泡 + 发布正文')
})

test('cancelling a turn removes its transient reaction previews', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-preview-cancel-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const workers: WorkerSet = {
    decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed', brief: `${role.name} 的即时反应。`, privateReaction: '' }),
    draft: async () => await new Promise(() => {}),
  }
  const runtime = new RoomRuntime(store, workers)
  runtime.submitTurn(roomId, { text: '玩家行动', requiredRoleIds: ['aria'] })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(runtime.get(roomId).reactions.length > 0)
  runtime.cancelTurn(roomId)
  assert.equal(runtime.get(roomId).reactions.length, 0)
})
