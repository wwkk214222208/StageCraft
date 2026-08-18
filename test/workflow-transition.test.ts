import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import { domainEvent } from '../src/core/domain-events.ts'

test('DomainEvent advances and persists matching fixed WorkflowInstance', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-transition-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    store.restartRoom(roomId, story, { mode: 'chat' })
    const room = store.getRoom(roomId)
    const core = new CoreRuntimeSkeleton()
    core.attachWorkflowStore({ save: (id, instance) => store!.saveWorkflowInstance(id, instance), list: id => store!.listWorkflowInstances(id) })
    core.projectRoom({ ...room, phase: 'role-speaking' })
    const before = core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.speech')!
    assert.equal(before.step, 'role-speaking')

    core.emitDomainEvent(domainEvent('role.speech.generated', { roomId, speech: { roleId: 'aria', text: '台词', turnId: 'turn-1' } }))
    const after = core.getView().workflows.find(item => item.id === before.id)!
    assert.equal(after.step, 'awaiting-approval')
    assert.equal(after.status, 'waiting')
    assert.equal(core.getView().actions.some(action => action.type === 'human-interaction'), true)
    assert.equal(store.listWorkflowInstances(roomId).find(item => item.id === before.id)?.step, 'awaiting-approval')
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
