import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.ts'
import { RoomRuntime } from '../src/room-runtime.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import type { CoreEvent } from '../src/core/protocol.ts'

test('chat speech lifecycle emits and persists domain events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-domain-events-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    store.restartRoom(roomId, story, { mode: 'chat' })
    const core = new CoreRuntimeSkeleton()
    core.attachEventLog({
      append: (id, revision, event) => store!.appendCoreEvent(id, revision, event),
      appendDomain: (id, revision, event) => store!.appendCoreDomainEvent(id, revision, event),
      list: (id, limit) => store!.listCoreEvents(id, limit),
      listDomain: (id, limit) => store!.listCoreDomainEvents(id, limit),
    })
    const runtime = new RoomRuntime(store, undefined, core)
    const received: CoreEvent[] = []
    core.subscribe(event => received.push(event))

    await runtime.submitTurn(roomId, { text: '我走近炉火。' })
    const roleId = store.getRoom(roomId).roles.find(role => role.presence === 'present')!.id
    await runtime.speak(roomId, roleId)
    const pending = store.getRoom(roomId).speech!
    await runtime.approveSpeech(roomId, pending.text)

    const types = store.listCoreDomainEvents(roomId).map(event => event.type)
    assert.deepEqual(types, [
      'player.contribution.submitted',
      'role.speech.requested',
      'role.speech.generated',
      'speech.approved',
      'scene.published',
    ])
    assert(received.some(event => event.type === 'domain.event' && event.event.type === 'role.speech.generated'))
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
