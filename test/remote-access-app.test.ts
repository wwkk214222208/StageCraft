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
    const operatorResponse = await fetch(`${base}/api/remote/pairing-code`, { method: 'POST' })
    assert.equal(operatorResponse.status, 200)
    const pairing = await operatorResponse.json() as { code: string; expiresAt: number }
    assert.match(pairing.code, /^[A-Z2-9]{8}$/)
    assert.ok(pairing.expiresAt > Date.now())
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

test('remote sessions can be revoked (self-revoke and operator clear-all)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-remote-access-'))
  const app = await startTavern({
    root: repositoryRoot, dataDir: join(root, 'data'), saveRoot: join(root, 'save'), port: 0, host: '127.0.0.1',
    remoteAccess: { enabled: true },
  })
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
  try {
    const pair = async (): Promise<string> => {
      const codeResponse = await fetch(`${base}/api/remote/pairing-code`, { method: 'POST' })
      assert.equal(codeResponse.status, 200)
      const { code } = await codeResponse.json() as { code: string }
      const exchange = await fetch(`${base}/api/remote/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
      assert.equal(exchange.status, 200)
      const { token } = await exchange.json() as { token: string }
      return token
    }
    const tokenA = await pair()
    const tokenB = await pair()
    assert.equal(app.remoteAccess.policy.authorize(tokenA), true)
    assert.equal(app.remoteAccess.policy.authorize(tokenB), true)
    // 自注销：带 Bearer 调用 /api/remote/revoke → 仅 tokenA 失效
    const revokeSelf = await fetch(`${base}/api/remote/revoke`, { method: 'POST', headers: { authorization: `Bearer ${tokenA}` } })
    assert.equal(revokeSelf.status, 200)
    assert.equal(app.remoteAccess.policy.authorize(tokenA), false)
    assert.equal(app.remoteAccess.policy.authorize(tokenB), true)
    // 操作员清空：本机无 token 调用 → 全部会话失效
    const revokeAll = await fetch(`${base}/api/remote/revoke`, { method: 'POST' })
    assert.equal(revokeAll.status, 200)
    assert.equal(app.remoteAccess.policy.authorize(tokenB), false)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('browser-direct cookie session: pair issues HttpOnly cookie, cookie authorizes, revoke clears it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-remote-access-'))
  const app = await startTavern({
    root: repositoryRoot, dataDir: join(root, 'data'), saveRoot: join(root, 'save'), port: 0, host: '127.0.0.1',
    remoteAccess: { enabled: true, authenticateLoopback: true },
  })
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
  try {
    // 未配对时浏览器先拿到配对页（app.js 对非本机 401 会跳转到这里）
    const pairPage = await fetch(`${base}/pair`)
    assert.equal(pairPage.status, 200)
    assert.match(pairPage.headers.get('content-type') ?? '', /text\/html/)
    assert.match(await pairPage.text(), /配对|remote\/pair/)
    // 未授权 /api 仍为 401（前端据此跳转配对页）
    assert.equal((await fetch(`${base}/api/room`)).status, 401)
    const codeResponse = await fetch(`${base}/api/remote/pairing-code`, { method: 'POST' })
    assert.equal(codeResponse.status, 200)
    const { code } = await codeResponse.json() as { code: string }
    const exchange = await fetch(`${base}/api/remote/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
    assert.equal(exchange.status, 200)
    const { token } = await exchange.json() as { token: string }
    // 配对成功后下发 HttpOnly 会话 Cookie（浏览器对同一源的所有请求自动携带）
    const expectedMaxAge = Math.ceil(app.remoteAccess.policy.sessionTtlMs / 1_000)
    assert.equal(exchange.headers.get('set-cookie'), `stagecraft_remote=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expectedMaxAge}`)
    // Cookie 令牌可直接访问受保护资源（/api 与 /assets）
    const cookieHeader = `stagecraft_remote=${token}`
    assert.equal((await fetch(`${base}/api/room`, { headers: { cookie: cookieHeader } })).status, 200)
    assert.equal((await fetch(`${base}/assets/noel.svg`, { headers: { cookie: cookieHeader } })).status, 200)
    // 自注销：仅带 Cookie 调用 revoke → 下发清除 Cookie 且令牌失效
    const revokeSelf = await fetch(`${base}/api/remote/revoke`, { method: 'POST', headers: { cookie: cookieHeader } })
    assert.equal(revokeSelf.status, 200)
    assert.equal(revokeSelf.headers.get('set-cookie'), 'stagecraft_remote=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
    assert.equal((await fetch(`${base}/api/room`, { headers: { cookie: cookieHeader } })).status, 401)
    assert.equal(app.remoteAccess.policy.authorize(token), false)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('non-loopback bearer cannot create an operator pairing code', async () => {
  const service = new (await import('../src/remote-access.ts')).RemoteAccessService({ enabled: true, randomBytes: size => new Uint8Array(size).fill(3) })
  const pairing = service.createPairingCode()
  const exchanged = service.policy.exchangePairingCode(pairing.code, 'setup')
  assert.equal(exchanged.ok, true)
  const responseState: { status?: number; body?: unknown } = {}
  const response = {
    writeHead(status: number) { responseState.status = status },
    end(body: string) { responseState.body = JSON.parse(body) },
  }
  const handled = await service.handlePairing({
    method: 'POST', headers: { authorization: `Bearer ${exchanged.ok ? exchanged.session.token : ''}` }, socket: { remoteAddress: '192.168.1.20' },
  } as any, response as any, new URL('http://desktop.test/api/remote/pairing-code'))
  assert.equal(handled, true)
  assert.equal(responseState.status, 404)
  assert.deepEqual(responseState.body, { error: 'Not found.' })
})

test('non-loopback binding fails closed unless remote access is explicitly enabled', async () => {
  await assert.rejects(startTavern({ root: repositoryRoot, host: '0.0.0.0', port: 0 }), /Non-loopback.*remote access/)
})
