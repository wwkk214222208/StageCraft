import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelGateway, createRealWorkers } from '../src/model-gateway.ts'

function gatewayWith(items: unknown[]) {
  let index = 0
  return new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' }, { fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(items[index++]) } }] }), { status: 200 }) })
}

test('Director accepts prose alias and defaults optional metadata', async () => {
  const workers = createRealWorkers(gatewayWith([{ prose: '可审批正文。', state_updates: {} }]))
  const draft = await workers.draft('turn', '玩家输入', [], [])
  assert.equal(draft.text, '可审批正文。')
  assert.deepEqual(draft.settingProposals, [])
})

test('Director retries once using minimal protocol when first response lacks prose', async () => {
  const workers = createRealWorkers(gatewayWith([{ summary: '没有正文。' }, { text: '重试成功正文。', stateUpdates: {} }]))
  const draft = await workers.draft('turn', '玩家输入', [], [])
  assert.equal(draft.text, '重试成功正文。')
})

test('Director reports only received field names after two invalid responses', async () => {
  const workers = createRealWorkers(gatewayWith([{ foo: 'x' }, { answer: 'y' }]))
  await assert.rejects(workers.draft('turn', '玩家输入', [], []), /Received fields: answer/)
})
