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

test('projectRoom preserves recovered workflow step across snapshot projection', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-recovery-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    const room = store.getRoom(roomId)
    const core = new CoreRuntimeSkeleton()
    const workflowStore = { save: (id: string, instance: import('../src/core/protocol.ts').WorkflowInstance) => store!.saveWorkflowInstance(id, instance), list: (id: string) => store!.listWorkflowInstances(id) }
    core.attachWorkflowStore(workflowStore)
    core.projectRoom(room)
    const recovered = { ...core.getView().workflows[0], step: 'drafting', status: 'running' as const }
    store.saveWorkflowInstance(roomId, recovered)
    core.restoreWorkflowInstances(roomId)
    core.projectRoom(store.getRoom(roomId))
    assert.equal(core.getView().workflows[0].step, 'drafting')
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
