import assert from 'node:assert/strict'
import test from 'node:test'
import { createOfficialLlmSystemService } from '../src/llm/official.ts'
import { createAndroidOpenAiDriver } from '../src/portable/android-llm.ts'

function harness() {
  const state = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  const requests: any[] = []
  let cancelled = false
  const operations: any = {
    invoke(operation: string, input: any, callbacks: any) {
      if (operation !== 'model.request') throw new Error(`unexpected operation ${operation}`)
      requests.push(input)
      callbacks.onStreamPayload(JSON.stringify({ choices: [{ delta: { reasoning_content: '思', content: '' } }] }))
      callbacks.onStreamPayload(JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"ok":true}' } }] } }] }))
      callbacks.onStreamPayload('[DONE]')
      return Promise.resolve({ streamComplete: true })
    },
    state,
    secrets,
  }
  return { operations, requests, secrets, state, cancelled: () => cancelled }
}

test('Android official driver preserves messages, secret boundary, stream chunks and tool text', async () => {
  const h = harness()
  const driver = createAndroidOpenAiDriver(h.operations, { models: ['android-model'] })
  const service = await createOfficialLlmSystemService({ apiVersion: '0.1', pluginId: 'test.llm', config: {}, log() {}, drivers: [driver], state: { read: async key => h.state.get(key), write: async (key, value) => { h.state.set(key, value) } }, secrets: { get: async key => h.secrets.get(key), set: async (key, value) => { h.secrets.set(key, value) }, delete: async key => { h.secrets.delete(key) }, has: async key => h.secrets.has(key) } })
  await service.upsertCredentialProfile({ id: 'profile-a', profileId: 'profile-a', providerId: driver.providerId, driverId: driver.driverId, name: 'A', baseUrl: 'https://example.test/v1', models: ['android-model'], selectedModel: 'android-model', responseFormat: 'none', toolCalling: true })
  await service.setCredentialSecret('profile-a', 'not-public')
  const messages = [{ role: 'system', content: '原样 system' }, { role: 'user', content: '原样 user' }]
  const chunks: any[] = []
  for await (const chunk of service.complete({ requestId: 'android-1', profileId: 'profile-a', messages, metadata: { llmContract: { id: 'answer', schema: { type: 'object' } } } } as any)) chunks.push(chunk)
  assert.deepEqual(h.requests[0].body.messages, messages)
  assert.equal(h.requests[0].apiKey, 'not-public')
  assert.deepEqual(chunks.map(chunk => chunk.type), ['thinking', 'text', 'done'])
  assert.equal(chunks.find(chunk => chunk.type === 'text').text, '{"ok":true}')
  assert.equal(JSON.stringify(service.listCredentialProfiles()).includes('not-public'), false)
  assert.equal(JSON.stringify(await service.queryUsage()).includes('not-public'), false)
  await service.stop()
})

test('Android official driver cancellation is request-scoped', async () => {
  const state = new Map<string, unknown>(); const secrets = new Map<string, string>(); const requests: string[] = []
  const operations: any = { invoke(operation: string, input: any, callbacks: any) { if (operation === 'model.request') requests.push(input.requestId); return new Promise(resolve => callbacks.signal.addEventListener('abort', () => resolve({ streamComplete: true }), { once: true })) } }
  const driver = createAndroidOpenAiDriver(operations, { models: ['m'] })
  const service = await createOfficialLlmSystemService({ apiVersion: '0.1', pluginId: 'test.llm.cancel', config: {}, log() {}, drivers: [driver], state: { read: async key => state.get(key), write: async (key, value) => { state.set(key, value) } }, secrets: { get: async key => secrets.get(key), set: async (key, value) => { secrets.set(key, value) } } })
  await service.upsertCredentialProfile({ id: 'p', providerId: driver.providerId, driverId: driver.driverId, name: 'p', baseUrl: 'https://example.test', models: ['m'], selectedModel: 'm', responseFormat: 'none', toolCalling: false })
  const consume = (async () => { for await (const _chunk of service.complete({ requestId: 'cancel-me', profileId: 'p', model: 'm', messages: [{ role: 'user', content: 'x' }] })) {} })()
  await new Promise(resolve => setTimeout(resolve, 0)); await service.cancel('cancel-me'); await consume
  assert.deepEqual(requests, ['cancel-me']); await service.stop()
})

test('Android official driver parses non-stream JSON and exposes tool arguments as text', async () => {
  const operations: any = { invoke(operation: string) {
    if (operation === 'model.request') return Promise.resolve({ responseBody: JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { arguments: '{"ok":true}' } }] } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }) })
    return Promise.resolve({ ok: true })
  } }
  const driver = createAndroidOpenAiDriver(operations, { models: ['m'] })
  const chunks: any[] = []
  for await (const chunk of driver.request({ requestId: 'json', model: 'm', messages: [{ role: 'user', content: 'x' }], metadata: { llmRoute: { baseUrl: 'https://example.test' } } }, {} as any)) chunks.push(chunk)
  assert.equal(chunks.find(chunk => chunk.type === 'text')?.text, '{"ok":true}')
  assert.equal(chunks.find(chunk => chunk.type === 'usage')?.usage.inputTokens, 2)
})
