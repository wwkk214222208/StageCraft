import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuthoringLlmSystemHarness, defineLlmSystem, defineProviderDriver, defineSolution, STAGECRAFT_AUTHORING_API } from '../src/sdk/index.ts'

const ctx = { apiVersion: STAGECRAFT_AUTHORING_API, pluginId: 'example.test', config: {}, log() {} }

test('LLM System owns drivers, routing, credentials, stream and usage', async () => {
  const seen: any[] = []
  const make = (providerId: string, text: string) => defineProviderDriver({ id: `example.${providerId}`, version: '0.1.0', title: providerId, providerId, models: [`${providerId}-model`], async *request(request) { seen.push(request); yield { type: 'text', text }; yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }; yield { type: 'done' } } })
  const system = defineLlmSystem({ id: 'example.llm', version: '0.1.0', title: 'LLM', start(c) { c.registerDriver(make('one', 'one')); c.registerDriver(make('two', 'two')); c.upsertCredentialProfile({ id: 'p1', providerId: 'two', label: 'Two' }) }, route: input => ({ providerId: input.providerId ?? 'two', model: input.model ?? 'two-model', credentialProfileId: 'p1' }) })
  const h = await createAuthoringLlmSystemHarness(system)
  assert.deepEqual(h.listModels(), [{ providerId: 'one', models: ['one-model'] }, { providerId: 'two', models: ['two-model'] }])
  assert.deepEqual(await h.route({}), { providerId: 'two', model: 'two-model', credentialProfileId: 'p1' })
  const chunks = []; for await (const c of h.complete({ requestId: 'r1', messages: [{ role: 'user', content: 'assembled' }], credential: { profileId: 'p1', secret: 'secret-value' } })) chunks.push(c.type)
  assert.deepEqual(chunks, ['text', 'usage', 'done']); assert.equal(seen[0].providerId, 'two'); assert.equal(seen[0].credential?.secret, 'secret-value')
  assert.equal(JSON.stringify(system.manifest).includes('secret-value'), false); assert.equal(JSON.stringify(h.listCredentialProfiles()).includes('secret-value'), false)
  assert.deepEqual(h.queryUsage(), [{ requestId: 'r1', providerId: 'two', model: 'two-model', inputTokens: 2, outputTokens: 3, timestamp: h.queryUsage()[0].timestamp }])
  assert.deepEqual(h.aggregateUsage(), { inputTokens: 2, outputTokens: 3, requests: 1 })
})

test('cancellation targets exactly one request and preserves Solution messages', async () => {
  let cancelled = ''; let captured: any
  const driver = defineProviderDriver({ id: 'example.cancel-driver', version: '0.1.0', title: 'Cancel', providerId: 'cancel', models: ['m'], request: async function* (request) { captured = request; while (!request.signal?.aborted) { yield { type: 'text', text: 'tick' }; await new Promise(resolve => setTimeout(resolve, 1)) } yield { type: 'done' } }, cancel: id => { cancelled = id } })
  const system = defineLlmSystem({ id: 'example.cancel-system', version: '0.1.0', title: 'Cancel system', start: c => c.registerDriver(driver), route: () => ({ providerId: 'cancel', model: 'm' }) })
  const h = await createAuthoringLlmSystemHarness(system); const iterator = h.complete({ requestId: 'target', messages: [{ role: 'system', content: 'owned by solution' }, { role: 'user', content: 'hi' }] })[Symbol.asyncIterator]()
  await iterator.next(); await h.cancel('target'); await iterator.next(); assert.equal(cancelled, 'target'); assert.deepEqual(captured.messages, [{ role: 'system', content: 'owned by solution' }, { role: 'user', content: 'hi' }]); assert.equal(h.queryUsage().length, 0)
})

test('active duplicate requestId is rejected instead of replacing the cancellable request', async () => {
  const driver = defineProviderDriver({ id: 'example.duplicate-driver', version: '0.1.0', title: 'Duplicate', providerId: 'duplicate', models: ['m'], request: async function* (request) { while (!request.signal?.aborted) { yield { type: 'text', text: 'tick' }; await new Promise(resolve => setTimeout(resolve, 1)) } }, cancel() {} })
  const h = await createAuthoringLlmSystemHarness(defineLlmSystem({ id: 'example.duplicate-system', version: '0.1.0', title: 'Duplicate', start: c => c.registerDriver(driver), route: () => ({ providerId: 'duplicate', model: 'm' }) }))
  const first = h.complete({ requestId: 'same', messages: [] })[Symbol.asyncIterator](); await first.next()
  assert.throws(() => h.complete({ requestId: 'same', messages: [] }), /requestId already active/)
  await h.cancel('same'); await first.return?.()
})

test('metadata is immutable and route rejects unknown driver/model/profile', async () => {
  const driver = defineProviderDriver({ id: 'example.d', version: '0.1.0', title: 'D', providerId: 'd', models: ['m'], async *request() { yield { type: 'done' } } })
  const h = await createAuthoringLlmSystemHarness(defineLlmSystem({ id: 'example.s', version: '0.1.0', title: 'S', start: c => c.registerDriver(driver), route: () => ({ providerId: 'missing', model: 'm' }) }))
  await assert.rejects(h.route({}), /no provider driver/)
  assert.throws(() => h.upsertCredentialProfile({ id: '', providerId: 'd' }), /required/)
  const profile = { id: 'p', providerId: 'd', label: 'P' }; h.upsertCredentialProfile(profile); profile.label = 'changed'; assert.equal(h.listCredentialProfiles()[0].label, 'P'); assert.equal(Object.isFrozen(h.listCredentialProfiles()[0]), true)
})

test('Solution system message is passed through without LLM mutation', async () => {
  const solution = defineSolution({ id: 'example.solution-llm', version: '0.1.0', title: 'Solution', systemPrompt: 'solution prompt', assemblePrompt: () => 'assembled' })
  const messages = [{ role: 'system', content: solution.systemPrompt! }, { role: 'user', content: await solution.assemblePrompt({ user: 'x' }, ctx) }]
  let received: any
  const driver = defineProviderDriver({ id: 'example.pass', version: '0.1.0', title: 'Pass', providerId: 'p', models: ['m'], async *request(r) { received = r.messages; yield { type: 'done' } } })
  const h = await createAuthoringLlmSystemHarness(defineLlmSystem({ id: 'example.pass-system', version: '0.1.0', title: 'Pass', start: c => c.registerDriver(driver), route: () => ({ providerId: 'p', model: 'm' }) })); for await (const _ of h.complete({ requestId: 'x', messages })) {}
  assert.deepEqual(received, messages)
})
