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

test('director turn player input and decision approval use Core interactions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-director-turn-'))
  let store: Store | undefined
  let container: import('../src/core/container.ts').DefaultCorePluginContainer | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    const seedRoom = store.getRoom(roomId)
    store.restartRoom(roomId, story, { mode: 'director' })
    const workers: WorkerSet = { decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed', brief: '观察局势。' }), draft: async (turnId) => ({ id: `draft-${turnId}`, turnId, text: '草稿场景', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], roleProposals: [], sceneUpdates: {}, createdAt: new Date().toISOString() }) }
    const core = new CoreRuntimeSkeleton()
    container = installStageCraftSolution(core)
    const runtime = new RoomRuntime(store, workers, core)
    installLegacyRuntimeSolution(container, runtime, roomId)
    core.attachWorkflowStore({ save: (id, instance) => store!.saveWorkflowInstance(id, instance), list: id => store!.listWorkflowInstances(id) })
    core.projectRoom(store.getRoom(roomId))
    const input = core.getView().interactions.find(item => item.id.includes('player-input'))!
    await core.dispatch({ id: 'input', actor: 'player', interactionId: input.id, type: 'submit-text', payload: { text: '走进森林。' } })
    const decision = core.getView().interactions.find(item => item.id.includes('decision-approval'))!
    assert.equal(decision.kind, 'approval')
    await core.dispatch({ id: 'decisions', actor: 'player', interactionId: decision.id, type: 'approve', payload: { action: 'decisions' } })
    assert.equal(store.getRoom(roomId).phase, 'awaiting-approval')
    assert.equal(core.getView().interactions.find(item => item.id.includes('draft-approval')) !== undefined, true)
  } finally {
    await container?.dispose()
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('director mode records player speech only on publish; hidePlayerSpeech is a UI-only flag', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-director-turn-'))
  let store: Store | undefined
  let container: import('../src/core/container.ts').DefaultCorePluginContainer | undefined
  try {
    store = new Store(join(root, 'state.sqlite'))
    const story = loadStoryPackage(fileURLToPath(new URL('../stories', import.meta.url)), 'eldoria')
    const roomId = store.seed(story)
    store.restartRoom(roomId, story, { mode: 'director' })
    const workers: WorkerSet = { decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed', brief: '观察局势。' }), draft: async (turnId) => ({ id: `draft-${turnId}`, turnId, text: '草稿场景', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], roleProposals: [], sceneUpdates: {}, createdAt: new Date().toISOString() }) }
    const core = new CoreRuntimeSkeleton()
    container = installStageCraftSolution(core)
    const runtime = new RoomRuntime(store, workers, core)
    installLegacyRuntimeSolution(container, runtime, roomId)
    core.attachWorkflowStore({ save: (id, instance) => store!.saveWorkflowInstance(id, instance), list: id => store!.listWorkflowInstances(id) })
    core.projectRoom(store.getRoom(roomId))

    // 提交行动：玩家发言只作为回合上下文暂存（playerContribution），不落盘正文
    await runtime.submitTurn(roomId, { text: '我推开木门。' })
    let snap = store.getRoom(roomId)
    assert.equal(snap.scenes.at(-1)?.speaker, undefined, '提交阶段不写玩家气泡')
    assert.equal(snap.playerContribution, '我推开木门。', '发言暂存为本回合上下文')
    // 拒绝草稿（取消本回合）→ 玩家发言随之消失，不残留
    await runtime.proceedToDraft(roomId)
    await runtime.rejectDraft(roomId)
    assert.equal(store.getRoom(roomId).phase, 'awaiting-player-input')
    assert.equal(store.getRoom(roomId).playerContribution, undefined)
    assert.equal(store.getRoom(roomId).scenes.some(scene => scene.speaker === 'player'), false, '取消回合后玩家发言不残留')
    // 开启「隐藏玩家发言」（仅 UI 隐藏显示）→ 正式发布时仍记录
    store.setRoomConfig(roomId, { hidePlayerSpeech: true })
    assert.equal(store.getRoom(roomId).hidePlayerSpeech, true)
    await runtime.submitTurn(roomId, { text: '我后退一步。' })
    await runtime.proceedToDraft(roomId)
    const draft = store.getRoom(roomId).draft
    assert.ok(draft, '草稿已生成')
    runtime.approve(roomId, draft.id, draft.text, draft.stateUpdates)
    const published = store.getRoom(roomId).scenes
    const playerScene = published.find(scene => scene.speaker === 'player')
    assert.ok(playerScene, '正式成稿发布时玩家发言随正文落盘')
    assert.equal(playerScene.text, '我后退一步。')
    const narrationScene = published.find(scene => scene.speaker === undefined && scene.kind === 'narration')
    assert.ok(narrationScene, '导演正文发布')
    assert.ok(narrationScene.createdAt >= playerScene.createdAt, '玩家气泡先于导演正文发布')
  } finally {
    await container?.dispose()
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
