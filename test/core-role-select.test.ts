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
import { installStageCraftSolution } from './core-solution-test-utils.ts'

test('chat role-select InteractionRequest drives legacy speak and Core workflow transition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-role-select-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    store.restartRoom(roomId, story, { mode: 'chat' })
    const core = new CoreRuntimeSkeleton()
    installStageCraftSolution(core)
    const runtime = new RoomRuntime(store, undefined, core)
    core.attachLegacyRuntime(runtime, roomId)
    core.attachWorkflowStore({ save: (id, instance) => store!.saveWorkflowInstance(id, instance), list: id => store!.listWorkflowInstances(id) })
    core.projectRoom(store.getRoom(roomId))
    const select = core.getView().interactions.find(item => item.kind === 'role-select')!
    const roleId = select.options![0].id
    await core.dispatch({ id: 'select-1', actor: 'player', interactionId: select.id, type: 'select-role', payload: { roleId } })
    const speechWorkflow = core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.speech')!
    assert.equal(speechWorkflow.step, 'awaiting-approval')
    assert.equal(store.getRoom(roomId).speech?.roleId, roleId)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
