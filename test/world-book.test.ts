import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.ts'
import { RoomRuntime } from '../src/room-runtime.ts'
import { parseWorldBookTxt, loadStoryPackageWithTxt } from '../src/story-packages.ts'
import { createRealWorkers, ModelGateway } from '../src/model-gateway.ts'
import type { LoreEntry } from '../src/types.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-lore-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const runtime = new RoomRuntime(store, {
    decide: async (role, participation) => ({ roleId: role.id, participation, status: 'completed', brief: '意图。', privateReaction: '反应。' }),
    draft: async (turnId) => ({ id: 'draft-x', turnId, text: '正文。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], createdAt: new Date().toISOString() }),
  })
  return { root, store, runtime, roomId }
}

test('parseWorldBookTxt parses === entries with optional role tags', () => {
  const entries = parseWorldBookTxt(`=== 创世神话 ===
世界正式名为赫普塔隆。
> 角色: aria, mira
=== 神凡限制 ===
七女神与凡间的纽带系于信仰场。
`)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], { name: '创世神话', roles: ['aria', 'mira'], content: '世界正式名为赫普塔隆。' })
  assert.deepEqual(entries[1], { name: '神凡限制', content: '七女神与凡间的纽带系于信仰场。' })
})

test('loadStoryPackageWithTxt merges txt world book entries not in JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-lore-txt-'))
  writeFileSync(join(root, 'demo.json'), JSON.stringify({
    id: 'demo', title: 'Demo', opening: '开场。', playerCharacter: { name: '玩家', persona: '人设。', currentState: '状态。' },
    roles: [{ id: 'aria', name: 'Aria', portraitRef: '/a.svg', currentState: '在场。', presence: 'present', memories: [{ text: '记忆。', occurredAt: '过去' }], selfModel: '克制。' }],
    lore: [{ name: 'JSON 已有条目', content: '来自 JSON。' }],
  }))
  writeFileSync(join(root, 'demo.txt'), `=== txt 新条目 ===\n> 角色: aria\n来自 txt。\n=== JSON 已有条目 ===\n来自 txt 的重复。\n`)
  const story = loadStoryPackageWithTxt(root, 'demo')
  assert.equal(story.lore!.length, 2)
  assert.deepEqual(story.lore!.find(e => e.name === 'JSON 已有条目'), { name: 'JSON 已有条目', content: '来自 JSON。' })
  assert.deepEqual(story.lore!.find(e => e.name === 'txt 新条目'), { name: 'txt 新条目', roles: ['aria'], content: '来自 txt。' })
})

test('store persists lore and round-trips through snapshot', () => {
  const { store, roomId } = fixture()
  store.saveLore(roomId, [{ name: '常开条目', content: '世界法则。' }, { name: '角色条目', roles: ['aria'], content: '关于 Aria。' }])
  const room = store.getRoom(roomId)!
  assert.deepEqual(room.lore, [{ name: '常开条目', content: '世界法则。' }, { name: '角色条目', roles: ['aria'], content: '关于 Aria。' }])
  assert.deepEqual(store.exportRoom(roomId).room!.lore, room.lore)
})

test('world book injected in prompt: 常开 + 角色条目 + 人物卡 + 记忆', async () => {
  const lore: LoreEntry[] = [
    { name: '创世神话', content: '七光创世。' },
    { name: 'Aria 专属', roles: ['aria'], content: 'Aria 是晨光花园学徒。' },
    { name: 'Mira 专属', roles: ['mira'], content: 'Mira 擅长玩笑。' },
  ]
  let captured: string[] = []
  class SpyGateway extends ModelGateway {
    constructor() { super({ name: 'spy', baseUrl: 'http://x', apiKey: 'k', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' }) }
    override async completeStreaming<T>(system: string, _user: string, schemaName: string): Promise<T> {
      if (schemaName === 'role_decision' || schemaName === 'minimal_role_decision') { captured.push(system); return { brief: '意图。', privateReaction: '反应。' } as T }
      if (schemaName === 'story_draft' || schemaName === 'minimal_story_draft') { return { text: '正文。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [] } as T }
      throw new Error(`Unexpected schema: ${schemaName}`)
    }
  }
  const workers = createRealWorkers(new SpyGateway() as unknown as ModelGateway)
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-lore-prompt-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  store.saveLore(roomId, lore)
  const runtime = new RoomRuntime(store, workers)
  runtime.setWorkers(workers)
  await runtime.submitTurn(roomId, { text: '你好。', requiredRoleIds: ['aria'] })
  const ariaPrompt = captured.find(system => system.includes('Aria 是晨光花园学徒。')) ?? ''
  const ariaIdx = ariaPrompt.indexOf('Aria 是晨光花园学徒。')
  const loreIdx = ariaPrompt.indexOf('创世神话')
  const selfIdx = ariaPrompt.indexOf('当前自我模型：')
  const memoryIdx = ariaPrompt.indexOf('角色记忆')
  const miraIdx = ariaPrompt.indexOf('Mira 擅长玩笑。')
  if (!(loreIdx >= 0 && ariaIdx >= 0)) console.error('实际 prompts:\n' + captured.join('\n====\n'))
  assert.ok(loreIdx >= 0 && ariaIdx >= 0, `世界书应注入: ${ariaPrompt}`)
  assert.ok(miraIdx === -1, 'Mira 专属条目不应注入 Aria 的 prompt')
  assert.ok(loreIdx < ariaIdx && ariaIdx < selfIdx && selfIdx < memoryIdx, '顺序应为 常开 < 角色条目 < 人物卡 < 记忆')
})

test('role prompt prefix is cached across turns', async () => {
  let calls = 0
  let captured: string[] = []
  class SpyGateway extends ModelGateway {
    constructor() { super({ name: 'spy', baseUrl: 'http://x', apiKey: 'k', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' }) }
    override async completeStreaming<T>(system: string, _user: string, schemaName: string): Promise<T> {
      if (schemaName === 'role_decision' || schemaName === 'minimal_role_decision') { calls++; captured.push(system); return { brief: '意图。', privateReaction: '反应。' } as T }
      if (schemaName === 'story_draft' || schemaName === 'minimal_story_draft') { return { text: '正文。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [] } as T }
      throw new Error(`Unexpected schema: ${schemaName}`)
    }
  }
  const workers = createRealWorkers(new SpyGateway() as unknown as ModelGateway)
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-lore-cache-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  store.saveLore(roomId, [{ name: '常开', content: '法则。' }])
  const runtime = new RoomRuntime(store, workers)
  runtime.setWorkers(workers)
  await runtime.submitTurn(roomId, { text: '第一回合。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const d1 = runtime.get(roomId).draft!
  runtime.approve(roomId, d1.id, d1.text, d1.stateUpdates)
  await runtime.submitTurn(roomId, { text: '第二回合。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  const d2 = runtime.get(roomId).draft!
  runtime.approve(roomId, d2.id, d2.text, d2.stateUpdates)
  assert.ok(captured.length >= 4, `两回合应有多次 decide: ${captured.length}`)
  const byRole = new Map<string, string[]>()
  for (const system of captured) {
    const match = system.match(/你是角色 (\S+) 的一次性决策 Worker/)
    const role = match ? match[1] : 'unknown'
    if (!byRole.has(role)) byRole.set(role, [])
    byRole.get(role)!.push(system)
  }
  for (const [role, prompts] of byRole) {
    if (prompts.length < 2) continue
    const prefix1 = prompts[0].split('当前场景')[0]
    const prefix2 = prompts[1].split('当前场景')[0]
    assert.equal(prefix1, prefix2, `角色 ${role} 的前缀（世界书+人物卡）应一致`)
  }
  assert.ok(captured.every(system => system.includes('角色记忆')))
})
