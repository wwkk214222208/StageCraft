import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProviderConfigStore } from '../src/provider-config.ts'

test('provider configuration persists independent default-role and Director models', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-routing-'))
  const store = new ProviderConfigStore(join(root, 'providers.json'))
  store.save({ id: 'cheap', name: '廉价服务', baseUrl: 'https://cheap.test/v1', apiKey: 'a', models: ['small', 'large'], responseFormat: 'json_object' })
  store.save({ id: 'strong', name: '强模型服务', baseUrl: 'https://strong.test/v1', apiKey: 'b', models: ['director-x'], responseFormat: 'json_object' })
  store.setDefaultRole('cheap', 'small')
  store.setDirector('strong', 'director-x')
  const restored = new ProviderConfigStore(join(root, 'providers.json'))
  assert.deepEqual(restored.defaults(), { defaultRoleProviderId: 'cheap', defaultRoleModel: 'small', directorProviderId: 'strong', directorModel: 'director-x' })
  assert.equal(restored.getDefaultRole()?.name, '廉价服务')
  assert.equal(restored.getDirector()?.name, '强模型服务')
})
