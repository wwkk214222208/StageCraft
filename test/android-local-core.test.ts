import assert from 'node:assert/strict'
import test from 'node:test'
import { installLocalCore, ANDROID_CORE_BUNDLE_VERSION, PROVIDER_SECRET_KEY } from '../src/portable/android-local-core.ts'

/** 带异步桥的假原生：同步操作 + 模型/源异步回调。 */
function fakeNative(room: any) {
  const secrets = new Map<string, string>()
  const transport: any = {
    requests: [],
    invokeSync(operation: string, inputJson: string): string {
      const input = JSON.parse(inputJson)
      if (operation === 'core-state.restore') return JSON.stringify({ revision: 0, state: {}, events: [], workflows: [] })
      if (operation === 'stagecraft.room.get') return JSON.stringify(room)
      if (operation === 'stagecraft.repository') return JSON.stringify(null)
      if (operation === 'secret.get') return secrets.has(input.key) ? JSON.stringify({ found: true, value: secrets.get(input.key) }) : JSON.stringify({ found: false })
      if (operation === 'secret.set') { secrets.set(input.key, String(input.value)); return JSON.stringify({ ok: true }) }
      if (operation === 'secret.remove') { secrets.delete(input.key); return JSON.stringify({ ok: true }) }
      if (operation === 'stories.list') return JSON.stringify({ stories: [{ id: 'eldoria', title: 'Eldoria', mode: 'director', custom: false }] })
      if (operation === 'story.read') return JSON.stringify({ value: JSON.stringify({ id: input.id, title: 'Eldoria', mode: 'director', roles: [], lore: [] }) })
      if (operation === 'model.cancel') return JSON.stringify({ ok: true })
      return JSON.stringify({})
    },
    invokeAsync(operation: string, inputJson: string, callbackId: string): void {
      const input = JSON.parse(inputJson)
      if (operation === 'story.read') {
        globalThis.StageCraftNativeResult.handle(callbackId, JSON.stringify({ value: JSON.stringify({ id: input.id, title: 'Eldoria', mode: 'director', roles: [], lore: [] }) }))
        return
      }
      if (operation === 'model.request') {
        transport.requests.push({ requestId: input.requestId, endpoint: input.endpoint, apiKey: input.apiKey })
        const thinking = input.requestId.startsWith('local:role-decision')
          ? '先掂量局势…'
          : ''
        const output = input.requestId.includes('role-decision')
          ? JSON.stringify({ brief: '观察玩家意图，保持克制。', privateReaction: '记下这个信号。' })
          : input.requestId.includes('director-consult')
            ? JSON.stringify({ text: '我会据此调整。' })
            : JSON.stringify({ text: '（生成的正文）', stateUpdates: {} })
        if (thinking) {
          globalThis.StageCraftNativeResult.handle(callbackId, JSON.stringify({ requestId: input.requestId, thinkingDelta: thinking.slice(0, 1) }))
        }
        // 与 Java 原生传输一致：output 以 JSON 字符串返回，由本地核心归一化解析
        globalThis.StageCraftNativeResult.handle(callbackId, JSON.stringify({ requestId: input.requestId, output, thinking, usage: { promptTokens: 10, completionTokens: 5 } }))
        return
      }
      globalThis.StageCraftNativeResult.handle(callbackId, JSON.stringify({ error: { message: `unsupported async op: ${operation}` } }))
    },
  }
  return { transport, secrets }
}

function streamNative(room: any) {
  const native = fakeNative(room)
  native.transport.invokeAsync = (operation: string, inputJson: string, callbackId: string): void => {
    const input = JSON.parse(inputJson)
    if (operation !== 'model.request') throw new Error(`unexpected async operation: ${operation}`)
    native.transport.requests.push({ requestId: input.requestId, endpoint: input.endpoint, apiKey: input.apiKey })
    const output = input.requestId.includes('role-decision')
      ? { brief: `完成-${input.requestId}`, privateReaction: '独立响应' }
      : { text: '导演正文', stateUpdates: {} }
    const argumentsJson = JSON.stringify(output)
    const middle = Math.floor(argumentsJson.length / 2)
    for (const fragment of [argumentsJson.slice(0, middle), argumentsJson.slice(middle)]) {
      const event = { choices: [{ delta: { content: '{\"ignored\":true}', tool_calls: [{ function: { arguments: fragment } }] } }] }
      globalThis.StageCraftNativeResult.handle(callbackId, JSON.stringify({ requestId: input.requestId, streamPayload: JSON.stringify(event) }))
    }
    globalThis.StageCraftNativeResult.handle(callbackId, JSON.stringify({ requestId: input.requestId, streamPayload: '[DONE]' }))
    globalThis.StageCraftNativeResult.handle(callbackId, JSON.stringify({ requestId: input.requestId, streamComplete: true }))
  }
  return native
}

test('local core routes model requests by provider table and defaults', async () => {
  const room = makeRoom([{ id: 'aria', name: 'Aria', portraitRef: '/assets/default.svg', currentState: 'At the festival.', presence: 'present', selfModel: 'Reserved.' }])
  const { transport, secrets } = fakeNative(room)
  // 预置多供应商表：A 为角色默认，B 为导演默认
  const meta = {
    providers: [
      { id: 'A', name: 'Role Provider', baseUrl: 'https://role.example.com/v1', apiKey: 'role-key', models: ['role-model'], selectedModel: 'role-model', responseFormat: 'json_object' },
      { id: 'B', name: 'Director Provider', baseUrl: 'https://director.example.com/v1', apiKey: 'director-key', models: ['director-model'], selectedModel: 'director-model', responseFormat: 'json_object' },
    ],
    defaults: { role: { providerId: 'A', model: 'role-model' }, director: { providerId: 'B', model: 'director-model' } },
  }
  secrets.set('local.provider.meta', JSON.stringify(meta))
  const globalObject: Record<string, unknown> = { StageCraftNative: transport }
  installLocalCore(globalObject)
  const local = globalObject.StageCraftLocalCore as any
  const messages: any[] = []
  local.start((message: string) => messages.push(JSON.parse(message)))
  await local.submitTurn({ text: '玩家向 Aria 搭话。' })
  // 角色决策按 defaults.role（A）路由；导演用途（director.draft/consult 等）由同一代码路径走 defaults.director
  const roleRequest = transport.requests.find((request: any) => request.requestId.includes('role-decision'))
  assert.ok(roleRequest, 'must issue a role-decision model request')
  assert.equal(roleRequest.endpoint, 'https://role.example.com/v1/chat/completions')
  assert.equal(roleRequest.apiKey, 'role-key')
  // 表读取：无请求上下文时 getProvider 按角色默认解析到 A
  const provider = local.getProvider()
  assert.equal(provider.configured, true)
  assert.equal(provider.baseUrl, 'https://role.example.com/v1')
  assert.equal(provider.model, 'role-model')
  local.dispose()
})

test('local core routes chat role speech to role default and director flows to director default', async () => {
  const room = makeRoom([{ id: 'aria', name: 'Aria', portraitRef: '/assets/default.svg', currentState: 'At the festival.', presence: 'present', selfModel: 'Reserved.' }])
  room.mode = 'chat'
  room.speechMode = 'director'
  const { transport, secrets } = fakeNative(room)
  const meta = {
    providers: [
      { id: 'A', name: 'Role Provider', baseUrl: 'https://role.example.com/v1', apiKey: 'role-key', models: ['role-model'], selectedModel: 'role-model', responseFormat: 'json_object' },
      { id: 'B', name: 'Director Provider', baseUrl: 'https://director.example.com/v1', apiKey: 'director-key', models: ['director-model'], selectedModel: 'director-model', responseFormat: 'json_object' },
    ],
    defaults: { role: { providerId: 'A', model: 'role-model' }, director: { providerId: 'B', model: 'director-model' } },
  }
  secrets.set('local.provider.meta', JSON.stringify(meta))
  const globalObject: Record<string, unknown> = { StageCraftNative: transport }
  installLocalCore(globalObject)
  const local = globalObject.StageCraftLocalCore as any
  const messages: any[] = []
  local.start((message: string) => messages.push(JSON.parse(message)))
  await local.directorDecide()
  await local.speakAll()
  const selectionRequest = transport.requests.find((request: any) => request.requestId.includes('chat-role-selection'))
  assert.ok(selectionRequest, 'must issue a chat-role-selection model request')
  assert.equal(selectionRequest.endpoint, 'https://director.example.com/v1/chat/completions', '导演选角走导演默认')
  const speechRequest = transport.requests.find((request: any) => request.requestId.includes('chat-speech'))
  assert.ok(speechRequest, 'must issue a chat-speech model request')
  assert.equal(speechRequest.endpoint, 'https://role.example.com/v1/chat/completions', '角色发言走角色默认（不再错路由到导演）')
  assert.equal(speechRequest.apiKey, 'role-key')
  local.dispose()
})

test('local core routes desktop-synced flat defaults (defaultRoleProviderId/directorProviderId)', async () => {
  const room = makeRoom([{ id: 'aria', name: 'Aria', portraitRef: '/assets/default.svg', currentState: 'At the festival.', presence: 'present', selfModel: 'Reserved.' }])
  room.mode = 'chat'
  room.speechMode = 'director'
  const { transport, secrets } = fakeNative(room)
  // 桌面 ProviderConfigStore.defaults() 扁平格式：同步后应仍按角色/导演分工路由
  const meta = {
    providers: [
      { id: 'A', name: 'Role Provider', baseUrl: 'https://role.example.com/v1', apiKey: 'role-key', models: ['role-model'], selectedModel: 'role-model', responseFormat: 'json_object' },
      { id: 'B', name: 'Director Provider', baseUrl: 'https://director.example.com/v1', apiKey: 'director-key', models: ['director-model'], selectedModel: 'director-model', responseFormat: 'json_object' },
    ],
    defaults: { defaultRoleProviderId: 'A', defaultRoleModel: 'role-model', directorProviderId: 'B', directorModel: 'director-model' },
  }
  secrets.set('local.provider.meta', JSON.stringify(meta))
  const globalObject: Record<string, unknown> = { StageCraftNative: transport }
  installLocalCore(globalObject)
  const local = globalObject.StageCraftLocalCore as any
  const messages: any[] = []
  local.start((message: string) => messages.push(JSON.parse(message)))
  await local.directorDecide()
  await local.speakAll()
  const selectionRequest = transport.requests.find((request: any) => request.requestId.includes('chat-role-selection'))
  assert.equal(selectionRequest.endpoint, 'https://director.example.com/v1/chat/completions', '桌面同步后导演选角仍走导演默认')
  const speechRequest = transport.requests.find((request: any) => request.requestId.includes('chat-speech'))
  assert.equal(speechRequest.endpoint, 'https://role.example.com/v1/chat/completions', '桌面同步后角色发言仍走角色默认')
  local.dispose()
})

test('local Core installs with async bridge and exposes the rich API facade', async () => {
  const room = makeRoom()
  const { transport, secrets } = fakeNative(room)
  const globalObject: Record<string, unknown> = { StageCraftNative: transport }
  installLocalCore(globalObject)
  const embedded = globalObject.StageCraftEmbeddedCore as any
  const local = globalObject.StageCraftLocalCore as any
  assert.equal(embedded.bundleVersion, ANDROID_CORE_BUNDLE_VERSION)
  assert.equal(typeof local.getRoom, 'function')
  assert.equal(typeof local.submitTurn, 'function')
  assert.equal(typeof local.dispatchCommand, 'function')

  const messages: any[] = []
  local.start((message: string) => messages.push(JSON.parse(message)))
  assert.ok(messages.some(message => message.type === 'connection.state'), 'start must emit connection.state')
  assert.ok(messages.some(message => message.type === 'core.resync'), 'start must emit core.resync')
  assert.equal(local.getRoom().id, 'android-local-room')

  // 供应商配置往返（secret 加密存储由 Java 侧负责，这里仅验证桥契约）
  local.setProvider({ baseUrl: 'https://api.example.com/v1', apiKey: 'secret-key', model: 'deepseek-chat' })
  assert.equal(local.getProvider().configured, true)
  assert.equal(secrets.get(PROVIDER_SECRET_KEY), JSON.stringify({ baseUrl: 'https://api.example.com/v1', apiKey: 'secret-key', model: 'deepseek-chat', responseFormat: 'json_object' }))

  // 剧本目录与剧本加载
  assert.equal(local.stories()[0].id, 'eldoria')
  const story = await local.story('eldoria')
  assert.equal(story.title, 'Eldoria')
  local.dispose()
})

test('local workers drive real model requests through the async bridge', async () => {
  const room = makeRoom([{ id: 'aria', name: 'Aria', portraitRef: '/assets/default.svg', currentState: 'At the festival.', presence: 'present', selfModel: 'Reserved.' }])
  const { transport } = fakeNative(room)
  const globalObject: Record<string, unknown> = { StageCraftNative: transport }
  installLocalCore(globalObject)
  const local = globalObject.StageCraftLocalCore as any
  local.setProvider({ baseUrl: 'https://api.example.com/v1', apiKey: 'key', model: 'deepseek-chat' })
  const messages: any[] = []
  local.start((message: string) => messages.push(JSON.parse(message)))
  // 提交导演回合：真实 workers 经异步桥请求模型并产生草稿/思考事件（fake transport 返回固定决策 JSON）
  await local.submitTurn({ text: '玩家向 Aria 搭话。' })
  assert.ok(room.revision > 0 || messages.some(message => message.type === 'room.changed'), 'turn must progress the room')
  assert.ok(messages.some(message => message.type === 'thinking'), 'turn must emit thinking events')
  local.dispose()
})

test('local core isolates shared stream parsing for an arbitrary concurrent role roster', async () => {
  const roles = Array.from({ length: 5 }, (_, index) => ({
    id: `role-${index + 1}`, name: `Role ${index + 1}`, portraitRef: '/assets/default.svg',
    currentState: 'Here.', presence: 'present', selfModel: `Persona ${index + 1}.`,
  }))
  const room = makeRoom(roles)
  const { transport } = streamNative(room)
  const globalObject: Record<string, unknown> = { StageCraftNative: transport }
  installLocalCore(globalObject)
  const local = globalObject.StageCraftLocalCore as any
  local.setProvider({ baseUrl: 'https://api.example.com/v1', apiKey: 'key', model: 'tool-model' })
  local.start(() => {})
  await local.submitTurn({ text: '同时观察多名角色。', requiredRoleIds: roles.map(role => role.id) })
  const roleRequests = transport.requests.filter((request: any) => request.requestId.includes('role-decision'))
  assert.equal(roleRequests.length, roles.length, 'every concurrent role must complete its own structured stream')
  local.dispose()
})

/** 与 Java SSE 分帧一致：先逐段推 reasoning，再推 content，最后 [DONE]。 */
function reasoningNative(room: any) {
  const native = fakeNative(room)
  native.transport.invokeAsync = (operation: string, inputJson: string, callbackId: string): void => {
    const input = JSON.parse(inputJson)
    if (operation !== 'model.request') throw new Error(`unexpected async operation: ${operation}`)
    native.transport.requests.push({ requestId: input.requestId })
    const output = input.requestId.includes('role-decision')
      ? { brief: '观察玩家意图，保持克制。', privateReaction: '记下这个信号。' }
      : { text: '（生成的正文）', stateUpdates: {} }
    for (const fragment of ['先观察', '玩家的意图，', '再决定如何回应。']) {
      const event = { choices: [{ delta: { reasoning_content: fragment } }] }
      globalThis.StageCraftNativeResult.handle(callbackId, JSON.stringify({ requestId: input.requestId, streamPayload: JSON.stringify(event) }))
    }
    const contentEvent = { choices: [{ delta: { content: JSON.stringify(output) } }] }
    globalThis.StageCraftNativeResult.handle(callbackId, JSON.stringify({ requestId: input.requestId, streamPayload: JSON.stringify(contentEvent) }))
    globalThis.StageCraftNativeResult.handle(callbackId, JSON.stringify({ requestId: input.requestId, streamPayload: '[DONE]' }))
    globalThis.StageCraftNativeResult.handle(callbackId, JSON.stringify({ requestId: input.requestId, streamComplete: true }))
  }
  return native
}

test('local core streams reasoning as incremental thinking events, not only at completion', async () => {
  const room = makeRoom([{ id: 'aria', name: 'Aria', portraitRef: '/assets/default.svg', currentState: 'At the festival.', presence: 'present', selfModel: 'Reserved.' }])
  const { transport } = reasoningNative(room)
  const globalObject: Record<string, unknown> = { StageCraftNative: transport }
  installLocalCore(globalObject)
  const local = globalObject.StageCraftLocalCore as any
  local.setProvider({ baseUrl: 'https://api.example.com/v1', apiKey: 'key', model: 'deepseek-chat' })
  const messages: any[] = []
  local.start((message: string) => messages.push(JSON.parse(message)))
  await local.submitTurn({ text: '玩家向 Aria 搭话。' })

  const events = messages.filter((message: any) => message.type === 'thinking').map((message: any) => message.event)
  const roleEvents = events.filter((event: any) => event.actor === 'role' && event.roleId === 'aria')
  const incremental = roleEvents.filter((event: any) => event.done === false && event.text)

  // 回归要点：修复前 workers 的 requestModel 直接调 modelRequest，绕过了 Core 事件总线，
  // 于是只剩 done:true 的收尾事件（思维链随最终结果一次性出现，看不到"流式"）。
  // 修复后必须收到多段 done:false 的增量。
  assert.ok(incremental.length >= 2, `思维链必须逐段上报，实际只收到 ${incremental.length} 段增量`)
  assert.equal(incremental.map((event: any) => event.text).join(''), '先观察玩家的意图，再决定如何回应。')
  assert.ok(roleEvents.some((event: any) => event.done === true), '结束时仍要有 done 收尾事件')
  local.dispose()
})

function makeRoom(roles: any[] = []) {
  return { id: 'android-local-room', title: 'Test', mode: 'director', autoPublish: false, speechMode: 'manual', hidePlayerSpeech: false, playerCharacter: { name: 'Player', persona: '', currentState: '' }, phase: 'awaiting-player-input', revision: 0, consultations: [], roles, reactions: [], decisions: [], scenes: [{ id: 'opening', turnId: 'opening', text: 'The festival begins.', kind: 'narration', createdAt: new Date().toISOString() }], lore: [] }
}
