import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { createStageCraftService, stageCraftServicePlugin } from '../src/core/cordis-plugins.ts'
import { Store } from '../src/store.ts'
import { StoreCoreStateRepository } from '../src/core/store-state-repository.ts'

function coreWithModule() {
  const core = new CoreRuntimeSkeleton()
  core.registerStateModule({ id: 'ext', version: '1' })
  return core
}

test('record collections support editable CRUD and reorder through state transactions', () => {
  const core = coreWithModule()
  const collection = core.registerRecordCollection({ id: 'items', moduleId: 'ext', path: '/items', validate: record => typeof (record as any)?.name === 'string' ? undefined : ['name required'] })
  const created = core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'create-or-upsert', record: { id: 'a', name: 'A' } })
  assert.deepEqual(created.records, [{ id: 'a', name: 'A' }])
  core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'create-or-upsert', record: { id: 'b', name: 'B' } })
  core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'edit', id: 'a', patches: [{ op: 'set', path: '/name', value: 'A-patched' }] })
  assert.equal((core.operateRecord({ collectionId: 'items', operation: 'list' }).records[0] as any).name, 'A-patched')
  core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'edit', id: 'a', record: { id: 'a', name: 'A2' } })
  core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'reorder', order: ['b', 'a'] })
  assert.deepEqual(core.operateRecord({ collectionId: 'items', operation: 'list' }).records, [{ id: 'b', name: 'B' }, { id: 'a', name: 'A2' }])
  core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'remove', id: 'b' })
  assert.deepEqual(core.operateRecord({ collectionId: 'items', operation: 'list' }).records, [{ id: 'a', name: 'A2' }])
  assert.throws(() => core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'edit', id: 'a', record: { id: 'a', bad: true } }), /validation/)
  assert.throws(() => core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'edit', id: 'a', record: { id: 'changed', name: 'bad' } }), /match/)
  assert.throws(() => core.registerRecordCollection({ id: 'bad-pointer', moduleId: 'ext', path: '/bad~2' }), /Pointer|escape/)
  assert.throws(() => core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'create-or-upsert', record: { name: 'missing-id' } }), /string id/)
  assert.throws(() => core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'create-or-upsert', baseRevision: 0, record: { id: 'c', name: 'C' } }), /conflict/)
  collection.dispose()
})

test('record collection failure is atomic and cannot escape its module namespace', () => {
  const core = coreWithModule()
  core.registerRecordCollection({ id: 'items', moduleId: 'ext', path: '/items' })
  core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'create-or-upsert', record: { id: 'a' } })
  const before = core.getView()
  assert.throws(() => core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'reorder', order: ['unknown'] }), /unknown|exactly/)
  assert.deepEqual(core.getView().state, before.state)
  core.transactState({ roomId: 'room', moduleId: 'ext', patches: [{ op: 'set', path: '/modules/ext/items', value: [{ id: 'dup' }, { id: 'dup' }] }] })
  assert.throws(() => core.operateRecord({ collectionId: 'items', operation: 'list' }), /duplicate ids/)
})

test('record persistence rejects non-JSON-safe values without changing revision or state', () => {
  const core = coreWithModule()
  core.registerRecordCollection({ id: 'items', moduleId: 'ext', path: '/items' })
  const before = core.getView()
  assert.throws(() => core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'create-or-upsert', record: { id: 'bad', value: new Map() } }), /Record.*JSON-safe/)
  assert.equal(core.getView().revision, before.revision)
  assert.deepEqual(core.getView().state, before.state)
})

test('record mutations require an explicit room when no runtime room exists', () => {
  const core = coreWithModule()
  core.registerRecordCollection({ id: 'items', moduleId: 'ext', path: '/items' })
  assert.throws(() => core.operateRecord({ collectionId: 'items', operation: 'create-or-upsert', record: { id: 'a' } }), /roomId/)
})

test('proposals can be edited, approved or rejected, and failed approval is atomic', () => {
  const core = coreWithModule()
  const type = core.registerProposalType({
    id: 'change', moduleId: 'ext', path: '/proposals', validate: input => typeof (input as any)?.value === 'number' ? undefined : ['value required'],
    apply: input => [{ op: 'set', path: '/modules/ext/value', value: (input as any).value }],
  })
  const created = core.operateProposal({ roomId: 'room', operation: 'create', id: 'p1', typeId: 'change', input: { value: 1 } }) as any
  core.operateProposal({ roomId: 'room', operation: 'edit', id: 'p1', input: { value: 2 } })
  const approved = core.operateProposal({ roomId: 'room', operation: 'approve', id: 'p1' }) as any
  assert.equal(approved.status, 'approved')
  assert.equal((core.getView().state.modules as any).ext.value, 2)
  const rejected = core.operateProposal({ roomId: 'room', operation: 'create', id: 'p2', typeId: 'change', input: { value: 3 } }) as any
  assert.equal((core.operateProposal({ roomId: 'room', operation: 'reject', id: rejected.id }) as any).status, 'rejected')
  core.operateProposal({ roomId: 'room', operation: 'create', id: 'p3', typeId: 'change', input: { value: 4 } })
  const otherType = core.registerProposalType({ id: 'other-change', moduleId: 'ext', path: '/proposals', validate: () => undefined, apply: () => [{ op: 'set', path: '/modules/ext/other', value: true }] })
  core.operateProposal({ roomId: 'room', operation: 'create', id: 'p4', typeId: 'other-change', input: { value: 5 } })
  assert.throws(() => core.operateProposal({ roomId: 'room', operation: 'create', id: 'p4', typeId: 'change', input: { value: 6 } }), /already exists/)
  assert.equal((core.operateProposal({ operation: 'list', typeId: 'change' }) as any[]).some(item => item.id === 'p4'), false)
  assert.equal((core.operateProposal({ operation: 'list', typeId: 'other-change' }) as any[]).some(item => item.id === 'p4'), true)
  otherType.dispose()
  assert.equal((core.operateProposal({ operation: 'get', id: created.id }) as any).input.value, 2)
  type.dispose()
  assert.throws(() => core.operateProposal({ roomId: 'room', operation: 'approve', id: 'p3' }), /not registered|does not exist/)
  assert.equal((core.getView().state.modules as any).ext.proposals.find((item: any) => item.id === 'p3').status, 'pending')
  const typeAgain = core.registerProposalType({ id: 'change', moduleId: 'ext', path: '/proposals', validate: input => typeof (input as any)?.value === 'number' ? undefined : ['value required'], apply: input => [{ op: 'set', path: '/modules/ext/value', value: (input as any).value }] })
  assert.equal((core.operateProposal({ operation: 'get', id: 'p3' }) as any).status, 'pending')
  typeAgain.dispose()
})

test('proposal input and apply output reject non-JSON-safe values atomically', () => {
  const core = coreWithModule()
  const badApply = core.registerProposalType({ id: 'bad-apply', moduleId: 'ext', path: '/proposals', validate: () => undefined, apply: () => [{ op: 'set', path: '/modules/ext/value', value: new Date() }] })
  assert.throws(() => core.operateProposal({ roomId: 'room', operation: 'create', id: 'bad-input', typeId: 'bad-apply', input: new Map() }), /Proposal input.*JSON-safe/)
  core.operateProposal({ roomId: 'room', operation: 'create', id: 'bad-apply-proposal', typeId: 'bad-apply', input: {} })
  const before = core.getView()
  assert.throws(() => core.operateProposal({ roomId: 'room', operation: 'approve', id: 'bad-apply-proposal' }), /Proposal transaction.*JSON-safe/)
  assert.equal(core.getView().revision, before.revision)
  assert.equal((core.operateProposal({ operation: 'get', id: 'bad-apply-proposal' }) as any).status, 'pending')
  badApply.dispose()
})

test('record and proposal snapshot data restore through SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-extensions-sqlite-'))
  const path = join(dir, 'state.sqlite')
  const store = new Store(path)
  const core = coreWithModule()
  core.attachStateRepository(new StoreCoreStateRepository(store))
  core.registerRecordCollection({ id: 'items', moduleId: 'ext', path: '/items' })
  const type = core.registerProposalType({ id: 'change', moduleId: 'ext', path: '/proposals', validate: () => undefined, apply: () => [{ op: 'set', path: '/modules/ext/value', value: true }] })
  core.operateRecord({ roomId: 'room', collectionId: 'items', operation: 'create-or-upsert', record: { id: 'saved' } })
  core.operateProposal({ roomId: 'room', operation: 'create', id: 'pending', typeId: 'change', input: {} })
  core.operateProposal({ roomId: 'room', operation: 'create', id: 'rejected', typeId: 'change', input: {} })
  core.operateProposal({ roomId: 'room', operation: 'reject', id: 'rejected' })
  core.operateProposal({ roomId: 'room', operation: 'edit', id: 'pending', input: { edited: true } })
  const revision = core.getView().revision
  store.close()
  const restoredStore = new Store(path)
  const restored = coreWithModule()
  restored.attachStateRepository(new StoreCoreStateRepository(restoredStore))
  restored.registerRecordCollection({ id: 'items', moduleId: 'ext', path: '/items' })
  restored.registerProposalType({ id: 'change', moduleId: 'ext', path: '/proposals', validate: () => undefined, apply: () => [] })
  assert.equal(restored.restoreState('room'), true)
  assert.equal(restored.getView().revision, revision)
  assert.equal((restored.operateRecord({ collectionId: 'items', operation: 'list' }).records[0] as any).id, 'saved')
  assert.equal((restored.operateProposal({ operation: 'get', id: 'pending' }) as any).input.edited, true)
  assert.equal((restored.operateProposal({ operation: 'get', id: 'rejected' }) as any).status, 'rejected')
  restoredStore.close(); rmSync(dir, { recursive: true, force: true }); type.dispose()
})

test('proposal approval guards its original id and rejects destructive apply atomically', () => {
  const core = coreWithModule()
  const type = core.registerProposalType({ id: 'destructive', moduleId: 'ext', path: '/proposals', validate: () => undefined, apply: () => [{ op: 'remove', path: '/modules/ext/proposals/0' }] })
  core.operateProposal({ roomId: 'room', operation: 'create', id: 'p', typeId: 'destructive', input: {} })
  assert.throws(() => core.operateProposal({ roomId: 'room', operation: 'approve', id: 'p' }), /test failed|does not exist|out of bounds/)
  assert.equal((core.getView().state.modules as any).ext.proposals[0].status, 'pending')
  type.dispose()
})

test('effect handlers clone input/output, propagate errors, and unload safely', async () => {
  const core = coreWithModule()
  const release = core.registerEffectHandler({ id: 'echo', handle: input => ({ ...(input as any), changed: true }) })
  const input = { value: 1 }
  const output = await core.invokeEffect('echo', input) as any
  assert.deepEqual(input, { value: 1 })
  output.changed = false
  assert.equal((await core.invokeEffect('echo', input) as any).changed, true)
  const failing = core.registerEffectHandler({ id: 'fail', handle: () => { throw new Error('effect failed') } })
  await assert.rejects(core.invokeEffect('fail', {}), /effect failed/)
  release.dispose(); failing.dispose()
  await assert.rejects(core.invokeEffect('echo', {}), /not registered/)
})

test('prompt and view contributors are stable, cloned, and reversible', () => {
  const core = coreWithModule()
  const low = core.registerPromptContributor({ id: 'z', priority: 1, contribute: input => ({ kind: 'z', content: input }) })
  const high = core.registerPromptContributor({ id: 'a', priority: 1, contribute: () => ({ kind: 'a', content: { safe: true } }) })
  const promptInput = { text: 'input' }
  const prompt = core.composePrompt(promptInput)
  assert.deepEqual(prompt.map(item => item.kind), ['a', 'z'])
  ;(prompt[1].content as any).text = 'changed'
  assert.equal((promptInput as any).text, 'input')
  const view = core.registerViewContributor({ id: 'view', contribute: () => ({ kind: 'generic', value: { ok: true } }) })
  assert.equal(core.getView().viewContributions?.[0].kind, 'generic')
  view.dispose(); low.dispose(); high.dispose()
  assert.deepEqual(core.composePrompt({}), [])
  assert.deepEqual(core.composeView({}), [])
})

test('prompt and view contributors reject non-JSON-safe output', () => {
  const core = coreWithModule()
  const fn = core.registerPromptContributor({ id: 'function-output', contribute: () => ({ kind: 'bad', content: undefined }) })
  assert.throws(() => core.composePrompt({}), /JSON-safe/)
  fn.dispose()
  const date = core.registerViewContributor({ id: 'date-output', contribute: () => ({ kind: 'bad', value: new Date() }) })
  assert.throws(() => core.composeView({}), /JSON-safe/)
  date.dispose()
  const cyclic: any = {}; cyclic.self = cyclic
  const cycle = core.registerViewContributor({ id: 'cycle-output', contribute: () => ({ kind: 'bad', value: cyclic }) })
  assert.throws(() => core.composeView({}), /cycles/)
  cycle.dispose()
  const emptyPrompt = core.registerPromptContributor({ id: 'empty-kind-prompt', contribute: () => ({ kind: '', content: true }) })
  assert.throws(() => core.composePrompt({}), /kind.*non-empty/)
  emptyPrompt.dispose()
  const emptyView = core.registerViewContributor({ id: 'empty-kind-view', contribute: () => ({ kind: '', value: true }) })
  assert.throws(() => core.composeView({}), /kind.*non-empty/)
  emptyView.dispose()
})

test('solution extension binding commits atomically and Cordis Fiber unload removes contributors', async () => {
  const core = coreWithModule()
  const binding = core.createSolutionBinding()
  binding.host.registerPromptContributor({ id: 'bound', contribute: () => ({ kind: 'bound', content: true }) })
  const installed = binding.commit()
  assert.equal(core.composePrompt({})[0].kind, 'bound')
  installed.dispose()
  assert.deepEqual(core.composePrompt({}), [])
  const rollback = core.createSolutionBinding()
  rollback.host.registerViewContributor({ id: 'rolled-back', contribute: () => ({ kind: 'x', value: true }) })
  rollback.rollback()
  assert.deepEqual(core.composeView({}), [])

  const container = new DefaultCorePluginContainer(core)
  const service = createStageCraftService(core, 'room', container, repository => core.attachStateRepository(repository))
  const ctx = new Context()
  const serviceFiber = ctx.plugin(stageCraftServicePlugin(service))
  await serviceFiber
  const fiber = ctx.plugin({ name: 'extension.fiber', inject: ['stagecraft'], apply(pluginCtx: Context) {
    const disposable = pluginCtx.stagecraft.extensions.registerViewContributor({ id: 'fiber-view', contribute: () => ({ kind: 'fiber', value: 1 }) })
    const records = pluginCtx.stagecraft.extensions.registerRecordCollection({ id: 'fiber-records', moduleId: 'ext', path: '/fiber-records' })
    pluginCtx.effect(() => () => { disposable.dispose(); records.dispose() })
  } })
  await fiber
  assert.equal(core.composeView({})[0].kind, 'fiber')
  service.extensions.operateRecord({ collectionId: 'fiber-records', operation: 'create-or-upsert', record: { id: 'from-room-wrapper' } })
  await fiber.dispose()
  assert.deepEqual(core.composeView({}), [])
  assert.equal((core.getView().state.modules as any).ext['fiber-records'][0].id, 'from-room-wrapper')
  assert.throws(() => service.extensions.operateRecord({ collectionId: 'fiber-records', operation: 'list' }), /not registered/)
  await serviceFiber.dispose(); await container.dispose()
})

test('solution extension commit conflict installs none of its staged extensions', () => {
  const core = coreWithModule()
  const binding = core.createSolutionBinding()
  binding.host.registerPromptContributor({ id: 'staged-a', contribute: () => ({ kind: 'a', content: true }) })
  binding.host.registerViewContributor({ id: 'staged-b', contribute: () => ({ kind: 'b', value: true }) })
  const external = core.registerPromptContributor({ id: 'staged-a', contribute: () => ({ kind: 'external', content: true }) })
  assert.throws(() => binding.commit(), /already registered/)
  assert.deepEqual(core.composeView({}), [])
  assert.deepEqual(core.composePrompt({}).map(item => item.kind), ['external'])
  external.dispose(); binding.rollback()
  const retry = core.registerPromptContributor({ id: 'staged-a', contribute: () => ({ kind: 'retry', content: true }) })
  retry.dispose()
})
