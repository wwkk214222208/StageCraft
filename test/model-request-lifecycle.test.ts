import test from 'node:test'
import assert from 'node:assert/strict'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { chatSpeechWorkflow } from '../src/core/solutions.ts'

test('Core model request lifecycle persists pending request IDs', async () => {
  const core = new CoreRuntimeSkeleton()
  const instance = { id: 'workflow:room-1:chat-speech', definitionId: chatSpeechWorkflow.id, definitionVersion: chatSpeechWorkflow.version, step: 'role-speaking', status: 'running' as const, locals: { roomId: 'room-1' }, pendingInteractionIds: [], pendingModelRequestIds: [], retryCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const store = new Map([[instance.id, instance]])
  core.attachWorkflowStore({ save: (_roomId, value) => store.set(value.id, value), list: () => [...store.values()] })
  core.restoreWorkflowInstances('room-1')
  const router = { request: async (request: import('../src/core/protocol.ts').ModelRequest) => core.submitModelResult({ requestId: request.requestId, output: { ok: true } }), cancel: async () => {}, install: () => ({ dispose: () => {} }) }
  core.attachLlmRouter(router)
  await core.requestModel({ requestId: 'req-1', workflowId: instance.id, capability: 'role.speech', prompt: { system: '', user: '', metadata: {} }, contract: { id: 'speech', version: '1', schema: {} } })
  assert.deepEqual(store.get(instance.id)!.pendingModelRequestIds, [])
})
