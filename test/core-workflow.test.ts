import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { chatSpeechWorkflow } from '../src/core/solutions.ts'

test('chat.speech is registered and projected from legacy room phase', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-workflow-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const roomId = store.seed(loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria'))
    const room = store.getRoom(roomId)
    const core = new CoreRuntimeSkeleton()
    core.projectRoom(room)
    const view = core.getView()
    assert.equal(chatSpeechWorkflow.id, 'stagecraft.chat.speech')
    assert.equal(view.workflows.length, 1)
    assert.equal(view.workflows[0].definitionId, chatSpeechWorkflow.id)
    assert.equal(view.workflows[0].step, 'awaiting-player-input')
    assert.equal(view.interactions[0].kind, 'text')
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
