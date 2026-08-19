import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { parseCardPackage, compileCardPackage, extractInitVars, decodeMvuUpdates, stMvuCompatPlugin } from '../src/compat/st-mvu.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { createStageCraftService, stageCraftServicePlugin } from '../src/core/cordis-plugins.ts'
import { Store } from '../src/store.ts'
import { StoreCoreStateRepository } from '../src/core/store-state-repository.ts'
import { applyStatePatches } from '../src/core/state-transaction.ts'

interface PrivateFixture { path: string; content: string; score: number }

function walkJson(root: string): Array<{ path: string; content: string; parsed: Record<string, unknown> }> {
  if (!existsSync(root)) return []
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) files.push(path)
    }
  }
  visit(root)
  const output: Array<{ path: string; content: string; parsed: Record<string, unknown> }> = []
  for (const path of files) {
    try {
      const content = readFileSync(path, 'utf8')
      const parsed = JSON.parse(content)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) output.push({ path, content, parsed })
    } catch {
      // Private directories may contain unrelated or incomplete JSON files.
    }
  }
  return output
}

function cardRoot(value: Record<string, unknown>): Record<string, unknown> {
  return value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data as Record<string, unknown> : value
}

function hasMarker(value: unknown): boolean {
  if (typeof value === 'string') return /\[InitVar\]|<initvar>|<UpdateVariable>|<JSONPatch>/i.test(value)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => /tavern[_-]?helper|regex[_-]?scripts|mvu/i.test(key) || hasMarker(child))
}

function selectFixture(root: string): PrivateFixture | undefined {
  const candidates = walkJson(root).map(candidate => {
    const card = cardRoot(candidate.parsed)
    const entries = card.character_book && typeof card.character_book === 'object' && !Array.isArray(card.character_book)
      ? (card.character_book as any).entries : undefined
    if (!Array.isArray(entries) || !hasMarker(card)) return undefined
    const serialized = JSON.stringify(card)
    const initCount = (serialized.match(/\[InitVar\]|<initvar>/gi) ?? []).length
    const disabledInitCount = entries.filter((entry: any) => entry?.enabled === false && /\[InitVar\]/i.test(String(entry?.comment ?? entry?.name ?? ''))).length
    const scriptCount = (serialized.match(/tavern[_-]?helper|regex[_-]?scripts/gi) ?? []).length
    const importCount = (serialized.match(/https?:\/\//gi) ?? []).length
    const greetingCount = Array.isArray(card.alternate_greetings) ? card.alternate_greetings.length : 0
    const score = entries.length * 2 + initCount * 5 + disabledInitCount * 6 + scriptCount * 4 + importCount * 3 + greetingCount
    return { ...candidate, score }
  }).filter((candidate): candidate is { path: string; content: string; parsed: Record<string, unknown>; score: number } => Boolean(candidate))
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  const selected = candidates[0]
  return selected ? { path: selected.path, content: selected.content, score: selected.score } : undefined
}

function pointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

function finiteLeaf(value: unknown, path = ''): { path: string; value: number } | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return { path, value }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue
    const found = finiteLeaf(child, `${path}/${pointerSegment(key)}`)
    if (found) return found
  }
  return undefined
}

const fixture = selectFixture(join(process.cwd(), 'custom'))

test('private ST/MVU card passes generic compatibility acceptance when available', { skip: !fixture }, async () => {
  assert.ok(fixture)
  const pkg = parseCardPackage(fixture.content, 'private-fixture.json')
  const report = compileCardPackage(pkg)
  const init = extractInitVars(pkg)
  assert.ok(pkg.worldbook.length > 0)
  assert.ok(pkg.scripts.length > 0)
  assert.ok(pkg.regexScripts.length > 0)
  assert.ok(pkg.alternateGreetings.length > 0)
  assert.ok(report.manifest.id.length > 0)
  assert.ok(report.imports.length > 0)
  assert.ok(Object.keys(init.state).length > 0)
  assert.equal(init.diagnostics.some(item => item.level === 'error'), false)
  assert.equal(report.imports.every(item => item.capability === 'blocked'), true)
  if (pkg.scripts.length + pkg.regexScripts.length > 0) assert.ok(pkg.diagnostics.some(item => item.code === 'script.blocked'))

  const disabled = pkg.worldbook.find(entry => !entry.enabled && /\[InitVar\]/i.test(String(entry.comment ?? entry.name ?? '')))
  assert.ok(disabled)
  const disabledState = extractInitVars({ ...pkg, worldbook: [disabled], texts: {} }).state
  assert.ok(Object.keys(disabledState).length > 0)
  const cardState = init.state
  for (const key of Object.keys(disabledState)) assert.ok(Object.prototype.hasOwnProperty.call(cardState, key))

  const root = mkdtempSync(join(tmpdir(), 'private-st-mvu-'))
  const databasePath = join(root, 'state.sqlite')
  let store: Store | undefined
  let restoredStore: Store | undefined
  let serviceFiber: any
  let pluginFiber: any
  let restoredServiceFiber: any
  let restoredPluginFiber: any
  let context: Context | undefined
  let restoredContext: Context | undefined
  let container: DefaultCorePluginContainer | undefined
  let restoredContainer: DefaultCorePluginContainer | undefined
  try {
    store = new Store(databasePath)
    const core = new CoreRuntimeSkeleton()
    core.attachStateRepository(new StoreCoreStateRepository(store))
    container = new DefaultCorePluginContainer(core)
    const service = createStageCraftService(core, 'private-room', container, repository => core.attachStateRepository(repository))
    context = new Context()
    serviceFiber = context.plugin(stageCraftServicePlugin(service)); await serviceFiber
    pluginFiber = context.plugin(stMvuCompatPlugin({ package: pkg, moduleId: report.moduleId, report })); await pluginFiber

    const view = core.getView()
    const statData = (view.state as any)?.modules?.[report.moduleId]?.state?.stat_data
    assert.ok(statData && typeof statData === 'object')
    const leaf = finiteLeaf(statData)
    assert.ok(leaf)
    const enabledBodyLength = pkg.worldbook.filter(entry => entry.enabled).reduce((total, entry) => total + entry.content.length, 0)
    const neutralPrompt = service.extensions.composePrompt({ text: '__stagecraft_neutral_context__' })
    const selectedBodyLength = neutralPrompt.reduce((total, fragment: any) => total + (Array.isArray(fragment.content) ? fragment.content.reduce((sum: number, item: any) => sum + String(item.content ?? '').length, 0) : 0), 0)
    if (enabledBodyLength > 0 && pkg.worldbook.some(entry => entry.enabled && !entry.constant)) assert.ok(selectedBodyLength < enabledBodyLength)
    if (disabled.content) assert.equal(JSON.stringify(neutralPrompt).includes(disabled.content), false)

    const path = leaf.path || '/value'
    const beforeApproval = structuredClone(statData)
    const expectedAfterApproval = applyStatePatches(beforeApproval, [{ op: 'delta', path, value: 2 }]).after
    const input = decodeMvuUpdates(`<UpdateVariable><JSONPatch>${JSON.stringify([{ op: 'delta', path: `/stat_data${path}`, value: 1 }])}</JSONPatch></UpdateVariable>`, report.moduleId)
    const proposal = service.extensions.operateProposal({ operation: 'create', typeId: `${report.moduleId}.mvu-patch`, input, roomId: 'private-room' }) as any
    const edited = decodeMvuUpdates(`<UpdateVariable><JSONPatch>${JSON.stringify([{ op: 'delta', path: `/stat_data${path}`, value: 2 }])}</JSONPatch></UpdateVariable>`, report.moduleId)
    service.extensions.operateProposal({ operation: 'edit', id: proposal.id, input: edited, roomId: 'private-room' })
    service.extensions.operateProposal({ operation: 'approve', id: proposal.id, roomId: 'private-room' })
    const afterApproval = (core.getView().state as any)?.modules?.[report.moduleId]?.state?.stat_data
    assert.equal(isDeepStrictEqual(afterApproval, expectedAfterApproval), true)
    const rejected = service.extensions.operateProposal({ operation: 'create', typeId: `${report.moduleId}.mvu-patch`, input, roomId: 'private-room' }) as any
    service.extensions.operateProposal({ operation: 'reject', id: rejected.id, roomId: 'private-room' })
    assert.equal(isDeepStrictEqual((core.getView().state as any)?.modules?.[report.moduleId]?.state?.stat_data, expectedAfterApproval), true)

    await pluginFiber.dispose(); pluginFiber = undefined
    assert.equal(isDeepStrictEqual((core.getView().state as any)?.modules?.[report.moduleId]?.state?.stat_data, expectedAfterApproval), true)
    assert.equal(core.restoreState('private-room'), true)
    await serviceFiber.dispose(); serviceFiber = undefined
    await container.dispose(); container = undefined
    store.close(); store = undefined

    restoredStore = new Store(databasePath)
    const restored = new CoreRuntimeSkeleton()
    restored.attachStateRepository(new StoreCoreStateRepository(restoredStore))
    assert.equal(restored.restoreState('private-room'), true)
    restoredContainer = new DefaultCorePluginContainer(restored)
    const restoredService = createStageCraftService(restored, 'private-room', restoredContainer, repository => restored.attachStateRepository(repository))
    restoredContext = new Context()
    restoredServiceFiber = restoredContext.plugin(stageCraftServicePlugin(restoredService)); await restoredServiceFiber
    restoredPluginFiber = restoredContext.plugin(stMvuCompatPlugin({ package: pkg, moduleId: report.moduleId, report })); await restoredPluginFiber
    assert.equal(isDeepStrictEqual((restored.getView().state as any)?.modules?.[report.moduleId]?.state?.stat_data, expectedAfterApproval), true)
  } finally {
    try { if (restoredContext && typeof (restoredContext as any).dispose === 'function') await (restoredContext as any).dispose() } catch { /* cleanup is best effort */ }
    try { if (context && typeof (context as any).dispose === 'function') await (context as any).dispose() } catch { /* cleanup is best effort */ }
    try { if (restoredPluginFiber) await restoredPluginFiber.dispose() } catch { /* cleanup is best effort */ }
    try { if (restoredServiceFiber) await restoredServiceFiber.dispose() } catch { /* cleanup is best effort */ }
    try { if (restoredContainer) await restoredContainer.dispose() } catch { /* cleanup is best effort */ }
    try { restoredStore?.close() } catch { /* cleanup is best effort */ }
    try { if (pluginFiber) await pluginFiber.dispose() } catch { /* cleanup is best effort */ }
    try { if (serviceFiber) await serviceFiber.dispose() } catch { /* cleanup is best effort */ }
    try { if (container) await container.dispose() } catch { /* cleanup is best effort */ }
    try { store?.close() } catch { /* cleanup is best effort */ }
    rmSync(root, { recursive: true, force: true })
  }
})
