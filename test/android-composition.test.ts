import assert from 'node:assert/strict'
import test from 'node:test'
import { createAndroidComposition } from '../src/portable/android-composition.ts'

function operations() {
  const state = new Map<string, unknown>()
  const room = { id: 'android-local-room', title: 'Local', mode: 'chat', phase: 'awaiting-player-input', revision: 0, roles: [], lore: [], scenes: [] } as any
  return {
    invokeSync(operation: string, input: any = {}) {
      if (operation === 'stagecraft.room.get') return room
      if (operation === 'core-state.restore') return state.get(input.roomId)
      if (operation === 'core-state.commit') { state.set(input.roomId, input); return {} }
      if (operation === 'stagecraft.repository') throw new Error(`repository method not configured: ${input.method}`)
      return {}
    },
    invoke() { return {} },
  } as any
}

test('Android composition starts the real StageCraft solution and exposes lifecycle protocol', async () => {
  const messages: any[] = []
  const composition = createAndroidComposition(operations(), { onMessage: value => messages.push(value) })
  composition.start()
  assert.equal(messages[0].type, 'connection.state')
  assert.equal(composition.core.getView().protocolVersion, '1.0')
  composition.refresh()
  composition.stop()
  composition.stop()
  composition.dispose()
})

test('Android composition cancellation is forwarded to Core without Java domain logic', async () => {
  const composition = createAndroidComposition(operations())
  composition.start()
  await composition.cancel('missing-request')
  composition.dispose()
})
