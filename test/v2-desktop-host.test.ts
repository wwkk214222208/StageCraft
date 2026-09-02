import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { request as httpRequest } from 'node:http'
import { buildComponentLaunchPlan } from '../src/v2/launch-plan.ts'
import { startDesktopEntry } from '../src/v2/desktop-entry.ts'
import { startV2DesktopHost } from '../src/v2/desktop-host.ts'
import { createInMemoryComponentStorage } from '../src/v2/component-storage.ts'
import type { ComponentManifest } from '../src/v2/component-contract.ts'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'))

function coreManifest(overrides: Partial<ComponentManifest> = {}): ComponentManifest {
  return {
    schemaVersion: '0.1', id: 'example.desktop-core', version: '1.0.0', title: 'Desktop Core', componentType: 'core',
    entrypoints: { runtime: 'dist/index.js' }, hostApi: { version: '0.1' }, integrity: { runtime: 'pending' }, ...overrides,
  }
}

function setupCore(base: string, source = `export default { boot(context) { context.ready() }, invoke(operation, input) { if (operation !== 'echo') throw new Error('unknown'); return { operation, input } }, shutdown() { globalThis.__m4Shutdown = (globalThis.__m4Shutdown || 0) + 1 } }`) {
  const dir = join(base, 'components', 'example.desktop-core', '1.0.0'); const runtime = join(dir, 'dist', 'index.js')
  mkdirSync(join(dir, 'dist'), { recursive: true }); writeFileSync(runtime, source)
  const manifest = coreManifest({ integrity: { runtime: `sha256-${createHash('sha256').update(readFileSync(runtime)).digest('hex')}` } })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const plan = buildComponentLaunchPlan({ core: manifest, plugins: [], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' })
  mkdirSync(join(base, 'data'), { recursive: true })
  writeFileSync(join(base, 'data', 'component-launch-plan.v2.json'), JSON.stringify(plan, null, 2))
}

function rewritePlan(base: string, manifest: ComponentManifest): void {
  const plan = buildComponentLaunchPlan({ core: manifest, plugins: [], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' })
  mkdirSync(join(base, 'data'), { recursive: true })
  writeFileSync(join(base, 'data', 'component-launch-plan.v2.json'), JSON.stringify(plan, null, 2))
}

function setupCoreWithPlugin(base: string, pluginSource = `export default { answer: 42 }`, badIntegrity = false): void {
  setupCore(base, `globalThis.__m4CoreImported = true; export default { boot(context) { if (context.request.pluginSelections.length !== 1 || context.components[0]?.defaultExport?.answer !== 42) throw new Error('plugin handoff missing'); context.ready() }, invoke(operation) { return operation === 'plugin.answer' ? contextValue : null } }`)
  const pluginDir = join(base, 'components', 'example.tool', '1.0.0'); const runtime = join(pluginDir, 'dist', 'index.js')
  mkdirSync(join(pluginDir, 'dist'), { recursive: true }); writeFileSync(runtime, pluginSource)
  const plugin: ComponentManifest = {
    schemaVersion: '0.1', id: 'example.tool', version: '1.0.0', title: 'Tool', componentType: 'plugin', pluginCategory: 'tool',
    entrypoints: { runtime: 'dist/index.js' }, integrity: { runtime: badIntegrity ? 'sha256-wrong' : `sha256-${createHash('sha256').update(readFileSync(runtime)).digest('hex')}` },
  }
  const corePath = join(base, 'components', 'example.desktop-core', '1.0.0', 'manifest.json')
  const core = JSON.parse(readFileSync(corePath, 'utf8')) as ComponentManifest
  const plan = buildComponentLaunchPlan({ core, plugins: [plugin], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' })
  writeFileSync(join(base, 'components', 'example.tool', '1.0.0', 'manifest.json'), JSON.stringify(plugin, null, 2))
  writeFileSync(join(base, 'data', 'component-launch-plan.v2.json'), JSON.stringify(plan, null, 2))
}

async function json(response: Response): Promise<any> { return response.json() }

test('desktop entry selects legacy without plan and never invokes it for v2 plan', async () => {
  const calls: string[] = []
  await startDesktopEntry({ planPath: 'missing', legacyOptions: {}, v2Options: {}, hasPlan: () => false, startLegacy: async () => { calls.push('legacy'); return 'legacy' }, startV2: async () => { calls.push('v2'); return 'v2' } })
  await startDesktopEntry({ planPath: 'present', legacyOptions: {}, v2Options: {}, hasPlan: () => true, startLegacy: async () => { calls.push('legacy-bad'); return 'legacy' }, startV2: async () => { calls.push('v2'); return 'v2' } })
  assert.deepEqual(calls, ['legacy', 'v2'])
})

test('v2 desktop host verifies artifact before import and serves status/invoke', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-host-')); try {
    setupCore(base); delete (globalThis as { __m4Shutdown?: number }).__m4Shutdown
    const host = await startV2DesktopHost({ userDataRoot: base, port: 0, maxBodyBytes: 32 })
    const address = host.server.address(); const port = typeof address === 'object' && address ? address.port : 0
    const status = await fetch(`http://127.0.0.1:${port}/api/v2/core/status`); assert.equal(status.status, 200); const statusBody = await json(status); assert.equal(statusBody.state, 'ready')
    const invoke = await fetch(`http://127.0.0.1:${port}/api/v2/core/invoke`, { method: 'POST', headers: { 'x-stagecraft-token': host.authToken }, body: JSON.stringify({ operation: 'echo', input: 3 }) }); assert.equal(invoke.status, 200); assert.deepEqual((await json(invoke)).result, { operation: 'echo', input: 3 })
    const badJson = await fetch(`http://127.0.0.1:${port}/api/v2/core/invoke`, { method: 'POST', headers: { 'x-stagecraft-token': host.authToken }, body: '{' }); assert.equal(badJson.status, 400); assert.equal((await json(badJson)).error.code, 'invalid_json')
    const tooLarge = await fetch(`http://127.0.0.1:${port}/api/v2/core/invoke`, { method: 'POST', headers: { 'x-stagecraft-token': host.authToken }, body: JSON.stringify({ operation: 'echo', input: 'x'.repeat(100) }) }); assert.equal(tooLarge.status, 413); assert.equal((await json(tooLarge)).error.code, 'body_too_large')
    await host.close(); assert.equal((globalThis as { __m4Shutdown?: number }).__m4Shutdown, 1); await host.close(); assert.equal((globalThis as { __m4Shutdown?: number }).__m4Shutdown, 1)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('v2 desktop host adapts an M2 defineCore default export to generic invoke', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-host-m2-')); try {
    setupCore(base, `export default { kind: 'core', manifest: { id: 'example.desktop-core', version: '1.0.0' }, start(context) { context.registerCommand('echo', input => ({ from: 'm2', input })); context.ready() } }`)
    const manifestPath = join(base, 'components', 'example.desktop-core', '1.0.0', 'manifest.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const runtimePath = join(base, 'components', 'example.desktop-core', '1.0.0', 'dist', 'index.js'); manifest.integrity.runtime = `sha256-${createHash('sha256').update(readFileSync(runtimePath)).digest('hex')}`; writeFileSync(manifestPath, JSON.stringify(manifest))
    const host = await startV2DesktopHost({ userDataRoot: base, port: 0 }); const address = host.server.address(); const port = typeof address === 'object' && address ? address.port : 0
    const invoke = await fetch(`http://127.0.0.1:${port}/api/v2/core/invoke`, { method: 'POST', headers: { 'x-stagecraft-token': host.authToken }, body: JSON.stringify({ operation: 'echo', input: 'hello' }) }); assert.equal(invoke.status, 200); assert.deepEqual((await json(invoke)).result, { from: 'm2', input: 'hello' })
    await host.close()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('v2 desktop host rejects an M2 Core whose authoring identity differs from the package', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-host-m2-mismatch-')); try {
    setupCore(base, `export default { kind: 'core', manifest: { id: 'm2.core', version: '0.1.0' }, start(context) { context.ready() } }`)
    await assert.rejects(() => startV2DesktopHost({ userDataRoot: base, port: 0 }), /\[v2:import\/example\.desktop-core\].*identity mismatch/)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('v2 desktop host validates and hands ordinary plugins to Core before Core import', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-host-plugin-')); try {
    setupCoreWithPlugin(base)
    const host = await startV2DesktopHost({ userDataRoot: base, port: 0 })
    assert.equal((globalThis as { __m4CoreImported?: boolean }).__m4CoreImported, true)
    assert.equal(host.session.request.pluginSelections[0].id, 'example.tool')
    assert.equal(host.session.state, 'ready')
    await host.close()
  } finally { rmSync(base, { recursive: true, force: true }); delete (globalThis as { __m4CoreImported?: boolean }).__m4CoreImported }
})

test('v2 desktop host rejects a bad plugin before importing Core and only permits loopback', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-host-security-')); try {
    setupCoreWithPlugin(base, `export default { answer: 42 }`, true)
    await assert.rejects(() => startV2DesktopHost({ userDataRoot: base, port: 0 }), /\[v2:artifact\/example\.tool\].*integrity mismatch/)
    assert.equal((globalThis as { __m4CoreImported?: boolean }).__m4CoreImported, undefined)
    await assert.rejects(() => startV2DesktopHost({ userDataRoot: base, host: '0.0.0.0', port: 0 }), /\[v2:listen\].*loopback/)
  } finally { rmSync(base, { recursive: true, force: true }); delete (globalThis as { __m4CoreImported?: boolean }).__m4CoreImported }
})

test('v2 desktop host validates and serves read-only UI entries', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-host-ui-')); try {
    setupCore(base)
    const componentDir = join(base, 'components', 'example.desktop-core', '1.0.0'); const uiPath = join(componentDir, 'dist', 'ui.js'); writeFileSync(uiPath, 'export const view = "ok"')
    const manifestPath = join(componentDir, 'manifest.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ComponentManifest
    manifest.entrypoints.ui = 'dist/ui.js'; manifest.integrity.ui = `sha256-${createHash('sha256').update(readFileSync(uiPath)).digest('hex')}`; writeFileSync(manifestPath, JSON.stringify(manifest)); rewritePlan(base, manifest)
    const host = await startV2DesktopHost({ userDataRoot: base, port: 0 }); const address = host.server.address(); const port = typeof address === 'object' && address ? address.port : 0
    const status = await (await fetch(`http://127.0.0.1:${port}/api/v2/core/status`)).json() as { uiEntries: { url: string }[] }; assert.equal(status.uiEntries.length, 1)
    const ui = await fetch(`http://127.0.0.1:${port}${status.uiEntries[0].url}`); assert.equal(ui.status, 200); assert.match(await ui.text(), /view/); await host.close()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('v2 desktop host rejects runtime and UI dependency loading despite a correct entry hash', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-host-single-file-')); try {
    setupCore(base, `import './payload.js'; globalThis.__m4PayloadImported = true; export default { boot(context) { context.ready() } }`)
    const runtimePath = join(base, 'components', 'example.desktop-core', '1.0.0', 'dist', 'index.js'); writeFileSync(join(base, 'components', 'example.desktop-core', '1.0.0', 'dist', 'payload.js'), `globalThis.__m4PayloadImported = true`)
    const manifestPath = join(base, 'components', 'example.desktop-core', '1.0.0', 'manifest.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ComponentManifest
    manifest.integrity.runtime = `sha256-${createHash('sha256').update(readFileSync(runtimePath)).digest('hex')}`; writeFileSync(manifestPath, JSON.stringify(manifest)); rewritePlan(base, manifest)
    await assert.rejects(() => startV2DesktopHost({ userDataRoot: base, port: 0 }), /\[v2:artifact\/example\.desktop-core\].*single-file.*bundle.*CLI/); assert.equal((globalThis as { __m4PayloadImported?: boolean }).__m4PayloadImported, undefined)
    const bareImport = `import 'unhashed-package'; export default { boot(context) { context.ready() } }`; writeFileSync(runtimePath, bareImport); manifest.integrity.runtime = `sha256-${createHash('sha256').update(readFileSync(runtimePath)).digest('hex')}`; writeFileSync(manifestPath, JSON.stringify(manifest)); rewritePlan(base, manifest)
    await assert.rejects(() => startV2DesktopHost({ userDataRoot: base, port: 0 }), /\[v2:artifact\/example\.desktop-core\].*single-file.*bundle.*CLI/)

    setupCore(base)
    const componentDir = join(base, 'components', 'example.desktop-core', '1.0.0'); const uiPath = join(componentDir, 'dist', 'ui.js'); writeFileSync(uiPath, `export { value } from './payload.js'`); writeFileSync(join(componentDir, 'dist', 'payload.js'), 'export const value = 1')
    const uiManifestPath = join(componentDir, 'manifest.json'); const uiManifest = JSON.parse(readFileSync(uiManifestPath, 'utf8')) as ComponentManifest; uiManifest.entrypoints.ui = 'dist/ui.js'; uiManifest.integrity.ui = `sha256-${createHash('sha256').update(readFileSync(uiPath)).digest('hex')}`; writeFileSync(uiManifestPath, JSON.stringify(uiManifest)); rewritePlan(base, uiManifest)
    await assert.rejects(() => startV2DesktopHost({ userDataRoot: base, port: 0 }), /\[v2:artifact\/example\.desktop-core\].*single-file.*bundle.*CLI/)

    setupCore(base, `export default { boot(context) { if (!import.meta.url) throw new Error('missing import.meta'); context.ready() } }`)
    const normalManifestPath = join(base, 'components', 'example.desktop-core', '1.0.0', 'manifest.json'); const normalManifest = JSON.parse(readFileSync(normalManifestPath, 'utf8')) as ComponentManifest; rewritePlan(base, normalManifest)
    const host = await startV2DesktopHost({ userDataRoot: base, port: 0 }); assert.equal(host.session.state, 'ready'); await host.close()
  } finally { rmSync(base, { recursive: true, force: true }); delete (globalThis as { __m4PayloadImported?: boolean }).__m4PayloadImported }
})

test('v2 close stops HTTP before a throwing Core shutdown and terminates session', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-host-close-')); try {
    setupCore(base, `export default { boot(context) { context.ready() }, shutdown() { throw new Error('shutdown failed') } }`)
    const host = await startV2DesktopHost({ userDataRoot: base, port: 0 }); await assert.rejects(() => host.close(), /shutdown failed/); assert.equal(host.server.listening, false); assert.equal(host.session.state, 'shutdown'); await host.close()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('v2 desktop host rejects required capability, integrity, path and handshake before success', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-host-invalid-')); try {
    setupCore(base)
    const manifestPath = join(base, 'components', 'example.desktop-core', '1.0.0', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.capabilities = { required: ['filesystem'] }; writeFileSync(manifestPath, JSON.stringify(manifest)); rewritePlan(base, manifest)
    await assert.rejects(() => startV2DesktopHost({ userDataRoot: base, port: 0, availableCapabilities: ['host.log'] }), /\[v2:capability\/example\.desktop-core\]/)
    manifest.capabilities = undefined; manifest.integrity.runtime = 'sha256-wrong'; writeFileSync(manifestPath, JSON.stringify(manifest)); rewritePlan(base, manifest)
    await assert.rejects(() => startV2DesktopHost({ userDataRoot: base, port: 0 }), /\[v2:artifact\/example\.desktop-core\].*integrity mismatch/)
    const runtimePath = join(base, 'components', 'example.desktop-core', '1.0.0', 'dist', 'index.js'); const source = `export default { boot(context) { context.ready({ selectedCore: { id: 'wrong.core', version: '1.0.0', manifestHash: 'x' } }) } }`; writeFileSync(runtimePath, source); manifest.integrity.runtime = `sha256-${createHash('sha256').update(source).digest('hex')}`; writeFileSync(manifestPath, JSON.stringify(manifest)); rewritePlan(base, manifest)
    await assert.rejects(() => startV2DesktopHost({ userDataRoot: base, port: 0 }), /\[v2:handshake\/example\.desktop-core\].*identity mismatch/)
    manifest.entrypoints.runtime = '../outside.js'; writeFileSync(manifestPath, JSON.stringify(manifest)); await assert.rejects(() => startV2DesktopHost({ userDataRoot: base, port: 0 }), /\[v2:plan\/example\.desktop-core\]/)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('v2 host port enforces per-capability authorization and per-caller storage', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-host-cap-')); try {
    setupCore(base, `let savedContext
export default {
  async boot(context) {
    savedContext = context
    await context.host.call('host.storage.write', { area: 'demo', value: { n: 7 } }, { pluginId: 'example.desktop-core', version: '1.0.0' })
    context.ready()
  },
  async invoke(operation) {
    const hostCall = (op, input, caller) => savedContext.host.call(op, input, caller ?? { pluginId: 'example.desktop-core', version: '1.0.0' })
    if (operation === 'storage/read') return hostCall('host.storage.read', { area: 'demo' })
    if (operation === 'storage/no-caller') return hostCall('host.storage.read', { area: 'demo' }, {})
    if (operation === 'log') { await hostCall('host.log', { hello: 'world' }); return 'logged' }
    if (operation === 'deny/unknown-op') return hostCall('host.nonsense', {})
    throw new Error('unexpected operation ' + operation)
  },
}`)
    const manifestPath = join(base, 'components', 'example.desktop-core', '1.0.0', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ComponentManifest
    manifest.capabilities = { required: ['host.storage'], optional: ['host.log'] }
    writeFileSync(manifestPath, JSON.stringify(manifest)); rewritePlan(base, manifest)
    const storage = createInMemoryComponentStorage()
    const host = await startV2DesktopHost({ userDataRoot: base, port: 0, storage })
    const address = host.server.address(); const port = typeof address === 'object' && address ? address.port : 0
    const call = async (operation: string) => fetch(`http://127.0.0.1:${port}/api/v2/core/invoke`, { method: 'POST', headers: { 'x-stagecraft-token': host.authToken }, body: JSON.stringify({ operation }) })
    const granted = await (await call('storage/read')).json() as any
    assert.deepEqual(granted.result, { ok: true, value: { n: 7 } })
    const noCaller = await (await call('storage/no-caller')).json() as any
    assert.match(noCaller.error.message, /requires a caller identity/)
    const logged = await (await call('log')).json() as any
    assert.equal(logged.result, 'logged')
    assert.ok(host.diagnostics.some(entry => entry.startsWith('host.log:')), 'granted host.log must reach diagnostics')
    const unknownOp = await (await call('deny/unknown-op')).json() as any
    assert.match(unknownOp.error.message, /Host operation denied: host\.nonsense/)
    await host.close()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('v2 host port denies storage for components that never declared the capability', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-host-cap-deny-')); try {
    setupCore(base, `let deniedMessage
export default {
  async boot(context) {
    try { await context.host.call('host.storage.write', { area: 'demo', value: 1 }, { pluginId: 'example.desktop-core', version: '1.0.0' }) } catch (error) { deniedMessage = String(error.message) }
    context.ready()
  },
  invoke() { return deniedMessage },
}`)
    const host = await startV2DesktopHost({ userDataRoot: base, port: 0, storage: createInMemoryComponentStorage() })
    const address = host.server.address(); const port = typeof address === 'object' && address ? address.port : 0
    const response = await fetch(`http://127.0.0.1:${port}/api/v2/core/invoke`, { method: 'POST', headers: { 'x-stagecraft-token': host.authToken }, body: JSON.stringify({ operation: 'denied' }) })
    const body = await response.json() as any
    assert.match(body.result, /Host capability denied: host\.storage for example\.desktop-core/)
    await host.close()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('v2 desktop host quarantines a plugin that throws at import and boots the Core without it', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-host-quarantine-')); try {
    setupCoreWithPlugin(base)
    const badDir = join(base, 'components', 'example.bad', '1.0.0'); const badRuntime = join(badDir, 'dist', 'index.js'); const badUi = join(badDir, 'dist', 'ui.js')
    mkdirSync(join(badDir, 'dist'), { recursive: true }); writeFileSync(badRuntime, `throw new Error('boom at import')`); writeFileSync(badUi, 'export const badUi = true')
    const bad: ComponentManifest = { schemaVersion: '0.1', id: 'example.bad', version: '1.0.0', title: 'Bad', componentType: 'plugin', pluginCategory: 'tool', entrypoints: { runtime: 'dist/index.js', ui: 'dist/ui.js' }, integrity: { runtime: `sha256-${createHash('sha256').update(readFileSync(badRuntime)).digest('hex')}`, ui: `sha256-${createHash('sha256').update(readFileSync(badUi)).digest('hex')}` } }
    writeFileSync(join(badDir, 'manifest.json'), JSON.stringify(bad, null, 2))
    const corePath = join(base, 'components', 'example.desktop-core', '1.0.0', 'manifest.json')
    const core = JSON.parse(readFileSync(corePath, 'utf8')) as ComponentManifest
    const good = JSON.parse(readFileSync(join(base, 'components', 'example.tool', '1.0.0', 'manifest.json'), 'utf8')) as ComponentManifest
    writeFileSync(join(base, 'data', 'component-launch-plan.v2.json'), JSON.stringify(buildComponentLaunchPlan({ core, plugins: [good, bad], hostApiVersion: '0.1', stateSchemaVersion: 'state-1' })))
    const host = await startV2DesktopHost({ userDataRoot: base, port: 0 })
    assert.equal(host.session.state, 'ready', 'Core must still boot when a plugin fails at import')
    assert.deepEqual(host.quarantinedPlugins, [{ id: 'example.bad', version: '1.0.0', reason: 'boom at import' }])
    assert.deepEqual(host.session.request.pluginSelections.map(selection => selection.id), ['example.tool'], 'effective selections must exclude the quarantined plugin')
    assert.equal(host.session.request.planHash, host.effectivePlan.planHash, 'effective request hash must match its effective plugin set')
    assert.notEqual(host.plan.planHash, host.effectivePlan.planHash, 'quarantine must produce a distinct effective hash')
    const status = await (await fetch(`http://127.0.0.1:${(host.server.address() as any).port}/api/v2/core/status`)).json() as any
    assert.equal(status.requestedPlanHash, host.plan.planHash)
    assert.equal(status.effectivePlanHash, host.effectivePlan.planHash)
    assert.equal(status.uiEntries.some((entry: any) => entry.id === 'example.bad'), false, 'quarantined plugin UI must not be exposed')
    assert.ok(host.diagnostics.some(entry => entry.includes('plugin quarantined: example.bad@1.0.0')))
    await host.close()
  } finally { rmSync(base, { recursive: true, force: true }); delete (globalThis as { __m4CoreImported?: boolean }).__m4CoreImported }
})

test('v2 host protects invoke/stream with a loopback token and loopback Host header', async () => {
  const base = mkdtempSync(join(root, '.tmp-v2-host-token-')); try {
    setupCore(base)
    const host = await startV2DesktopHost({ userDataRoot: base, port: 0 })
    const address = host.server.address(); const port = typeof address === 'object' && address ? address.port : 0
    const url = `http://127.0.0.1:${port}/api/v2/core/invoke`
    const denied = await fetch(url, { method: 'POST', body: JSON.stringify({ operation: 'echo', input: 1 }) })
    assert.equal(denied.status, 401)
    const wrongToken = await fetch(url, { method: 'POST', headers: { 'x-stagecraft-token': 'nope' }, body: JSON.stringify({ operation: 'echo', input: 1 }) })
    assert.equal(wrongToken.status, 401)
    const queryToken = await fetch(`${url}?token=${encodeURIComponent(host.authToken)}`, { method: 'POST', body: JSON.stringify({ operation: 'echo', input: 1 }) })
    assert.equal(queryToken.status, 200, 'query parameter token must be accepted')
    const tokenHeader = await fetch(url, { method: 'POST', headers: { 'x-stagecraft-token': host.authToken }, body: JSON.stringify({ operation: 'echo', input: 2 }) })
    assert.equal(tokenHeader.status, 200)
    // DNS-rebinding guard: Host header must be a loopback literal. fetch() forbids
    // overriding Host, so use a raw http request.
    const rebound: any = await new Promise((resolveRebound, rejectRebound) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/v2/core/invoke', headers: { host: 'evil.example.com', 'x-stagecraft-token': host.authToken, 'content-type': 'application/json' } }, res => { let data = ''; res.on('data', chunk => { data += chunk }); res.on('end', () => resolveRebound({ status: res.statusCode, body: JSON.parse(data) })) })
      req.on('error', rejectRebound); req.end(JSON.stringify({ operation: 'echo', input: 3 }))
    })
    assert.equal(rebound.status, 403)
    assert.equal(rebound.body.error.code, 'forbidden_host')
    // status stays open (read-only) and reports the mount URL
    const status = await (await fetch(`http://127.0.0.1:${port}/api/v2/core/status`)).json() as any
    assert.equal(status.mountUrl, '/api/v2/ui')
    // token file persisted for legitimate local launchers
    assert.equal(readFileSync(join(base, 'data', 'v2-host-token'), 'utf8'), host.authToken)
    // UI mount page renders with the token injected
    const page = await (await fetch(`http://127.0.0.1:${port}/api/v2/ui`)).text()
    assert.match(page, /v2 UI mount/)
    assert.match(page, new RegExp(host.authToken.slice(0, 8)))
    await host.close()
  } finally { rmSync(base, { recursive: true, force: true }) }
})
