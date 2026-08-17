import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelGateway } from '../src/model-gateway.ts'

test('raw model logging prints only final message content when enabled', async () => {
  const lines: string[] = []
  const original = console.log
  console.log = (...items: unknown[]) => { lines.push(items.join(' ')) }
  try {
    const gateway = new ModelGateway({ baseUrl: 'https://model.test', apiKey: 'x', model: 'm', timeoutMs: 1000, responseFormat: 'json_object' }, { logRawFinalContent: true, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"final"}', reasoning_content: 'must-not-print' } }] }), { status: 200 }) })
    await gateway.complete('system json', 'user json', 'test_schema', {})
  } finally {
    console.log = original
  }
  assert.match(lines.join('\n'), /final/)
  assert.doesNotMatch(lines.join('\n'), /must-not-print/)
})
