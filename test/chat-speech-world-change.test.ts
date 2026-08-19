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
import type { WorldChangeRequest } from '../src/types.ts'
import { installStageCraftSolution } from './core-solution-test-utils.ts'

function setup(root: string, worldChange: WorldChangeRequest) {
  const store = new Store(join(root, 'state.sqlite'))
  const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
  const roomId = store.seed(story)
  store.restartRoom(roomId, story, { mode: 'chat' })
  const workers: WorkerSet = {
    ...((undefined as unknown) as WorkerSet),
    decide: async () => ({ roleId: 'aria', participation: 'excluded', status: 'abstained' }),
    draft: async () => ({ text: '' }),
    speak: async () => ({ text: '我指向远方。', worldChange }),
  }
  const core = new CoreRuntimeSkeleton()
  installStageCraftSolution(core)
  const runtime = new RoomRuntime(store, workers, core)
  core.attachLegacyRuntime(runtime, roomId)
  core.attachWorkflowStore({ save: (id, instance) => store.saveWorkflowInstance(id, instance), list: id => store.listWorkflowInstances(id) })
  core.projectRoom(store.getRoom(roomId))
  return { store, core, roomId }
}

test('chat speech world-change approval returns to role selection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-world-change-'))
  let store: Store | undefined
  try {
    const setupResult = setup(root, { time: '翌日', location: '北塔' })
    store = setupResult.store
    const select = setupResult.core.getView().interactions.find(item => item.kind === 'role-select')!
    await setupResult.core.dispatch({ id: 'select', actor: 'player', interactionId: select.id, type: 'select-role', payload: { roleId: select.options![0].id } })
    const approval = setupResult.core.getView().interactions.find(item => item.id.includes('world-change-approval'))!
    assert.equal(setupResult.core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.speech')!.step, 'world-change-approval')
    await setupResult.core.dispatch({ id: 'approve-world', actor: 'player', interactionId: approval.id, type: 'approve', payload: { action: 'speech', text: store.getRoom(setupResult.roomId).speech!.text } })
    assert.equal(store.getRoom(setupResult.roomId).phase, 'awaiting-player-input')
    assert.equal(setupResult.core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.speech')!.step, 'awaiting-player-input')
    assert.equal(setupResult.core.getView().interactions.find(item => item.kind === 'role-select') !== undefined, true)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
