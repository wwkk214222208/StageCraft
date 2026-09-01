import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildComponentLaunchPlan } from '../src/v2/launch-plan.ts'
import { startV2DesktopRecoveryServer } from '../src/v2/desktop-recovery.ts'
import { startV2DesktopHost } from '../src/v2/desktop-host.ts'
import type { ComponentManifest } from '../src/v2/component-contract.ts'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'))

function writeComponent(base: string, manifest: ComponentManifest, source: string): void {
  const dir = join(base, 'components', manifest.id, manifest.version)
  const runtime = join(dir, manifest.entrypoints.runtime)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(runtime, source)
  const withIntegrity = { ...manifest, integrity: { ...manifest.integrity, runtime: `sha256-${createHash('sha256').update(readFileSync(runtime)).digest('hex')}` } }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(withIntegrity, null, 2))
}

function setupBrokenPlan(base: string): void {
  const coreSource = `export default { boot(context) { context.ready() }, invoke(operation) { return operation } }`
  const pluginSource = `export default { answer: 1 }`
  const core: ComponentManifest = { schemaVersion: '0.1', id: 'example.desktop-core', version: '1.0.0', title: 'Desktop Core', componentType: 'core', entrypoints: { runtime: 'dist/index.js' }, hostApi: { version: '0.1' }, integrity: { runtime: 'pending' } }
  const one: ComponentManifest = { schemaVersion: '0.1', id: 'example.one', version: '1.0.0', title: 'One', componentType: 'plugin', pluginCategory: 'tool', entrypoints: { runtime: 'dist/index.js' }, integrity: { runtime: 'pending' } }
  const two: ComponentManifest = { schemaVersion: '0.1', id: 'example.two', version: '1.0.0', title: 'Two', componentType: 'plugin', pluginCategory: 'tool', entrypoints: { runtime: 'dist/index.js' }, integrity: { runtime: 'pending' } }
  writeComponent(base, core, coreSource)
  writeComponent(base, one, pluginSource)
  writeComponent(base, two, pluginSource)
  const coreManifest = JSON.parse(readFileSync(join(base, 'components', core.id, core.version, 'manifest.json'), 'utf8')) as ComponentManifest
  const oneManifest = JSON.parse(readFileSync(join(base, 'components', one.id, one.version, 'manifest.json'), 'utf8')) as ComponentManifest
  const twoManifest = JSON.parse(readFileSync(join(base, 'components', two.id, two.version, 'manifest.json'), 'utf8')) as ComponentManifest
  const plan = buildComponentLaunchPlan({ core: coreManifest, plugins: [oneManifest, twoManifest], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' })
  mkdirSync(join(base, 'data'), { recursive: true })
  writeFileSync(join(base, 'data', 'component-launch-plan.v2.json'), JSON.stringify(plan, null, 2))
}

test('v2 recovery server disables a plugin by rebuilding a valid plan', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-recovery-')); try {
    setupBrokenPlan(base)
    const recovery = await startV2DesktopRecoveryServer({ userDataRoot: base, port: 0, failure: 'core handshake failed' })
    const address = recovery.server.address(); const port = typeof address === 'object' && address ? address.port : 0
    const page = await (await fetch(`http://127.0.0.1:${port}/admin/v2`)).text()
    assert.match(page, /v2 恢复模式/)
    assert.match(page, /core handshake failed/)
    assert.match(page, /example\.two/)
    const disable = await fetch(`http://127.0.0.1:${port}/admin/v2/disable-plugin`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: 'example.two' }).toString() })
    assert.equal(disable.status, 303)
    const plan = JSON.parse(readFileSync(recovery.planPath, 'utf8')) as { plugins: { id: string }[] }
    assert.deepEqual(plan.plugins.map(selection => selection.id), ['example.one'], 'disabled plugin must be removed from the plan')
    // The rebuilt plan must be directly bootable: it is a valid launch plan.
    const host = await startV2DesktopHost({ userDataRoot: base, port: 0 })
    assert.equal(host.session.state, 'ready')
    const hostAddress = host.server.address(); const hostPort = typeof hostAddress === 'object' && hostAddress ? hostAddress.port : 0
    const echo = await fetch(`http://127.0.0.1:${hostPort}/api/v2/core/invoke`, { method: 'POST', headers: { 'x-stagecraft-token': host.authToken }, body: JSON.stringify({ operation: 'echo', input: 1 }) })
    assert.equal(echo.status, 200)
    await host.close()
    await recovery.close()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('v2 recovery server clears the plan so the next start selects the v1 chain', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-recovery-clear-')); try {
    setupBrokenPlan(base)
    const recovery = await startV2DesktopRecoveryServer({ userDataRoot: base, port: 0 })
    const address = recovery.server.address(); const port = typeof address === 'object' && address ? address.port : 0
    const clear = await fetch(`http://127.0.0.1:${port}/admin/v2/clear-plan`, { method: 'POST' })
    assert.equal(clear.status, 303)
    assert.equal(existsSync(recovery.planPath), false)
    await recovery.close()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('v2 recovery server refuses a non-loopback bind', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-recovery-loop-')); try {
    await assert.rejects(() => startV2DesktopRecoveryServer({ userDataRoot: base, host: '0.0.0.0', port: 0 }), /loopback/)
  } finally { rmSync(base, { recursive: true, force: true }) }
})
