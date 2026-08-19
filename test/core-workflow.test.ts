import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { chatDirectorWorkflow, chatSpeechWorkflow, directorTurnWorkflow, workflowInstancesFromRoom } from '../src/core/solutions.ts'
import { installStageCraftSolution } from './core-solution-test-utils.ts'

test('chat.speech is registered and projected from legacy room phase', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-workflow-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const roomId = store.seed(loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria'))
    const room = store.getRoom(roomId)
    const core = new CoreRuntimeSkeleton()
    installStageCraftSolution(core)
    core.projectRoom(room)
    const view = core.getView()
    assert.equal(chatSpeechWorkflow.id, 'stagecraft.chat.speech')
    assert.equal(chatDirectorWorkflow.id, 'stagecraft.chat.director')
    assert.equal(directorTurnWorkflow.id, 'stagecraft.director.turn')
    assert.equal(view.workflows.length, 1)
    assert.equal(view.workflows[0].definitionId, directorTurnWorkflow.id)
    assert.equal(view.workflows[0].step, 'awaiting-player-input')
    assert.equal(view.interactions[0].kind, 'text')

    const chatWorkflows = workflowInstancesFromRoom({ ...room, mode: 'chat' })
    assert.equal(chatWorkflows.length, 2)
    assert.equal(chatWorkflows[0].definitionId, chatSpeechWorkflow.id)
    assert.equal(chatWorkflows[1].definitionId, chatDirectorWorkflow.id)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
