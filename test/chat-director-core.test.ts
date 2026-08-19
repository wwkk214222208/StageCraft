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

test('chat.director suggestion uses Core interaction and returns to suggestion state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-director-core-'))
  let store: Store | undefined
  let container: import('../src/core/container.ts').DefaultCorePluginContainer | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    store.restartRoom(roomId, story, { mode: 'chat' })
    const workers: WorkerSet = { decide: async () => ({ roleId: 'aria', participation: 'excluded', status: 'abstained' }), draft: async () => ({ text: '' }), directorChat: async () => ({ reply: '收到，我会留意北塔。' }) }
    const core = new CoreRuntimeSkeleton()
    container = installStageCraftSolution(core)
    const runtime = new RoomRuntime(store, workers, core)
    installLegacyRuntimeSolution(container, runtime, roomId)
    core.attachWorkflowStore({ save: (id, instance) => store!.saveWorkflowInstance(id, instance), list: id => store!.listWorkflowInstances(id) })
    core.projectRoom(store.getRoom(roomId))
    const interaction = core.getView().interactions.find(item => item.id.includes('director-suggestion'))!
    assert.equal(interaction.kind, 'text')
    await core.dispatch({ id: 'suggest', actor: 'player', interactionId: interaction.id, type: 'submit-text', payload: { text: '把时间推进到明天。' } })
    const workflow = core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.director')!
    assert.equal(workflow.step, 'awaiting-suggestion')
    assert.equal(store.getRoom(roomId).consultations.at(-1)?.role, 'director')
  } finally {
    await container?.dispose()
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
