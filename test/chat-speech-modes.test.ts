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
import { fakeWorkers, type WorkerSet } from '../src/workers.ts'
import { installStageCraftSolution, installLegacyRuntimeSolution } from './core-solution-test-utils.ts'

function chatCore(root: string, workers?: WorkerSet) {
  const store = new Store(join(root, 'state.sqlite'))
  const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
  const roomId = store.seed(story)
  store.restartRoom(roomId, story, { mode: 'chat' })
  const core = new CoreRuntimeSkeleton()
  const container = installStageCraftSolution(core)
  const runtime = new RoomRuntime(store, workers, core)
  installLegacyRuntimeSolution(container, runtime, roomId)
  core.attachWorkflowStore({ save: (id, instance) => store.saveWorkflowInstance(id, instance), list: id => store.listWorkflowInstances(id) })
  core.projectRoom(store.getRoom(roomId))
  return { store, core, roomId, container }
}

test('story gameplay declares chat speechMode which flows into the room and persists', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-chat-mode-'))
  const store = new Store(join(root, 'state.sqlite'))
  const base = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
  const story = { ...base, gameplay: { chat: { speechMode: 'director' as const } } }
  try {
    const roomId = store.seed(story)
    store.restartRoom(roomId, story, { mode: 'chat' })
    assert.equal(store.getRoom(roomId).speechMode, 'director')
    // 玩家可覆盖并持久化（speechMode 覆盖 = all）
    store.setRoomConfig(roomId, { speechMode: 'all' })
    assert.equal(store.getRoom(roomId).speechMode, 'all')
  } finally {
    store.close()
    // 未声明的玩法回退 manual（新 store，避免 seed 复用同 story_id 的房间）
    const store2 = new Store(join(root, 'state2.sqlite'))
    try {
      const plain = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
      const room2 = store2.seed(plain)
      assert.equal(store2.getRoom(room2).speechMode, 'manual')
    } finally {
      store2.close()
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('director speech mode: director selects roles (no approval of selection), speeches generated and approved one by one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-chat-mode-'))
  let store: Store | undefined
  let setup: ReturnType<typeof chatCore> | undefined
  const workers: WorkerSet = {
    ...fakeWorkers,
    selectSpeakingRoles: async context => ({ roleIds: context.roles.filter(role => role.presence === 'present').slice(0, 2).map(role => role.id), reason: '剧情需要。' }),
  }
  try {
    setup = chatCore(root, workers)
    store = setup.store
    const roomId = setup.roomId
    store.setRoomConfig(roomId, { speechMode: 'director' })
    assert.equal(store.getRoom(roomId).speechMode, 'director')

    await setup.core.dispatch({ id: 'submit', actor: 'player', type: 'submit-text', payload: { roomId, scope: 'chat', action: 'chat-contribution', text: '玩家推开门走进来。' } })
    assert.equal(store.getRoom(roomId).phase, 'awaiting-player-input')

    // 导演选角：不需要玩家审批选角，直接进入首位角色发言
    await setup.core.dispatch({ id: 'decide', actor: 'player', type: 'select-role', payload: { roomId, scope: 'chat', action: 'director-role-selection' } })
    let room = store.getRoom(roomId)
    assert.equal(room.phase, 'awaiting-approval')
    const first = room.speech!
    assert.ok(first.text)

    // 逐个审批：第一位批准后自动进入第二位
    await setup.core.dispatch({ id: 'approve1', actor: 'player', type: 'approve', payload: { roomId, scope: 'chat', action: 'speech', text: first.text } })
    room = store.getRoom(roomId)
    assert.equal(room.phase, 'awaiting-approval')
    assert.ok(room.speech)
    assert.notEqual(room.speech.roleId, first.roleId)

    // 第二位批准后回合结束
    await setup.core.dispatch({ id: 'approve2', actor: 'player', type: 'approve', payload: { roomId, scope: 'chat', action: 'speech', text: room.speech.text } })
    room = store.getRoom(roomId)
    assert.equal(room.phase, 'awaiting-player-input')
    const speakers = room.scenes.filter(scene => scene.speaker && scene.speaker !== 'player').map(scene => scene.speaker)
    assert.deepEqual(speakers.slice(-2), [first.roleId, room.scenes.at(-1)!.speaker])
    assert.notEqual(speakers[speakers.length - 1], first.roleId)
  } finally {
    await setup?.container.dispose()
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('director speech mode: empty role selection falls back to a local random present role', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-chat-mode-'))
  let store: Store | undefined
  let setup: ReturnType<typeof chatCore> | undefined
  const workers: WorkerSet = { ...fakeWorkers, selectSpeakingRoles: async () => ({ roleIds: [] }) }
  try {
    setup = chatCore(root, workers)
    store = setup.store
    const roomId = setup.roomId
    store.setRoomConfig(roomId, { speechMode: 'director' })
    await setup.core.dispatch({ id: 'submit', actor: 'player', type: 'submit-text', payload: { roomId, scope: 'chat', action: 'chat-contribution', text: '玩家环顾四周。' } })
    await setup.core.dispatch({ id: 'decide', actor: 'player', type: 'select-role', payload: { roomId, scope: 'chat', action: 'director-role-selection' } })
    const room = store.getRoom(roomId)
    assert.equal(room.phase, 'awaiting-approval')
    assert.ok(room.speech)
    assert.equal(room.roles.find(role => role.id === room.speech!.roleId)?.presence, 'present')
  } finally {
    await setup?.container.dispose()
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('all speech mode: every present role speaks in role order, approved one by one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-chat-mode-'))
  let store: Store | undefined
  let setup: ReturnType<typeof chatCore> | undefined
  try {
    setup = chatCore(root)
    store = setup.store
    const roomId = setup.roomId
    store.setRoomConfig(roomId, { speechMode: 'all' })
    const present = store.getRoom(roomId).roles.filter(role => role.presence === 'present').map(role => role.id)
    assert.ok(present.length >= 2, 'eldoria should have at least two present roles')

    await setup.core.dispatch({ id: 'submit', actor: 'player', type: 'submit-text', payload: { roomId, scope: 'chat', action: 'chat-contribution', text: '玩家宣布了一件事。' } })
    await setup.core.dispatch({ id: 'all', actor: 'player', type: 'select-role', payload: { roomId, scope: 'chat', action: 'chat-speech-all' } })

    let room = store.getRoom(roomId)
    const speakers: string[] = []
    let guard = 0
    while (room.phase === 'awaiting-approval' && room.speech && guard < 10) {
      speakers.push(room.speech.roleId)
      await setup.core.dispatch({ id: `approve-${guard}`, actor: 'player', type: 'approve', payload: { roomId, scope: 'chat', action: 'speech', text: room.speech.text } })
      room = store.getRoom(roomId)
      guard += 1
    }
    assert.equal(room.phase, 'awaiting-player-input')
    assert.deepEqual(speakers, present)
  } finally {
    await setup?.container.dispose()
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
