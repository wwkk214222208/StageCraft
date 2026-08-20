import assert from 'node:assert/strict'
import test from 'node:test'
import { LegacySandboxSession, legacySandboxCsp, isLegacySandboxAssetUrl } from '../src/core/legacy-sandbox.ts'

const descriptor = { id: 'card.legacy', owner: 'card', version: '1', assetId: 'card-asset', actions: [{ id: 'card.run', label: 'Run' }] }
const view = { revision: 4, state: { public: { value: 'ok' } }, interactions: [] } as any

test('legacy RPC exposes only cloned public view and allowlisted action', async () => {
  const calls: any[] = []
  const session = new LegacySandboxSession(descriptor, { getView: () => view, invokeUiAction: async (id, input, owner) => { calls.push({ id, input, owner }); return { accepted: true } } })
  const result = JSON.parse(await session.handle(JSON.stringify({ id: 'v1', method: 'getView' })))
  assert.deepEqual(result, { id: 'v1', ok: true, result: view })
  result.result.state.public.value = 'changed'
  assert.equal(view.state.public.value, 'ok')
  const action = JSON.parse(await session.handle(JSON.stringify({ id: 'a1', method: 'invokeAction', params: { actionId: 'card.run', input: { value: 2 } } })))
  assert.deepEqual(action.result, { accepted: true })
  assert.deepEqual(calls, [{ id: 'card.run', input: { value: 2 }, owner: 'card' }])
})

test('legacy RPC rejects privileged methods, unknown actions, malformed and unsafe JSON', async () => {
  const session = new LegacySandboxSession(descriptor, { getView: () => view, invokeUiAction: async () => null })
  for (const method of ['eval', 'fetch', 'readFile', 'getSecrets', 'getCookies', 'getDom', 'native']) {
    const result = JSON.parse(await session.handle(JSON.stringify({ id: 'x', method })))
    assert.equal(result.ok, false); assert.equal(result.error.code, 'forbidden')
  }
  assert.equal(JSON.parse(await session.handle(JSON.stringify({ id: 'x', method: 'invokeAction', params: { actionId: 'other', input: {} } }))).error.code, 'not_found')
  assert.equal(JSON.parse(await session.handle('{')).error.code, 'invalid_request')
  assert.equal(JSON.parse(await session.handle(JSON.stringify({ id: 'x', method: 'getView', params: { secret: true } }))).error.code, 'invalid_request')
  assert.equal(JSON.parse(await session.handle('{"id":"x","method":"invokeAction","params":{"actionId":"card.run","input":{"__proto__":true}}}')).error.code, 'internal')
})

test('legacy session close revokes every request and CSP has no ambient capabilities', async () => {
  const session = new LegacySandboxSession(descriptor, { getView: () => view, invokeUiAction: async () => null })
  session.close()
  const result = JSON.parse(await session.handle(JSON.stringify({ id: 'x', method: 'getView' })))
  assert.equal(result.error.code, 'closed')
  const csp = legacySandboxCsp()
  assert.match(csp, /default-src 'none'/); assert.match(csp, /connect-src 'none'/); assert.match(csp, /frame-src 'none'/); assert.match(csp, /object-src 'none'/)
  assert.equal(isLegacySandboxAssetUrl('https://appassets.androidplatform.net/legacy/card-asset/index.html', 'card-asset'), true)
  assert.equal(isLegacySandboxAssetUrl('https://example.test/legacy/card-asset/index.html', 'card-asset'), false)
  assert.equal(isLegacySandboxAssetUrl('https://appassets.androidplatform.net/legacy/card-asset/../secret', 'card-asset'), false)
})
