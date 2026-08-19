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
import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { LegacyRuntimeSolutionPlugin } from '../src/core/command-adapter.ts'

test('CoreRuntime dispatches submit-text to legacy RoomRuntime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-command-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    const core = new CoreRuntimeSkeleton()
    const runtime = new RoomRuntime(store, undefined, core)
    const container = new DefaultCorePluginContainer(core)
    container.addSolution(new LegacyRuntimeSolutionPlugin({ runtime, defaultRoomId: roomId }))
    await core.dispatch({ id: 'cmd-1', actor: 'player', type: 'submit-text', payload: { text: '玩家输入' } })
    assert.equal(store.getRoom(roomId).playerContribution, '玩家输入')
    await container.dispose()
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('CoreRuntime rejects unsupported command without changing legacy state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-command-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    const core = new CoreRuntimeSkeleton()
    const runtime = new RoomRuntime(store, undefined, core)
    const container = new DefaultCorePluginContainer(core)
    container.addSolution(new LegacyRuntimeSolutionPlugin({ runtime, defaultRoomId: roomId }))
    await assert.rejects(() => core.dispatch({ id: 'cmd-2', actor: 'player', type: 'reject', payload: { action: 'draft' } }), /No draft is awaiting rejection|Unsupported reject action/)
    assert.equal(store.getRoom(roomId).phase, 'awaiting-player-input')
    await container.dispose()
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
