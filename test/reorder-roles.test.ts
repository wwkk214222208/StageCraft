import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.ts'
import { RoomRuntime } from '../src/room-runtime.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-reorder-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store)
  return { store, runtime, roomId }
}

test('reorder roles persists new order', () => {
  const { runtime, roomId } = fixture()
  const original = runtime.get(roomId).roles.map(role => role.id)
  assert.deepEqual(original, ['aria', 'mira', 'noel'])
  // 反转顺序
  const reversed = [...original].reverse()
  runtime.reorderRoles(roomId, reversed)
  assert.deepEqual(runtime.get(roomId).roles.map(role => role.id), reversed)
})

test('reorder validates role list completeness', () => {
  const { runtime, roomId } = fixture()
  assert.throws(() => runtime.reorderRoles(roomId, ['aria', 'mira']), /does not match/)
  assert.throws(() => runtime.reorderRoles(roomId, ['aria', 'mira', 'ghost']), /Unknown role/)
})

test('reorder requires idle phase', async () => {
  const { runtime, roomId } = fixture()
  await runtime.submitTurn(roomId, { text: '测试。', requiredRoleIds: ['aria'] })
  assert.throws(() => runtime.reorderRoles(roomId, ['noel', 'mira', 'aria']), /空闲时进行/)
})
