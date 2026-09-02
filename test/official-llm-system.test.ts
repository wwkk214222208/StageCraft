import test from 'node:test'
import assert from 'node:assert/strict'
import { createOfficialLlmSystemService, createOpenAiCompatibleDriver } from '../src/llm/index.ts'
import { defineProviderDriver, type LlmSystemStartContext } from '../src/sdk/index.ts'

function ports() {
  const stateData = new Map<string, unknown>(); const secretData = new Map<string, string>()
  return {
    state: { async read<T>(key: string) { return structuredClone(stateData.get(key)) as T | undefined }, async write<T>(key: string, value: T) { stateData.set(key, structuredClone(value)) } },
    secrets: { async get(id: string) { return secretData.get(id) }, async set(id: string, value: string) { secretData.set(id, value) }, async delete(id: string) { secretData.delete(id) }, async has(id: string) { return secretData.has(id) } },
    stateData, secretData,
  }
}

function context(extra: Partial<LlmSystemStartContext> = {}): LlmSystemStartContext {
  return { apiVersion: '0.1', pluginId: 'stagecraft.official.llm', config: {}, log() {}, drivers: [], ...extra }
}

test('official LLM System owns provider CRUD, discovery, secrets and explicit routes', async () => {
  const p = ports(); const driver = defineProviderDriver({ id: 'example.driver', version: '1.0.0', title: 'Driver', driverId: 'openai', providerId: 'openai', models: ['gpt-old', 'gpt-role'], async *request() { yield { type: 'done' } } })
  const service = await createOfficialLlmSystemService(context({ drivers: [driver], state: p.state, secrets: p.secrets, fetch: async () => new Response(JSON.stringify({ data: [{ id: 'gpt-discovered' }] }), { status: 200 }) }), { profiles: [{ id: 'role-profile', driverId: 'openai', providerId: 'openai', name: 'Role', baseUrl: 'https://example.test', models: ['gpt-old'], responseFormat: 'json_object', toolCalling: true }, { id: 'director-profile', driverId: 'openai', providerId: 'openai', name: 'Director', baseUrl: '', models: ['gpt-role'], responseFormat: 'none', toolCalling: false }], defaults: { role: { profileId: 'role-profile', model: 'gpt-role' }, director: { profileId: 'director-profile', model: 'gpt-role' } } })
  await service.setCredentialSecret('role-profile', 'secret-value')
  assert.equal(JSON.stringify(service.listCredentialProfiles()).includes('secret-value'), false)
  assert.deepEqual(await service.discoverModels('role-profile'), ['gpt-discovered'])
  const roleRoute = await service.route({ role: 'aria' }); assert.equal(roleRoute.profileId, 'role-profile'); assert.equal(roleRoute.providerId, 'openai'); assert.equal(roleRoute.driverId, 'openai')
  assert.equal((await service.route({ purpose: 'director' })).profileId, 'director-profile')
  await service.upsertCredentialProfile({ id: 'assistant-profile', providerId: 'openai', driverId: 'openai', name: 'Assistant', baseUrl: '', models: ['gpt-role'], responseFormat: 'none', toolCalling: false })
  await service.setRouteDefault('assistant', { profileId: 'assistant-profile', driverId: 'openai', model: 'gpt-role' })
  assert.equal((await service.route({ purpose: 'assistant' })).profileId, 'assistant-profile')
  assert.equal(JSON.stringify(await service.queryUsage()).includes('secret-value'), false)
})

test('official LLM System keeps secrets in memory when no host ports are available', async () => {
  let authorization = ''
  const driver = createOpenAiCompatibleDriver({
    id: 'memory.openai', version: '1.0.0', title: 'Memory OpenAI', driverId: 'memory-openai', models: ['memory-model'],
    fetchImpl: async (_url, init) => {
      authorization = String((init?.headers as Record<string, string>)?.authorization ?? '')
      return new Response(JSON.stringify({ choices: [{ message: { content: 'memory reply' } }] }), { headers: { 'content-type': 'application/json' } })
    },
  })
  const service = await createOfficialLlmSystemService(context({ drivers: [driver] }))
  await service.upsertCredentialProfile({ id: 'memory-profile', providerId: 'memory-openai', driverId: 'memory-openai', name: 'Memory', baseUrl: 'https://memory.test', models: ['memory-model'], responseFormat: 'none', toolCalling: false })
  await service.setCredentialSecret('memory-profile', 'memory-secret')
  assert.equal(await service.hasCredentialSecret('memory-profile'), true)
  const chunks: any[] = []
  for await (const chunk of service.complete({ requestId: 'memory-request', profileId: 'memory-profile', messages: [{ role: 'user', content: 'hello' }] })) chunks.push(chunk)
  assert.equal(authorization, 'Bearer memory-secret')
  assert.deepEqual(chunks.map(chunk => chunk.type), ['text', 'done'])
  assert.equal(JSON.stringify(service.listCredentialProfiles()).includes('memory-secret'), false)
  assert.equal(JSON.stringify(await service.queryUsage()).includes('memory-secret'), false)
  await service.deleteCredentialProfile('memory-profile')
  assert.equal(await service.hasCredentialSecret('memory-profile'), false)
  await service.stop()
})

test('official LLM System streams exact messages, isolates cancellation, aggregates usage and restores state', async () => {
  const p = ports(); const seen: unknown[] = []
  const driver = defineProviderDriver({ id: 'example.driver', version: '1.0.0', title: 'Driver', driverId: 'demo', providerId: 'demo', models: ['demo-1'], async *request(request) { seen.push(request.messages); yield { type: 'text', text: 'hello' }; yield { type: 'thinking', text: 'thought' }; yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, cachedTokens: 1 } }; while (!request.signal?.aborted && request.requestId === 'a') await new Promise(resolve => setTimeout(resolve, 1)); yield { type: 'done' } }, cancel() {} })
  const make = () => createOfficialLlmSystemService(context({ drivers: [driver], state: p.state, secrets: p.secrets }))
  const first = await make(); await first.upsertCredentialProfile({ id: 'demo', providerId: 'demo', driverId: 'demo', name: 'Demo', baseUrl: '', models: ['demo-1'], responseFormat: 'none', toolCalling: false })
  const messages = Object.freeze([{ role: 'system', content: 'solution-owned' }, { role: 'user', content: 'hello' }]); const a = first.complete({ requestId: 'a', messages }); const b = first.complete({ requestId: 'b', messages }); const ai = a[Symbol.asyncIterator](); const bi = b[Symbol.asyncIterator](); await ai.next(); await ai.next(); await ai.next(); await bi.next(); await first.cancel('a'); await ai.return?.(); let bDone = false; while (!bDone) bDone = Boolean((await bi.next()).done); assert.equal(bDone, true)
  assert.deepEqual(seen[0], messages); const aggregate = await first.aggregateUsage(); assert.equal(aggregate.cachedTokens, 2); assert.equal(aggregate.requests, 2); assert.equal(aggregate.cost, 0)
  await first.stop(); const second = await make(); assert.equal((await second.listCredentialProfiles()).length, 1); assert.equal((await second.queryUsage()).length, 2); await second.stop()
})

test('official OpenAI driver reuses production SSE and JSON parsing', async () => {
  const sseBody = 'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"hello"}}]}\r\n\r\ndata: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{}"}}]}}]}\r\n\r\ndata: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":1}}}\r\n\r\ndata: [DONE]\r\n\r\n'
  const sse = createOpenAiCompatibleDriver({ id: 'example.openai', version: '1.0.0', title: 'OpenAI', driverId: 'openai', models: ['m'], fetchImpl: async () => { const bytes = new TextEncoder().encode(sseBody); const split = bytes.indexOf(13); const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, split + 1)); controller.enqueue(bytes.slice(split + 1)); controller.close() } }); return new Response(body, { headers: { 'content-type': 'text/event-stream' } }) } })
  const streamChunks: any[] = []; for await (const chunk of sse.request({ requestId: 's', model: 'm', messages: [], metadata: { llmRoute: { baseUrl: 'https://example.test' } } }, context())) streamChunks.push(chunk)
  assert.deepEqual(streamChunks, [{ type: 'thinking', text: 'think' }, { type: 'text', text: 'hello' }, { type: 'text', text: '{}' }, { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, cachedTokens: 1 } }, { type: 'done' }])
  const json = createOpenAiCompatibleDriver({ id: 'example.json', version: '1.0.0', title: 'JSON', driverId: 'json', models: ['m'], fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { reasoning_content: 'reason', tool_calls: [{ function: { arguments: '{"ok":true}' } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } }) })
  const jsonChunks: any[] = []; for await (const chunk of json.request({ requestId: 'j', model: 'm', messages: [] }, context())) jsonChunks.push(chunk)
  assert.deepEqual(jsonChunks, [{ type: 'thinking', text: 'reason' }, { type: 'text', text: '{"ok":true}' }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cachedTokens: undefined } }, { type: 'done' }])
})
