import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.ts'
import { RoomRuntime } from '../src/room-runtime.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CoreEvent } from '../src/core/protocol.ts'
import { installStageCraftSolution } from './core-solution-test-utils.ts'

test('RoomRuntime state changes emit Core Events through projectRoom', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-integration-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'test.sqlite'))
    const storiesPath = fileURLToPath(new URL('../stories', import.meta.url))
    const roomId = store.seed(loadStoryPackage(storiesPath, 'eldoria'))
    
    const core = new CoreRuntimeSkeleton()
    installStageCraftSolution(core)
    const runtime = new RoomRuntime(store, undefined, core)
    
    const events: CoreEvent[] = []
    core.subscribe(event => events.push(event))
    
    // 触发简单状态变更：setRolePresence 会调用 emit
    const room = store.getRoom(roomId)
    const firstRole = room.roles[0]
    runtime.setRolePresence(roomId, firstRole.id, 'absent')
    
    // 验证至少有一个 state.changed 事件
    const stateEvents = events.filter(e => e.type === 'state.changed')
    assert(stateEvents.length >= 1, `Expected at least 1 state.changed event, got ${stateEvents.length}`)
    
    // 验证最后一个事件的 revision 匹配当前房间
    const latestRoom = store.getRoom(roomId)
    const view = core.getView()
    assert.equal(view.revision, latestRoom.revision)
    
    // 验证投影的状态包含角色信息
    const state = view.state as { entities?: { roles?: unknown[] } }
    assert(state.entities?.roles, 'Expected entities.roles in projected state')
    assert.equal(state.entities.roles.length, room.roles.length)
    
    store.close()
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
