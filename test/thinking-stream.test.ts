import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ModelGateway, createRealWorkers } from '../src/model-gateway.ts'
import { RoomRuntime, type ThinkingEvent } from '../src/room-runtime.ts'
import { Store } from '../src/store.ts'
import type { Role } from '../src/types.ts'

const role: Role = {
  id: 'aria', name: 'Aria', portraitRef: '/aria.svg', presence: 'present',
  currentState: '在祭典主厅。', memoryTimeline: { '未标注时间': ['她注意到玩家的沉默。'] }, selfModel: '克制。',
}

/** 构造一个 content-type 为 text/event-stream 的 SSE 响应 */
function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('streaming gateway splits reasoning deltas from content deltas', async () => {
  const thinking: string[] = []
  const contents: string[] = []
  const gateway = new ModelGateway({ baseUrl: 'https://model.test/v1', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' }, {
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      assert.equal(body.stream, true)
      return sseResponse([
        { choices: [{ delta: { reasoning_content: '先观察' } }] },
        { choices: [{ delta: { reasoning_content: '玩家的意图。' } }] },
        { choices: [{ delta: { content: '{"brief":"保持观察。","privateReaction":"她提高警惕。"}' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ])
    },
  })
  const result = await gateway.completeStreaming<{ brief: string; privateReaction: string }>('s', 'u', 'role_decision', { type: 'object' }, undefined, { onThinking: text => thinking.push(text), onContent: text => contents.push(text) })
  assert.equal(result.brief, '保持观察。')
  assert.equal(thinking.join(''), '先观察玩家的意图。')
  assert.match(contents.join(''), /"brief":"保持观察。"/)
  assert.equal(gateway.usage().promptTokens, 5)
  assert.equal(gateway.usage().completionTokens, 3)
})

test('streaming gateway accumulates tool call arguments and falls back to JSON on non-SSE responses', async () => {
  const toolGateway = new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_schema' }, {
    fetchImpl: async () => sseResponse([
      { choices: [{ delta: { reasoning: '想一下。' } }] },
      JSON.parse('{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"brief\\":\\"b\\""}}]}}]}'),
      JSON.parse('{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"}"}}]}}]}'),
    ]),
  })
  const thinking: string[] = []
  const toolResult = await toolGateway.completeStreaming<{ brief: string }>('s', 'u', 'x', { type: 'object' }, { name: 't', description: 'd', parameters: { type: 'object' } }, { onThinking: text => thinking.push(text) })
  assert.equal(toolResult.brief, 'b')
  assert.equal(thinking.join(''), '想一下。')

  // 非 SSE 响应（网关忽略 stream）：走完整 JSON 路径并提取 message.reasoning_content
  const jsonGateway = new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' }, {
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { reasoning_content: '一次性思考。', content: '{"ok":1}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const nonStreamThinking: string[] = []
  const jsonResult = await jsonGateway.completeStreaming<{ ok: number }>('s', 'u', 'x', { type: 'object' }, undefined, { onThinking: text => nonStreamThinking.push(text) })
  assert.equal(jsonResult.ok, 1)
  assert.equal(nonStreamThinking.join(''), '一次性思考。')
})

test('real workers capture reasoning into decision and draft', async () => {
  const gateway = new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' }, {
    fetchImpl: async () => sseResponse([
      { choices: [{ delta: { reasoning_content: '决策思考。' } }] },
      { choices: [{ delta: { content: JSON.stringify({ brief: '公开意图。', privateReaction: '私有反应。' }) } }] },
    ]),
  })
  const workers = createRealWorkers(gateway)
  const decision = await workers.decide(role, 'required', '玩家输入')
  assert.equal(decision.thinking, '决策思考。')
  assert.equal(decision.brief, '公开意图。')

  const draftGateway = new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' }, {
    fetchImpl: async () => sseResponse([
      { choices: [{ delta: { reasoning_content: '导演思考。' } }] },
      { choices: [{ delta: { content: JSON.stringify({ text: '草稿。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [] }) } }] },
    ]),
  })
  const draftWorkers = createRealWorkers(draftGateway)
  const draft = await draftWorkers.draft('turn-1', '玩家输入', [decision], [role])
  assert.equal(draft.thinking, '导演思考。')
  assert.equal(draft.text, '草稿。')
})

test('runtime pushes thinking events and persists thinking with decisions and drafts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'character-tavern-thinking-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed()
  const events: ThinkingEvent[] = []
  const runtime = new RoomRuntime(store, {
    decide: async (target, participation, contribution, _roles, _scene, onThinking) => {
      onThinking?.('（角色推理中）')
      return { roleId: target.id, participation, status: 'completed', brief: '公开意图。', privateReaction: '私有反应。', thinking: '（角色推理中）' }
    },
    draft: async (turnId, _contribution, _decisions, _roles, _consultations, _player, _scene, onThinking) => {
      onThinking?.('（导演推理中）')
      return { id: 'draft-1', turnId, text: '草稿。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], thinking: '（导演推理中）', createdAt: new Date().toISOString() }
    },
  })
  runtime.subscribeThinking(roomId, event => events.push(event))
  await runtime.submitTurn(roomId, { text: '玩家行动。', requiredRoleIds: ['aria'] })
  await runtime.proceedToDraft(roomId)
  assert.equal(runtime.get(roomId).phase, 'awaiting-approval')
  const roles = events.filter(event => event.actor === 'role' && event.roleId === 'aria')
  assert.ok(roles.length >= 2)
  assert.equal(roles[0].text, '（角色推理中）')
  assert.equal(roles[0].done, false)
  assert.equal(roles[roles.length - 1].done, true)
  const directorEvents = events.filter(event => event.actor === 'director')
  assert.equal(directorEvents[0].text, '（导演推理中）')
  assert.equal(directorEvents[directorEvents.length - 1].done, true)
  const snapshot = runtime.get(roomId)
  assert.equal(snapshot.decisions.find(item => item.roleId === 'aria')?.thinking, '（角色推理中）')
  assert.equal(snapshot.draft?.thinking, '（导演推理中）')

  // 重启恢复：thinking 从 SQLite 读回
  const store2 = new Store(join(root, 'app.sqlite'))
  const restored = store2.getRoom(roomId)
  assert.equal(restored?.decisions.find(item => item.roleId === 'aria')?.thinking, '（角色推理中）')
  assert.equal(restored?.draft?.thinking, '（导演推理中）')
})
