import test from 'node:test'
import assert from 'node:assert/strict'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { CORE_PROTOCOL_VERSION, type WorkflowDefinition } from '../src/core/protocol.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import { Store } from '../src/store.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installStageCraftSolution } from './core-solution-test-utils.ts'

test('core runtime exposes versioned Core View and event subscription', async () => {
  const core = new CoreRuntimeSkeleton()
  const events: unknown[] = []
  core.subscribe(event => events.push(event))

  await assert.rejects(() => core.dispatch({ id: 'command-1', actor: 'player', type: 'submit-text', payload: { text: 'hello' } }), /Core command has no handler: submit-text/)

  const view = core.getView()
  assert.equal(view.protocolVersion, CORE_PROTOCOL_VERSION)
  assert.equal(view.revision, 0)
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], {
    type: 'error',
    revision: 0,
    message: 'Core command has no handler: submit-text',
  })
})

test('core runtime projects legacy RoomSnapshot into extensible state categories', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-core-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const storiesPath = fileURLToPath(new URL('../stories', import.meta.url))
    const roomId = store.seed(loadStoryPackage(storiesPath, 'eldoria'))
    const room = store.getRoom(roomId)
    store.close()
    const core = new CoreRuntimeSkeleton()
    installStageCraftSolution(core)
    core.projectRoom(room)
    const view = core.getView()
    const state = view.state as { room: { id: string }; world: { time?: string }; narrative: { scenes: unknown[] }; workflow: { phase: string } }
    assert.equal(state.room.id, roomId)
    assert.equal(state.world.time, room.sceneTime)
    assert.equal(state.narrative.scenes.length, room.scenes.length)
    assert.equal(state.workflow.phase, room.phase)
    assert.equal(view.revision, room.revision)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('core runtime validates and registers fixed workflow definitions', () => {
  const core = new CoreRuntimeSkeleton()
  const definition: WorkflowDefinition = {
    id: 'test.workflow',
    version: '1.0.0',
    initialStep: 'start',
    steps: {
      start: { id: 'start', actions: [{ type: 'finish' }] },
    },
    transitions: [],
  }

  core.registerWorkflow(definition)
  assert.throws(() => core.registerWorkflow(definition), /already registered/)
  assert.throws(() => core.registerWorkflow({ ...definition, id: 'broken', initialStep: 'missing' }), /initial step is missing/)
})
