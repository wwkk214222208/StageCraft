import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ModelGateway, createRealWorkers } from '../src/model-gateway.ts'
import { RoomRuntime } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import type { Decision, Role } from '../src/types.ts'
import { fakeWorkers, type WorkerSet } from '../src/workers.ts'

function fixture(workers: WorkerSet = fakeWorkers) {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-dir-prompt-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  return { runtime: new RoomRuntime(store, workers), roomId }
}

/** 捕获真实导演请求的 system/user（隐私边界：只注入公开人设、长期目标/记忆/印象不外泄，对外身份进入 briefs；固定头在前；stateUpdates 必须用 id） */
test('director request: 公开人设注入且私有段剥离、固定头在前、stateUpdates 必须用角色 id', async () => {
  const captured: Array<{ system: string; user: string }> = []
  const gateway = new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' }, {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      captured.push({ system: body.messages[0].content, user: body.messages[1].content })
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: '正文。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [] }) } }] }), { status: 200 })
    },
  })
  const workers = createRealWorkers(gateway)
  const roles: Role[] = [
    {
      id: 'seraphina', name: '塞拉菲娜', portraitRef: '/x.png', currentState: '在木屋里照料旅人。', presence: 'present',
      memories: [{ text: '救回旅人。', occurredAt: '今日' }], impressions: { '旅人': '刚救回的伤者。', '罗温': '谨慎的猎人。' },
      selfModel: '名字：塞拉菲娜\n身份：守护者\n\n性格定义：\n1. 温柔但不软弱。\n\n===== 长期目标 =====\n- 守住空地。',
    },
    {
      id: 'vex', name: '影牙', portraitRef: '/v.svg', currentState: '在结界外徘徊。', presence: 'absent',
      selfModel: '名字：影牙\n身份：兽群首领\n===== 长期目标 =====\n- 让森林统一在黑暗之下。',
    },
  ]
  const decisions: Decision[] = [{ roleId: 'seraphina', participation: 'required', status: 'completed', brief: '她会先确认旅人的伤势。', publicIdentity: '以普通旅人身份示人，隐瞒守护者身份。' }]
  await workers.draft('turn-1', '我坐起身。', decisions, roles, [], { name: '旅人', persona: '谨慎。', currentState: '刚醒来。' }, { time: '黄昏', location: '空地' }, undefined, [], '上一幕正文。', '旧草稿正文。')
  const { user } = captured[0]

  // 公开人设：注入角色卡公开面（名字/身份/性格），剥离私有段（长期目标）
  assert.ok(user.includes('【seraphina】塞拉菲娜'), '应在场角色公开人设包含 id 与姓名')
  assert.ok(user.includes('名字：塞拉菲娜'), '应注入公开人设')
  assert.ok(user.includes('性格定义：'), '公开部分（性格）应保留')
  assert.ok(!user.includes('守住空地'), '长期目标不得注入')
  assert.ok(!user.includes('名字：影牙'), '缺席角色公开人设不得注入')

  // 记忆时间线与他人印象仍归私有
  assert.ok(!user.includes('救回旅人。'), '记忆时间线不得注入')
  assert.ok(!user.includes('对旅人的印象'), '他人印象不得注入')

  // 角色主动上报的对外身份进入 briefs
  assert.ok(user.includes('对外身份/形象：以普通旅人身份示人，隐瞒守护者身份。'), '角色主动上报的对外身份应进入导演上下文')

  // fix 4：指令要求用角色 id（兼容归一化保留在代码侧）
  assert.ok(user.includes('stateUpdates 的键必须用角色 id（玩家状态用 player）'), '应要求用角色 id')
  assert.ok(!user.includes('stateUpdates 的键用角色名或角色 id 均可'), '不得引导使用角色名')
  assert.ok(user.includes('seraphina（塞拉菲娜）：在木屋里照料旅人。'), '角色状态应带 id（姓名）对照')

  // fix 1/2：recentScene 与 previousDraft 都进入请求（上一版草稿独立成块）
  assert.ok(user.includes('上一幕正文。'), '应包含最近已批准正文')
  assert.ok(user.includes('【上一版草稿（当前待修订，仅修订时出现）】'), '上一版草稿应独立成块')
  assert.ok(user.includes('旧草稿正文。'), '上一版草稿正文应注入')

  // fix 8：固定头（常开世界书/公开人设/玩家信息）在可变尾（剧情进展/玩家贡献）之前
  assert.ok(user.indexOf('世界书') < user.indexOf('当前场景：'), '世界书应在当前场景之前')
  assert.ok(user.indexOf('公开人设') < user.indexOf('玩家贡献'), '公开人设应在可变量之前')
  assert.ok(user.indexOf('常开世界书') < user.indexOf('角色公开意图'), '常开世界书应在本回合可变量之前')
  assert.ok(user.indexOf('玩家角色') < user.indexOf('当前场景：'), '玩家信息应在当前场景之前')
  assert.ok(user.indexOf('当前剧情进展') < user.indexOf('玩家贡献'), '可变量应集中在尾部')
})

/** fix 7 新机制：角色决策输出 identity → normalize → Decision.publicIdentity */
test('角色决策的 identity 字段经 normalize 进入 Decision', async () => {
  const gateway = new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' }, {
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ brief: '公开意图。', privateReaction: '私有反应。', identity: '伪装成平民，隐瞒身份。' }) } }] }), { status: 200 }),
  })
  const workers = createRealWorkers(gateway)
  const role: Role = { id: 'aria', name: 'Aria', portraitRef: '/aria.svg', currentState: '位于主厅。', presence: 'present', selfModel: '克制、敏锐。' }
  const decision = await workers.decide(role, 'optional', '玩家行动。', [])
  assert.equal(decision.status, 'completed')
  assert.equal(decision.brief, '公开意图。')
  assert.equal(decision.publicIdentity, '伪装成平民，隐瞒身份。')
})

/** fix 7 新机制：publicIdentity 持久化并在快照中还原（导演重试/修订复用同一批决策时不会丢） */
test('publicIdentity 持久化并在房间快照中还原', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-identity-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const turnId = 'turn-identity'
  store.createTurn(roomId, turnId, '贡献', [{ roleId: 'aria', participation: 'optional', status: 'pending' }])
  store.saveDecision(turnId, { roleId: 'aria', participation: 'optional', status: 'completed', brief: '公开意图。', privateReaction: '私有反应。', publicIdentity: '以化名示人。' })
  const room = store.getRoom(roomId)
  assert.equal(room.decisions.find(item => item.roleId === 'aria')?.publicIdentity, '以化名示人。')
})

/** fix 1/2/3/6：redraft 携带上一版草稿与最近正文；咨询记录按回合过滤；场景上下文合并 sceneUpdates */
test('redraft: previousDraft/recentScene/场景合并/咨询按回合过滤', async () => {
  interface Seen { consultations: string[]; recentScene: string | undefined; previousDraft: string | undefined; scene: { time?: string; location?: string } }
  const seen: Seen[] = []
  const workers: WorkerSet = {
    decide: fakeWorkers.decide,
    draft: async (turnId, contribution, decisions, roles, consultations = [], _playerCharacter, scene, onThinking, lore, recentScene, previousDraft) => {
      seen.push({ consultations: consultations.map(message => message.text), recentScene, previousDraft, scene: scene ?? {} })
      const base = await fakeWorkers.draft(turnId, contribution, decisions, roles, consultations)
      if (seen.length === 2) return { ...base, id: `draft-${seen.length}`, sceneUpdates: { time: '深夜' } }
      return { ...base, id: `draft-${seen.length}` }
    },
    consult: fakeWorkers.consult,
  }
  const { runtime, roomId } = fixture(workers)

  // 回合 1：先咨询再批准，产生一条「上一回合」的咨询记录
  await runtime.submitTurn(roomId, { text: '第一个问题。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const d1 = runtime.get(roomId).draft!
  await runtime.consult(roomId, d1.id, '第一回合的咨询。')
  await runtime.finishConsultation(roomId)
  runtime.approve(roomId, d1.id, d1.text, d1.stateUpdates)
  const scene1 = runtime.get(roomId).scenes.at(-1)!.text

  // 回合 2：空闲期玩家加设定 → 起草
  runtime.setDirectorSetting(roomId, '深夜设定：祭祀进入尾声。')
  await runtime.submitTurn(roomId, { text: '第二个行动。' })
  await runtime.proceedToDraft(roomId)
  const d2 = runtime.get(roomId).draft!

  assert.equal(seen[1].recentScene, scene1, '回合 2 首次起草应携带最近已批准正文')
  assert.ok(seen[1].consultations.includes('深夜设定：祭祀进入尾声。'), '本回合设定应进入导演上下文')
  assert.ok(!seen[1].consultations.includes('第一回合的咨询。'), '上一回合咨询不得泄漏进本回合')

  // 修订：咨询后 redraft
  await runtime.consult(roomId, d2.id, '请重写。')
  await runtime.redraft(roomId, d2.id)
  const revised = runtime.get(roomId)

  assert.equal(seen[2].previousDraft, d2.text, 'redraft 应携带上一版草稿全文')
  assert.equal(seen[2].recentScene, scene1, 'redraft 应携带最近已批准正文')
  assert.equal(seen[2].scene.time, '深夜', 'redraft 场景时间应合并草稿 sceneUpdates')
  assert.equal(seen[2].scene.location, '皇家祭典主厅', '未提案的地点回退房间当前地点')
  assert.ok(seen[2].consultations.includes('请重写。'), '本回合咨询应进入修订上下文')
  assert.ok(!seen[2].consultations.includes('第一回合的咨询。'), '上一回合咨询不得进入修订上下文')
  assert.equal(revised.phase, 'awaiting-approval')
})

/** fix 1：导演重试也携带最近已批准正文（此前缺失，会误报「开局」） */
test('retryDirector 携带最近已批准正文', async () => {
  let call = 0
  const recentScenes: Array<string | undefined> = []
  const workers: WorkerSet = {
    decide: fakeWorkers.decide,
    draft: async (turnId, contribution, decisions, roles, consultations = [], _playerCharacter, _scene, _onThinking, _lore, recentScene) => {
      recentScenes.push(recentScene)
      call++
      if (call === 1) throw new Error('首次导演失败')
      return await fakeWorkers.draft(turnId, contribution, decisions, roles, consultations)
    },
    consult: fakeWorkers.consult,
  }
  const { runtime, roomId } = fixture(workers)
  await runtime.submitTurn(roomId, { text: '行动。' })
  await runtime.proceedToDraft(roomId)
  assert.ok(runtime.get(roomId).lastError, '首次起草应失败')
  await runtime.retryDirector(roomId)
  assert.equal(runtime.get(roomId).phase, 'awaiting-approval')
  const latest = runtime.get(roomId).scenes.at(-1)!.text
  assert.equal(recentScenes[0], latest, '首次起草应携带最近正文（开局）')
  assert.equal(recentScenes[1], latest, '导演重试也应携带最近正文')
})
