import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { applyStatePatches, type StateTransactionRequest } from '../src/core/state-transaction.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { Store } from '../src/store.ts'
import { StoreCoreStateRepository } from '../src/core/store-state-repository.ts'

const moduleManifest = { id: 'demo', version: '1.0.0' }
const request = (patches: StateTransactionRequest['patches']): StateTransactionRequest => ({
  roomId: 'room', moduleId: 'demo', patches, baseRevision: undefined,
})

test('state patch executor supports JSON Pointer operations atomically', () => {
  const initial = { modules: { demo: { n: 2, obj: { a: 1 }, list: ['a', 'b'] } } }
  const result = applyStatePatches(initial, [
    { op: 'set', path: '/modules/demo/new/deep', value: true },
    { op: 'replace', path: '/modules/demo/obj/a', value: 3 },
    { op: 'delta', path: '/modules/demo/n', value: 4 },
    { op: 'insert', path: '/modules/demo/list/1', value: 'x' },
    { op: 'move', from: '/modules/demo/list/0', path: '/modules/demo/list/2' },
    { op: 'merge', path: '/modules/demo/obj', value: { b: 2 } },
    { op: 'test', path: '/modules/demo/n', value: 6 },
    { op: 'remove', path: '/modules/demo/list/0' },
  ])
  assert.deepEqual(result.after, { modules: { demo: { n: 6, obj: { a: 3, b: 2 }, list: ['b', 'a'], new: { deep: true } } } })
  assert.notEqual(result.after, initial)
  assert.ok(result.changes.some(change => change.path === '/modules/demo/n'))
  const source = { nested: { value: 1 } }
  assert.throws(() => applyStatePatches(source, [{ op: 'set', path: '/nested/value', value: 2 }, { op: 'test', path: '/missing', value: 1 }]))
  assert.deepEqual(source, { nested: { value: 1 } })
})

test('patch executor handles escaped keys and object/array moves, and rejects unsafe paths', () => {
  const result = applyStatePatches({ a: { 'x/y~z': 1 }, b: {}, list: [1, 2] }, [
    { op: 'move', from: '/a/x~1y~0z', path: '/b/value' },
    { op: 'move', from: '/list/0', path: '/b/number' },
    { op: 'move', from: '/b/number', path: '/list/1' },
  ])
  assert.deepEqual(result.after, { a: {}, b: { value: 1 }, list: [2, 1] })
  assert.throws(() => applyStatePatches({}, [{ op: 'set', path: '/__proto__/polluted', value: true }]), /Forbidden/)
  assert.throws(() => applyStatePatches({}, [{ op: 'set', path: '/prototype/x', value: true }]), /Forbidden/)
  assert.throws(() => applyStatePatches({}, [{ op: 'set', path: '/bad~2escape', value: true }]), /escape/)
  assert.throws(() => applyStatePatches({ list: [1] }, [{ op: 'set', path: '/list/01', value: 2 }]), /array index/)
  assert.throws(() => applyStatePatches({ list: [1] }, [{ op: 'set', path: '/list/2', value: 2 }]), /bounds/)
  assert.throws(() => applyStatePatches({ n: 1 }, [{ op: 'delta', path: '/n', value: Infinity }]), /finite/)
  assert.throws(() => applyStatePatches({ a: 1 }, [{ op: 'replace', path: '/missing', value: 2 }]), /does not exist/)
  assert.throws(() => applyStatePatches({ a: 1 }, [{ op: 'insert', path: '', value: 2 }]), /root/i)
  assert.equal(applyStatePatches({ a: 1 }, [{ op: 'remove', path: '' }]).after, undefined)
  assert.throws(() => applyStatePatches({ a: 1 }, [{ op: 'move', from: '', path: '/a' }]), /root/)
})

test('state transactions enforce owner namespace, schema and atomic repository commit', () => {
  const core = new CoreRuntimeSkeleton()
  core.registerStateModule(moduleManifest)
  let commits = 0
  core.attachStateRepository({
    commit() { commits++; throw new Error('disk unavailable') },
    restore() { return undefined },
  })
  const before = core.getView()
  assert.throws(() => core.transactState(request([{ op: 'set', path: '/other/x', value: 1 }])), /outside/)
  assert.throws(() => core.transactState({ ...request([{ op: 'set', path: '/modules/demo/x', value: 1 }]), assertions: [{ op: 'test', path: '/modules/demo/x', value: 2 }] }), /State test failed/)
  assert.equal(commits, 0)
  assert.throws(() => core.transactState(request([{ op: 'set', path: '/modules/demo/x', value: 1 }])), /disk unavailable/)
  assert.equal(commits, 1)
  assert.deepEqual(core.getView(), before)
})

test('state transaction runs ordered reducers, cascades events, and prevents cycles', () => {
  const core = new CoreRuntimeSkeleton()
  core.registerStateModule(moduleManifest)
  core.registerStateReducer({
    id: 'z-first', moduleId: 'demo', priority: 1, listensTo: ['start'],
    reduce: () => ({ patches: [{ op: 'set', path: '/modules/demo/value', value: 1 }, { op: 'set', path: '/modules/demo/multi', value: true }], events: [{ id: 'next', type: 'next' }] }),
  })
  core.registerStateReducer({
    id: 'a-order', moduleId: 'demo', priority: 1, listensTo: ['start'],
    reduce: () => ({ patches: [{ op: 'set', path: '/modules/demo/order', value: 'stable' }] }),
  })
  core.registerStateReducer({
    id: 'a-second', moduleId: 'demo', priority: 2, listensTo: ['next'],
    reduce: state => ({ patches: [{ op: 'delta', path: '/modules/demo/value', value: 1 }], events: [{ id: 'cycle', type: 'cycle' }] }),
  })
  core.registerStateReducer({
    id: 'events-only', moduleId: 'demo', priority: 3, listensTo: ['start'],
    reduce: () => ({ events: [{ id: 'events-only-next', type: 'noop' }] }),
  })
  const result = core.transactState({ roomId: 'room', moduleId: 'demo', events: [{ id: 'start', type: 'start' }] })
  assert.equal(result.after.modules && (result.after.modules as any).demo.value, 2)
  assert.deepEqual(result.trace.reducers, ['a-order', 'z-first', 'events-only', 'a-second'])
  assert.equal(result.trace.reducers.filter(id => id === 'events-only').length, 1)
  const cycle = new CoreRuntimeSkeleton()
  cycle.registerStateModule(moduleManifest)
  cycle.registerStateReducer({ id: 'cycle', moduleId: 'demo', listensTo: ['loop'], reduce: () => ({ events: [{ id: 'loop', type: 'loop' }] }) })
  assert.throws(() => cycle.transactState({ roomId: 'room', moduleId: 'demo', events: [{ id: 'start', type: 'loop' }] }), /Duplicate state transaction event id/)
})

test('state transaction validates module schema, revision and safe reducer namespace', () => {
  const core = new CoreRuntimeSkeleton()
  core.registerStateModule(moduleManifest)
  core.registerStateSchema({ id: 'demo.schema', moduleId: 'demo', validate: state => (state as any)?.ok === true ? undefined : ['ok is required'] })
  assert.throws(() => core.transactState({ ...request([{ op: 'set', path: '/modules/demo/value', value: 1 }]), assertions: [{ op: 'test', path: '/modules/demo/value', value: 2 }] }), /State test failed/)
  assert.throws(() => core.transactState(request([{ op: 'set', path: '/modules/demo/ok', value: false }])), /schema/)
  const success = core.transactState(request([{ op: 'set', path: '/modules/demo/ok', value: true }]))
  assert.equal(success.revision, 1)
  assert.throws(() => core.transactState({ ...request([{ op: 'set', path: '/modules/demo/x', value: 1 }]), baseRevision: 0 }), /conflict/)
  const leaked = success.after as any
  leaked.modules.demo.ok = false
  assert.equal((core.getView().state.modules as any).demo.ok, true)
  const bad = new CoreRuntimeSkeleton()
  bad.registerStateModule(moduleManifest)
  bad.registerStateReducer({ id: 'bad', moduleId: 'demo', listensTo: ['go'], reduce: () => ({ patches: [{ op: 'set', path: '/modules/other/x', value: 1 }] }) })
  assert.throws(() => bad.transactState({ roomId: 'room', moduleId: 'demo', events: [{ id: 'go', type: 'go' }] }), /outside/)
})

test('direct state registration disposers are owner-safe', () => {
  const core = new CoreRuntimeSkeleton()
  const first = core.registerStateModule(moduleManifest)
  first.dispose()
  const second = core.registerStateModule(moduleManifest)
  first.dispose()
  assert.doesNotThrow(() => core.transactState(request([{ op: 'set', path: '/modules/demo/value', value: 1 }])))
  second.dispose()
  assert.throws(() => core.transactState(request([{ op: 'set', path: '/modules/demo/value', value: 2 }])), /not registered/)
})

test('module ids with slashes remain isolated and schema/reducer disposers are owner-safe', () => {
  const core = new CoreRuntimeSkeleton()
  const moduleId = 'foo/bar'
  const module = core.registerStateModule({ id: moduleId, version: '1' })
  const schema1 = core.registerStateSchema({ id: 'schema', moduleId, validate: () => undefined })
  const reducer1 = core.registerStateReducer({ id: 'reducer', moduleId, listensTo: ['go'], reduce: () => ({ patches: [{ op: 'set', path: '/modules/foo~1bar/value', value: 1 }] }) })
  schema1.dispose()
  reducer1.dispose()
  const schema2 = core.registerStateSchema({ id: 'schema', moduleId, validate: () => undefined })
  const reducer2 = core.registerStateReducer({ id: 'reducer', moduleId, listensTo: ['go'], reduce: () => ({ patches: [{ op: 'set', path: '/modules/foo~1bar/value', value: 2 }] }) })
  schema1.dispose()
  reducer1.dispose()
  const result = core.transactState({ roomId: 'room', moduleId, events: [{ id: 'go', type: 'go' }] })
  assert.equal((result.after.modules as any)['foo/bar'].value, 2)
  schema2.dispose(); reducer2.dispose(); module.dispose()
})

test('system transactions can change registered categories but not arbitrary roots', () => {
  const core = new CoreRuntimeSkeleton()
  const binding = core.createSolutionBinding()
  binding.host.registerStateCategory({ id: 'system.category', label: 'System' })
  const installed = binding.commit()
  assert.doesNotThrow(() => core.transactState({ roomId: 'room', system: true, patches: [{ op: 'set', path: '/system.category/value', value: 1 }] }))
  assert.throws(() => core.transactState({ roomId: 'room', system: true, patches: [{ op: 'set', path: '/arbitrary/value', value: 1 }] }), /unregistered state category/)
  installed.dispose()
})

test('nested state transactions from reducer callbacks are rejected and leave outer work atomic', () => {
  const core = new CoreRuntimeSkeleton()
  core.registerStateModule(moduleManifest)
  core.registerStateReducer({
    id: 'reentrant', moduleId: 'demo', listensTo: ['go'],
    reduce: () => {
      assert.throws(() => core.transactState(request([{ op: 'set', path: '/modules/demo/nested', value: true }])), /Nested/)
      return { patches: [{ op: 'set', path: '/modules/demo/value', value: true }] }
    },
  })
  const result = core.transactState({ roomId: 'room', moduleId: 'demo', events: [{ id: 'go', type: 'go', payload: { mutable: true } }] })
  assert.equal((result.after.modules as any).demo.value, true)
})

test('distinct cascading event ids are bounded by depth without a repository commit', () => {
  const core = new CoreRuntimeSkeleton()
  core.registerStateModule(moduleManifest)
  let commits = 0
  core.attachStateRepository({ commit() { commits++ }, restore() { return undefined } })
  let counter = 0
  core.registerStateReducer({ id: 'infinite', moduleId: 'demo', listensTo: ['loop'], reduce: () => ({ events: [{ id: `loop-${counter++}`, type: 'loop' }] }) })
  assert.throws(() => core.transactState({ roomId: 'room', moduleId: 'demo', events: [{ id: 'root', type: 'loop' }] }), /cascade depth/)
  assert.equal(commits, 0)
  assert.equal(core.getView().revision, 0)
})

test('SQLite repository round-trips the latest generic module snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-transaction-sqlite-'))
  const path = join(dir, 'state.sqlite')
  const firstStore = new Store(path)
  const first = new CoreRuntimeSkeleton()
  first.registerStateModule(moduleManifest)
  first.attachStateRepository(new StoreCoreStateRepository(firstStore))
  first.transactState(request([{ op: 'set', path: '/modules/demo/value', value: 'persisted' }]))
  first.projectRoom({ id: 'room', title: 'Room', mode: 'director', autoPublish: false, phase: 'idle', revision: 0, playerCharacter: { id: 'player', name: 'Player' }, consultations: [], roles: [], reactions: [], decisions: [], scenes: [], lore: [] } as any, 'test.project', { persist: true })
  firstStore.close()
  const secondStore = new Store(path)
  const second = new CoreRuntimeSkeleton()
  second.registerStateModule(moduleManifest)
  second.attachStateRepository(new StoreCoreStateRepository(secondStore))
  assert.equal(second.restoreState('room'), true)
  assert.equal((second.getView().state.modules as any).demo.value, 'persisted')
  assert.equal(second.getView().revision, 1)
  secondStore.close()
  rmSync(dir, { recursive: true, force: true })
})

test('repository receives defensive snapshots and cannot mutate committed memory', () => {
  const core = new CoreRuntimeSkeleton()
  core.registerStateModule(moduleManifest)
  core.attachStateRepository({
    commit(snapshot) {
      ;(snapshot.state.modules as any).demo.value = 'tampered'
      snapshot.events.length = 0
      snapshot.workflows.length = 0
    },
    restore() { return undefined },
  })
  core.transactState(request([{ op: 'set', path: '/modules/demo/value', value: 'safe' }]))
  assert.equal((core.getView().state.modules as any).demo.value, 'safe')
})

test('room projection preserves generic modules and never lowers the Core revision', () => {
  const core = new CoreRuntimeSkeleton()
  core.registerStateModule(moduleManifest)
  core.transactState(request([{ op: 'set', path: '/modules/demo/value', value: 'kept' }]))
  core.projectRoom({
    id: 'room', title: 'Room', mode: 'director', autoPublish: false, phase: 'idle', revision: 0,
    playerCharacter: { id: 'player', name: 'Player' }, consultations: [], roles: [], reactions: [], decisions: [], scenes: [], lore: [],
  } as any, 'test.project', { persist: false })
  assert.equal((core.getView().state.modules as any).demo.value, 'kept')
  assert.equal(core.getView().revision, 1)
})
