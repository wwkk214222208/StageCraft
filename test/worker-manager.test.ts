import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { DEBUG_SANDBOX_PROTOCOL_VERSION, type WorkerRequest } from '../src/debug/sandbox-protocol.ts'
import { WorkerManager, type WorkerManagerChild } from '../src/debug/worker-manager.ts'

class FakeChild extends EventEmitter implements WorkerManagerChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 9001
  private readonly mode: 'normal' | 'hang' | 'crash'
  killed = false

  constructor(mode: 'normal' | 'hang' | 'crash' = 'normal') {
    super()
    this.mode = mode
    let buffer = ''
    this.stdin.on('data', chunk => {
      buffer += String(chunk)
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); newline = buffer.indexOf('\n')
        if (!line) continue
        const request = JSON.parse(line) as WorkerRequest
        if (request.kind !== 'request' || this.mode === 'hang') continue
        if (request.method === 'worker.stop') {
          this.respond(request, { status: 'stopped', generation: 1, changedAt: '2026-01-01T00:00:00Z' })
          queueMicrotask(() => this.emit('exit', 0, null))
        } else if (request.method === 'worker.recover') {
          this.respond(request, { status: 'running', generation: 1, changedAt: '2026-01-01T00:00:00Z' })
        } else if (this.mode === 'crash') {
          queueMicrotask(() => this.emit('exit', 7, null))
        } else {
          this.respond(request, request.method === 'worker.status' ? { status: 'running', generation: 1, changedAt: '2026-01-01T00:00:00Z' } : { accepted: true })
        }
      }
    })
    queueMicrotask(() => this.stdout.write(JSON.stringify({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'ready', generation: 1, pid: this.pid, changedAt: '2026-01-01T00:00:00Z' }) + '\n'))
  }

  kill(): boolean { this.killed = true; this.emit('exit', null, 'SIGKILL'); return true }
  private respond(request: WorkerRequest, result: unknown): void { this.stdout.write(JSON.stringify({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'response', requestId: request.requestId, owner: { ownerId: request.owner.ownerId, sessionId: request.owner.sessionId }, method: request.method, ok: true, result }) + '\n') }
}

const owner = { ownerId: 'test', sessionId: 'test-session', capabilities: ['debug.read', 'debug.control', 'debug.reload', 'debug.stream'] as const }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function manager(child: FakeChild, options: Partial<ConstructorParameters<typeof WorkerManager>[0]> = {}) {
  return new WorkerManager({ owner, handshakeTimeoutMs: 100, gracefulShutdownMs: 20, requestTimeoutMs: 30, spawnChild: () => child, ...options })
}

test('manager starts, handshakes, requests, and gracefully stops without killing a healthy child', async () => {
  const child = new FakeChild()
  const supervisor = manager(child)
  assert.equal((await supervisor.start()).status, 'running')
  assert.equal((await supervisor.request('worker.status', {})).status, 'running')
  assert.equal((await supervisor.stop('test')).status, 'stopped')
  assert.equal(child.killed, false)
})

test('manager captures child crash and does not terminate the parent', async () => {
  const child = new FakeChild('crash')
  const supervisor = manager(child)
  await supervisor.start()
  await supervisor.request('worker.status', {}).catch(() => {})
  await wait(5)
  assert.equal(supervisor.getStatus().status, 'failed')
  assert.equal(supervisor.getStatus().lastExit?.code, 7)
})

test('manager times out and cancels a hung request, then force-kills on shutdown', async () => {
  const child = new FakeChild('hang')
  const supervisor = manager(child, { requestTimeoutMs: 10, gracefulShutdownMs: 10 })
  await supervisor.start()
  await assert.rejects(supervisor.request('worker.status', {}, 10), /timed out/)
  await supervisor.kill('timeout recovery')
  assert.equal(child.killed, true)
  assert.equal(supervisor.getStatus().status, 'stopped')
})

test('manager restart creates a new generation and performs preserve-state recovery', async () => {
  const children = [new FakeChild(), new FakeChild()]
  let index = 0
  const supervisor = new WorkerManager({ owner, handshakeTimeoutMs: 100, gracefulShutdownMs: 20, requestTimeoutMs: 30, spawnChild: () => children[index++] })
  await supervisor.start()
  const snapshot = await supervisor.restart('crash recovery')
  assert.equal(snapshot.status, 'running')
  assert.equal(snapshot.generation, 2)
  assert.equal(index, 2)
  await supervisor.shutdown()
})

test('manager exposes bounded stream subscriptions and forwards stderr logs', async () => {
  const child = new FakeChild()
  const logs: string[] = []
  const supervisor = manager(child, { onLog: line => logs.push(line) })
  const streams: unknown[] = []
  supervisor.subscribe(['worker.status'], envelope => streams.push(envelope))
  await supervisor.start()
  child.stderr.write('synthetic worker diagnostic\n')
  assert.deepEqual(logs, ['synthetic worker diagnostic'])
  assert.equal(streams.length, 0)
  await supervisor.shutdown()
})
