import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelGateway, createRealWorkers } from '../src/model-gateway.ts'
import type { Role } from '../src/types.ts'

const role: Role = {
  id: 'aria', name: 'Aria', portraitRef: '/aria.svg', presence: 'present',
  currentState: '在祭典主厅。', memoryTimeline: { '未标注时间': ['她注意到玩家的沉默。'] }, selfModel: '克制。',
}

function response(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers: { 'content-type': 'application/json' } })
}

test('gateway sends schema request without temperature and parses JSON', async () => {
  let request: Request | undefined
  const gateway = new ModelGateway({ baseUrl: 'https://model.test/v1', apiKey: 'secret', model: 'test-model', timeoutMs: 1000, responseFormat: 'json_object' }, {
    fetchImpl: async (input, init) => {
      request = new Request(input, init)
      return response(JSON.stringify({ brief: '保持观察。', privateReaction: '她提高警惕。' }))
    },
  })
  const result = await gateway.complete<{ brief: string; privateReaction: string }>('system json', 'user json', 'role_decision', { type: 'object' })
  assert.equal(result.brief, '保持观察。')
  const body = await request!.json() as Record<string, unknown>
  assert.equal(body.temperature, undefined)
  assert.equal((body.response_format as Record<string, unknown>).type, 'json_object')
})

test('gateway reports provider HTTP errors and invalid JSON', async () => {
  const httpFailure = new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'x', timeoutMs: 1000, responseFormat: 'json_object' }, { fetchImpl: async () => response('bad', 503) })
  await assert.rejects(httpFailure.complete('s', 'u', 'x', {}), /Model HTTP 503.*bad/)
  const jsonFailure = new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'x', timeoutMs: 1000, responseFormat: 'json_object' }, { fetchImpl: async () => response('not-json') })
  await assert.rejects(jsonFailure.complete('s', 'u', 'x', {}), /valid JSON/)
})

test('real workers keep private role memory out of Director prompt', async () => {
  const prompts: string[] = []
  const gateway = new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'x', timeoutMs: 1000, responseFormat: 'json_object' }, { fetchImpl: async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }
    prompts.push(body.messages.map(message => message.content).join('\n'))
    return response(JSON.stringify(prompts.length === 1 ? { brief: '公开意图。', privateReaction: '私有反应。' } : { text: '草稿。', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [] }))
  } })
  const workers = createRealWorkers(gateway)
  const decision = await workers.decide(role, 'required', '玩家输入')
  assert.match(prompts[0], /json/i)
  await workers.draft('turn-1', '玩家输入', [decision], [role])
  assert.match(prompts[0], /她注意到玩家的沉默。/)
  assert.doesNotMatch(prompts[1], /她注意到玩家的沉默。/)
  assert.match(prompts[1], /公开意图。/)
})
