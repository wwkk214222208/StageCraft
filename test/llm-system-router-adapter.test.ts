import test from 'node:test'
import assert from 'node:assert/strict'
import { createOfficialLlmSystemService, createOpenAiCompatibleDriver } from '../src/llm/index.ts'
import { LlmSystemRouterAdapter } from '../src/core/llm-system-router-adapter.ts'
import type { LlmSystemStartContext } from '../src/sdk/index.ts'

function context(drivers: LlmSystemStartContext['drivers']): LlmSystemStartContext {
  return { apiVersion: '0.1', pluginId: 'stagecraft.official.llm', config: {}, log() {}, drivers }
}

test('Core ModelRequest is routed through the official service with exact messages and contract metadata', async () => {
  let body: Record<string, any> | undefined
  const driver = createOpenAiCompatibleDriver({
    id: 'adapter.openai', version: '1.0.0', title: 'Adapter OpenAI', driverId: 'openai-compatible', models: ['adapter-model'],
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"ok"}', reasoning_content: 'thinking' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
    },
  })
  const service = await createOfficialLlmSystemService(context([driver]))
  await service.upsertCredentialProfile({ id: 'adapter-profile', profileId: 'adapter-profile', providerId: 'openai-compatible', driverId: 'openai-compatible', name: 'Adapter', baseUrl: 'https://adapter.test', models: ['adapter-model'], responseFormat: 'json_schema', toolCalling: true })
  await service.setCredentialSecret('adapter-profile', 'adapter-secret')
  const adapter = new LlmSystemRouterAdapter(service)
  const results: any[] = []; const events: any[] = []
  const installed = adapter.install({ submitModelResult: async result => { results.push(result) }, publishModelEvent: event => { events.push(event) } })
  const messages = Object.freeze([{ role: 'system' as const, content: 'solution system' }, { role: 'user' as const, content: 'solution user' }])
  await adapter.request({ requestId: 'adapter-request', capability: 'director.draft', prompt: { system: 'ignored fallback', user: 'ignored fallback', messages }, contract: { id: 'story-draft', version: '1.0.0', schema: { type: 'object', properties: { text: { type: 'string' } } } }, route: { providerId: 'adapter-profile', model: 'adapter-model', purpose: 'director.draft' }, tool: { name: 'submit_story_draft', description: 'submit', parameters: { type: 'object' } }, stream: true, metadata: { includeTelemetry: true } })
  assert.deepEqual(body?.messages, messages)
  // Tool calling takes precedence on the first request. The driver retries
  // without tools (and may then send json_schema) only after a 400/422 tool
  // compatibility rejection.
  assert.equal(body?.response_format, undefined)
  assert.deepEqual(body?.tools, [{ type: 'function', function: { name: 'submit_story_draft', description: 'submit', parameters: { type: 'object' } } }])
  assert.equal(body?.model, 'adapter-model')
  assert.equal(results[0].output.text, 'ok')
  assert.equal(results[0].thinking, 'thinking')
  assert.equal(events[0].type, 'model.started')
  await installed.dispose()
})
