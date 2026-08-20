import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { DEBUG_SANDBOX_PROTOCOL_VERSION, type WorkerRequest } from '../src/debug/sandbox-protocol.ts'
import { WorkerRpcServer } from '../src/debug/worker-rpc.ts'

function request(method: WorkerRequest['method'], params: Record<string, unknown>, requestId = method): string {
  return JSON.stringify({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'request', requestId, owner: { ownerId: 'test', sessionId: 'session', capabilities: ['debug.read', 'debug.control', 'debug.reload', 'debug.stream', 'debug.inspect'] }, method, params }) + '\n'
}

function harness() {
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks: string[] = []
  output.on('data', chunk => chunks.push(String(chunk)))
  const core = new CoreRuntimeSkeleton()
  const server = new WorkerRpcServer({ input, output, pid: 42, now: () => '2026-01-01T00:00:00Z', createComposition: async () => ({ core, close: async () => {} }) })
  return { input, server, lines: () => chunks.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(check(), true)
}

test('worker boots composition and answers bounded status/view requests', async () => {
  const h = harness()
  await h.server.start()
  assert.equal(h.lines()[0].kind, 'ready')
  h.input.write(request('worker.status', {}))
  await waitFor(() => h.lines().some(line => line.requestId === 'worker.status'))
  const response = h.lines().find(line => line.requestId === 'worker.status')!
  assert.equal(response.ok, true)
  assert.equal((response.result as Record<string, unknown>).status, 'running')
  h.input.write(request('core.view.get', {}))
  await waitFor(() => h.lines().some(line => line.requestId === 'core.view.get'))
  assert.equal(h.lines().find(line => line.requestId === 'core.view.get')?.ok, true)
  await h.server.stop('test')
})

test('worker rejects unsupported commands and malformed frames without crashing', async () => {
  const h = harness()
  await h.server.start()
  h.input.write(request('core.command.dispatch', { command: { id: 'bad', actor: 'player', type: 'eval', payload: {} } }, 'bad-command'))
  await waitFor(() => h.lines().some(line => line.requestId === 'bad-command'))
  assert.equal((h.lines().find(line => line.requestId === 'bad-command')?.error as Record<string, unknown>).code, 'internal')
  h.input.write('{not-json}\n')
  await waitFor(() => h.lines().some(line => line.requestId === 'invalid-frame'))
  assert.equal(h.lines().some(line => line.requestId === 'invalid-frame'), true)
  await h.server.stop('test')
})

test('worker subscriptions stream status and core events as JSON envelopes', async () => {
  const h = harness()
  await h.server.start()
  h.input.write(request('debug.subscribe', { streams: ['worker.status', 'core.event'] }))
  await waitFor(() => h.lines().some(line => line.requestId === 'debug.subscribe'))
  h.input.write(request('core.command.dispatch', { command: { id: 'unknown', actor: 'player', type: 'submit-text', payload: { text: 'x' } } }, 'command'))
  await waitFor(() => h.lines().some(line => line.requestId === 'command'))
  assert.equal(h.lines().some(line => line.kind === 'stream' && line.stream === 'core.event'), true)
  await h.server.stop('test')
})

test('worker cancellation is request scoped', async () => {
  const h = harness()
  await h.server.start()
  h.input.write(request('fiber.reload', { fiberId: 'nope' }, 'cancel-me'))
  h.input.write(JSON.stringify({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'cancel', requestId: 'cancel-me', owner: { ownerId: 'test', sessionId: 'session' }, reason: 'test' }) + '\n')
  await waitFor(() => h.lines().some(line => line.requestId === 'cancel-me'))
  assert.equal(h.lines().find(line => line.requestId === 'cancel-me')?.ok, false)
  await h.server.stop('test')
})
