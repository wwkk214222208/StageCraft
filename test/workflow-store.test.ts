import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'

test('WorkflowInstance persists and restores from SQLite', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-workflow-store-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const roomId = store.seed(loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria'))
    const room = store.getRoom(roomId)
    const workflowStore = { save: (id: string, instance: import('../src/core/protocol.ts').WorkflowInstance) => store!.saveWorkflowInstance(id, instance), list: (id: string) => store!.listWorkflowInstances(id) }
    const core = new CoreRuntimeSkeleton()
    core.attachWorkflowStore(workflowStore)
    core.projectRoom(room)
    const saved = store.listWorkflowInstances(roomId)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].definitionId, 'stagecraft.director.turn')

    const restored = new CoreRuntimeSkeleton()
    restored.attachWorkflowStore(workflowStore)
    restored.restoreWorkflowInstances(roomId)
    assert.equal(restored.getView().workflows[0].id, saved[0].id)
    assert.equal(restored.getView().actions.length > 0, true)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
