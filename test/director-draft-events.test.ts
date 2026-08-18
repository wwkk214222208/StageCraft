import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.ts'
import { RoomRuntime } from '../src/room-runtime.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import type { WorkerSet } from '../src/workers.ts'

test('director draft approval emits domain events and returns to player input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-draft-events-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    store.restartRoom(roomId, story, { mode: 'director' })
    const workers: WorkerSet = { decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed' }), draft: async (turnId) => ({ id: 'draft-1', turnId, text: '场景', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], createdAt: new Date().toISOString() }) }
    const core = new CoreRuntimeSkeleton()
    const runtime = new RoomRuntime(store, workers, core)
    core.attachLegacyRuntime(runtime, roomId)
    core.attachEventLog({ append: (id, revision, event) => store!.appendCoreEvent(id, revision, event), appendDomain: (id, revision, event) => store!.appendCoreDomainEvent(id, revision, event), list: (id, limit) => store!.listCoreEvents(id, limit), listDomain: (id, limit) => store!.listCoreDomainEvents(id, limit) })
    core.attachWorkflowStore({ save: (id, instance) => store!.saveWorkflowInstance(id, instance), list: id => store!.listWorkflowInstances(id) })
    core.projectRoom(store.getRoom(roomId))
    const input = core.getView().interactions[0]
    await core.dispatch({ id: 'input', actor: 'player', interactionId: input.id, type: 'submit-text', payload: { text: '前进。' } })
    const decisions = core.getView().interactions.find(item => item.id.includes('decision-approval'))!
    await core.dispatch({ id: 'decisions', actor: 'player', interactionId: decisions.id, type: 'approve', payload: { action: 'decisions' } })
    const approval = core.getView().interactions.find(item => item.id.includes('draft-approval'))!
    await core.dispatch({ id: 'draft', actor: 'player', interactionId: approval.id, type: 'approve', payload: { draftId: 'draft-1', text: '场景', stateUpdates: {} } })
    assert.equal(store.getRoom(roomId).phase, 'awaiting-player-input')
    assert.equal(core.getView().workflows[0].step, 'awaiting-player-input')
    assert.equal(store.listCoreDomainEvents(roomId).some(event => event.type === 'draft.approved'), true)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
