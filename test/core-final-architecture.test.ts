import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { StageCraftSolutionPlugin } from '../src/core/solutions.ts'
import type { CoreSolutionPlugin } from '../src/core/plugins.ts'
import type { StageCraftChatPort, StageCraftDirectorPort } from '../src/core/solutions.ts'

test('generic Core files do not depend on RoomRuntime, StageCraft services, or app boot', () => {
  const coreRoot = fileURLToPath(new URL('../src/core/', import.meta.url))
  const boundaryFiles = new Set([
    'command-adapter.ts',
    'solutions.ts',
    'model-router-adapter.ts',
    'store-state-repository.ts',
    'http-human-plugin.ts',
  ])
  const forbiddenImport = /from\s+['"]\.\.\/(?:room-runtime|stagecraft-[^'"/]+|app-boot)(?:\.ts)?['"]/
  const violations: string[] = []
  for (const file of readdirSync(coreRoot).filter(name => name.endsWith('.ts') && !boundaryFiles.has(name))) {
    if (forbiddenImport.test(readFileSync(join(coreRoot, file), 'utf8'))) violations.push(file)
  }
  assert.deepEqual(violations, [])
})

test('StageCraft solution is disposable and does not affect another installed solution', async () => {
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const calls: string[] = []
  const chat = {
    speak: async () => { calls.push('chat.speak') },
    approveSpeech: async () => {}, rejectSpeech: async () => {}, retrySpeak: async () => {}, directorChat: async () => {},
    approveWorldChange: async () => {}, rejectWorldChange: async () => {}, cancel: () => {},
  } as StageCraftChatPort
  const director = {
    submitTurn: async () => {}, proceedToDraft: async () => {}, rejectDraft: async () => {}, retryDirector: async () => { calls.push('director.retry') },
    reconsiderReaction: async () => {}, consult: async () => {}, finishConsultation: () => {}, redraft: async () => {}, approve: () => {}, cancel: () => {},
  } as StageCraftDirectorPort
  const stagecraft = container.addSolution(new StageCraftSolutionPlugin({
    chat,
    director,
    management: {
      setRoomConfig: async () => { calls.push('management.set-room-config') },
    } as any,
    defaultRoomId: 'room-1',
  }))
  const other: CoreSolutionPlugin = {
    id: 'test.other.solution',
    install(host) {
      return host.registerCommandHandler({
        id: 'test.other.command-handler',
        canHandle: command => command.type === 'other-command',
        handle: async () => { calls.push('other') },
      })
    },
  }
  container.addSolution(other)
  await core.dispatch({ id: 'chat', actor: 'player', type: 'select-role', payload: { roomId: 'room-1', scope: 'chat', action: 'chat-speech', roleId: 'aria' } })
  await core.dispatch({ id: 'director', actor: 'operator', type: 'retry', payload: { roomId: 'room-1', scope: 'director', action: 'director-retry' } })
  await core.dispatch({ id: 'management', actor: 'operator', type: 'role-management', payload: { roomId: 'room-1', operation: 'set-room-config', mode: 'chat' } })
  await core.dispatch({ id: 'other', actor: 'operator', type: 'other-command', payload: {} })
  assert.deepEqual(calls, ['chat.speak', 'director.retry', 'management.set-room-config', 'other'])
  await stagecraft.dispose()
  for (const [id, command] of [
    ['chat-after-uninstall', { actor: 'player', type: 'select-role', payload: { roomId: 'room-1', scope: 'chat', action: 'chat-speech', roleId: 'aria' } }],
    ['director-after-uninstall', { actor: 'operator', type: 'retry', payload: { roomId: 'room-1', scope: 'director', action: 'director-retry' } }],
    ['management-after-uninstall', { actor: 'operator', type: 'role-management', payload: { roomId: 'room-1', operation: 'set-room-config', mode: 'chat' } }],
  ] as const) {
    await assert.rejects(() => core.dispatch({ id, ...command } as any), /Core command has no handler/)
  }
  await core.dispatch({ id: 'other-after-uninstall', actor: 'operator', type: 'other-command', payload: {} })
  assert.deepEqual(calls, ['chat.speak', 'director.retry', 'management.set-room-config', 'other', 'other'])
  await container.dispose()
})
