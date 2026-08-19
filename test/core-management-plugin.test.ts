import test from 'node:test'
import assert from 'node:assert/strict'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { StageCraftSolutionPlugin } from '../src/core/solutions.ts'
import type { StageCraftManagementPort } from '../src/stagecraft-management-service.ts'
import { createRealWorkers } from '../src/model-gateway.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.ts'
import { RoomRuntime } from '../src/room-runtime.ts'
import { loadStoryPackage } from '../src/story-packages.ts'
import { LegacyRuntimeSolutionPlugin } from '../src/core/command-adapter.ts'

test('management commands use the installed narrow handler and reject invalid operations without legacy fallback', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const calls: Array<{ method: string; args: unknown[] }> = []
  const management = new Proxy({}, { get: (_target, property: string) => (...args: unknown[]) => { calls.push({ method: property, args }) } }) as StageCraftManagementPort
  container.addSolution(new StageCraftSolutionPlugin({ management, defaultRoomId: 'room-1' }))
  await core.dispatch({ id: 'room-config', actor: 'operator', type: 'role-management', payload: { roomId: 'room-1', operation: 'set-room-config', mode: 'chat', autoPublish: true } })
  assert.deepEqual(calls, [{ method: 'setRoomConfig', args: ['room-1', { mode: 'chat', autoPublish: true }] }])
  await assert.rejects(() => core.dispatch({ id: 'bad-management', actor: 'operator', type: 'role-management', payload: { roomId: 'room-1', operation: 'not-real' } }), /Unsupported management operation: not-real/)
  assert.equal(calls.length, 1)
  const revisionBeforeInvalid = core.getView().revision
  const invalidCommands = [
    { id: 'bad-presence', type: 'role-management', payload: { roomId: 'room-1', operation: 'set-role-presence', roleId: 'aria', presence: 'online' } },
    { id: 'bad-thinking', type: 'role-management', payload: { roomId: 'room-1', operation: 'set-role-thinking', roleId: 'aria', thinkingStrength: 'max' } },
    { id: 'bad-role', type: 'role-management', payload: { roomId: 'room-1', operation: 'create-role', role: { id: 'aria' } } },
    { id: 'bad-memory', type: 'role-management', payload: { roomId: 'room-1', operation: 'store-memories', roleId: 'aria', entries: [{ text: '' }] } },
    { id: 'bad-supersede', type: 'role-management', payload: { roomId: 'room-1', operation: 'supersede-memory', entry: { text: '替代', occurredAt: '过去' } } },
    { id: 'bad-restart', type: 'restart', payload: { roomId: 'room-1', story: { id: 'story', title: '缺少角色' } } },
  ] as const
  for (const command of invalidCommands) {
    await assert.rejects(() => core.dispatch({ ...command, actor: 'operator' } as any))
    assert.equal(calls.length, 1, command.id)
    assert.equal(core.getView().revision, revisionBeforeInvalid, command.id)
  }
  await assert.rejects(() => core.dispatch({ id: 'unhandled', actor: 'operator', type: 'submit-text', payload: { roomId: 'room-1', action: 'not-real' } }), /Core command has no handler: submit-text/)
  assert.equal(calls.length, 1)
  await container.dispose()
})

test('management handler maps every supported operation to its narrow port method', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const calls: Array<{ method: string; args: unknown[] }> = []
  const management = new Proxy({}, { get: (_target, property: string) => (...args: unknown[]) => { calls.push({ method: property, args }) } }) as StageCraftManagementPort
  container.addSolution(new StageCraftSolutionPlugin({ management, defaultRoomId: 'room-1' }))
  const role = { id: 'new-role', name: '新角色', portraitRef: '/assets/new.svg', currentState: '在场', presence: 'present' as const, selfModel: '谨慎', memoryTimeline: {} }
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['import-archive', { archive: { room: {} } }, 'importArchive'],
    ['set-room-config', { mode: 'chat', autoPublish: true }, 'setRoomConfig'],
    ['update-player-character', { name: '玩家', persona: '观察者', currentState: '站在门口' }, 'updatePlayerCharacter'],
    ['set-player-avatar', { portraitRef: '/assets/player.svg' }, 'setPlayerAvatar'],
    ['intervene-role', { roleId: 'aria', selfModel: '克制', memoryTimeline: {}, config: {} }, 'interveneRole'],
    ['store-memories', { roleId: 'aria', entries: [{ text: '记住这件事', occurredAt: '过去' }] }, 'storeNpcMemories'],
    ['retract-memory', { memoryId: 'memory-1' }, 'retractNpcMemory'],
    ['update-memory', { memoryId: 'memory-1', entry: { text: '更新', occurredAt: '过去' } }, 'updateNpcMemory'],
    ['reorder-memories', { roleId: 'aria', memoryIds: ['memory-1'] }, 'reorderNpcMemories'],
    ['supersede-memory', { memoryId: 'memory-1', entry: { text: '替代', occurredAt: '过去' } }, 'supersedeNpcMemory'],
    ['save-lore', { lore: [{ name: '规则', content: '夜晚很安静' }] }, 'saveLore'],
    ['create-role', { role }, 'createRole'],
    ['delete-role', { roleId: 'aria' }, 'deleteRole'],
    ['set-role-presence', { roleId: 'aria', presence: 'absent' }, 'setRolePresence'],
    ['set-role-thinking', { roleId: 'aria', thinkingStrength: 'deep' }, 'setRoleThinking'],
    ['reorder-roles', { roleIds: ['aria'] }, 'reorderRoles'],
    ['set-role-avatar', { roleId: 'aria', portraitRef: '/assets/aria.svg' }, 'setRoleAvatar'],
    ['set-role-state', { roleId: 'aria', currentState: '靠近窗边' }, 'setRoleCurrentState'],
    ['set-director-setting', { text: '保持压迫感' }, 'setDirectorSetting'],
    ['update-scene', { time: '黄昏', location: '塔顶' }, 'updateScene'],
  ]
  for (const [operation, payload, method] of cases) {
    calls.length = 0
    await core.dispatch({ id: `management-${operation}`, actor: 'operator', type: 'role-management', payload: { roomId: 'room-1', operation, ...payload } })
    assert.equal(calls[0]?.method, method, operation)
    assert.equal(calls.length, 1, operation)
  }
  calls.length = 0
  await core.dispatch({ id: 'management-restart', actor: 'operator', type: 'restart', payload: { roomId: 'room-1', story: { id: 'story', title: '故事', roles: [role] } } })
  assert.equal(calls[0]?.method, 'restart')
  await container.dispose()
})

test('Core workers advertise request-scoped cancellation only when cancelModel is installed', () => {
  const requestModel = async () => ({ requestId: 'request', output: {} })
  assert.equal(createRealWorkers({} as any, () => ({} as any), { requestModel }).supportsRequestCancellation, false)
  assert.equal(createRealWorkers({} as any, () => ({} as any), { requestModel, cancelModel: async () => {} }).supportsRequestCancellation, true)
})

test('RoomRuntime facade delegates to its single Store-backed management service and projects once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-management-'))
  const store = new Store(join(root, 'state.sqlite'))
  const roomId = store.seed(loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria'))
  const core = new CoreRuntimeSkeleton()
  const runtime = new RoomRuntime(store, undefined, core)
  const container = new DefaultCorePluginContainer(core)
  container.addSolution(new StageCraftSolutionPlugin({ management: runtime.getManagementService(), defaultRoomId: roomId }))
  core.projectRoom(runtime.get(roomId))
  let projections = 0
  const unsubscribe = core.subscribe(event => { if (event.type === 'state.changed') projections += 1 })
  try {
    runtime.setRoomConfig(roomId, { mode: 'chat' })
    assert.equal(runtime.get(roomId).mode, 'chat')
    assert.equal(projections, 1)
    assert.equal((core.getView().state as { room: { mode: string } }).room.mode, 'chat')
  } finally {
    unsubscribe(); runtime.dispose(); await container.dispose(); store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('legacy compatibility adapter works only while explicitly installed', async () => {
  const core = new CoreRuntimeSkeleton()
  let calls = 0
  const container = new DefaultCorePluginContainer(core)
  const installation = container.addSolution(new LegacyRuntimeSolutionPlugin({ runtime: { submitTurn: async () => { calls += 1 } } as any, defaultRoomId: 'room-1' }))
  await core.dispatch({ id: 'legacy', actor: 'operator', type: 'submit-text', payload: {} })
  assert.equal(calls, 1)
  await installation.dispose()
  await assert.rejects(() => core.dispatch({ id: 'closed', actor: 'operator', type: 'submit-text', payload: {} }), /Core command has no handler: submit-text/)
  assert.equal(calls, 1)
  await container.dispose()
})
