import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'

test('Core Event Log persists room projection events and restores them', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-event-log-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const roomId = store.seed(loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria'))
    const room = store.getRoom(roomId)
    const eventLog = { append: (id: string, revision: number, event: import('../src/core/protocol.ts').StateEvent) => store!.appendCoreEvent(id, revision, event), list: (id: string, limit?: number) => store!.listCoreEvents(id, limit) }

    const initial = new CoreRuntimeSkeleton()
    initial.attachEventLog(eventLog)
    initial.projectRoom(room, 'test:initial')
    initial.projectRoom(room, 'test:duplicate')

    const events = store.listCoreEvents(roomId)
    assert.equal(events.length, 1, 'same room revision has a deterministic event id and is deduplicated')
    assert.equal(events[0].type, 'room.snapshot.projected')
    assert.equal(events[0].causedBy, 'test:initial')

    const restored = new CoreRuntimeSkeleton()
    restored.attachEventLog(eventLog)
    restored.restoreEventHistory(roomId)
    assert.equal(restored.getView().recentEvents.length, 1)
    assert.equal(restored.getView().recentEvents[0].id, events[0].id)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
