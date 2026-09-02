import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuthoringLlmSystemHarness, defineLlmSystem, type LlmSystemService } from '../src/sdk/index.ts'

function service(text: string): LlmSystemService {
  const profile = { id: 'p', providerId: 'demo' }
  return {
    status: 'ready', listDrivers: () => [], listModels: () => [], listCredentialProfiles: () => [profile], getCredentialProfile: id => id === 'p' ? profile : undefined, discoverModels: async () => [], getRouteDefaults: () => ({}), setRouteDefault() {},
    upsertCredentialProfile() {}, deleteCredentialProfile() {}, setCredentialSecret() {}, hasCredentialSecret: () => false,
    route: () => ({ providerId: 'demo', model: 'demo-1' }), complete: async function* (input) { yield { type: 'text', text: `${text}:${input.messages[0]?.content ?? ''}` }; yield { type: 'done' } }, cancel() {}, recordUsage() {}, queryUsage: () => [], aggregateUsage: () => ({ inputTokens: 0, outputTokens: 0, requests: 0 }), stop() {},
  }
}

test('old start+route shape is rejected', () => {
  assert.throws(() => defineLlmSystem({ id: 'example.old', version: '1.0.0', title: 'Old', start: async () => service('old'), route: () => ({ providerId: 'demo', model: 'demo-1' }) } as any), /route\/stop/)
})

test('authoring harness rejects incomplete service returned by start', async () => {
  const plugin = defineLlmSystem({ id: 'example.incomplete', version: '1.0.0', title: 'Incomplete', start: () => ({ status: 'ready', route() {} } as any) })
  await assert.rejects(() => createAuthoringLlmSystemHarness(plugin), /missing:.*complete.*cancel.*usage|missing:/)
})

test('two LLM plugins provide different replaceable behavior and preserve solution messages', async () => {
  const first = defineLlmSystem({ id: 'example.first', version: '1.0.0', title: 'First', start: () => service('first') })
  const second = defineLlmSystem({ id: 'example.second', version: '1.0.0', title: 'Second', start: () => service('second') })
  const messages = Object.freeze([{ role: 'system', content: 'owned by solution' }, { role: 'user', content: 'hello' }])
  const a = await createAuthoringLlmSystemHarness(first); const b = await createAuthoringLlmSystemHarness(second)
  const read = async (s: LlmSystemService) => { const rows = []; for await (const chunk of s.complete({ requestId: 'r', messages })) rows.push(chunk); return rows }
  assert.deepEqual(await read(a), [{ type: 'text', text: 'first:owned by solution' }, { type: 'done' }])
  assert.deepEqual(await read(b), [{ type: 'text', text: 'second:owned by solution' }, { type: 'done' }])
})
