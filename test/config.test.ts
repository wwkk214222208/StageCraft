import assert from 'node:assert/strict'
import test from 'node:test'
import { routeFromEnvironment } from '../src/model-gateway.ts'

test('model route uses safe defaults and explicit environment overrides', () => {
  const route = routeFromEnvironment({ RP_MODEL_ROUTE: 'local', RP_MODEL_BASE_URL: 'http://127.0.0.1:9000/v1', RP_MODEL_API_KEY: 'secret', RP_MODEL_NAME: 'local-model', RP_MODEL_TIMEOUT_MS: '1234' })
  assert.deepEqual(route, { name: 'local', baseUrl: 'http://127.0.0.1:9000/v1', apiKey: 'secret', model: 'local-model', timeoutMs: 1234, responseFormat: 'json_object' })
})
