import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildComponentLaunchPlan } from '../src/v2/launch-plan.ts'
import { startV2DesktopHost } from '../src/v2/desktop-host.ts'
import type { ComponentManifest } from '../src/v2/component-contract.ts'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'))
const examples = join(root, 'examples', 'v2')

function manifestFor(base: string, name: string): ComponentManifest {
  const project = join(examples, name); const packageManifest = JSON.parse(readFileSync(join(project, 'stagecraft.plugin.json'), 'utf8'))
  const runtime = readFileSync(join(project, packageManifest.output));
  const component: ComponentManifest = { schemaVersion: '0.1', id: packageManifest.id, version: packageManifest.version, title: packageManifest.title, componentType: packageManifest.category === 'core' ? 'core' : 'plugin', ...(packageManifest.category === 'core' ? { hostApi: { version: '0.1' } } : { pluginCategory: packageManifest.category }), entrypoints: { runtime: packageManifest.output }, integrity: { runtime: `sha256-${createHash('sha256').update(runtime).digest('hex')}` } }
  const dir = join(base, 'components', component.id, component.version); mkdirSync(join(dir, 'dist'), { recursive: true }); cpSync(join(project, packageManifest.output), join(dir, packageManifest.output)); writeFileSync(join(dir, 'manifest.json'), JSON.stringify(component, null, 2)); return component
}

test('M9 real example chain: build components, launch plan, Host, Solution, LLM stream/usage and Tool', async () => {
  for (const name of ['core', 'driver', 'llm', 'solution', 'tool']) execFileSync(process.execPath, ['scripts/stagecraft.mjs', 'plugin', 'build', join('examples', 'v2', name)], { cwd: root, stdio: 'ignore' })
  const base = mkdtempSync(join(root, '.tmp-m9-e2e-'))
  let host: Awaited<ReturnType<typeof startV2DesktopHost>> | undefined
  try {
    const components = ['core', 'driver', 'llm', 'solution', 'tool'].map(name => manifestFor(base, name)); const core = components[0]
    const plan = buildComponentLaunchPlan({ core, plugins: components.slice(1), hostApiVersion: '0.1', stateSchemaVersion: 'demo-state-1' }); mkdirSync(join(base, 'data'), { recursive: true }); writeFileSync(join(base, 'data', 'component-launch-plan.v2.json'), JSON.stringify(plan, null, 2))
    host = await startV2DesktopHost({ userDataRoot: base, port: 0 }); const address = host.server.address(); const port = typeof address === 'object' && address ? address.port : 0
    const response = await fetch(`http://127.0.0.1:${port}/api/v2/core/invoke`, { method: 'POST', body: JSON.stringify({ operation: 'demo/run', input: { user: 'hello', tool: 7 } }) }); const responseBody = await response.json() as any; assert.equal(response.status, 200, JSON.stringify(responseBody))
    const result = responseBody.result; assert.deepEqual(result.messages, [{ role: 'system', content: 'You are the StageCraft demo narrator.' }, { role: 'user', content: 'User says: hello' }]); assert.deepEqual(result.chunks, [{ type: 'text', text: 'echo:You are the StageCraft demo narrator.|User says: hello' }, { type: 'usage', usage: { inputTokens: 4, outputTokens: 6 } }, { type: 'done' }]); assert.deepEqual(result.tool, { tool: 'echo', input: 7 })
  } finally { if (host) await host.close().catch(() => undefined); rmSync(base, { recursive: true, force: true }) }
})

test('M9 invalid Core is a v2 startup failure and never falls back to v1', async () => {
  const base = mkdtempSync(join(root, '.tmp-m9-bad-core-'))
  try {
    const core = manifestFor(base, 'core'); const runtimePath = join(base, 'components', core.id, core.version, core.entrypoints.runtime); writeFileSync(runtimePath, 'export default { boot() { throw new Error("bad core") } }'); core.integrity.runtime = `sha256-${createHash('sha256').update(readFileSync(runtimePath)).digest('hex')}`; writeFileSync(join(base, 'components', core.id, core.version, 'manifest.json'), JSON.stringify(core)); mkdirSync(join(base, 'data'), { recursive: true }); writeFileSync(join(base, 'data', 'component-launch-plan.v2.json'), JSON.stringify(buildComponentLaunchPlan({ core, plugins: [], hostApiVersion: '0.1', stateSchemaVersion: 'demo' })))
    await assert.rejects(() => startV2DesktopHost({ userDataRoot: base, port: 0 }), /\[v2:handshake\/example\.stagecraft\.core\]/)
  } finally { rmSync(base, { recursive: true, force: true }) }
})
