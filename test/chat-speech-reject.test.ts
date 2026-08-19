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

test('rejecting chat speech with world change clears proposal and restores role select', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-speech-reject-'))
  let store: Store | undefined
  let container: import('../src/core/container.ts').DefaultCorePluginContainer | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    store.restartRoom(roomId, story, { mode: 'chat' })
    const workers: WorkerSet = {
      decide: async () => ({ roleId: 'aria', participation: 'excluded', status: 'abstained' }),
      draft: async () => ({ text: '' }),
      speak: async () => ({ text: '我不再前进。', worldChange: { location: '北塔' } }),
    }
    const core = new CoreRuntimeSkeleton()
    container = installStageCraftSolution(core)
    const runtime = new RoomRuntime(store, workers, core)
    installLegacyRuntimeSolution(container, runtime, roomId)
    core.attachWorkflowStore({ save: (id, instance) => store!.saveWorkflowInstance(id, instance), list: id => store!.listWorkflowInstances(id) })
    core.projectRoom(store.getRoom(roomId))
    const select = core.getView().interactions.find(item => item.kind === 'role-select')!
    await core.dispatch({ id: 'select', actor: 'player', interactionId: select.id, type: 'select-role', payload: { roleId: select.options![0].id } })
    const approval = core.getView().interactions.find(item => item.id.includes('world-change-approval'))!
    await core.dispatch({ id: 'reject', actor: 'player', interactionId: approval.id, type: 'reject', payload: { action: 'speech' } })
    const room = store.getRoom(roomId)
    assert.equal(room.phase, 'awaiting-player-input')
    assert.equal(room.speech, undefined)
    assert.equal(room.pendingWorldChange, undefined)
    assert.equal(core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.speech')!.step, 'awaiting-player-input')
    assert.equal(core.getView().interactions.find(item => item.kind === 'role-select') !== undefined, true)
  } finally {
    await container?.dispose()
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
