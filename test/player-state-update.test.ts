import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'

test('approved Draft can update only the player current state through player key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'character-tavern-player-state-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store)
  runtime.updatePlayerCharacter(roomId, { name: '林', persona: '谨慎的旅人。', currentState: '位于入口。' })
  await runtime.submitTurn(roomId, { text: '我走进主厅。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const draft = runtime.get(roomId).draft!
  runtime.approve(roomId, draft.id, draft.text, { ...draft.stateUpdates, player: '位于主厅中央。' })
  assert.deepEqual(runtime.get(roomId).playerCharacter, { name: '林', persona: '谨慎的旅人。', currentState: '位于主厅中央。' })
})
