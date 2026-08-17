import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelGateway } from '../src/model-gateway.ts'

/** enqueue 后不 close：模拟供应商"内容发完但不关流/不发 [DONE]"的僵持流 */
function hangingStream(events: Array<Record<string, unknown>>): Response {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const baseRoute = { baseUrl: 'https://model.test/v1', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' as const }

test('混合 delta：reasoning+content 同事件，正文不被吞（无工具请求）', async () => {
  const thinking: string[] = []
  const contents: string[] = []
  const gateway = new ModelGateway(baseRoute, {
    fetchImpl: async () => hangingStream([
      // deepseek-v4-flash 等：一个 chunk 里 reasoning_content 与 content 同时在场
      { choices: [{ delta: { reasoning_content: '先想', content: '{"brief":"正文。","privateReaction":"内心。"}' } }] },
      { choices: [{ delta: { reasoning_content: '再想' } }] },
      { choices: [{ finish_reason: 'stop', delta: {} }] },
    ]),
  })
  const result = await gateway.completeStreaming<{ brief: string; privateReaction: string }>('s', 'u', 'x', { type: 'object' }, undefined, {
    onThinking: text => thinking.push(text),
    onContent: text => contents.push(text),
  }, { graceMs: 300 })
  assert.equal(thinking.join(''), '先想再想')
  // 正文（content 字段）没有被 thinking 分支吞掉
  assert.equal(result.brief, '正文。')
  assert.equal(result.privateReaction, '内心。')
  assert.ok(contents.join('').includes('"brief":"正文。"'))
})

test('混合 delta：reasoning+content+tool_calls 同事件，工具参数不被吞', async () => {
  const thinking: string[] = []
  const gateway = new ModelGateway(baseRoute, {
    fetchImpl: async () => hangingStream([
      { choices: [{ delta: { reasoning_content: '想', content: '{}', tool_calls: [{ function: { arguments: '{"brief":"工具版。","privateReaction":"p"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
  })
  const result = await gateway.completeStreaming<{ brief: string }>('s', 'u', 'x', { type: 'object' }, { name: 't', description: 'd', parameters: { type: 'object' } }, { onThinking: text => thinking.push(text) }, { graceMs: 300 })
  // 工具模式下以工具参数为准，且同一事件里的 thinking 也正确累计
  assert.equal(result.brief, '工具版。')
  assert.equal(thinking.join(''), '想')
})

test('finish_reason 到达后供应商不关流：宽限到期主动收尾，不报超时', async () => {
  const thinking: string[] = []
  const gateway = new ModelGateway(baseRoute, {
    fetchImpl: async () => hangingStream([
      { choices: [{ delta: { reasoning_content: '长篇思考。' } }] },
      { choices: [{ delta: { content: '{"brief":"完成了。","privateReaction":"p"}' } }] },
      { choices: [{ finish_reason: 'stop', delta: {} }] },
      // 之后供应商既不发 [DONE] 也不关流 → 挂 300ms 后应主动返回
    ]),
  })
  const started = Date.now()
  const result = await gateway.completeStreaming<{ brief: string }>('s', 'u', 'x', { type: 'object' }, undefined, { onThinking: text => thinking.push(text) }, { graceMs: 300 })
  const elapsed = Date.now() - started
  assert.equal(result.brief, '完成了。')
  assert.equal(thinking.join(''), '长篇思考。')
  assert.ok(elapsed < 2000, `应在宽限后主动返回，实际 ${elapsed}ms`)
})

test('收到 [DONE] 立即结束，不等流 close', async () => {
  const gateway = new ModelGateway(baseRoute, {
    fetchImpl: async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // enqueue 后不 close：不发 [DONE] 的僵持流会触发宽限，但这里有 [DONE] 应立即返回
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\"brief\\":\\"done。\\",\\"privateReaction\\":\\"p\\"}"}}]}\n\ndata: [DONE]\n\n'))
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ),
  })
  const started = Date.now()
  const result = await gateway.completeStreaming<{ brief: string }>('s', 'u', 'x', { type: 'object' }, undefined, {}, { graceMs: 5000 })
  assert.equal(result.brief, 'done。')
  assert.ok(Date.now() - started < 1500, '收到 [DONE] 应立即返回，不应等宽限')
})

test('工具参数流：finish_reason(tool_calls) 后不关流也在宽限内收尾', async () => {
  const gateway = new ModelGateway({ ...baseRoute, responseFormat: 'json_object' }, {
    fetchImpl: async () => hangingStream([
      JSON.parse('{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"brief\\":\\"工具版完成。\\""}}]}}]}'),
      JSON.parse('{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"}"}}]}}]}'),
      JSON.parse('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'),
    ]),
  })
  const started = Date.now()
  const result = await gateway.completeStreaming<{ brief: string }>('s', 'u', 'x', { type: 'object' }, { name: 't', description: 'd', parameters: { type: 'object' } }, {}, { graceMs: 300 })
  assert.equal(result.brief, '工具版完成。')
  assert.ok(Date.now() - started < 2000)
})