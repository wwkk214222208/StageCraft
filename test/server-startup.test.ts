import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'))
const LOAD_TEST_TIMEOUT_MS = 15_000

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolveListen, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', () => resolveListen()) })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolveClose => probe.close(() => resolveClose()))
  assert.ok(port > 0)
  return port
}

test('server.ts is actually loadable by Node strip-types without a top-level return syntax error', async () => {
  const serverPath = resolve(root, 'src/server.ts')
  const result = await new Promise<{ code: number | null; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', serverPath], {
      cwd: root,
      env: { ...process.env, STAGECRAFT_SKIP_START: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    // Import-only smoke can be delayed by the full-suite scheduler; it must
    // still kill the child if the process genuinely hangs.
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server.ts load test timed out after ${LOAD_TEST_TIMEOUT_MS}ms`)) }, LOAD_TEST_TIMEOUT_MS)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolveResult({ code, stderr }) })
  })
  assert.equal(result.code, 0, result.stderr)
  assert.doesNotMatch(result.stderr, /ERR_INVALID_TYPESCRIPT_SYNTAX|Return statement is not allowed here/)
})

test('failed v2 startup exposes plugin recovery from the normal application root', async () => {
  const userDataRoot = mkdtempSync(resolve(tmpdir(), 'stagecraft-startup-e2e-'))
  const port = await freePort()
  mkdirSync(resolve(userDataRoot, 'data'), { recursive: true })
  writeFileSync(resolve(userDataRoot, 'data', 'component-launch-plan.v2.json'), JSON.stringify({
    planVersion: 1, core: { id: 'missing.core', version: '1.0.0' }, plugins: [],
    hostApiVersion: '0.1', stateSchemaVersion: 'state-1', planHash: 'sha256-invalid',
  }), 'utf8')
  const child = spawn(process.execPath, ['--experimental-strip-types', resolve(root, 'src/server.ts')], {
    cwd: root,
    env: { ...process.env, STAGECRAFT_USER_DATA: userDataRoot, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const deadline = Date.now() + 7000
  let recoveryPort = 0
  try {
    while (Date.now() < deadline) {
      const match = stderr.match(/已进入 v2 恢复模式：打开 http:\/\/127\.0\.0\.1:(\d+)\/admin\/v2/)
      if (match) { recoveryPort = Number(match[1]); break }
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
    assert.ok(recoveryPort > 0, `server did not enter v2 recovery mode: ${stderr}`)
    const rootResponse = await fetch(`http://127.0.0.1:${recoveryPort}/`, { redirect: 'manual' })
    assert.equal(rootResponse.status, 302)
    assert.equal(rootResponse.headers.get('location'), '/admin/v2')
    const page = await (await fetch(`http://127.0.0.1:${recoveryPort}/admin/v2`)).text()
    assert.match(page, /v2 恢复模式/)
    assert.match(page, /missing\.core/)
  } finally {
    child.kill()
    await new Promise<void>(resolveExit => {
      if (child.exitCode !== null) { resolveExit(); return }
      child.once('exit', () => resolveExit())
      setTimeout(() => resolveExit(), 1000)
    })
    rmSync(userDataRoot, { recursive: true, force: true })
  }
})
