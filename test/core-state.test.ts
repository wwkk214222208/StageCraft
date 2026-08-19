import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { StageCraftSolutionPlugin } from '../src/core/solutions.ts'
import { Store } from '../src/store.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import { StoreCoreStateRepository } from '../src/core/store-state-repository.ts'
import { startTavern } from '../src/app-boot.ts'
import type { CoreSolutionPlugin } from '../src/core/plugins.ts'
import type { StateEvent, WorkflowInstance } from '../src/core/protocol.ts'
import { domainEvent } from '../src/core/domain-events.ts'

const storiesRoot = fileURLToPath(new URL('../stories', import.meta.url))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-core-state-'))
  const store = new Store(join(root, 'state.sqlite'))
  const roomId = store.seed(loadStoryPackage(storiesRoot, 'eldoria'))
  return { root, store, room: store.getRoom(roomId) }
}

function statePlugin(id: string, categoryId: string, providerId: string, initial: unknown, reducer?: (current: unknown, event: StateEvent) => unknown): CoreSolutionPlugin {
  return {
    id,
    install(host) {
      host.registerStateCategory({ id: categoryId, label: categoryId, reducer })
      host.registerStateProjection({ id: providerId, project: () => ({ [categoryId]: initial }) })
      return { dispose: () => {} }
    },
  }
}

function event(id: string, payload: unknown): StateEvent {
  return { id, type: 'test.event', source: 'plugin', payload, createdAt: new Date().toISOString() }
}

test('empty Core has no state categories; StageCraft installs its state projection', () => {
  const fixtureValue = fixture()
  try {
    const empty = new CoreRuntimeSkeleton()
    empty.projectRoom(fixtureValue.room)
    assert.deepEqual(empty.getView().state, {})

    const core = new CoreRuntimeSkeleton()
    const container = new DefaultCorePluginContainer(core)
    container.addSolution(new StageCraftSolutionPlugin())
    core.projectRoom(fixtureValue.room)
    const state = core.getView().state as Record<string, unknown>
    assert.equal((state.room as { id: string }).id, fixtureValue.room.id)
    assert.equal((state.world as { time?: string }).time, fixtureValue.room.sceneTime)
    void container.dispose()
  } finally {
    fixtureValue.store.close()
    rmSync(fixtureValue.root, { recursive: true, force: true })
  }
})

test('state categories and projections are owner-isolated, disabled categories stay hidden, and reducers are atomic', async () => {
  const fixtureValue = fixture()
  try {
    const core = new CoreRuntimeSkeleton()
    const container = new DefaultCorePluginContainer(core)
    const first = container.addSolution(statePlugin('state-a', 'counter', 'state-a.projection', { value: 0 }, (current, received) => ({ value: Number((current as { value?: number } | undefined)?.value ?? 0) + Number((received.payload as { amount?: number }).amount ?? 0) })))
    container.addSolution(statePlugin('state-b', 'other', 'state-b.projection', 'kept'))
    container.addSolution({ id: 'disabled', install(host) { host.registerStateCategory({ id: 'disabled.category', label: 'disabled', enabled: false }); host.registerStateProjection({ id: 'disabled.projection', project: () => ({ 'disabled.category': 'hidden' }) }); return { dispose: () => {} } } })
    core.projectRoom(fixtureValue.room)
    assert.deepEqual(core.getView().state, { counter: { value: 0 }, other: 'kept' })

    core.applyStateEvents([event('one', { amount: 2 }), event('two', { amount: 3 })])
    assert.deepEqual((core.getView().state as { counter: { value: number } }).counter, { value: 5 })
    assert.throws(() => container.addSolution(statePlugin('conflicting-state', 'counter', 'conflicting.projection', 1)), /State category already registered/)
    const brokenInstall: CoreSolutionPlugin = { id: 'broken-state', install(host) { host.registerStateCategory({ id: 'broken.category', label: 'broken' }); throw new Error('state install failed') } }
    assert.throws(() => container.addSolution(brokenInstall), /state install failed/)
    core.projectRoom(fixtureValue.room)
    assert.equal((core.getView().state as Record<string, unknown>)['broken.category'], undefined)
    const beforeFailure = core.getView().state
    const failing = statePlugin('failing', 'failing.category', 'failing.projection', 0, () => { throw new Error('reducer failed') })
    container.addSolution(failing)
    assert.throws(() => core.applyStateEvents([event('three', { amount: 1 })]), /reducer failed/)
    assert.deepEqual(core.getView().state, beforeFailure)

    await first.dispose()
    core.projectRoom(fixtureValue.room)
    assert.equal((core.getView().state as Record<string, unknown>).counter, undefined)
    assert.equal((core.getView().state as Record<string, unknown>).other, 'kept')
    await container.dispose()
  } finally {
    fixtureValue.store.close()
    rmSync(fixtureValue.root, { recursive: true, force: true })
  }
})

test('SQLite Core repository round-trips and rolls back state/event/workflow together', () => {
  const fixtureValue = fixture()
  try {
    const repository = new StoreCoreStateRepository(fixtureValue.store)
    const core = new CoreRuntimeSkeleton()
    const container = new DefaultCorePluginContainer(core)
    container.addSolution(new StageCraftSolutionPlugin())
    core.attachStateRepository(repository)
    core.projectRoom(fixtureValue.room)
    const saved = repository.restore(fixtureValue.room.id)!
    assert.equal(saved.revision, fixtureValue.room.revision)
    assert.equal(saved.events.length, 1)
    assert.equal(saved.workflows.length, core.getView().workflows.length)

    const badWorkflow = { ...saved.workflows[0], locals: { invalid: BigInt(1) } } as unknown as WorkflowInstance
    assert.throws(() => fixtureValue.store.saveCoreStateTransaction({ roomId: fixtureValue.room.id, revision: saved.revision + 1, state: { broken: true }, events: [event('failed-transaction', {})], workflows: [badWorkflow] }))
    const afterFailure = repository.restore(fixtureValue.room.id)!
    assert.equal(afterFailure.revision, saved.revision)
    assert.equal(afterFailure.events.length, saved.events.length)
    assert.deepEqual(afterFailure.workflows, saved.workflows)
    fixtureValue.store.saveWorkflowInstance(fixtureValue.room.id, { ...saved.workflows[0], id: 'workflow:unknown', definitionId: 'missing.solution.workflow' })
    fixtureValue.store.saveWorkflowInstance(fixtureValue.room.id, { ...saved.workflows[0], id: 'workflow:wrong-version', definitionVersion: '0.0.0' })
    fixtureValue.store.saveWorkflowInstance(fixtureValue.room.id, { ...saved.workflows[0], id: 'workflow:wrong-step', step: 'missing-step' })
    const restored = new CoreRuntimeSkeleton()
    const restoredContainer = new DefaultCorePluginContainer(restored)
    restoredContainer.addSolution(new StageCraftSolutionPlugin())
    restored.attachStateRepository(repository)
    assert.equal(restored.restoreState(fixtureValue.room.id), true)
    assert.equal(restored.getView().workflows.some(item => item.definitionId === 'missing.solution.workflow'), false)
    assert.equal(restored.getView().workflows.some(item => item.id === 'workflow:wrong-version'), false)
    assert.equal(restored.getView().workflows.some(item => item.id === 'workflow:wrong-step'), false)
    restored.attachWorkflowStore({ save: (id, instance) => fixtureValue.store.saveWorkflowInstance(id, instance), list: id => fixtureValue.store.listWorkflowInstances(id) })
    restored.restoreWorkflowInstances(fixtureValue.room.id)
    assert.equal(restored.getView().workflows.some(item => item.id === 'workflow:wrong-version'), false)
    assert.equal(restored.getView().workflows.some(item => item.id === 'workflow:wrong-step'), false)
    void restoredContainer.dispose()
    void container.dispose()
  } finally {
    fixtureValue.store.close()
    rmSync(fixtureValue.root, { recursive: true, force: true })
  }
})

test('applyStateEvents commits reducer state and recent events atomically through SQLite', () => {
  const fixtureValue = fixture()
  try {
    const repository = new StoreCoreStateRepository(fixtureValue.store)
    const core = new CoreRuntimeSkeleton()
    const container = new DefaultCorePluginContainer(core)
    container.addSolution(statePlugin('counter-state', 'counter', 'counter.projection', { value: 0 }, (current, received) => ({ value: Number((current as { value?: number } | undefined)?.value ?? 0) + Number((received.payload as { amount?: number }).amount ?? 0) })))
    core.attachStateRepository(repository)
    const emitted: Array<{ type?: string; transition?: { events?: StateEvent[] } }> = []
    core.subscribe(value => emitted.push(value as typeof emitted[number]))
    core.projectRoom(fixtureValue.room)
    const batch = [event('state-one', { roomId: fixtureValue.room.id, amount: 2 }), event('state-two', { roomId: fixtureValue.room.id, amount: 3 })]
    core.applyStateEvents(batch)
    assert.deepEqual((core.getView().state as { counter: { value: number } }).counter, { value: 5 })
    assert.deepEqual(emitted.at(-1)?.transition?.events?.map(item => item.id), ['state-one', 'state-two'])
    assert.deepEqual(core.getView().recentEvents.map(item => item.id), [`state-snapshot-${fixtureValue.room.id}-${fixtureValue.room.revision}`, 'state-one', 'state-two'])
    const restored = new CoreRuntimeSkeleton()
    const restoredContainer = new DefaultCorePluginContainer(restored)
    restoredContainer.addSolution(statePlugin('counter-state', 'counter', 'counter.projection', { value: 0 }, (current, received) => ({ value: Number((current as { value?: number } | undefined)?.value ?? 0) + Number((received.payload as { amount?: number }).amount ?? 0) })))
    restored.attachStateRepository(repository)
    assert.equal(restored.restoreState(fixtureValue.room.id), true)
    assert.deepEqual((restored.getView().state as { counter: { value: number } }).counter, { value: 5 })
    assert.deepEqual(repository.restore(fixtureValue.room.id)!.events.map(item => item.id).slice(-2), ['state-one', 'state-two'])

    const before = core.getView()
    const emittedCount = emitted.length
    core.attachStateRepository({ commit: () => { throw new Error('state repository unavailable') }, restore: () => undefined })
    assert.throws(() => core.applyStateEvents([event('state-failed', { roomId: fixtureValue.room.id, amount: 1 })]), /state repository unavailable/)
    assert.deepEqual(core.getView(), before)
    assert.equal(emitted.length, emittedCount)
    void restoredContainer.dispose()
    void container.dispose()
  } finally {
    fixtureValue.store.close()
    rmSync(fixtureValue.root, { recursive: true, force: true })
  }
})

test('Store.listCoreEvents returns the most recent events in chronological order', () => {
  const fixtureValue = fixture()
  try {
    for (let index = 1; index <= 5; index += 1) fixtureValue.store.appendCoreEvent(fixtureValue.room.id, index, event(`ordered-${index}`, { index }))
    assert.deepEqual(fixtureValue.store.listCoreEvents(fixtureValue.room.id, 2).map(item => item.id), ['ordered-4', 'ordered-5'])
  } finally {
    fixtureValue.store.close()
    rmSync(fixtureValue.root, { recursive: true, force: true })
  }
})

test('Core state-event commits persist reducer results and prune stale workflows atomically', () => {
  const fixtureValue = fixture()
  try {
    const repository = new StoreCoreStateRepository(fixtureValue.store)
    const core = new CoreRuntimeSkeleton()
    const container = new DefaultCorePluginContainer(core)
    container.addSolution(new StageCraftSolutionPlugin())
    core.attachStateRepository(repository)
    core.projectRoom(fixtureValue.room)
    const first = repository.restore(fixtureValue.room.id)!
    const extra = { ...first.workflows[0], id: 'workflow:extra' }
    fixtureValue.store.saveCoreStateTransaction({ roomId: fixtureValue.room.id, revision: first.revision + 1, state: first.state, events: [event('extra-snapshot', {})], workflows: [...first.workflows, extra] })
    assert.equal(repository.restore(fixtureValue.room.id)!.workflows.length, first.workflows.length + 1)
    fixtureValue.store.saveCoreStateTransaction({ roomId: fixtureValue.room.id, revision: first.revision + 2, state: first.state, events: [event('pruned-snapshot', {})], workflows: [first.workflows[0]] })
    const pruned = repository.restore(fixtureValue.room.id)!
    assert.equal(pruned.workflows.length, 1)
    assert.equal(pruned.workflows[0].id, first.workflows[0].id)
    void container.dispose()
  } finally {
    fixtureValue.store.close()
    rmSync(fixtureValue.root, { recursive: true, force: true })
  }
})

test('emitDomainEvent uses the unified repository and keeps memory unchanged on failure', () => {
  const fixtureValue = fixture()
  try {
    const repository = new StoreCoreStateRepository(fixtureValue.store)
    const core = new CoreRuntimeSkeleton()
    const container = new DefaultCorePluginContainer(core)
    container.addSolution(new StageCraftSolutionPlugin())
    core.attachStateRepository(repository)
    core.projectRoom(fixtureValue.room)
    const before = core.getView()
    const received: unknown[] = []
    core.subscribe(value => received.push(value))
    core.emitDomainEvent(domainEvent('player.contribution.submitted', { roomId: fixtureValue.room.id, text: '事件' }))
    const saved = repository.restore(fixtureValue.room.id)!
    assert.equal(saved.events.some(item => item.type === 'player.contribution.submitted'), true)
    assert.equal(saved.workflows[0].step, 'collecting-decisions')
    assert.equal(received.some(value => (value as { type?: string }).type === 'state.changed'), true)

    const afterCommit = core.getView()
    core.attachStateRepository({ commit: () => { throw new Error('domain repository unavailable') }, restore: () => undefined })
    const eventCount = received.length
    assert.throws(() => core.emitDomainEvent(domainEvent('role.decision.completed', { roomId: fixtureValue.room.id, turnId: 'turn' })), /domain repository unavailable/)
    assert.deepEqual(core.getView(), afterCommit)
    assert.equal(received.length, eventCount)
    void container.dispose()
  } finally {
    fixtureValue.store.close()
    rmSync(fixtureValue.root, { recursive: true, force: true })
  }
})

test('projecting the same restored snapshot does not duplicate recent events', () => {
  const fixtureValue = fixture()
  try {
    const core = new CoreRuntimeSkeleton()
    const container = new DefaultCorePluginContainer(core)
    container.addSolution(new StageCraftSolutionPlugin())
    core.attachStateRepository(new StoreCoreStateRepository(fixtureValue.store))
    core.projectRoom(fixtureValue.room)
    core.projectRoom(fixtureValue.room, 'app-boot:restore')
    assert.equal(core.getView().recentEvents.length, 1)
    void container.dispose()
  } finally {
    fixtureValue.store.close()
    rmSync(fixtureValue.root, { recursive: true, force: true })
  }
})

test('repository failure leaves Core memory and event stream unchanged', () => {
  const fixtureValue = fixture()
  try {
    const core = new CoreRuntimeSkeleton()
    const container = new DefaultCorePluginContainer(core)
    container.addSolution(new StageCraftSolutionPlugin())
    core.attachStateRepository({ commit: () => { throw new Error('repository unavailable') }, restore: () => undefined })
    const before = core.getView()
    const emitted: unknown[] = []
    core.subscribe(eventValue => emitted.push(eventValue))
    assert.throws(() => core.projectRoom(fixtureValue.room), /repository unavailable/)
    assert.deepEqual(core.getView(), before)
    assert.deepEqual(emitted, [])
    void container.dispose()
  } finally {
    fixtureValue.store.close()
    rmSync(fixtureValue.root, { recursive: true, force: true })
  }
})

test('app boot uses the unified Core state repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-app-state-'))
  let app: ReturnType<typeof startTavern> | undefined
  try {
    app = startTavern({ root, storiesRoot, publicRoot: fileURLToPath(new URL('../public', import.meta.url)), dataDir: join(root, 'data'), saveRoot: join(root, 'save'), port: 0 })
    assert.ok(app.store.loadCoreState(app.roomId))
  } finally {
    await app?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
