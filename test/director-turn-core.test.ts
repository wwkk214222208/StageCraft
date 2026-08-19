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
import { installStageCraftSolution, installLegacyRuntimeSolution } from './core-solution-test-utils.ts'

test('director turn player input and decision approval use Core interactions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-director-turn-'))
  let store: Store | undefined
  let container: import('../src/core/container.ts').DefaultCorePluginContainer | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    const seedRoom = store.getRoom(roomId)
    store.restartRoom(roomId, story, { mode: 'director' })
    const workers: WorkerSet = { decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed', brief: '观察局势。' }), draft: async (turnId) => ({ id: `draft-${turnId}`, turnId, text: '草稿场景', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], roleProposals: [], sceneUpdates: {}, createdAt: new Date().toISOString() }) }
    const core = new CoreRuntimeSkeleton()
    container = installStageCraftSolution(core)
    const runtime = new RoomRuntime(store, workers, core)
    installLegacyRuntimeSolution(container, runtime, roomId)
    core.attachWorkflowStore({ save: (id, instance) => store!.saveWorkflowInstance(id, instance), list: id => store!.listWorkflowInstances(id) })
    core.projectRoom(store.getRoom(roomId))
    const input = core.getView().interactions.find(item => item.id.includes('player-input'))!
    await core.dispatch({ id: 'input', actor: 'player', interactionId: input.id, type: 'submit-text', payload: { text: '走进森林。' } })
    const decision = core.getView().interactions.find(item => item.id.includes('decision-approval'))!
    assert.equal(decision.kind, 'approval')
    await core.dispatch({ id: 'decisions', actor: 'player', interactionId: decision.id, type: 'approve', payload: { action: 'decisions' } })
    assert.equal(store.getRoom(roomId).phase, 'awaiting-approval')
    assert.equal(core.getView().interactions.find(item => item.id.includes('draft-approval')) !== undefined, true)
  } finally {
    await container?.dispose()
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
