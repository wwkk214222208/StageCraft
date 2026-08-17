import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import { loadStoryPackage } from '../src/story-packages.ts'

const stories = join(import.meta.dirname, '..', 'stories')
const fixtures = join(import.meta.dirname, 'fixtures')

test('restart atomically clears the current room and applies the selected story package', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-restart-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store)
  await runtime.submitTurn(roomId, { text: '旧回合。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const oldDraft = runtime.get(roomId).draft
  assert.ok(oldDraft)
  runtime.approve(roomId, oldDraft.id, oldDraft.text, oldDraft.stateUpdates)
  runtime.restart(roomId, loadStoryPackage(fixtures, 'royal-festival'))
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.scenes.length, 1, '重开后开局文本成为第一条历史 scene')
  assert.equal(room.scenes[0].text, loadStoryPackage(fixtures, 'royal-festival').opening)
  assert.equal(room.draft, undefined)
  assert.equal(room.consultations.length, 0)
})

test('restart is allowed while the room is awaiting approval and clears the draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-restart-busy-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store)
  await runtime.submitTurn(roomId, { text: '不能误删。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  runtime.restart(roomId, loadStoryPackage(fixtures, 'royal-festival'))
  assert.equal(runtime.get(roomId).phase, 'awaiting-player-input')
  assert.equal(runtime.get(roomId).draft, undefined)
})
