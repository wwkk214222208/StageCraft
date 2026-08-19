import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { StageCraftSolutionPlugin } from '../src/core/solutions.ts'
import type { CoreSolutionPlugin } from '../src/core/plugins.ts'
import type { WorkflowDefinition, WorkflowInstance } from '../src/core/protocol.ts'
import { Store } from '../src/store.ts'
import { loadStoryPackage } from '../src/story-packages.ts'

const storiesRoot = fileURLToPath(new URL('../stories', import.meta.url))

function roomFixture() {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-solutions-'))
  const store = new Store(join(root, 'state.sqlite'))
  const roomId = store.seed(loadStoryPackage(storiesRoot, 'eldoria'))
  return { root, store, room: store.getRoom(roomId) }
}

function definition(id: string): WorkflowDefinition {
  return { id, version: '1.0.0', initialStep: 'start', steps: { start: { id: 'start', actions: [{ type: 'finish' }] } }, transitions: [] }
}

function instance(roomId: string, workflowId: string): WorkflowInstance {
  const now = new Date().toISOString()
  return { id: `workflow:${roomId}:${workflowId}`, definitionId: workflowId, definitionVersion: '1.0.0', step: 'start', status: 'running', locals: { roomId }, pendingInteractionIds: [], pendingModelRequestIds: [], retryCount: 0, createdAt: now, updatedAt: now }
}

function solution(id: string, workflowId: string, interactionId = `interaction:${id}`): CoreSolutionPlugin {
  return {
    id,
    install(host) {
      host.registerWorkflow(definition(workflowId))
      host.registerProjection({
        id: `${id}.projection`,
        project: room => ({ workflows: [instance(room.id, workflowId)], interactions: [{ id: interactionId, kind: 'text', title: id, createdAt: new Date().toISOString() }] }),
        interactionBelongsToWorkflow: (interaction, workflow) => interaction.id === interactionId && workflow.definitionId === workflowId,
      })
      return { dispose: () => {} }
    },
  }
}

test('empty Core is solution-agnostic and StageCraft installation restores the default projection', async () => {
  const fixture = roomFixture()
  try {
    const core = new CoreRuntimeSkeleton()
    core.projectRoom(fixture.room)
    assert.deepEqual(core.getView().workflows, [])
    assert.deepEqual(core.getView().interactions, [])
    assert.deepEqual(core.getView().actions, [])

    const container = new DefaultCorePluginContainer(core)
    const stageCraft = container.addSolution(new StageCraftSolutionPlugin())
    core.projectRoom(fixture.room)
    assert.equal(core.getView().workflows.length, 1)
    assert.equal(core.getView().workflows[0].definitionId, 'stagecraft.director.turn')
    assert.equal(core.getView().interactions.length > 0, true)

    const chatRoom = { ...fixture.room, mode: 'chat' as const, phase: 'awaiting-player-input' as const, speech: undefined }
    core.projectRoom(chatRoom)
    const chatSpeech = core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.speech')!
    const chatDirector = core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.director')!
    assert.equal(chatSpeech.pendingInteractionIds.includes(`interaction:${chatRoom.id}:role-select`), true)
    assert.equal(chatDirector.pendingInteractionIds.includes(`interaction:${chatRoom.id}:director-suggestion`), true)
    assert.equal(chatSpeech.pendingInteractionIds.includes(`interaction:${chatRoom.id}:director-suggestion`), false)

    await stageCraft.dispose()
    assert.equal(container.solutions.length, 0)
    assert.deepEqual(core.getView().workflows, [])
    core.projectRoom(fixture.room)
    assert.deepEqual(core.getView().workflows, [])
    assert.deepEqual(core.getView().interactions, [])
    assert.deepEqual(core.getView().actions, [])

    container.addSolution(new StageCraftSolutionPlugin())
    core.projectRoom(fixture.room)
    assert.equal(core.getView().workflows[0].definitionId, 'stagecraft.director.turn')
    await container.dispose()
  } finally {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('StageCraft chat interaction ownership follows speech and director activity', async () => {
  const fixture = roomFixture()
  try {
    const cases = [
      {
        room: { ...fixture.room, mode: 'chat' as const, phase: 'awaiting-player-input' as const, speech: undefined },
        speech: 'role-select', director: 'director-suggestion',
      },
      {
        room: { ...fixture.room, mode: 'chat' as const, phase: 'awaiting-approval' as const, speech: {} },
        speech: 'speech-approval', director: undefined,
      },
      {
        room: { ...fixture.room, mode: 'chat' as const, phase: 'role-speaking' as const, speech: undefined },
        speech: undefined, director: undefined, directorDormant: true,
      },
      {
        room: { ...fixture.room, mode: 'chat' as const, phase: 'world-change-approval' as const, speech: {} },
        speech: 'world-change-approval', director: undefined,
      },
      {
        room: { ...fixture.room, mode: 'chat' as const, phase: 'world-change-approval' as const, speech: undefined },
        speech: undefined, director: 'world-change-approval',
      },
    ]
    for (const item of cases) {
      const core = new CoreRuntimeSkeleton()
      const container = new DefaultCorePluginContainer(core)
      container.addSolution(new StageCraftSolutionPlugin())
      core.projectRoom(item.room)
      const speechWorkflow = core.getView().workflows.find(workflow => workflow.definitionId === 'stagecraft.chat.speech')!
      const directorWorkflow = core.getView().workflows.find(workflow => workflow.definitionId === 'stagecraft.chat.director')!
      if (item.speech) assert.deepEqual(speechWorkflow.pendingInteractionIds, [`interaction:${item.room.id}:${item.speech}`])
      else assert.deepEqual(speechWorkflow.pendingInteractionIds, [])
      if (item.director) assert.deepEqual(directorWorkflow.pendingInteractionIds, [`interaction:${item.room.id}:${item.director}`])
      else assert.deepEqual(directorWorkflow.pendingInteractionIds, [])
      if (item.directorDormant) assert.equal(directorWorkflow.locals.dormant, true)
      await container.dispose()
    }
  } finally {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('custom solutions can coexist and unloading one leaves the other isolated', async () => {
  const fixture = roomFixture()
  try {
    const core = new CoreRuntimeSkeleton()
    const container = new DefaultCorePluginContainer(core)
    const first = container.addSolution(solution('solution-a', 'solution.a.workflow'))
    container.addSolution(solution('solution-b', 'solution.b.workflow'))
    core.projectRoom(fixture.room)
    assert.deepEqual(core.getView().workflows.map(item => item.definitionId).sort(), ['solution.a.workflow', 'solution.b.workflow'])
    assert.equal(core.getView().interactions.length, 2)
    const firstWorkflow = core.getView().workflows.find(item => item.definitionId === 'solution.a.workflow')!
    const secondWorkflow = core.getView().workflows.find(item => item.definitionId === 'solution.b.workflow')!
    assert.deepEqual(firstWorkflow.pendingInteractionIds, ['interaction:solution-a'])
    assert.deepEqual(secondWorkflow.pendingInteractionIds, ['interaction:solution-b'])
    await first.dispose()
    core.projectRoom(fixture.room)
    assert.deepEqual(core.getView().workflows.map(item => item.definitionId), ['solution.b.workflow'])
    assert.deepEqual(core.getView().interactions.map(item => item.id), ['interaction:solution-b'])
    assert.deepEqual(core.getView().workflows[0].pendingInteractionIds, ['interaction:solution-b'])
    container.addSolution(solution('solution-a', 'solution.a.workflow'))
    core.projectRoom(fixture.room)
    assert.deepEqual(core.getView().workflows.map(item => item.definitionId).sort(), ['solution.a.workflow', 'solution.b.workflow'])
    await container.dispose()
  } finally {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('solution conflicts, invalid definitions and install failures roll back atomically', async () => {
  const fixture = roomFixture()
  try {
    const core = new CoreRuntimeSkeleton()
    const container = new DefaultCorePluginContainer(core)
    container.addSolution(new StageCraftSolutionPlugin())
    const conflicting = solution('conflict', 'stagecraft.chat.speech')
    assert.throws(() => container.addSolution(conflicting), /already registered/)
    assert.equal(container.solutions.length, 1)

    const broken: CoreSolutionPlugin = {
      id: 'broken',
      install(host) {
        host.registerWorkflow(definition('broken.valid'))
        host.registerProjection({ id: 'broken.projection', project: () => ({ workflows: [], interactions: [] }) })
        throw new Error('install failed')
      },
    }
    assert.throws(() => container.addSolution(broken), /install failed/)
    assert.equal(container.solutions.length, 1)
    core.projectRoom(fixture.room)
    assert.equal(core.getView().workflows.length, 1)
    assert.equal(core.getView().workflows.some(item => item.definitionId === 'broken.valid'), false)

    const failedRegistrationCore = new CoreRuntimeSkeleton()
    const failedRegistrationContainer = new DefaultCorePluginContainer(failedRegistrationCore)
    failedRegistrationContainer.solutions.push = (() => { throw new Error('list failure') }) as typeof failedRegistrationContainer.solutions.push
    assert.throws(() => failedRegistrationContainer.addSolution(solution('list-failure', 'list.failure.workflow')), /list failure/)
    await new Promise<void>(resolve => setImmediate(resolve))
    failedRegistrationCore.projectRoom(fixture.room)
    assert.deepEqual(failedRegistrationCore.getView().workflows, [])
    assert.deepEqual(failedRegistrationCore.getView().interactions, [])

    const invalid: CoreSolutionPlugin = {
      id: 'invalid',
      install(host) {
        host.registerWorkflow({ ...definition('invalid.workflow'), initialStep: 'missing' })
        return { dispose: () => {} }
      },
    }
    assert.throws(() => container.addSolution(invalid), /initial step is missing/)
    assert.equal(container.solutions.length, 1)

    const invalidTransition: CoreSolutionPlugin = {
      id: 'invalid-transition',
      install(host) {
        host.registerWorkflow({ ...definition('invalid.transition'), transitions: [{ from: 'start', event: 'go', to: 'missing' }] })
        return { dispose: () => {} }
      },
    }
    assert.throws(() => container.addSolution(invalidTransition), /transition target step is missing/)
    assert.equal(container.solutions.length, 1)

    const invalidStepId: CoreSolutionPlugin = {
      id: 'invalid-step-id',
      install(host) {
        host.registerWorkflow({ ...definition('invalid.step'), steps: { start: { id: 'different', actions: [{ type: 'finish' }] } } })
        return { dispose: () => {} }
      },
    }
    assert.throws(() => container.addSolution(invalidStepId), /step id does not match key/)
    assert.equal(container.solutions.length, 1)
    await container.dispose()
  } finally {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('restoring a workflow from an unloaded solution is ignored safely', () => {
  const core = new CoreRuntimeSkeleton()
  const now = new Date().toISOString()
  core.attachWorkflowStore({
    save: () => {},
    list: () => [
      {
        id: 'workflow:missing-room:missing', definitionId: 'missing.solution.workflow', definitionVersion: '1.0.0',
        step: 'start', status: 'running', locals: { roomId: 'missing-room' }, pendingInteractionIds: [], pendingModelRequestIds: [],
        retryCount: 0, createdAt: now, updatedAt: now,
      },
    ],
  })
  core.restoreWorkflowInstances('missing-room')
  assert.deepEqual(core.getView().workflows, [])
  assert.deepEqual(core.getView().actions, [])
})
