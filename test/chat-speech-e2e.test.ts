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

function chatCore(root: string) {
  const store = new Store(join(root, 'state.sqlite'))
  const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
  const roomId = store.seed(story)
  store.restartRoom(roomId, story, { mode: 'chat' })
  const core = new CoreRuntimeSkeleton()
  const runtime = new RoomRuntime(store, undefined, core)
  core.attachLegacyRuntime(runtime, roomId)
  core.attachWorkflowStore({ save: (id, instance) => store.saveWorkflowInstance(id, instance), list: id => store.listWorkflowInstances(id) })
  core.projectRoom(store.getRoom(roomId))
  return { store, core, roomId }
}

test('chat.speech completes through Core select-role and approval interactions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-chat-e2e-'))
  let store: Store | undefined
  try {
    const setup = chatCore(root)
    store = setup.store
    const select = setup.core.getView().interactions.find(item => item.kind === 'role-select')!
    const roleId = select.options![0].id
    await setup.core.dispatch({ id: 'select', actor: 'player', interactionId: select.id, type: 'select-role', payload: { roleId } })

    const approval = setup.core.getView().interactions.find(item => item.id.includes('speech-approval'))!
    const speech = store.getRoom(setup.roomId).speech!
    await setup.core.dispatch({ id: 'approve', actor: 'player', interactionId: approval.id, type: 'approve', payload: { action: 'speech', text: speech.text } })

    const room = store.getRoom(setup.roomId)
    assert.equal(room.phase, 'awaiting-player-input')
    assert.equal(room.speech, undefined)
    assert.equal(room.scenes.at(-1)?.speaker, roleId)
    const workflow = setup.core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.speech')!
    assert.equal(workflow.step, 'awaiting-player-input')
    const nextSelect = setup.core.getView().interactions.find(item => item.kind === 'role-select')!
    assert.equal(nextSelect.options!.some(option => option.id === roleId), true)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
