import assert from 'node:assert/strict'
import test from 'node:test'
import plugin from '../src/index.ts'
import { createAuthoringLlmSystemHarness, defineProviderDriver } from '../../../../src/sdk/index.ts'

test('third-party plugin streams exact messages and records usage', async () => {
  let seen: readonly { role: string; content: string }[] = []
  const driver = defineProviderDriver({ id: 'plugin.test.driver', version: '1.0.0', title: 'Test', providerId: 'test', models: ['m'], async *request(request) { seen = request.messages; yield { type: 'text', text: 'ok' }; yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, cost: 0.01, currency: 'USD' } }; yield { type: 'done' } } })
  const service = await createAuthoringLlmSystemHarness(plugin, {}, { drivers: [driver] })
  await service.upsertCredentialProfile({ id: 'p', providerId: 'test', driverId: 'test', models: ['m'], selectedModel: 'm' })
  const messages = [{ role: 'system', content: 'Solution message' }, { role: 'user', content: 'assembled' }]
  const chunks: any[] = []; for await (const chunk of service.complete({ requestId: 'plugin-test', profileId: 'p', model: 'm', messages })) chunks.push(chunk)
  assert.deepEqual(seen, messages); assert.equal((await service.aggregateUsage()).cost, 0.01); assert.equal((await service.queryUsage({ driverId: 'test' })).length, 1); await service.stop()
})
