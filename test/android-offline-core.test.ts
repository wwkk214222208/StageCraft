import assert from 'node:assert/strict'
import test from 'node:test'
import { installOfflineCore, ANDROID_CORE_BUNDLE_VERSION, PROVIDER_SECRET_KEY } from '../src/portable/android-offline-core.ts'

/** 带异步桥的假原生：同步操作 + 模型/源异步回调。 */
function fakeNative(room: any) {
  const secrets = new Map<string, string>()
  const transport = {
    invokeSync(operation: string, inputJson: string): string {
      const input = JSON.parse(inputJson)
      if (operation === 'core-state.restore') return JSON.stringify({ revision: 0, state: {}, events: [], workflows: [] })
      if (operation === 'stagecraft.room.get') return JSON.stringify(room)
      if (operation === 'stagecraft.repository') return JSON.stringify(null)
      if (operation === 'secret.get') return secrets.has(input.key) ? JSON.stringify({ found: true, value: secrets.get(input.key) }) : JSON.stringify({ found: false })
      if (operation === 'secret.set') { secrets.set(input.key, String(input.value)); return JSON.stringify({ ok: true }) }
      if (operation === 'secret.remove') { secrets.delete(input.key); return JSON.stringify({ ok: true }) }
      if (operation === 'stories.list') return JSON.stringify({ stories: [{ id: 'eldoria', title: 'Eldoria', mode: 'director', custom: false }] })
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
        const thinking = input.requestId.startsWith('offline:role-decision')
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
        globalThis.StageCraftNativeResult.handle(callbackId, JSON.stringify({ requestId: input.requestId, output: output.startsWith('{') ? JSON.parse(output) : output, thinking, usage: { promptTokens: 10, completionTokens: 5 } }))
        return
      }
      globalThis.StageCraftNativeResult.handle(callbackId, JSON.stringify({ error: { message: `unsupported async op: ${operation}` } }))
    },
  }
  return { transport, secrets }
}

test('offline Core installs with async bridge and exposes the rich API facade', async () => {
  const room = makeRoom()
  const { transport, secrets } = fakeNative(room)
  const globalObject: Record<string, unknown> = { StageCraftNative: transport }
  installOfflineCore(globalObject)
  const embedded = globalObject.StageCraftEmbeddedCore as any
  const offline = globalObject.StageCraftOfflineCore as any
  assert.equal(embedded.bundleVersion, ANDROID_CORE_BUNDLE_VERSION)
  assert.equal(typeof offline.getRoom, 'function')
  assert.equal(typeof offline.submitTurn, 'function')
  assert.equal(typeof offline.dispatchCommand, 'function')

  const messages: any[] = []
  offline.start((message: string) => messages.push(JSON.parse(message)))
  assert.ok(messages.some(message => message.type === 'connection.state'), 'start must emit connection.state')
  assert.ok(messages.some(message => message.type === 'core.resync'), 'start must emit core.resync')
  assert.equal(offline.getRoom().id, 'android-local-room')

  // 供应商配置往返（secret 加密存储由 Java 侧负责，这里仅验证桥契约）
  offline.setProvider({ baseUrl: 'https://api.example.com/v1', apiKey: 'secret-key', model: 'deepseek-chat' })
  assert.equal(offline.getProvider().configured, true)
  assert.equal(secrets.get(PROVIDER_SECRET_KEY), JSON.stringify({ baseUrl: 'https://api.example.com/v1', apiKey: 'secret-key', model: 'deepseek-chat', responseFormat: 'json_object' }))

  // 剧本目录与剧本加载
  assert.equal(offline.stories()[0].id, 'eldoria')
  const story = await offline.story('eldoria')
  assert.equal(story.title, 'Eldoria')
  offline.dispose()
})

test('offline workers drive real model requests through the async bridge', async () => {
  const room = makeRoom([{ id: 'aria', name: 'Aria', portraitRef: '/assets/default.svg', currentState: 'At the festival.', presence: 'present', selfModel: 'Reserved.' }])
  const { transport } = fakeNative(room)
  const globalObject: Record<string, unknown> = { StageCraftNative: transport }
  installOfflineCore(globalObject)
  const offline = globalObject.StageCraftOfflineCore as any
  offline.setProvider({ baseUrl: 'https://api.example.com/v1', apiKey: 'key', model: 'deepseek-chat' })
  const messages: any[] = []
  offline.start((message: string) => messages.push(JSON.parse(message)))
  // 提交导演回合：真实 workers 经异步桥请求模型并产生草稿/思考事件（fake transport 返回固定决策 JSON）
  await offline.submitTurn({ text: '玩家向 Aria 搭话。' })
  assert.ok(room.revision > 0 || messages.some(message => message.type === 'room.changed'), 'turn must progress the room')
  assert.ok(messages.some(message => message.type === 'thinking'), 'turn must emit thinking events')
  offline.dispose()
})

function makeRoom(roles: any[] = []) {
  return { id: 'android-local-room', title: 'Test', mode: 'director', autoPublish: false, speechMode: 'manual', hidePlayerSpeech: false, playerCharacter: { name: 'Player', persona: '', currentState: '' }, phase: 'awaiting-player-input', revision: 0, consultations: [], roles, reactions: [], decisions: [], scenes: [{ id: 'opening', turnId: 'opening', text: 'The festival begins.', kind: 'narration', createdAt: new Date().toISOString() }], lore: [] }
}