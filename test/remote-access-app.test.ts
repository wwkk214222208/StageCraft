import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startTavern } from '../src/app-boot.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

test('app remote boundary protects API, command, SSE and private assets with pairing bearer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-remote-access-'))
  const app = await startTavern({
    root: repositoryRoot, dataDir: join(root, 'data'), saveRoot: join(root, 'save'), port: 0, host: '127.0.0.1',
    remoteAccess: { enabled: true, authenticateLoopback: true },
  })
  const address = app.server.address() as { port: number }
  const base = `http://127.0.0.1:${address.port}`
  try {
    for (const path of ['/api', '/api/room', '/api/core/view', '/api/core/events', '/assets', '/assets/noel.svg', '/custom', '/custom/not-present']) {
      const response = await fetch(`${base}${path}`)
      assert.equal(response.status, 401)
      assert.deepEqual(await response.json(), { error: 'Unauthorized' })
    }
    const oversized = await fetch(`${base}/api/remote/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'x'.repeat(5_000) }) })
    assert.equal(oversized.status, 401)
    const nullBody = await fetch(`${base}/api/remote/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' })
    assert.equal(nullBody.status, 401)
    assert.deepEqual(await nullBody.json(), { error: 'Pairing failed.' })
    const pairing = app.remoteAccess.createPairingCode()
    const wrong = await fetch(`${base}/api/remote/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'WRONG-CODE' }) })
    assert.equal(wrong.status, 401)
    const exchange = await fetch(`${base}/api/remote/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code }) })
    assert.equal(exchange.status, 200)
    const session = await exchange.json() as { token: string }
    assert.ok(session.token.length >= 40)
    const reused = await fetch(`${base}/api/remote/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code }) })
    assert.equal(reused.status, 401)
    const authorization = { authorization: `Bearer ${session.token}` }
    assert.equal((await fetch(`${base}/api/room`, { headers: authorization })).status, 200)
    assert.equal((await fetch(`${base}/assets/noel.svg`, { headers: authorization })).status, 200)
    assert.equal((await fetch(`${base}/custom/not-present`, { headers: authorization })).status, 404)
    const command = await fetch(`${base}/api/core/commands`, {
      method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'remote-command', actor: 'player', type: 'role-management', payload: { operation: 'set-room-config', mode: 'chat', autoPublish: false } }),
    })
    assert.equal(command.status, 200)
    const abort = new AbortController()
    const stream = await fetch(`${base}/api/core/events`, { headers: authorization, signal: abort.signal })
    assert.equal(stream.status, 200)
    await stream.body?.cancel(); abort.abort()
    assert.equal(app.remoteAccess.revokeSession(session.token), true)
    assert.equal((await fetch(`${base}/api/core/view`, { headers: authorization })).status, 401)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('non-loopback binding fails closed unless remote access is explicitly enabled', async () => {
  await assert.rejects(startTavern({ root: repositoryRoot, host: '0.0.0.0', port: 0 }), /Non-loopback.*remote access/)
})
