import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelGateway } from '../src/model-gateway.ts'

test('gateway tracks request and provider token usage', async () => {
  const gateway = new ModelGateway({ name: 'test', baseUrl: 'https://model.test', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' }, {
    fetchImpl: async () => new Response(JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 7 }, choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }),
  })
  await gateway.complete('s', 'u', 'x', { type: 'object' })
  assert.deepEqual(gateway.usage(), { route: 'test', model: 'm', requests: 1, promptTokens: 12, completionTokens: 7 })
})

test('gateway emits the final submitted prompt as a debug detail', async () => {
  const details: string[] = []
  const gateway = new ModelGateway({ name: 'test', baseUrl: 'https://model.test', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' }, {
    fetchImpl: async () => new Response(JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 7 }, choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }),
    onDetail: text => details.push(text),
  })
  await gateway.complete('sys marker', 'usr marker', 'x', { type: 'object' })
  const promptDetail = details.find(text => text.startsWith('模型提交提示词'))
  assert.ok(promptDetail, '模型提交提示词 detail not emitted')
  assert.ok(promptDetail!.includes('sys marker'))
  assert.ok(promptDetail!.includes('usr marker'))
})
