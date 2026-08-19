import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelGateway } from '../src/model-gateway.ts'
import { ModelGatewayRouterAdapter } from '../src/core/model-router-adapter.ts'
import type { CoreEvent, ModelRequest } from '../src/core/protocol.ts'
import { resolveRouteModel, resolveRouteProviderId } from '../src/app-boot.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { DefaultCorePluginContainer } from '../src/core/container.ts'

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

test('production route selection prefers explicit provider and model metadata', () => {
  const request = { route: { providerId: 'request-provider', model: 'request-model' } }
  assert.equal(resolveRouteProviderId(request, 'role-provider', 'default-provider'), 'request-provider')
  assert.equal(resolveRouteModel(request, 'role-model', 'default-model'), 'request-model')
  assert.equal(resolveRouteProviderId({ route: {} }, 'role-provider', 'default-provider'), 'role-provider')
  assert.equal(resolveRouteModel({ route: {} }, 'role-model', 'default-model'), 'role-model')
})

test('ModelGateway router reports a failed result through one Core error event', async () => {
  const gateway = new ModelGateway({ baseUrl: 'http://model.test', apiKey: 'key', model: 'test', timeoutMs: 1000, responseFormat: 'none' }, {
    fetchImpl: async () => new Response('upstream failed', { status: 503, headers: { 'content-type': 'text/plain' } }),
  })
  const adapter = new ModelGatewayRouterAdapter(gateway)
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const events: CoreEvent[] = []
  core.subscribe(event => events.push(event))
  container.addLlm(adapter)
  const result = await core.requestModel({ ...request(), requestId: 'failed-router-request' })
  assert.match(result.error ?? '', /503|upstream/i)
  assert.equal(events.filter(event => event.type === 'model.completed' && event.result.requestId === 'failed-router-request').length, 1)
  assert.equal(events.filter(event => event.type === 'error' && event.requestId === 'failed-router-request').length, 1)
  await container.dispose()
})
