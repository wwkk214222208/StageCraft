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
import type { WorkerSet } from '../src/workers.ts'
import { installStageCraftSolution, installLegacyRuntimeSolution } from './core-solution-test-utils.ts'

test('chat.director history is bounded to the current consultation turn and room', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-director-history-'))
  let store: Store | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const firstRoom = store.createRoomFromPackage(story, 'history-room-a')
    const secondRoom = store.createRoomFromPackage(story, 'history-room-b')
    store.restartRoom(firstRoom, story, { mode: 'chat' })
    store.restartRoom(secondRoom, story, { mode: 'chat' })
    const histories: Array<{ roomId: string; texts: string[] }> = []
    const workers: WorkerSet = {
      decide: async () => ({ roleId: 'aria', participation: 'excluded', status: 'abstained' }),
      draft: async () => ({ text: '' }),
      directorChat: async (text, context) => {
        histories.push({ roomId: context.roomId, texts: context.history?.map(message => message.text) ?? [] })
        return { reply: `收到：${text}` }
      },
    }
    const runtime = new RoomRuntime(store, workers)
    await runtime.directorChat(firstRoom, '第一房间第一轮')
    await runtime.directorChat(firstRoom, '第一房间第二轮')
    await runtime.directorChat(secondRoom, '第二房间第一轮')
    assert.deepEqual(histories, [
      { roomId: firstRoom, texts: [] },
      { roomId: firstRoom, texts: [] },
      { roomId: secondRoom, texts: [] },
    ])
    assert.deepEqual(store.getRoom(firstRoom)?.consultations.map(message => message.text), ['第一房间第一轮', '收到：第一房间第一轮', '第一房间第二轮', '收到：第一房间第二轮'])
    assert.deepEqual(store.getRoom(secondRoom)?.consultations.map(message => message.text), ['第二房间第一轮', '收到：第二房间第一轮'])
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat.director suggestion uses Core interaction and returns to suggestion state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-director-core-'))
  let store: Store | undefined
  let container: import('../src/core/container.ts').DefaultCorePluginContainer | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    store.restartRoom(roomId, story, { mode: 'chat' })
    const workers: WorkerSet = { decide: async () => ({ roleId: 'aria', participation: 'excluded', status: 'abstained' }), draft: async () => ({ text: '' }), directorChat: async () => ({ reply: '收到，我会留意北塔。' }) }
    const core = new CoreRuntimeSkeleton()
    container = installStageCraftSolution(core)
    const runtime = new RoomRuntime(store, workers, core)
    installLegacyRuntimeSolution(container, runtime, roomId)
    core.attachWorkflowStore({ save: (id, instance) => store!.saveWorkflowInstance(id, instance), list: id => store!.listWorkflowInstances(id) })
    core.projectRoom(store.getRoom(roomId))
    const interaction = core.getView().interactions.find(item => item.id.includes('director-suggestion'))!
    assert.equal(interaction.kind, 'text')
    await core.dispatch({ id: 'suggest', actor: 'player', interactionId: interaction.id, type: 'submit-text', payload: { text: '把时间推进到明天。' } })
    const workflow = core.getView().workflows.find(item => item.definitionId === 'stagecraft.chat.director')!
    assert.equal(workflow.step, 'awaiting-suggestion')
    assert.equal(store.getRoom(roomId).consultations.at(-1)?.role, 'director')
  } finally {
    await container?.dispose()
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
