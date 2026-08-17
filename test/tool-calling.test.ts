import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelGateway } from '../src/model-gateway.ts'

const route = { baseUrl: 'https://model.test/v1', apiKey: 'key', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' as const }
const tool = { name: 'submit_result', description: 'Submit structured result.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }

test('gateway sends native tools without incompatible response formatting and parses tool arguments', async () => {
  let request: any
  const gateway = new ModelGateway(route, { fetchImpl: async (_url, init) => {
    request = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'submit_result', arguments: '{"text":"tool output"}' } }] } }] }), { status: 200 })
  } })
  const result = await gateway.complete<{ text: string }>('system', 'user', 'result', tool.parameters, tool)
  assert.equal(result.text, 'tool output')
  assert.equal(request.tools[0].function.name, 'submit_result')
  assert.equal(request.tool_choice, undefined)
  assert.equal(request.response_format, undefined)
})

test('gateway parses Markdown-wrapped tool arguments', async () => {
  const gateway = new ModelGateway(route, { fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { arguments: '```json\n{"text":"wrapped"}\n```' } }] } }] }), { status: 200 }) })
  const result = await gateway.complete<{ text: string }>('system', 'user', 'result', tool.parameters, tool)
  assert.equal(result.text, 'wrapped')
})

test('gateway falls back to JSON content only when provider rejects tools', async () => {
  let calls = 0
  const gateway = new ModelGateway(route, { fetchImpl: async () => {
    calls += 1
    if (calls === 1) return new Response('tools not supported', { status: 400 })
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"fallback"}' } }] }), { status: 200 })
  } })
  const result = await gateway.complete<{ text: string }>('system', 'user', 'result', tool.parameters, tool)
  assert.equal(result.text, 'fallback')
  assert.equal(calls, 2)
})
