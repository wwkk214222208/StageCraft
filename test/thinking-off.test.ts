import assert from 'node:assert/strict'
import test from 'node:test'
import { buildThinkingParams } from '../src/thinking-params.ts'
import { createRealWorkers, ModelGateway } from '../src/model-gateway.ts'

test('buildThinkingParams disables thinking with each model family specific params', () => {
  assert.deepEqual(buildThinkingParams('deepseek-chat', 'off'), { body: { thinking: { type: 'disabled' } } })
  assert.deepEqual(buildThinkingParams('glm-5', 'off'), { body: { thinking: { type: 'disabled' } } })
  assert.deepEqual(buildThinkingParams('doubao-seed-2', 'off'), { body: { thinking: { type: 'disabled' } } })
  assert.deepEqual(buildThinkingParams('gpt-5.6', 'off'), { body: { reasoning_effort: 'none' } })
  assert.deepEqual(buildThinkingParams('gemini-3-pro', 'off'), { body: { reasoning_effort: 'minimal' } })
  assert.deepEqual(buildThinkingParams('kimi-k3', 'off'), { body: { reasoning_effort: 'low' } })
  assert.ok(String(buildThinkingParams('claude-4', 'off').promptSuffix ?? '').includes('思考控制'))
  assert.ok(String(buildThinkingParams('unknown-model', 'off').promptSuffix ?? '').includes('思考控制'))
})

test('director role-selection worker sends thinkingStrength off through the core request path', async () => {
  const gateway = new ModelGateway({ name: 'director', baseUrl: 'https://model.test', apiKey: 'x', model: 'deepseek-chat', timeoutMs: 1000, responseFormat: 'json_object' })
  const captured: Array<{ thinkingStrength?: string }> = []
  const workers = createRealWorkers(gateway, undefined, {
    requestModel: async request => { captured.push(request); return { output: { roleIds: ['aria'] }, usage: { promptTokens: 10, completionTokens: 5 } } },
  })
  const role = { id: 'aria', name: 'Aria', portraitRef: '/assets/aria.svg', currentState: '位于祭典主厅。', presence: 'present' as const, selfModel: '克制、敏锐。' }
  await workers.selectSpeakingRoles!({ playerContribution: '玩家推门而入。', roles: [role], roomId: 'room-1', turnId: 'turn-1' })
  assert.equal(captured.length, 1)
  assert.equal(captured[0].thinkingStrength, 'off')
})
