import assert from 'node:assert/strict'
import test from 'node:test'
import { installAndroidCore, ANDROID_CORE_BRIDGE_VERSION, ANDROID_CORE_BUNDLE_VERSION } from '../src/portable/android-core.ts'

test('embedded Android composition executes shared Core and speaks the bridge protocol', async () => {
  const globalObject: Record<string, unknown> = { StageCraftNative: { invokeSync: (operation: string) => JSON.stringify(operation === 'core-state.restore' ? { revision: 0, state: {}, events: [], workflows: [] } : operation === 'stagecraft.room.get' ? { id: 'android-local-room', title: 'Test', mode: 'director', autoPublish: false, playerCharacter: { name: 'Player', persona: '', currentState: '' }, phase: 'awaiting-player-input', revision: 0, consultations: [], roles: [], reactions: [], decisions: [], scenes: [], lore: [] } : {}) } }
  installAndroidCore(globalObject)
  const api = globalObject.StageCraftEmbeddedCore as any
  assert.equal(api.bundleVersion, ANDROID_CORE_BUNDLE_VERSION)
  assert.equal(api.bridgeVersion, ANDROID_CORE_BRIDGE_VERSION)
  const messages: any[] = []
  api.start((message: string) => messages.push(JSON.parse(message)))
  assert.equal(messages[0].type, 'connection.state')
  assert.equal(messages[1].type, 'core.resync')
  assert.equal(messages[1].view.protocolVersion, '1.1')
  api.dispatch(JSON.stringify({ id: 'android-test', actor: 'player', type: 'submit-text', payload: { text: 'hello' } }))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(messages.some(message => message.type === 'connection.error' && /Core command has no handler/.test(message.message)))
  api.dispose()
})

test('embedded Core refresh projects native repository writes into the current view', () => {
  let room: any = { id: 'android-local-room', title: 'Before', mode: 'director', autoPublish: false, playerCharacter: { name: 'Player', persona: '', currentState: '' }, phase: 'awaiting-player-input', revision: 0, consultations: [], roles: [], reactions: [], decisions: [], scenes: [], lore: [] }
  const globalObject: Record<string, unknown> = { StageCraftNative: { invokeSync: (operation: string, inputJson: string) => {
    const input = JSON.parse(inputJson)
    if (operation === 'core-state.restore') return JSON.stringify({ revision: 0, state: {}, events: [], workflows: [] })
    if (operation === 'stagecraft.room.get') return JSON.stringify(room)
    if (operation === 'stagecraft.repository') {
      if (input.method === 'llmStateRead') return JSON.stringify({ value: null })
      if (input.method === 'llmStateWrite' || input.method === 'llmStateDelete') return JSON.stringify({ ok: true })
      if (input.method === 'setContribution') { room = { ...room, title: 'After native write', revision: 1 }; return JSON.stringify(null) }
      return JSON.stringify({})
    }
    return JSON.stringify({})
  } } }
  installAndroidCore(globalObject)
  const api = globalObject.StageCraftEmbeddedCore as any
  const messages: any[] = []
  api.start((message: string) => messages.push(JSON.parse(message)))
  assert.equal(messages.at(-1).view.state.room.title, 'Before')
  const operations = (globalObject.StageCraftNative as any)
  operations.invokeSync('stagecraft.repository', JSON.stringify({ method: 'setContribution', args: ['android-local-room', 'native'] }))
  api.refresh()
  assert.equal(messages.at(-1).view.state.room.title, 'After native write')
  api.dispose()
})
