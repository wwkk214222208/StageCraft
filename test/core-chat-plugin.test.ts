import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { StageCraftSolutionPlugin, type StageCraftChatPort } from '../src/core/solutions.ts'
import type { CoreLlmRouterPlugin } from '../src/core/plugins.ts'
import type { ModelRequest } from '../src/core/protocol.ts'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import { createRealWorkers, ModelGateway } from '../src/model-gateway.ts'

const storiesRoot = fileURLToPath(new URL('../stories', import.meta.url))

function chatPort(calls: string[]): StageCraftChatPort {
  return {
    speak: async (_roomId, roleId, feedback) => { calls.push(`speak:${roleId}:${feedback ?? ''}`) },
    approveSpeech: async (_roomId, text) => { calls.push(`approve-speech:${text}`) },
    rejectSpeech: async () => { calls.push('reject-speech') },
    retrySpeak: async () => { calls.push('retry-speak') },
    directorChat: async (_roomId, text) => { calls.push(`director:${text}`) },
    approveWorldChange: async () => { calls.push('approve-world-change') },
    rejectWorldChange: async () => { calls.push('reject-world-change') },
    cancel: () => { calls.push('cancel') },
  }
}

test('StageCraft chat commands use the solution handler instead of the legacy dispatcher', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const calls: string[] = []
  container.addSolution(new StageCraftSolutionPlugin({ chat: chatPort(calls), defaultRoomId: 'room-1' }))
  await core.dispatch({ id: 'select', actor: 'player', type: 'select-role', payload: { roleId: 'aria', scope: 'chat', action: 'chat-speech', feedback: '请更克制一些' } })
  await core.dispatch({ id: 'director', actor: 'player', type: 'submit-text', payload: { roomId: 'room-1', action: 'director-chat', text: '推进到黄昏' } })
  await core.dispatch({ id: 'approve', actor: 'player', type: 'approve', payload: { roomId: 'room-1', text: '好的', action: 'speech' } })
  await core.dispatch({ id: 'reject-wc', actor: 'player', type: 'reject', payload: { roomId: 'room-1', action: 'world-change' } })
  await core.dispatch({ id: 'retry', actor: 'player', type: 'retry', payload: { scope: 'chat', action: 'chat-speech' } })
  await assert.rejects(() => core.dispatch({ id: 'non-chat-choose', actor: 'player', type: 'choose', payload: { roleId: 'aria', scope: 'director' } }), /Core command has no handler: choose/)
  await assert.rejects(() => core.dispatch({ id: 'non-chat-cancel', actor: 'player', type: 'cancel', payload: { scope: 'director' } }), /Core command has no handler: cancel/)
  await assert.rejects(() => core.dispatch({ id: 'non-chat-retry', actor: 'player', type: 'retry', payload: { scope: 'director' } }), /Core command has no handler: retry/)
  assert.deepEqual(calls, ['speak:aria:请更克制一些', 'director:推进到黄昏', 'approve-speech:好的', 'reject-world-change', 'retry-speak'])
  await container.dispose()
})

test('Core model requests resolve only their matching router result and preserve route metadata', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const requests: ModelRequest[] = []
  let host: Parameters<CoreLlmRouterPlugin['install']>[0]
  const router: CoreLlmRouterPlugin = {
    id: 'test.chat-router',
    install: installedHost => { host = installedHost; return { dispose: () => {} } },
    async request(request) {
      requests.push(request)
      await new Promise(resolve => setTimeout(resolve, 5))
      // The plugin host is captured per installation to prove request/result correlation.
      await host.submitModelResult({ requestId: request.requestId, output: { text: 'ok' }, usage: { promptTokens: 2, completionTokens: 1 } })
    },
    cancel: async () => {},
  }
  container.addLlm(router)
  const result = await core.requestModel({ requestId: 'chat-speech:aria:1', capability: 'role.speech', route: { role: 'aria', providerId: 'role-provider', model: 'role-model', purpose: 'chat.speech' }, prompt: { system: '', user: '' }, contract: { id: 'chat.speech', version: '1.0.0', schema: {} } })
  assert.equal(result.requestId, 'chat-speech:aria:1')
  assert.equal(requests[0].route?.providerId, 'role-provider')
  assert.equal(requests[0].route?.model, 'role-model')
  assert.deepEqual(result.usage, { promptTokens: 2, completionTokens: 1 })
  await container.dispose()
})

test('cancelled Core model requests reject and ignore late router results', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  let host: Parameters<CoreLlmRouterPlugin['install']>[0]
  let requestStarted: (() => void) | undefined
  let releaseRequest: (() => void) | undefined
  const started = new Promise<void>(resolve => { requestStarted = resolve })
  const holdRequest = new Promise<void>(resolve => { releaseRequest = resolve })
  container.addLlm({
    id: 'test.cancel-router',
    install: installedHost => { host = installedHost; return { dispose: () => {} } },
    request: async () => { requestStarted?.(); await holdRequest },
    cancel: async () => {},
  })
  const events: string[] = []
  core.subscribe(event => events.push(event.type))
  const pending = core.requestModel({ requestId: 'cancel-me', capability: 'role.speech', prompt: { system: '', user: '' }, contract: { id: 'speech', version: '1', schema: {} } })
  await started
  await core.cancel('cancel-me')
  await assert.rejects(pending, /cancelled/)
  await assert.rejects(core.requestModel({ requestId: 'cancel-me', capability: 'role.speech', prompt: { system: '', user: '' }, contract: { id: 'speech', version: '1', schema: {} } }), /cannot be reused/)
  await host!.submitModelResult({ requestId: 'cancel-me', output: { text: 'late' } })
  assert.equal(events.includes('model.completed'), false)
  releaseRequest?.()
  await container.dispose()
})

test('Core model requests wait for submitModelResult even when router resolves first, and support sync submit/retry', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  let host: Parameters<CoreLlmRouterPlugin['install']>[0]
  let releaseLate: (() => void) | undefined
  let calls = 0
  container.addLlm({
    id: 'test.request-lifecycle-router',
    install: installedHost => { host = installedHost; return { dispose: () => {} } },
    request: async request => {
      calls += 1
      if (calls === 1) {
        await new Promise<void>(resolve => { releaseLate = resolve })
        await host.submitModelResult({ requestId: request.requestId, output: { phase: 'late' } })
        return
      }
      await host.submitModelResult({ requestId: request.requestId, output: { phase: 'sync' } })
    },
    cancel: async () => {},
  })
  const request = { requestId: 'wait-for-result', capability: 'role.speech', prompt: { system: '', user: '' }, contract: { id: 'speech', version: '1', schema: {} } } as ModelRequest
  const pending = core.requestModel(request)
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(settled, false)
  releaseLate?.()
  assert.deepEqual(await pending, { requestId: request.requestId, output: { phase: 'late' } })
  const syncRequest = { ...request, requestId: 'sync-result' }
  assert.deepEqual(await core.requestModel(syncRequest), { requestId: 'sync-result', output: { phase: 'sync' } })
  await container.dispose()
})

test('a rejected router request clears its waiter so the same request id can be retried', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  let host: Parameters<CoreLlmRouterPlugin['install']>[0]
  let calls = 0
  container.addLlm({
    id: 'test.retry-router',
    install: installedHost => { host = installedHost; return { dispose: () => {} } },
    request: async request => {
      calls += 1
      if (calls === 1) throw new Error('transport failed')
      await host.submitModelResult({ requestId: request.requestId, output: { ok: true } })
    },
    cancel: async () => {},
  })
  const request = { requestId: 'retryable', capability: 'role.speech', prompt: { system: '', user: '' }, contract: { id: 'speech', version: '1', schema: {} } } as ModelRequest
  await assert.rejects(core.requestModel(request), /transport failed/)
  assert.deepEqual(await core.requestModel(request), { requestId: 'retryable', output: { ok: true } })
  await container.dispose()
})

test('replacing a router rejects only its pending requests and clears workflow pending state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-router-dispose-'))
  const store = new Store(join(root, 'state.sqlite'))
  try {
    const roomId = store.seed(loadStoryPackage(storiesRoot, 'eldoria'))
    const core = new CoreRuntimeSkeleton()
    const runtime = new RoomRuntime(store, undefined, core)
    const container = new DefaultCorePluginContainer(core)
    runtime.setRoomConfig(roomId, { mode: 'chat', autoPublish: false })
    container.addSolution(new StageCraftSolutionPlugin({ defaultRoomId: roomId }))
    core.projectRoom(runtime.get(roomId))
    const workflow = core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.speech')!
    let release: (() => void) | undefined
    const hold = new Promise<void>(resolve => { release = resolve })
    const oldBinding = container.addLlm({ id: 'test.old-dispose-router', install: () => ({ dispose: () => {} }), request: async () => { await hold }, cancel: async () => {} })
    const pending = core.requestModel({ requestId: 'old-pending', workflowId: workflow.id, capability: 'role.speech', prompt: { system: '', user: '' }, contract: { id: 'speech', version: '1', schema: {} } })
    await new Promise(resolve => setTimeout(resolve, 2))
    const replacement = container.addLlm({ id: 'test.new-dispose-router', install: () => ({ dispose: () => {} }), request: async () => {}, cancel: async () => {} })
    await assert.rejects(pending, /router was disposed/i)
    const restoredWorkflow = core.getView().workflows.find(item => item.id === workflow.id)!
    assert.deepEqual(restoredWorkflow.pendingModelRequestIds, [])
    await oldBinding.dispose()
    await replacement.dispose()
    release?.()
    await container.dispose()
    runtime.dispose()
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat speech uses the Core LLM router request/result path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-chat-router-'))
  const store = new Store(join(root, 'state.sqlite'))
  try {
    const roomId = store.seed(loadStoryPackage(storiesRoot, 'eldoria'))
    const core = new CoreRuntimeSkeleton()
    const container = new DefaultCorePluginContainer(core)
    const runtime = new RoomRuntime(store, undefined, core)
    runtime.setRoomConfig(roomId, { mode: 'chat', autoPublish: false })
    container.addSolution(new StageCraftSolutionPlugin({ chat: runtime.getChatService(), defaultRoomId: roomId }))
    core.projectRoom(runtime.get(roomId))
    const requests: ModelRequest[] = []
    const thinkingEvents: Array<{ actor: string; text: string; done: boolean }> = []
    runtime.subscribeThinking(roomId, event => thinkingEvents.push({ actor: event.actor, text: event.text, done: event.done }))
    let host: Parameters<CoreLlmRouterPlugin['install']>[0]
    container.addLlm({
      id: 'test.chat-speech-router',
      install: installedHost => { host = installedHost; return { dispose: () => {} } },
      request: async request => {
        requests.push(request)
        host.publishModelEvent({ type: 'model.started', revision: 0, request })
        host.publishModelEvent({ type: 'model.thinking.delta', revision: 0, requestId: request.requestId, text: '实时思考片段' })
        await host.submitModelResult({ requestId: request.requestId, output: request.capability === 'director.chat' ? { reply: '导演通过 Core 路由回复' } : { text: '通过 Core 路由生成的台词' }, thinking: '完整思考', usage: { promptTokens: 3, completionTokens: 4 } })
      },
      cancel: async () => {},
    })
    const routedWorkers = createRealWorkers({} as ModelGateway, () => ({} as ModelGateway), { requestModel: request => core.requestModel(request) })
    routedWorkers.digest = undefined
    runtime.setWorkers(routedWorkers)
    await core.dispatch({ id: 'chat-speak', actor: 'player', type: 'select-role', payload: { roomId, roleId: runtime.get(roomId).roles[0].id } })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].capability, 'role.speech')
    assert.equal(requests[0].contract.id, 'chat.speech')
    assert.equal(requests[0].route?.role, runtime.get(roomId).roles[0].id)
    assert.equal(runtime.get(roomId).speech?.text, '通过 Core 路由生成的台词')
    assert.equal(runtime.get(roomId).speech?.thinking, '完整思考')
    assert.deepEqual(runtime.get(roomId).speech?.usage, { promptTokens: 3, completionTokens: 4 })
    assert.deepEqual(thinkingEvents.slice(0, 2), [
      { actor: 'role', text: '实时思考片段', done: false },
      { actor: 'role', text: '', done: true },
    ])
    await core.dispatch({ id: 'chat-approve', actor: 'player', type: 'approve', payload: { roomId, action: 'speech', text: '通过 Core 路由生成的台词' } })
    await core.dispatch({ id: 'chat-director', actor: 'player', type: 'submit-text', payload: { roomId, action: 'director-chat', text: '推进到黄昏' } })
    assert.equal(requests[1].capability, 'director.chat')
    assert.equal(requests[1].contract.id, 'chat.director')
    const directorConsultation = runtime.get(roomId).consultations.at(-1)
    assert.equal(directorConsultation?.thinking, '完整思考')
    assert.deepEqual(directorConsultation?.usage, { promptTokens: 3, completionTokens: 4 })
    await container.dispose()
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Core thinking correlation stays isolated for two rooms sharing a role id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-thinking-correlation-'))
  const store = new Store(join(root, 'state.sqlite'))
  try {
    const roomA = store.seed(loadStoryPackage(storiesRoot, 'eldoria'))
    const roomB = store.createRoomFromPackage(loadStoryPackage(storiesRoot, 'eldoria'), 'eldoria-thinking-room-b')
    const core = new CoreRuntimeSkeleton()
    const runtime = new RoomRuntime(store, undefined, core)
    const eventsA: string[] = []
    const eventsB: string[] = []
    runtime.subscribeThinking(roomA, event => eventsA.push(event.text))
    runtime.subscribeThinking(roomB, event => eventsB.push(event.text))
    const container = new DefaultCorePluginContainer(core)
    let host: Parameters<CoreLlmRouterPlugin['install']>[0]
    container.addLlm({
      id: 'test.thinking-correlation-router',
      install: installedHost => { host = installedHost; return { dispose: () => {} } },
      request: async () => {},
      cancel: async () => {},
    })
    const request = (roomId: string, requestId: string) => ({ requestId, capability: 'role.speech', prompt: { system: '', user: '' }, contract: { id: 'speech', version: '1', schema: {} }, metadata: { correlation: { roomId, turnId: `${roomId}-turn`, actor: 'role', roleId: 'aria' } } })
    const requestA = request(roomA, 'a-request')
    const requestB = request(roomB, 'b-request')
    host.publishModelEvent({ type: 'model.started', revision: 0, request: requestA })
    host.publishModelEvent({ type: 'model.started', revision: 0, request: requestB })
    host.publishModelEvent({ type: 'model.thinking.delta', revision: 0, requestId: 'a-request', text: 'A 思考' })
    host.publishModelEvent({ type: 'model.thinking.delta', revision: 0, requestId: 'b-request', text: 'B 思考' })
    assert.deepEqual(eventsA, ['A 思考'])
    assert.deepEqual(eventsB, ['B 思考'])
    host.publishModelEvent({ type: 'model.completed', revision: 0, result: { requestId: 'a-request', output: {} } })
    host.publishModelEvent({ type: 'error', revision: 0, requestId: 'b-request', message: 'failed' })
    host.publishModelEvent({ type: 'model.thinking.delta', revision: 0, requestId: 'a-request', text: '完成后不应转发 A' })
    host.publishModelEvent({ type: 'model.thinking.delta', revision: 0, requestId: 'b-request', text: '错误后不应转发 B' })
    assert.deepEqual(eventsA, ['A 思考'])
    assert.deepEqual(eventsB, ['B 思考'])
    host.publishModelEvent({ type: 'model.started', revision: 0, request: requestA })
    runtime.getChatService().cancel(roomA)
    host.publishModelEvent({ type: 'model.thinking.delta', revision: 0, requestId: 'a-request', text: '取消后不应转发' })
    assert.deepEqual(eventsA, ['A 思考'])
    runtime.dispose()
    runtime.dispose()
    host.publishModelEvent({ type: 'model.started', revision: 0, request: request(roomA, 'after-dispose') })
    host.publishModelEvent({ type: 'model.thinking.delta', revision: 0, requestId: 'after-dispose', text: '不应到达' })
    assert.deepEqual(eventsA, ['A 思考'])
    assert.deepEqual(eventsB, ['B 思考'])
    await container.dispose()
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('router rejection terminates correlated thinking and clears workflow pending state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-thinking-reject-'))
  const store = new Store(join(root, 'state.sqlite'))
  try {
    const roomId = store.seed(loadStoryPackage(storiesRoot, 'eldoria'))
    const core = new CoreRuntimeSkeleton()
    const runtime = new RoomRuntime(store, undefined, core)
    runtime.setRoomConfig(roomId, { mode: 'chat', autoPublish: false })
    const container = new DefaultCorePluginContainer(core)
    container.addSolution(new StageCraftSolutionPlugin({ defaultRoomId: roomId }))
    core.projectRoom(runtime.get(roomId))
    const workflow = core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.speech')!
    const thinking: string[] = []
    runtime.subscribeThinking(roomId, event => thinking.push(event.text))
    let host: Parameters<CoreLlmRouterPlugin['install']>[0]
    container.addLlm({
      id: 'test.reject-correlated-router',
      install: installedHost => { host = installedHost; return { dispose: () => {} } },
      request: async request => {
        host.publishModelEvent({ type: 'model.started', revision: 0, request })
        throw new Error('router unavailable')
      },
      cancel: async () => {},
    })
    const request = { requestId: 'reject-correlated', workflowId: workflow.id, capability: 'role.speech', prompt: { system: '', user: '' }, contract: { id: 'speech', version: '1', schema: {} }, metadata: { correlation: { roomId, turnId: 'reject-turn', actor: 'role', roleId: 'aria' } } } as ModelRequest
    await assert.rejects(core.requestModel(request), /router unavailable/)
    await host!.publishModelEvent({ type: 'model.thinking.delta', revision: 0, requestId: request.requestId, text: '迟到思考' })
    assert.deepEqual(thinking, [])
    assert.deepEqual(core.getView().workflows.find(item => item.id === workflow.id)?.pendingModelRequestIds, [])
    await container.dispose()
    runtime.dispose()
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
