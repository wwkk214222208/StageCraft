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

test('chat.director world change enters approval and returns to suggestion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-director-world-'))
  let store: Store | undefined
  let container: import('../src/core/container.ts').DefaultCorePluginContainer | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    store.restartRoom(roomId, story, { mode: 'chat' })
    const workers: WorkerSet = { decide: async () => ({ roleId: 'aria', participation: 'excluded', status: 'abstained' }), draft: async () => ({ text: '' }), directorChat: async () => ({ reply: '可以。', worldChange: { location: '北塔' }, narration: '风雪改变了方向。' }) }
    const core = new CoreRuntimeSkeleton()
    container = installStageCraftSolution(core)
    const runtime = new RoomRuntime(store, workers, core)
    installLegacyRuntimeSolution(container, runtime, roomId)
    core.attachWorkflowStore({ save: (id, instance) => store!.saveWorkflowInstance(id, instance), list: id => store!.listWorkflowInstances(id) })
    core.projectRoom(store.getRoom(roomId))
    const suggestion = core.getView().interactions.find(item => item.id.includes('director-suggestion'))!
    await core.dispatch({ id: 'suggest', actor: 'player', interactionId: suggestion.id, type: 'submit-text', payload: { text: '推进时间。' } })
    assert.equal(core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.director')!.step, 'awaiting-world-change-approval')
    const approval = core.getView().interactions.find(item => item.id.includes('world-change-approval'))!
    await core.dispatch({ id: 'approve', actor: 'player', interactionId: approval.id, type: 'approve', payload: { action: 'world-change' } })
    assert.equal(store.getRoom(roomId).phase, 'awaiting-player-input')
    assert.equal(core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.director')!.step, 'awaiting-suggestion')
  } finally {
    await container?.dispose()
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
