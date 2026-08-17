import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProviderConfigStore } from '../src/provider-config.ts'

test('provider config persists keys server-side and exposes only redacted public data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'character-tavern-provider-'))
  const path = join(root, 'providers.json')
  const store = new ProviderConfigStore(path)
  store.save({ id: 'local', name: '本地服务', baseUrl: 'http://model.test/v1', apiKey: 'secret', models: [], responseFormat: 'json_object' })
  const discovered = await store.discoverModels('local', async () => new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), { status: 200 }))
  assert.deepEqual(discovered.models, ['model-a', 'model-b'])
  assert.equal(discovered.hasApiKey, true)
  assert.equal(JSON.stringify(discovered).includes('secret'), false)
  const restored = new ProviderConfigStore(path)
  assert.equal(restored.getSelected()?.apiKey, 'secret')
})
