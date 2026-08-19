import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCardPackage, compileCardPackage, extractInitVars, parseSafeYaml, selectWorldbook, worldbookDiagnostics, decodeMvuUpdates, StateOverlay, stMvuCompatPlugin } from '../src/compat/st-mvu.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { createStageCraftService, stageCraftServicePlugin } from '../src/core/cordis-plugins.ts'

const cardJson = JSON.stringify({
  spec: 'chara_card_v3', name: 'Public Test Card', description: 'Description', alternate_greetings: ['Hello', 'Hi'],
  character_book: { entries: [
    { id: 'disabled', keys: ['never'], comment: '[InitVar] disabled initializer', content: 'disabledValue: 3', enabled: false },
    { id: 'constant', keys: [], content: 'always', constant: true, order: 2 },
    { id: 'selective', keys: ['castle'], secondary_keys: ['moon'], selective: true, content: 'selective', order: 1 },
    { id: 'inserted', keys: ['castle'], content: 'inserted', constant: true, insertion_order: 0 },
  ] },
  extensions: { tavern_helper: { script: 'throw new Error("must not execute")' }, regex_scripts: [{ script: 'https://example.test/x.js' }], regexScripts: [{ script: 'https://example.test/y.js' }] },
  system_prompt: '[InitVar]\nscore: 1\nflags:\n  - ready\n[/InitVar]',
})

test('card package parsing is lossless, cloned and script-free', () => {
  const pkg = parseCardPackage(cardJson, 'public-test.json')
  assert.equal(pkg.metadata.filename, 'public-test.json')
  assert.equal(pkg.metadata.sha256.length, 64)
  assert.equal(pkg.worldbook.length, 4)
  assert.deepEqual(pkg.alternateGreetings, ['Hello', 'Hi'])
  assert.ok(pkg.scripts.length >= 1)
  assert.ok(pkg.regexScripts.length >= 2)
  assert.ok(pkg.diagnostics.some(item => item.code === 'script.blocked'))
  ;(pkg.raw as any).name = 'changed'
  assert.equal(JSON.parse(cardJson).name, 'Public Test Card')
  const report = compileCardPackage(parseCardPackage(cardJson))
  assert.equal(report.manifest.id.startsWith('card.'), true)
  assert.ok(report.imports.every(item => item.capability === 'blocked'))
})

test('InitVar handles disabled entries, JSON/YAML scalars and safe failure', () => {
  const pkg = parseCardPackage(cardJson)
  const init = extractInitVars(pkg)
  assert.equal((init.state as any).score, 1)
  assert.equal((init.state as any).disabledValue, 3)
  assert.deepEqual((init.state as any).flags, ['ready'])
  assert.deepEqual(parseSafeYaml('a: true\nb: null\nc: [1, 2]\nobj: {a: 1, b: text}\nquoted: "a # b" # comment\nitems:\n  - key: value\n    other: 2\nnested:\n  value: text'), { a: true, b: null, c: [1, 2], obj: { a: 1, b: 'text' }, quoted: 'a # b', items: [{ key: 'value', other: 2 }], nested: { value: 'text' } })
  assert.throws(() => parseSafeYaml('a: &anchor x'), /YAML|JSON/)
  assert.throws(() => parseSafeYaml('__proto__: polluted'), /Unsafe YAML/)
  assert.throws(() => parseSafeYaml('items:\n  - __proto__: polluted'), /Unsafe YAML/)
  assert.throws(() => parseSafeYaml('x: {constructor: bad}'), /Unsafe YAML/)
  assert.throws(() => parseSafeYaml('x: 1\nx: 2'), /Duplicate YAML/)
  assert.throws(() => parseSafeYaml('x: {a: 1, a: 2}'), /Duplicate YAML/)
  assert.throws(() => parseCardPackage('null'), /root must be an object/)
  assert.throws(() => parseCardPackage('[]'), /root must be an object/)
  const dangerous = parseCardPackage(JSON.stringify({ system_prompt: '[InitVar]{"__proto__":{"polluted":true},"constructor":{"bad":1},"safe":2}[/InitVar]' }))
  const dangerousInit = extractInitVars(dangerous)
  assert.equal((dangerousInit.state as any).safe, undefined)
  assert.ok(dangerousInit.diagnostics.some(item => item.code === 'initvar.invalid'))
  assert.equal(({} as any).polluted, undefined)
})

test('worldbook selector respects enabled/constant/selective/order without static full injection', () => {
  const pkg = parseCardPackage(cardJson)
  assert.deepEqual(selectWorldbook(pkg.worldbook, { text: 'castle under moon' }).map(entry => entry.id), ['inserted', 'selective', 'constant'])
  assert.deepEqual(selectWorldbook(pkg.worldbook, { text: 'castle only' }).map(entry => entry.id), ['inserted', 'constant'])
  assert.equal(selectWorldbook(pkg.worldbook, { text: 'nothing' }).some(entry => entry.id === 'disabled'), false)
})

test('worldbook selector implements SillyTavern numeric selective logic', () => {
  const make = (selectiveLogic: number) => parseCardPackage(JSON.stringify({ character_book: { entries: [{ id: String(selectiveLogic), keys: ['primary'], secondary_keys: ['one', 'two'], selective: true, extensions: { selectiveLogic }, content: 'entry' }] } })).worldbook[0]
  for (const logic of [0, 1, 2, 3]) {
    const entry = make(logic)
    assert.equal(selectWorldbook([entry], { text: 'primary one' }).length, logic === 0 || logic === 1 ? 1 : 0)
    assert.equal(selectWorldbook([entry], { text: 'primary one two' }).length, logic === 0 || logic === 3 ? 1 : 0)
  }
  const stringEntry = make(0)
  ;(stringEntry.extensions as any).selectiveLogic = 'AND_ANY'
  assert.equal(selectWorldbook([stringEntry], { text: 'primary two' }).length, 1)
  ;(stringEntry.extensions as any).selectiveLogic = 'AND ANY'
  assert.equal(selectWorldbook([stringEntry], { text: 'primary two' }).length, 1)
  ;(stringEntry.extensions as any).selectiveLogic = 'and-any'
  assert.equal(selectWorldbook([stringEntry], { text: 'primary two' }).length, 1)
})

test('worldbook diagnostics report ignored recursion and grouping capabilities', () => {
  const entry = parseCardPackage(JSON.stringify({ character_book: { entries: [{ id: 'unsupported', content: '', extensions: { delay_until_recursion: true, delay: 2, useProbability: true, group_weight: 2, group_override: true, use_group_scoring: true, scan_depth: 3, depth: 2, triggers: ['x'], vectorized: true, use_regex: true } }] } })).worldbook[0]
  const codes = worldbookDiagnostics([entry]).map(item => item.code)
  for (const name of ['delay_until_recursion', 'delay', 'useProbability', 'group_weight', 'group_override', 'use_group_scoring', 'scan_depth', 'depth', 'triggers', 'vectorized', 'use_regex']) assert.ok(codes.includes(`worldbook.${name}.unsupported`))
})

test('MVU decoder maps safe pointers, ignores analysis and rejects ambiguity/escape', () => {
  const decoded = decodeMvuUpdates('Analysis: ignore\n<UpdateVariable><JSONPatch>```json\n[{"op":"set","path":"/stat_data/score","value":2},{"op":"move","from":"/主角/a","path":"/主角/b"}]\n```</JSONPatch></UpdateVariable>', 'module/x')
  assert.equal(decoded.patches[0].path, '/modules/module~1x/state/stat_data/score')
  assert.equal((decoded.patches[1] as any).from, '/modules/module~1x/state/stat_data/主角/a')
  assert.throws(() => decodeMvuUpdates('<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable><UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>', 'm'), /Multiple/)
  assert.throws(() => decodeMvuUpdates('<UpdateVariable><JSONPatch>[{"op":"set","path":"/modules/x","value":1}]</JSONPatch></UpdateVariable>', 'm'), /escapes/)
  assert.throws(() => decodeMvuUpdates('<UpdateVariable><JSONPatch>[{"op":"wat","path":"/x"}]</JSONPatch></UpdateVariable>', 'm'), /invalid operation/)
  assert.throws(() => decodeMvuUpdates('<UpdateVariable><JSONPatch>[{"op":"set","path":"/x~2y","value":1}]</JSONPatch></UpdateVariable>', 'm'), /escape/)
  assert.throws(() => decodeMvuUpdates('<UpdateVariable><JSONPatch>[{"op":"merge","path":"/x","value":[1]}]</JSONPatch></UpdateVariable>', 'm'), /merge value/)
})

test('StateOverlay applies in order, previews and discards without side effects', () => {
  const overlay = new StateOverlay({ value: 1, list: [] })
  overlay.apply([{ op: 'delta', path: '/value', value: 1 }]).apply([{ op: 'insert', path: '/list/-', value: 'x' }])
  assert.deepEqual(overlay.preview(), { value: 2, list: ['x'] })
  assert.equal(overlay.get('/value'), 2)
  assert.equal(overlay.toPatches().length, 2)
  overlay.discard()
  assert.deepEqual(overlay.preview(), { value: 1, list: [] })
})

test('Cordis compatibility plugin initializes once, registers proposal/prompt/view and unloads capabilities', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const service = createStageCraftService(core, 'room', container, repository => core.attachStateRepository(repository))
  const ctx = new Context()
  const serviceFiber = ctx.plugin(stageCraftServicePlugin(service)); await serviceFiber
  const fiber = ctx.plugin(stMvuCompatPlugin({ package: parseCardPackage(cardJson), moduleId: 'compat.test' })); await fiber
  const state = core.getView().state as any
  assert.equal(state.modules['compat.test'].state.stat_data.score, 1)
  const summary = core.getView().viewContributions?.find(item => item.kind === 'compat.summary') as any
  assert.equal(summary.value.statePresent, true)
  assert.equal(typeof summary.value.revision, 'number')
  assert.deepEqual(summary.value.topLevelKeys, ['disabledValue', 'flags', 'score'])
  const diagnosticKeys = summary.value.diagnostics.map((item: any) => `${item.level}:${item.code}:${item.message}`)
  assert.equal(new Set(diagnosticKeys).size, diagnosticKeys.length)
  service.state.transact({ roomId: 'room', moduleId: 'compat.test', patches: [{ op: 'set', path: '/modules/compat.test/state/stat_data/score', value: 99 }] })
  await fiber.dispose()
  const reinstall = ctx.plugin(stMvuCompatPlugin({ package: parseCardPackage(cardJson), moduleId: 'compat.test' })); await reinstall
  assert.equal((core.getView().state as any).modules['compat.test'].state.stat_data.score, 99)
  const proposal = service.extensions.operateProposal({ operation: 'create', typeId: 'compat.test.mvu-patch', input: decodeMvuUpdates('<UpdateVariable><JSONPatch>[{"op":"set","path":"/stat_data/score","value":7}]</JSONPatch></UpdateVariable>', 'compat.test'), roomId: 'room' }) as any
  const edited = service.extensions.operateProposal({ operation: 'edit', id: proposal.id, input: decodeMvuUpdates('<UpdateVariable><JSONPatch>[{"op":"set","path":"/stat_data/score","value":8}]</JSONPatch></UpdateVariable>', 'compat.test'), roomId: 'room' }) as any
  assert.equal(edited.status, 'pending')
  assert.equal((service.extensions.operateProposal({ operation: 'approve', id: proposal.id, roomId: 'room' }) as any).status, 'approved')
  const rejected = service.extensions.operateProposal({ operation: 'create', typeId: 'compat.test.mvu-patch', input: decodeMvuUpdates('<UpdateVariable><JSONPatch>[{"op":"set","path":"/stat_data/score","value":10}]</JSONPatch></UpdateVariable>', 'compat.test'), roomId: 'room' }) as any
  assert.equal((service.extensions.operateProposal({ operation: 'reject', id: rejected.id, roomId: 'room' }) as any).status, 'rejected')
  assert.throws(() => service.extensions.operateProposal({ operation: 'create', typeId: 'compat.test.mvu-patch', input: { patches: [{ op: 'set', path: '/modules/compat.test/state/stat_dataevil', value: 2 }] }, roomId: 'room' }), /invalid proposal|namespace/)
  await reinstall.dispose(); await serviceFiber.dispose(); await container.dispose()
  assert.equal(service.extensions.operateProposal({ operation: 'get', id: proposal.id }), undefined)
  assert.equal((core.getView().state as any).modules['compat.test'].state.stat_data.score, 8)
})

test('Cordis compatibility plugin conflict is compensated and can be reinstalled', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const service = createStageCraftService(core, 'room', container, repository => core.attachStateRepository(repository))
  const ctx = new Context()
  const serviceFiber = ctx.plugin(stageCraftServicePlugin(service)); await serviceFiber
  const packageData = parseCardPackage(cardJson)
  const first = ctx.plugin(stMvuCompatPlugin({ package: packageData, moduleId: 'compat.conflict' })); await first
  const conflicting = ctx.plugin(stMvuCompatPlugin({ package: packageData, moduleId: 'compat.conflict' }))
  await assert.rejects(async () => { await conflicting })
  await first.dispose()
  const replacement = ctx.plugin(stMvuCompatPlugin({ package: packageData, moduleId: 'compat.conflict' })); await replacement
  await replacement.dispose(); await serviceFiber.dispose(); await container.dispose()
})

test('Cordis compatibility plugin compensates after proposal registration conflict', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const service = createStageCraftService(core, 'room', container, repository => core.attachStateRepository(repository))
  const ctx = new Context()
  const serviceFiber = ctx.plugin(stageCraftServicePlugin(service)); await serviceFiber
  const packageData = parseCardPackage(cardJson)
  const originalRegisterSchema = service.state.registerSchema
  let blocker: { dispose(): void } | undefined
  ;(service.state as any).registerSchema = (schema: any) => {
    const disposable = originalRegisterSchema(schema)
    blocker = service.extensions.registerProposalType({ id: 'compat.midway.mvu-patch', moduleId: 'compat.midway', path: '/runtime/proposals', validate: () => undefined, apply: () => [] })
    return disposable
  }
  const failed = ctx.plugin(stMvuCompatPlugin({ package: packageData, moduleId: 'compat.midway' }))
  await assert.rejects(async () => { await failed })
  ;(service.state as any).registerSchema = originalRegisterSchema
  blocker?.dispose()
  const replacement = ctx.plugin(stMvuCompatPlugin({ package: packageData, moduleId: 'compat.midway' })); await replacement
  await replacement.dispose(); await serviceFiber.dispose(); await container.dispose()
})
