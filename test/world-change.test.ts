import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import type { WorkerSet } from '../src/workers.ts'
import type { Role } from '../src/types.ts'

function fixture(): { runtime: RoomRuntime; roomId: string; databasePath: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-wc-'))
  const databasePath = join(root, 'app.sqlite')
  const store = new Store(databasePath)
  return { runtime: new RoomRuntime(store), roomId: store.seed(), databasePath, store }
}

/** 一个会随发言附带世界变更申请的 fake speak worker */
function worldChangeWorkers(worldChange: import('../src/types.ts').WorldChangeRequest): WorkerSet {
  return {
    decide: (role: Role, participation: import('../src/types.ts').Decision['participation']) => Promise.resolve({ roleId: role.id, participation, status: participation === 'excluded' ? 'abstained' : 'completed', brief: `${role.name} 的回应。` }),
    draft: () => Promise.resolve({ id: 'x', turnId: 't', text: '正文', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], createdAt: new Date().toISOString() }),
    speak: () => Promise.resolve({ text: '「我推开门，外面天色已晚。」', worldChange }),
  }
}

/** 一个会产出回复 + 世界变更 + 叙述的 fake directorChat worker */
function directorChatWorkers(worldChange: import('../src/types.ts').WorldChangeRequest | undefined, narration?: string): WorkerSet {
  return {
    decide: (role: Role, participation: import('../src/types.ts').Decision['participation']) => Promise.resolve({ roleId: role.id, participation, status: participation === 'excluded' ? 'abstained' : 'completed', brief: `${role.name} 的回应。` }),
    draft: () => Promise.resolve({ id: 'x', turnId: 't', text: '正文', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], createdAt: new Date().toISOString() }),
    directorChat: () => Promise.resolve({
      reply: '好的，我把这个变化整理成世界变更申请。',
      ...(worldChange ? { worldChange } : {}),
      ...(worldChange && narration ? { narration } : {}),
    }),
  }
}

test('群聊模式：角色发言附带世界变更申请 → 进入 world-change-approval 并待玩家确认', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  runtime.setWorkers(worldChangeWorkers({ sceneTime: '深夜', sceneLocation: '城门下' }))
  await runtime.speak(roomId, 'aria')
  let room = runtime.get(roomId)
  assert.equal(room.phase, 'world-change-approval')
  assert.ok(room.speech)
  assert.ok(room.pendingWorldChange)
  assert.equal(room.pendingWorldChange?.sceneTime, '深夜')
  assert.equal(room.pendingWorldChange?.sceneLocation, '城门下')
  // 世界变更未落地前，场景时间/地点不变
  assert.notEqual(room.sceneTime, '深夜')

  // 批准台词时一并落地世界变更
  await runtime.approveSpeech(roomId, '「我推开门，外面天色已晚。」')
  room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.sceneTime, '深夜')
  assert.equal(room.sceneLocation, '城门下')
  assert.equal(room.pendingWorldChange, undefined)
  assert.equal(room.scenes.at(-1)?.text, '「我推开门，外面天色已晚。」')
})

test('群聊模式：世界变更申请可在批准时由玩家编辑覆盖时间/地点', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  runtime.setWorkers(worldChangeWorkers({ sceneTime: '深夜', sceneLocation: '城门下' }))
  await runtime.speak(roomId, 'aria')
  // 玩家把时间改成「黄昏」
  await runtime.approveSpeech(roomId, '正文', { sceneTime: '黄昏' })
  const room = runtime.get(roomId)
  assert.equal(room.sceneTime, '黄昏')
  assert.equal(room.sceneLocation, '城门下')
})

test('群聊模式：无世界变更的普通发言仍走 awaiting-approval，不受影响', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  await runtime.speak(roomId, 'aria')
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-approval')
  assert.equal(room.pendingWorldChange, undefined)
})

test('沉浸模式（群聊）：附带世界变更申请的台词自动发布并落地', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat', autoPublish: true })
  runtime.setWorkers(worldChangeWorkers({ sceneTime: '深夜', sceneLocation: '城门下' }))
  await runtime.speak(roomId, 'aria')
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.sceneTime, '深夜')
  assert.equal(room.sceneLocation, '城门下')
  assert.equal(room.pendingWorldChange, undefined)
  assert.ok(room.scenes.at(-1)?.text.length > 0)
})

test('群聊模式：世界变更申请随台词一并被放弃', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  runtime.setWorkers(worldChangeWorkers({ sceneTime: '深夜' }))
  await runtime.speak(roomId, 'aria')
  assert.equal(runtime.get(roomId).phase, 'world-change-approval')
  runtime.cancelTurn(roomId)
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.pendingWorldChange, undefined)
  assert.equal(room.speech, undefined)
  assert.notEqual(room.sceneTime, '深夜')
})

test('群聊模式：世界变更申请可提议新人物，批准后创建', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  runtime.setWorkers(worldChangeWorkers({
    roleProposals: [{ id: 'guard', name: '守门人', portraitRef: '/assets/default.svg', currentState: '正在城门口巡视。', presence: 'present', selfModel: '你是一个沉默寡言的守门人。', memoryTimeline: {} }],
  }))
  await runtime.speak(roomId, 'aria')
  let room = runtime.get(roomId)
  assert.equal(room.phase, 'world-change-approval')
  assert.equal(room.pendingWorldChange?.roleProposals?.length, 1)
  assert.equal(room.roles.some(role => role.id === 'guard'), false)

  await runtime.approveSpeech(roomId, '正文')
  room = runtime.get(roomId)
  const created = room.roles.find(role => role.id === 'guard')
  assert.ok(created, '批准后新人物应被创建')
  assert.equal(created.name, '守门人')
  assert.equal(created.presence, 'present')
})

test('群聊模式：一次导演咨询的结构化变更统一走批准与记忆流程', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  const seenDigest: string[] = []
  runtime.setWorkers({
    ...directorChatWorkers({
      sceneTime: '深夜',
      sceneLocation: '城门下',
      roleProposals: [{ id: 'guard', name: '守门人', portraitRef: '/assets/default.svg', currentState: '正在城门口巡视。', presence: 'present', selfModel: '沉默寡言的守门人。', memoryTimeline: {} }],
      rolePresence: [{ roleId: 'noel', presence: 'present' }],
    }, '诺尔推门走进城门，守门人开始巡视。'),
    digest: async (role, scene) => {
      seenDigest.push(`${role.id}:${scene.worldChangeId ?? 'none'}`)
      return { entries: [{ text: `记住：${scene.text}`, occurredAt: scene.sceneTime }] }
    },
  })

  await runtime.directorChat(roomId, '入夜，去城门并让诺尔进场，安排守门人出现。')
  let room = runtime.get(roomId)
  assert.equal(room.phase, 'world-change-approval')
  assert.equal(room.pendingWorldChange?.sceneTime, '深夜')
  assert.equal(room.pendingWorldChange?.sceneLocation, '城门下')
  assert.equal(room.pendingWorldChange?.roleProposals?.[0]?.id, 'guard')
  assert.equal(room.pendingWorldChange?.rolePresence?.[0]?.roleId, 'noel')
  assert.equal(room.roles.some(role => role.id === 'guard'), false)
  assert.equal(room.roles.find(role => role.id === 'noel')?.presence, 'absent')

  await runtime.approveWorldChange(roomId)
  room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.sceneTime, '深夜')
  assert.equal(room.sceneLocation, '城门下')
  assert.equal(room.roles.find(role => role.id === 'guard')?.presence, 'present')
  assert.equal(room.roles.find(role => role.id === 'noel')?.presence, 'present')
  assert.equal(room.scenes.at(-1)?.text, '诺尔推门走进城门，守门人开始巡视。')
  assert.ok(seenDigest.some(item => item.startsWith('aria:') && !item.endsWith(':none')))
  assert.ok(room.roles.find(role => role.id === 'aria')?.memories.some(memory => memory.text.includes('诺尔推门走进城门')))
})

test('群聊模式：导演对话无变更时仅回复，房间保持空闲', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  runtime.setWorkers(directorChatWorkers(undefined))
  await runtime.directorChat(roomId, '现在是什么时候？')
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.pendingWorldChange, undefined)
  const consults = room.consultations
  assert.equal(consults.at(-2)?.role, 'player')
  assert.equal(consults.at(-2)?.text, '现在是什么时候？')
  assert.equal(consults.at(-1)?.role, 'director')
})

test('群聊模式：导演对话建议世界变更（上帝模式）→ 待确认 → 批准后落地并写叙述', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  runtime.setWorkers(directorChatWorkers({ sceneTime: '深夜', sceneLocation: '城门下' }, '夜色渐深，众人离开祭典主厅，来到了城门下。'))
  await runtime.directorChat(roomId, '天黑了，我们去城门那边。')
  let room = runtime.get(roomId)
  assert.equal(room.phase, 'world-change-approval')
  assert.equal(room.speech, undefined)
  assert.equal(room.pendingWorldChange?.sceneTime, '深夜')
  assert.equal(room.pendingWorldChange?.sceneLocation, '城门下')
  assert.equal(room.pendingNarration, '夜色渐深，众人离开祭典主厅，来到了城门下。')
  assert.notEqual(room.sceneTime, '深夜')

  // 批准：落地世界变更 + 写叙述 scene（narration，无 speaker）
  await runtime.approveWorldChange(roomId)
  room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.sceneTime, '深夜')
  assert.equal(room.sceneLocation, '城门下')
  assert.equal(room.pendingWorldChange, undefined)
  assert.equal(room.pendingNarration, undefined)
  const last = room.scenes.at(-1)
  assert.ok(last)
  assert.equal(last.text, '夜色渐深，众人离开祭典主厅，来到了城门下。')
  assert.equal(last.speaker, undefined)
})

test('群聊模式：导演建议的世界变更可被拒绝', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  runtime.setWorkers(directorChatWorkers({ sceneTime: '深夜' }, '夜色渐深。'))
  await runtime.directorChat(roomId, '让天变黑。')
  assert.equal(runtime.get(roomId).phase, 'world-change-approval')
  await runtime.rejectWorldChange(roomId)
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.pendingWorldChange, undefined)
  assert.equal(room.pendingNarration, undefined)
  assert.notEqual(room.sceneTime, '深夜')
})

test('沉浸模式（群聊）：导演建议的世界变更直接生效并写叙述', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat', autoPublish: true })
  runtime.setWorkers(directorChatWorkers({ sceneTime: '深夜' }, '夜色渐深，火把的光影摇曳。'))
  await runtime.directorChat(roomId, '入夜吧。')
  const room = runtime.get(roomId)
  assert.equal(room.phase, 'awaiting-player-input')
  assert.equal(room.sceneTime, '深夜')
  assert.equal(room.pendingWorldChange, undefined)
  assert.equal(room.scenes.at(-1)?.text, '夜色渐深，火把的光影摇曳。')
})

test('群聊模式：世界变更申请支持角色进离场（rolePresence）', async () => {
  const { runtime, roomId } = fixture()
  runtime.setRoomConfig(roomId, { mode: 'chat' })
  runtime.setWorkers(directorChatWorkers({ rolePresence: [{ roleId: 'noel', presence: 'present' }] }, '诺尔推门走了进来。'))
  await runtime.directorChat(roomId, '让诺尔进来。')
  let room = runtime.get(roomId)
  assert.equal(room.phase, 'world-change-approval')
  assert.equal(room.pendingWorldChange?.rolePresence?.[0]?.roleId, 'noel')
  assert.equal(room.roles.find(role => role.id === 'noel')?.presence, 'absent')

  await runtime.approveWorldChange(roomId)
  room = runtime.get(roomId)
  assert.equal(room.roles.find(role => role.id === 'noel')?.presence, 'present')
  assert.equal(room.scenes.at(-1)?.text, '诺尔推门走了进来。')
})
