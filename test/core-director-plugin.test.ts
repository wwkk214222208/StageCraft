import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { StageCraftSolutionPlugin } from '../src/core/solutions.ts'
import { LegacyRuntimeSolutionPlugin } from '../src/core/command-adapter.ts'
import type { ModelRequest } from '../src/core/protocol.ts'
import { ModelGatewayRouterAdapter } from '../src/core/model-router-adapter.ts'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import { ModelGateway, createRealWorkers } from '../src/model-gateway.ts'
import { fakeWorkers, type WorkerSet } from '../src/workers.ts'
import { switchProviderSafely } from '../src/app-boot.ts'
import type { CoreLlmRouterHost } from '../src/core/plugins.ts'

const storiesRoot = fileURLToPath(new URL('../stories', import.meta.url))

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-director-plugin-'))
  const store = new Store(join(root, 'state.sqlite'))
  const roomId = store.seed(loadStoryPackage(storiesRoot, 'eldoria'))
  const core = new CoreRuntimeSkeleton()
  const runtime = new RoomRuntime(store, undefined, core)
  runtime.setRoomConfig(roomId, { mode: 'director', autoPublish: false })
  const container = new DefaultCorePluginContainer(core)
  container.addSolution(new StageCraftSolutionPlugin({ director: runtime.getDirectorService(), defaultRoomId: roomId }))
  core.projectRoom(runtime.get(roomId))
  return { root, store, roomId, core, runtime, container }
}

async function startDraft(env: ReturnType<typeof setup>): Promise<string> {
  const input = env.core.getView().interactions.find(item => item.id.endsWith(':player-input'))!
  await env.core.dispatch({ id: `turn-${Date.now()}`, actor: 'player', interactionId: input.id, type: 'submit-text', payload: { roomId: env.roomId, text: '继续前进', requiredRoleIds: [env.runtime.get(env.roomId).roles[0].id] } })
  const decisions = env.core.getView().interactions.find(item => item.id.endsWith(':decision-approval'))!
  await env.core.dispatch({ id: `decisions-${Date.now()}`, actor: 'player', interactionId: decisions.id, type: 'approve', payload: { roomId: env.roomId, action: 'decisions' } })
  return env.runtime.get(env.roomId).draft?.id ?? ''
}

test('Director Core handler completes the real InteractionRequest chain without legacy dispatch', async () => {
  const env = setup()
  let legacyCalls = 0
  const legacyProxy = new Proxy(env.runtime, { get(target, property, receiver) {
    if (['submitTurn', 'proceedToDraft', 'approve', 'rejectDraft', 'cancelTurn', 'retryDirector', 'reconsiderReaction', 'consult', 'finishConsultation', 'redraft'].includes(String(property))) return () => { legacyCalls += 1; throw new Error('legacy path must not be called') }
    return Reflect.get(target, property, receiver)
  } })
  env.container.addSolution(new LegacyRuntimeSolutionPlugin({ runtime: legacyProxy, defaultRoomId: env.roomId }))
  try {
    const first = env.core.getView().interactions.find(item => item.id.endsWith(':player-input'))!
    await env.core.dispatch({ id: 'turn', actor: 'player', interactionId: first.id, type: 'submit-text', payload: { roomId: env.roomId, text: '沿林间小路前进' } })
    const decision = env.core.getView().interactions.find(item => item.id.endsWith(':decision-approval'))!
    await env.core.dispatch({ id: 'decisions', actor: 'player', interactionId: decision.id, type: 'approve', payload: { roomId: env.roomId, action: 'decisions' } })
    const draft = env.runtime.get(env.roomId).draft!
    const approval = env.core.getView().interactions.find(item => item.id.endsWith(':draft-approval'))!
    await env.core.dispatch({ id: 'draft', actor: 'player', interactionId: approval.id, type: 'approve', payload: { roomId: env.roomId, action: 'draft-approval', draftId: draft.id, text: draft.text, stateUpdates: draft.stateUpdates } })
    assert.equal(env.runtime.get(env.roomId).phase, 'awaiting-player-input')
    assert.equal(legacyCalls, 0)
  } finally {
    await env.container.dispose()
    env.runtime.dispose()
    env.store.close()
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('director model requests preserve provider/model, thinking strength and native tool schema', async () => {
  const requests: ModelRequest[] = []
  const workers = createRealWorkers({} as ModelGateway, () => ({} as ModelGateway), {
    directorProviderId: 'director-provider', directorModel: 'deepseek-reasoner', directorThinkingStrength: 'deep',
    requestModel: async request => {
      requests.push(request)
      return { requestId: request.requestId, output: request.capability.startsWith('role.decision') ? { brief: '回应', privateReaction: '记住' } : { text: '草稿', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [] } }
    },
  })
  const role = { id: 'aria', name: 'Aria', portraitRef: '', currentState: '', presence: 'present' as const, selfModel: 'self', providerId: 'role-provider', modelOverride: 'role-model', thinkingStrength: 'standard' as const }
  const decision = await workers.decide(role, 'required', '继续', [role], { roomId: 'room', turnId: 'turn' })
  assert.equal(decision.status, 'completed')
  await workers.draft('turn', '继续', [decision], [role], [], undefined, { roomId: 'room', turnId: 'turn' })
  assert.equal(requests[0].route?.providerId, 'role-provider')
  assert.equal(requests[0].route?.model, 'role-model')
  assert.equal(requests[0].route?.role, 'aria')
  assert.equal(requests[0].thinkingStrength, 'standard')
  // Direct worker requests are assembled before the Core adapter; the director route is explicit.
  assert.equal(requests[1].route?.providerId, 'director-provider')
  assert.equal(requests[1].route?.model, 'deepseek-reasoner')
  assert.equal(requests[1].thinkingStrength, 'deep')
  assert.ok(requests[1].tool?.parameters)
  assert.equal((requests[1].metadata as Record<string, unknown>).apiKey, undefined)
})

test('ModelGateway forwards thinking body and native tools for both request modes', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const response = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  const gateway = new ModelGateway({ baseUrl: 'https://offline.invalid', apiKey: 'test-key', model: 'deepseek-reasoner', timeoutMs: 1000, responseFormat: 'json_object' }, { fetchImpl: async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return response() } })
  await gateway.complete('system', 'user', 'test', { type: 'object' }, { name: 'tool', description: 'tool', parameters: { type: 'object' } }, {}, { thinkingStrength: 'deep', requestId: 'one' })
  assert.deepEqual((bodies[0].thinking as Record<string, unknown>).type, 'enabled')
  assert.equal(bodies[0].reasoning_effort, 'max')
  assert.ok(Array.isArray(bodies[0].tools))
  assert.equal((bodies[0].tools as Array<Record<string, unknown>>)[0].type, 'function')
})

test('Core + ModelGatewayRouterAdapter preserves tools and DeepSeek thinking for stream/non-stream requests', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const response = (stream: boolean) => stream
    ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"ok":true}' } }] } }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    : new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { arguments: '{"ok":true}' } }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  const gateway = new ModelGateway({ baseUrl: 'https://offline.invalid', apiKey: 'offline-key', model: 'deepseek-reasoner', timeoutMs: 1000, responseFormat: 'json_object' }, { fetchImpl: async (_url, init) => { const body = JSON.parse(String(init?.body)) as Record<string, unknown>; bodies.push(body); return response(body.stream === true) } })
  container.addLlm(new ModelGatewayRouterAdapter(gateway))
  const tool = { name: 'emit', description: 'emit result', parameters: { type: 'object', properties: { ok: { type: 'boolean' } } } }
  const request = (id: string, stream: boolean, thinkingStrength: 'deep' | 'standard' | 'off'): ModelRequest => ({ requestId: id, capability: 'director.draft', prompt: { system: 's', user: 'u' }, contract: { id: 'x', version: '1', schema: { type: 'object' } }, tool, thinkingStrength, stream })
  await core.requestModel(request('deep', false, 'deep'))
  await core.requestModel(request('standard', true, 'standard'))
  await core.requestModel(request('off', false, 'off'))
  await core.requestModel(request('stream-off', true, 'off'))
  assert.equal(bodies.length, 4)
  assert.equal(bodies[0].reasoning_effort, 'max'); assert.deepEqual(bodies[0].thinking, { type: 'enabled' })
  assert.equal(bodies[1].reasoning_effort, 'high'); assert.deepEqual(bodies[1].thinking, { type: 'enabled' }); assert.equal(bodies[1].stream, true)
  assert.deepEqual(bodies[2].thinking, { type: 'disabled' }); assert.equal(bodies[2].reasoning_effort, undefined)
  assert.deepEqual(bodies[3].thinking, { type: 'disabled' }); assert.equal(bodies[3].reasoning_effort, undefined); assert.equal(bodies[3].stream, true)
  for (const body of bodies) assert.equal((body.tools as Array<Record<string, unknown>>)[0].type, 'function')
  await container.dispose()
})

test('Core cancellation through ModelGatewayRouterAdapter rejects A while B on same gateway completes', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  let resolveB: (() => void) | undefined
  const gateway = new ModelGateway({ baseUrl: 'https://offline.invalid', apiKey: 'offline-key', model: 'deepseek-reasoner', timeoutMs: 5000, responseFormat: 'none' }, { fetchImpl: async (_url, init) => await new Promise<Response>((resolve, reject) => {
    const body = String(init?.body); const signal = init?.signal
    if (body.includes('A')) signal?.addEventListener('abort', () => reject(new Error('aborted A')), { once: true })
    else { resolveB = () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 })); signal?.addEventListener('abort', () => reject(new Error('aborted B')), { once: true }) }
  }) })
  container.addLlm(new ModelGatewayRouterAdapter(gateway))
  const request = (id: string, text: string): ModelRequest => ({ requestId: id, capability: 'director.draft', prompt: { system: 's', user: text }, contract: { id: 'x', version: '1', schema: { type: 'object' } }, tool: { name: 'emit', description: 'emit', parameters: { type: 'object' } } })
  const a = core.requestModel(request('A', 'A'))
  const b = core.requestModel(request('B', 'B'))
  await new Promise(resolve => setTimeout(resolve, 0))
  await core.cancel('A')
  resolveB?.()
  const results = await Promise.allSettled([a, b])
  assert.equal(results[0].status, 'rejected')
  assert.equal(results[1].status, 'fulfilled')
  await container.dispose()
})

test('draft failure leaves drafting state; retryDirector retries draft only', async () => {
  const env = setup()
  let decideCalls = 0
  let draftCalls = 0
  const workers: WorkerSet = {
    ...fakeWorkers,
    decide: async (...args) => { decideCalls += 1; return fakeWorkers.decide(...args) },
    draft: async (...args) => { draftCalls += 1; if (draftCalls === 1) throw new Error('offline'); return fakeWorkers.draft(...args) },
  }
  env.runtime.setWorkers(workers)
  try {
    await startDraft(env)
    assert.equal(env.runtime.get(env.roomId).phase, 'drafting')
    assert.equal(decideCalls, env.runtime.get(env.roomId).roles.filter(role => role.presence === 'present').length)
    await env.core.dispatch({ id: 'retry-draft', actor: 'player', type: 'retry', payload: { roomId: env.roomId, scope: 'director', action: 'director-retry' } })
    assert.equal(env.runtime.get(env.roomId).phase, 'awaiting-approval')
    assert.equal(decideCalls, env.runtime.get(env.roomId).roles.filter(role => role.presence === 'present').length)
    assert.equal(draftCalls, 2)
  } finally {
    await env.container.dispose(); env.runtime.dispose(); env.store.close(); rmSync(env.root, { recursive: true, force: true })
  }
})

test('required role decision failure is recorded and blocks drafting through Core', async () => {
  const env = setup()
  const requiredRole = env.runtime.get(env.roomId).roles.find(role => role.presence === 'present')!
  const workers: WorkerSet = { ...fakeWorkers, decide: async (role, participation, ...args) => role.id === requiredRole.id && participation === 'required' ? Promise.reject(new Error('required offline')) : fakeWorkers.decide(role, participation, ...args) }
  env.runtime.setWorkers(workers)
  try {
    const input = env.core.getView().interactions.find(item => item.id.endsWith(':player-input'))!
    await env.core.dispatch({ id: 'required-failure', actor: 'player', interactionId: input.id, type: 'submit-text', payload: { roomId: env.roomId, text: '必须成功' , requiredRoleIds: [requiredRole.id] } })
    assert.equal(env.runtime.get(env.roomId).phase, 'collecting-decisions')
    assert.match(env.runtime.get(env.roomId).lastError ?? '', /Required role decisions unavailable/)
    assert.equal(env.runtime.get(env.roomId).draft, undefined)
  } finally {
    await env.container.dispose(); env.runtime.dispose(); env.store.close(); rmSync(env.root, { recursive: true, force: true })
  }
})

test('reconsiderReaction accepts empty feedback without adding an empty feedback clause', async () => {
  const env = setup()
  const contributions: string[] = []
  const workers: WorkerSet = { ...fakeWorkers, decide: async (role, participation, contribution, ...rest) => { contributions.push(contribution); return fakeWorkers.decide(role, participation, contribution, ...rest) } }
  env.runtime.setWorkers(workers)
  try {
    await startDraft(env)
    const roleId = env.runtime.get(env.roomId).roles[0].id
    await env.core.dispatch({ id: 'reconsider', actor: 'player', type: 'retry', payload: { roomId: env.roomId, scope: 'director', action: 'reconsider-reaction', roleId, feedback: '' } })
    assert.ok(contributions.at(-1) && !contributions.at(-1)!.includes('批复：'))
    assert.equal(env.runtime.get(env.roomId).decisions.find(item => item.roleId === roleId)?.status, 'completed')
  } finally {
    await env.container.dispose(); env.runtime.dispose(); env.store.close(); rmSync(env.root, { recursive: true, force: true })
  }
})

test('reject draft returns to input and autoPublish publishes a complete turn', async () => {
  const env = setup()
  try {
    const draftId = await startDraft(env)
    await env.core.dispatch({ id: 'reject-draft', actor: 'player', type: 'reject', payload: { roomId: env.roomId, scope: 'director', action: 'draft-approval' } })
    assert.equal(env.runtime.get(env.roomId).phase, 'awaiting-player-input')
    env.runtime.setRoomConfig(env.roomId, { autoPublish: true })
    const input = env.core.getView().interactions.find(item => item.id.endsWith(':player-input'))!
    await env.core.dispatch({ id: 'auto-publish', actor: 'player', interactionId: input.id, type: 'submit-text', payload: { roomId: env.roomId, text: '自动推进', requiredRoleIds: [env.runtime.get(env.roomId).roles[0].id] } })
    assert.equal(env.runtime.get(env.roomId).phase, 'awaiting-player-input')
    assert.ok(env.runtime.get(env.roomId).scenes.length > 1)
    assert.notEqual(draftId, '')
  } finally {
    await env.container.dispose(); env.runtime.dispose(); env.store.close(); rmSync(env.root, { recursive: true, force: true })
  }
})

test('consult can finish or redraft, preserving previousDraft and merged scene context', async () => {
  const env = setup()
  const scenes: Array<{ scene?: unknown; previousDraft?: string }> = []
  const workers: WorkerSet = {
    ...fakeWorkers,
    draft: async (...args) => {
      scenes.push({ scene: args[6], previousDraft: args[10] })
      const result = await fakeWorkers.draft(...args)
      if (scenes.length === 1) return { ...result, sceneUpdates: { time: '黄昏' } }
      return result
    },
  }
  env.runtime.setWorkers(workers)
  try {
    const draftId = await startDraft(env)
    const initialDraftText = env.runtime.get(env.roomId).draft!.text
    env.store.updateScene(env.roomId, { location: '塔顶' })
    await env.core.dispatch({ id: 'consult', actor: 'player', type: 'submit-text', payload: { roomId: env.roomId, scope: 'director', action: 'director-consult', draftId, text: '请把场景改得更紧张' } })
    assert.equal(env.runtime.get(env.roomId).phase, 'consulting-director')
    await env.core.dispatch({ id: 'finish-consult', actor: 'player', type: 'approve', payload: { roomId: env.roomId, action: 'consult-finish' } })
    assert.equal(env.runtime.get(env.roomId).phase, 'awaiting-approval')
    await env.core.dispatch({ id: 'redraft', actor: 'player', type: 'retry', payload: { roomId: env.roomId, scope: 'director', action: 'redraft', draftId } })
    assert.equal(env.runtime.get(env.roomId).phase, 'awaiting-approval')
    assert.equal(scenes.length, 2)
    assert.equal((scenes[1].scene as { time?: string }).time, '黄昏')
    assert.equal((scenes[1].scene as { location?: string }).location, '塔顶')
    assert.equal(scenes[1].previousDraft, initialDraftText)
  } finally {
    await env.container.dispose(); env.runtime.dispose(); env.store.close(); rmSync(env.root, { recursive: true, force: true })
  }
})

test('director service rejects overlapping same-room operations and rejects work after dispose', async () => {
  const env = setup()
  let release: (() => void) | undefined
  const workers: WorkerSet = { ...fakeWorkers, draft: async (...args) => { await new Promise<void>(resolve => { release = resolve }); return fakeWorkers.draft(...args) } }
  env.runtime.setWorkers(workers)
  try {
    const input = env.core.getView().interactions.find(item => item.id.endsWith(':player-input'))!
    await env.core.dispatch({ id: 'turn', actor: 'player', interactionId: input.id, type: 'submit-text', payload: { roomId: env.roomId, text: '并发测试' } })
    const decision = env.core.getView().interactions.find(item => item.id.endsWith(':decision-approval'))!
    const drafting = env.core.dispatch({ id: 'proceed', actor: 'player', interactionId: decision.id, type: 'approve', payload: { roomId: env.roomId, action: 'decisions' } })
    await new Promise(resolve => setTimeout(resolve, 0))
    await assert.rejects(env.runtime.redraft(env.roomId, 'missing'), /A Director operation is already active for this room\./)
    release?.(); await drafting
    env.runtime.dispose()
    await assert.rejects(env.runtime.proceedToDraft(env.roomId), /disposed/)
  } finally {
    release?.(); await env.container.dispose(); env.store.close(); rmSync(env.root, { recursive: true, force: true })
  }
})

test('request-scoped ModelGateway cancellation aborts A while same-gateway B completes', async () => {
  let resolveB: (() => void) | undefined
  const gateway = new ModelGateway({ baseUrl: 'https://offline.invalid', apiKey: 'test-key', model: 'deepseek-reasoner', timeoutMs: 5000, responseFormat: 'none' }, {
    fetchImpl: async (_url, init) => await new Promise<Response>((resolve, reject) => {
      const body = String(init?.body)
      const signal = init?.signal
      if (body.includes('A')) signal?.addEventListener('abort', () => reject(new Error('aborted A')), { once: true })
      else { resolveB = () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 })); signal?.addEventListener('abort', () => reject(new Error('aborted B')), { once: true }) }
    }),
  })
  const call = (id: string, text: string) => gateway.complete('system', text, 'test', { type: 'object' }, undefined, {}, { requestId: id })
  const a = call('A', 'A')
  const b = call('B', 'B')
  await new Promise(resolve => setTimeout(resolve, 0))
  gateway.cancelRequest('A')
  resolveB?.()
  const results = await Promise.allSettled([a, b])
  assert.equal(results[0].status, 'rejected')
  assert.equal(results[1].status, 'fulfilled')
})

test('provider switch preflight runs before dispose/install and preserves strict order', async () => {
  const events: string[] = []
  await assert.rejects(switchProviderSafely(() => { events.push('assert'); throw new Error('active') }, () => { events.push('dispose') }, () => { events.push('install') }), /active/)
  assert.deepEqual(events, ['assert'])
  events.length = 0
  await switchProviderSafely(() => { events.push('assert') }, () => { events.push('dispose') }, () => { events.push('install'); return 'new' })
  assert.deepEqual(events, ['assert', 'dispose', 'install'])
})

test('chat director activity prevents provider switching even without a room filter', async () => {
  const env = setup()
  let release: (() => void) | undefined
  const workers: WorkerSet = {
    ...fakeWorkers,
    directorChat: async () => await new Promise(resolve => { release = resolve }),
  }
  env.runtime.setWorkers(workers)
  env.runtime.setRoomConfig(env.roomId, { mode: 'chat' })
  try {
    const pending = env.runtime.directorChat(env.roomId, '推进世界')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(env.runtime.getChatService().isActive(), true)
    assert.throws(() => env.runtime.assertWorkersSwitchAllowed(), /回合进行中不能切换模型。/)
    release?.({ reply: '收到' })
    await pending
    assert.equal(env.runtime.getChatService().isActive(), false)
  } finally {
    release?.({ reply: '收到' }); env.runtime.dispose(); await env.container.dispose(); env.store.close(); rmSync(env.root, { recursive: true, force: true })
  }
})

test('two Director Core rooms cancel only room A and ignore its late model results', async () => {
  const a = setup()
  const b = setup()
  const pendingA = new Map<string, ModelRequest>()
  const lateStarts = new Map<string, () => void>()
  const outputFor = (request: ModelRequest): unknown => request.capability.startsWith('role.')
    ? { brief: 'B 的角色反馈', privateReaction: 'B 的私有反应' }
    : { text: 'B 的草稿', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [] }
  const installRouter = (core: CoreRuntimeSkeleton, delayedRoom: string, suffix: string) => {
    let host: CoreLlmRouterHost | undefined
    const router = {
      id: `offline-director-router-${suffix}`,
      install(next: CoreLlmRouterHost) { host = next; return { dispose() { host = undefined } } },
      async request(request: ModelRequest) {
        const correlation = request.metadata?.correlation as { roomId?: string } | undefined
        if (correlation?.roomId === delayedRoom) {
          pendingA.set(request.requestId, request)
          if (suffix === 'a') {
            lateStarts.set(request.requestId, () => host?.publishModelEvent({ type: 'model.started', revision: 0, request }))
            return
          }
        }
        host?.publishModelEvent({ type: 'model.started', revision: 0, request })
        await host?.submitModelResult({ requestId: request.requestId, output: outputFor(request) })
      },
      async cancel(_requestId?: string) { /* keep a late result available to verify Core tombstones */ },
    }
    return router
  }
  a.container.addLlm(installRouter(a.core, a.roomId, 'a'))
  b.container.addLlm(installRouter(b.core, 'never', 'b'))
  const workersFor = (core: CoreRuntimeSkeleton) => createRealWorkers({} as ModelGateway, () => ({} as ModelGateway), {
    requestModel: request => core.requestModel(request),
    cancelModel: requestId => core.cancel(requestId),
    directorThinkingStrength: 'standard',
  })
  a.runtime.setWorkers(workersFor(a.core)); b.runtime.setWorkers(workersFor(b.core))
  const inputA = a.core.getView().interactions.find(item => item.id.endsWith(':player-input'))!
  const inputB = b.core.getView().interactions.find(item => item.id.endsWith(':player-input'))!
  try {
    const turnA = a.core.dispatch({ id: 'turn-a', actor: 'player', interactionId: inputA.id, type: 'submit-text', payload: { roomId: a.roomId, text: 'A', requiredRoleIds: [a.runtime.get(a.roomId).roles[0].id] } })
    await new Promise(resolve => setTimeout(resolve, 0))
    const turnB = b.core.dispatch({ id: 'turn-b', actor: 'player', interactionId: inputB.id, type: 'submit-text', payload: { roomId: b.roomId, text: 'B', requiredRoleIds: [b.runtime.get(b.roomId).roles[0].id] } })
    await turnB
    const decisionsB = b.core.getView().interactions.find(item => item.id.endsWith(':decision-approval'))!
    await b.core.dispatch({ id: 'decisions-b', actor: 'player', interactionId: decisionsB.id, type: 'approve', payload: { roomId: b.roomId, action: 'decisions' } })
    assert.equal(b.runtime.get(b.roomId).phase, 'awaiting-approval')
    a.runtime.cancelTurn(a.roomId)
    await turnA
    for (const request of pendingA.values()) {
      lateStarts.get(request.requestId)?.()
      await a.core.submitModelResult({ requestId: request.requestId, output: outputFor(request) })
    }
    assert.equal(a.runtime.get(a.roomId).phase, 'awaiting-player-input')
    assert.equal(a.runtime.get(a.roomId).draft, undefined)
    assert.equal(b.runtime.get(b.roomId).phase, 'awaiting-approval')
    assert.ok(pendingA.size > 0)
  } finally {
    a.runtime.dispose(); b.runtime.dispose(); await a.container.dispose(); await b.container.dispose(); a.store.close(); b.store.close(); rmSync(a.root, { recursive: true, force: true }); rmSync(b.root, { recursive: true, force: true })
  }
})
