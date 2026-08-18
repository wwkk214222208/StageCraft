import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelGateway } from '../src/model-gateway.ts'
import { ModelGatewayRouterAdapter } from '../src/core/model-router-adapter.ts'
import type { CoreEvent, ModelRequest } from '../src/core/protocol.ts'

function request(): ModelRequest {
  return {
    requestId: 'req-core-1',
    capability: 'test.reply',
    prompt: { system: 'system', user: 'user' },
    contract: { id: 'reply', version: '1', schema: { type: 'object', properties: { reply: { type: 'string' } } } },
    stream: false,
  }
}

test('ModelGateway router adapts a model request into Core events and result', async () => {
  const gateway = new ModelGateway({ baseUrl: 'http://model.test', apiKey: 'key', model: 'test', timeoutMs: 1000, responseFormat: 'none' }, {
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"ok"}' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const adapter = new ModelGatewayRouterAdapter(gateway)
  const events: CoreEvent[] = []
  let result: unknown
  adapter.install({ submitModelResult: async value => { result = value }, publishModelEvent: event => events.push(event) })
  await adapter.request(request())
  assert.equal(events[0].type, 'model.started')
  assert.equal(events.length, 1)
  assert.deepEqual(result, { requestId: 'req-core-1', output: { reply: 'ok' } })
})
