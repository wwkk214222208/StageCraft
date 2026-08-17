import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'

test('room archive round-trips canonical scenes and roles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'character-tavern-archive-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store)
  await runtime.submitTurn(roomId, { text: '存档测试。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const draft = runtime.get(roomId).draft!
  runtime.approve(roomId, draft.id, draft.text, draft.stateUpdates)
  const archive = runtime.exportArchive(roomId)
  runtime.restart(roomId, { id: 'copy', title: '临时', opening: '临时', roles: [] as never[] })
  runtime.importArchive(roomId, archive as { room: ReturnType<typeof runtime.get> })
  const restored = runtime.get(roomId)
  assert.equal(restored.scenes.length, 2, '存档往返应保留开局 scene + 已批准正文')
  assert.equal(restored.scenes[0].turnId, 'opening')
  assert.equal(restored.roles.find(role => role.id === 'aria')?.name, 'Aria')
})
