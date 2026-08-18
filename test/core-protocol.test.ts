import test from 'node:test'
import assert from 'node:assert/strict'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { CORE_PROTOCOL_VERSION, type WorkflowDefinition } from '../src/core/protocol.ts'

test('core runtime exposes versioned Core View and event subscription', async () => {
  const core = new CoreRuntimeSkeleton()
  const events: unknown[] = []
  core.subscribe(event => events.push(event))

  await core.dispatch({ id: 'command-1', actor: 'player', type: 'submit-text', payload: { text: 'hello' } })

  const view = core.getView()
  assert.equal(view.protocolVersion, CORE_PROTOCOL_VERSION)
  assert.equal(view.revision, 0)
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], {
    type: 'error',
    revision: 0,
    message: 'Core command is not wired yet: submit-text',
  })
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
