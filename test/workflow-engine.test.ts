import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowExecutor, WorkflowRegistry } from '../src/core/workflow-engine.ts'
import { chatSpeechWorkflow } from '../src/core/solutions.ts'
import { workflowInstanceFromRoom } from '../src/core/solutions.ts'

test('fixed workflow registry plans human and model actions', () => {
  const registry = new WorkflowRegistry()
  registry.register(chatSpeechWorkflow)
  const executor = new WorkflowExecutor(registry)
  const input = workflowInstanceFromRoom({ id: 'room-1', mode: 'chat', phase: 'awaiting-player-input', revision: 1 })
  const human = executor.plan(input)
  assert.equal(human[0].type, 'human-interaction')

  const speaking = { ...input, step: 'role-speaking' }
  const model = executor.plan(speaking)
  assert.equal(model[0].type, 'model-interaction')
  assert.equal(model[0].request.capability, 'role.speech')
})

test('fixed workflow executor transitions only declared edges', () => {
  const registry = new WorkflowRegistry()
  registry.register(chatSpeechWorkflow)
  const executor = new WorkflowExecutor(registry)
  const input = workflowInstanceFromRoom({ id: 'room-1', mode: 'chat', phase: 'awaiting-approval', revision: 1 })
  const next = executor.transition(input, { id: 'event-1', type: 'speech.approved', source: 'system', payload: {}, createdAt: new Date().toISOString() })
  assert.equal(next.step, 'awaiting-player-input')
  const unchanged = executor.transition(next, { id: 'event-2', type: 'unknown', source: 'system', payload: {}, createdAt: new Date().toISOString() })
  assert.equal(unchanged.step, next.step)
})
