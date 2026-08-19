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
import { installStageCraftSolution, installLegacyRuntimeSolution } from './core-solution-test-utils.ts'

test('Core interaction is pending, validates command type, then resolves after legacy dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-interaction-'))
  let store: Store | undefined
  let container: import('../src/core/container.ts').DefaultCorePluginContainer | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    const core = new CoreRuntimeSkeleton()
    container = installStageCraftSolution(core)
    const runtime = new RoomRuntime(store, undefined, core)
    installLegacyRuntimeSolution(container, runtime, roomId)
    core.attachWorkflowStore({ save: (id, instance) => store!.saveWorkflowInstance(id, instance), list: id => store!.listWorkflowInstances(id) })
    core.projectRoom(store.getRoom(roomId))
    const interaction = core.getView().interactions[0]
    assert.equal(interaction.kind, 'text')
    assert.equal(core.getView().workflows[0].pendingInteractionIds.includes(interaction.id), true)
    assert.equal(core.getView().availableCommands[0].type, 'submit-text')

    await assert.rejects(() => core.dispatch({ id: 'bad', actor: 'player', interactionId: interaction.id, type: 'approve' }), /not allowed/)
    await core.dispatch({ id: 'good', actor: 'player', interactionId: interaction.id, type: 'submit-text', payload: { text: '行动' } })
    assert.equal(core.getView().interactions.some(item => item.id === interaction.id), false)
    assert.equal(core.getView().workflows[0].pendingInteractionIds.includes(interaction.id), false)
    assert.equal(store.listWorkflowInstances(roomId).every(item => !item.pendingInteractionIds.includes(interaction.id)), true)
  } finally {
    await container?.dispose()
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
