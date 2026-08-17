import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelGateway } from '../src/model-gateway.ts'

const encoder = new TextEncoder()
function sseChunk(payload: string): Uint8Array {
  return encoder.encode(`data: ${payload}\n\n`)
}

// 空闲超时语义：流式过程中只要还在收到数据就重置计时器；
// 只有连续 timeoutMs 没有新数据（卡住/断流）才掐断。

test('长流式生成（持续有数据、总时长超过 timeoutMs）不触发超时', async () => {
  const gateway = new ModelGateway({ baseUrl: 'https://model.test/v1', apiKey: 'x', model: 'm', timeoutMs: 300, responseFormat: 'json_object' }, {
    fetchImpl: async () => {
      const stream = new ReadableStream({
        start(controller) {
          let i = 0
          const timer = setInterval(() => {
            i += 1
            controller.enqueue(sseChunk(JSON.stringify({ choices: [{ delta: { content: `t${i}` } }] })))
            if (i >= 8) { clearInterval(timer); controller.close() }
          }, 50) // 每 50ms 一个 token，总时长 ~400ms > timeoutMs 300，但空闲间隔 50ms < 300ms
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  // 流完整走完（8 个增量拼成 "t1t2...t8" 不是合法 JSON）→ 抛 JSON 解析错误而非超时错误
  await assert.rejects(
    gateway.completeStreaming<{ brief: string }>('s', 'u', 'role_decision', { type: 'object', properties: { brief: { type: 'string' } }, required: ['brief'] }),
    /not valid JSON/,
  )
})

test('流中途空闲超过 timeoutMs 触发超时', async () => {
  const gateway = new ModelGateway({ baseUrl: 'https://model.test/v1', apiKey: 'x', model: 'm', timeoutMs: 200, responseFormat: 'json_object' }, {
    fetchImpl: async (_input, init) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(sseChunk(JSON.stringify({ choices: [{ delta: { content: 'a' } }] })))
          // 之后不再推送 → 空闲；abort 时 error 流，模拟真实 fetch 的 body 中断
          init.signal.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted.', 'AbortError')))
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  await assert.rejects(
    gateway.completeStreaming<{ brief: string }>('s', 'u', 'role_decision', { type: 'object', properties: { brief: { type: 'string' } }, required: ['brief'] }),
    /timed out after 200ms/,
  )
})
