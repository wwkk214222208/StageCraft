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

function chatCore(root: string) {
  const store = new Store(join(root, 'state.sqlite'))
  const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
  const roomId = store.seed(story)
  store.restartRoom(roomId, story, { mode: 'chat' })
  const core = new CoreRuntimeSkeleton()
  const container = installStageCraftSolution(core)
  const runtime = new RoomRuntime(store, undefined, core)
  installLegacyRuntimeSolution(container, runtime, roomId)
  core.attachWorkflowStore({ save: (id, instance) => store.saveWorkflowInstance(id, instance), list: id => store.listWorkflowInstances(id) })
  core.projectRoom(store.getRoom(roomId))
  return { store, core, roomId, container }
}

test('chat.speech completes through Core select-role and approval interactions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-chat-e2e-'))
  let store: Store | undefined
  let setupResult: ReturnType<typeof chatCore> | undefined
  try {
    setupResult = chatCore(root)
    store = setupResult.store
    const select = setupResult.core.getView().interactions.find(item => item.kind === 'role-select')!
    const roleId = select.options![0].id
    await setupResult.core.dispatch({ id: 'select', actor: 'player', interactionId: select.id, type: 'select-role', payload: { roleId } })

    const approval = setupResult.core.getView().interactions.find(item => item.id.includes('speech-approval'))!
    const speech = store.getRoom(setupResult.roomId).speech!
    await setupResult.core.dispatch({ id: 'approve', actor: 'player', interactionId: approval.id, type: 'approve', payload: { action: 'speech', text: speech.text } })

    const room = store.getRoom(setupResult.roomId)
    assert.equal(room.phase, 'awaiting-player-input')
    assert.equal(room.speech, undefined)
    assert.equal(room.scenes.at(-1)?.speaker, roleId)
    const workflow = setupResult.core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.speech')!
    assert.equal(workflow.step, 'awaiting-player-input')
    const nextSelect = setupResult.core.getView().interactions.find(item => item.kind === 'role-select')!
    assert.equal(nextSelect.options!.some(option => option.id === roleId), true)
  } finally {
    await setupResult?.container.dispose()
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
