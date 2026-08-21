import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import {
  DEBUG_SANDBOX_LIMITS,
  DEBUG_SANDBOX_PROTOCOL_VERSION,
  type DebugOwner,
  type DebugRpcMethod,
  type DebugRpcParams,
  type DebugRpcResults,
  type DebugStream,
  type DebugStreamEnvelope,
  type RequestCancellation,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerStatus,
  type WorkerStatusSnapshot,
  type WorkerReadyEnvelope,
  assertBoundedJson,
  validateWorkerResponse,
} from './sandbox-protocol.ts'

export interface WorkerManagerChild {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  once(event: 'exit' | 'error', listener: (...args: any[]) => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
  pid?: number
}

export interface WorkerManagerOptions {
  command?: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  owner?: DebugOwner
  handshakeTimeoutMs?: number
  gracefulShutdownMs?: number
  requestTimeoutMs?: number
  maxQueuedFrames?: number
  maxRestarts?: number
  spawnChild?: (command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }) => WorkerManagerChild
  now?: () => string
  onStream?: (envelope: DebugStreamEnvelope) => void
  onLog?: (line: string) => void
}

export interface WorkerExit {
  code: number | null
  signal: NodeJS.Signals | null
  error?: string
  stderr: string
  unexpected: boolean
}

export interface WorkerManagerSnapshot extends WorkerStatusSnapshot {
  lastExit?: WorkerExit
}

interface PendingRequest {
  request: WorkerRequest
  resolve: (response: WorkerResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_OWNER: DebugOwner = { ownerId: 'dsh-supervisor', sessionId: 'worker-manager', capabilities: ['debug.read', 'debug.control', 'debug.reload', 'debug.stream'] }
const DEFAULT_COMMAND = process.execPath
const DEFAULT_ARGS = ['--experimental-strip-types', 'src/debug/stagecraft-worker.ts']

/** DSH-side supervisor for the isolated StageCraft child process. */
export class WorkerManager {
  private readonly options: Required<Pick<WorkerManagerOptions, 'handshakeTimeoutMs' | 'gracefulShutdownMs' | 'requestTimeoutMs' | 'maxQueuedFrames' | 'maxRestarts'>>
  private readonly owner: DebugOwner
  private readonly now: () => string
  private readonly spawnChild: NonNullable<WorkerManagerOptions['spawnChild']>
  private child?: WorkerManagerChild
  private reader?: Interface
  private pending = new Map<string, PendingRequest>()
  private subscriptions = new Map<DebugStream, Set<(envelope: DebugStreamEnvelope) => void>>()
  private writeChain = Promise.resolve()
  private queuedWrites = 0
  private requestSequence = 0
  private generation = 0
  private status: WorkerStatus = 'stopped'
  private changedAt: string
  private lastExit?: WorkerExit
  private stderr = ''
  private stopping = false
  private restartCount = 0
  private ready?: WorkerReadyEnvelope
  private exitPromise?: Promise<WorkerExit>

  constructor(options: WorkerManagerOptions = {}) {
    this.options = {
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 5_000,
      gracefulShutdownMs: options.gracefulShutdownMs ?? 1_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      maxQueuedFrames: options.maxQueuedFrames ?? 128,
      maxRestarts: options.maxRestarts ?? 0,
    }
    this.owner = options.owner ?? DEFAULT_OWNER
    this.now = options.now ?? (() => new Date().toISOString())
    this.changedAt = this.now()
    this.spawnChild = options.spawnChild ?? ((command, args, spawnOptions) => spawn(command, [...args], { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as WorkerManagerChild)
    this.onStream = options.onStream
    this.onLog = options.onLog
    this.command = options.command ?? DEFAULT_COMMAND
    this.args = options.args ?? DEFAULT_ARGS
    this.cwd = options.cwd
    this.env = options.env
  }

  private readonly command: string
  private readonly args: readonly string[]
  private readonly cwd?: string
  private readonly env?: NodeJS.ProcessEnv
  private readonly onStream?: (envelope: DebugStreamEnvelope) => void
  private readonly onLog?: (line: string) => void

  async start(): Promise<WorkerManagerSnapshot> {
    if (this.status === 'running') return this.snapshot()
    if (this.child) await this.forceKill('replacing stale worker')
    this.stopping = false
    this.stderr = ''
    this.ready = undefined
    this.setStatus(this.restartCount > 0 ? 'restarting' : 'starting')
    const child = this.spawnChild(this.command, this.args, { cwd: this.cwd, env: { ...process.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.generation++
    this.reader = createInterface({ input: child.stdout })
    this.reader.on('line', line => this.handleLine(line))
    child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-DEBUG_SANDBOX_LIMITS.maxStringLength)
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) this.onLog?.(line)
    })
    this.exitPromise = new Promise(resolve => {
      child.once('error', error => resolve(this.recordExit(null, null, error)))
      child.once('exit', (code, signal) => resolve(this.recordExit(code, signal)))
    })
    const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Worker handshake timed out.')), this.options.handshakeTimeoutMs))
    try {
      await Promise.race([this.waitForReady(), deadline])
      this.setStatus('running')
      return this.snapshot()
    } catch (error) {
      this.setStatus('failed', errorMessage(error))
      await this.forceKill('handshake failure')
      throw error
    }
  }

  async stop(reason = 'stopped'): Promise<WorkerManagerSnapshot> {
    if (!this.child) { this.setStatus('stopped', reason); return this.snapshot() }
    this.stopping = true
    try {
      if (this.status === 'running' && this.ready) await this.request('worker.stop', { reason }, this.options.gracefulShutdownMs).catch(() => {})
    } finally {
      this.setStatus('stopping', reason)
      const exit = this.exitPromise
      if (exit) {
        await Promise.race([exit, delay(this.options.gracefulShutdownMs)])
        if (this.child) await this.forceKill(reason)
      }
      this.rejectPending(new Error(`Worker stopped: ${reason}`))
      this.setStatus('stopped', reason)
    }
    return this.snapshot()
  }

  async kill(reason = 'killed'): Promise<WorkerManagerSnapshot> {
    this.stopping = true
    this.setStatus('stopping', reason)
    await this.forceKill(reason)
    this.rejectPending(new Error(`Worker killed: ${reason}`))
    this.setStatus('stopped', reason)
    return this.snapshot()
  }

  async restart(reason = 'restarted'): Promise<WorkerManagerSnapshot> {
    // 优先进程内重建（worker.restart：关 composition → 重建 → 复用同一端口，
    // 无 TCP 释放竞态）。失败才回退杀进程 + 重新 spawn。
    if (this.status === 'running' && this.ready) {
      try {
        await this.request('worker.restart', { reason }, this.options.requestTimeoutMs)
        return this.snapshot()
      } catch { /* fall through to process-level restart */ }
    }
    await this.stop(reason)
    this.restartCount++
    const snapshot = await this.start()
    if (snapshot.status === 'running') {
      await this.request('worker.recover', { reason: 'preserve-state recovery' }, this.options.requestTimeoutMs).catch(() => {})
    }
    return this.snapshot()
  }

  async recover(reason = 'recovered'): Promise<WorkerManagerSnapshot> {
    if (this.status !== 'running') return this.restart(reason)
    await this.request('worker.recover', { reason }, this.options.requestTimeoutMs)
    return this.snapshot()
  }

  async request<M extends DebugRpcMethod>(method: M, params: DebugRpcParams[M], timeoutMs = this.options.requestTimeoutMs, signal?: AbortSignal): Promise<DebugRpcResults[M]> {
    if (!this.child || this.status !== 'running') throw new Error(`Worker is ${this.status}.`)
    const requestId = `dsh-${++this.requestSequence}`
    const request: WorkerRequest<M> = { protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'request', requestId, owner: this.owner, method, params }
    assertBoundedJson(request, 'worker request')
    if (signal?.aborted) throw new Error('Request cancelled.')
    const response = await new Promise<WorkerResponse<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        void this.sendCancel(request, 'request timeout')
        reject(new Error(`Worker request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(requestId, { request, resolve: resolve as (response: WorkerResponse) => void, reject, timer })
      void this.enqueue(request).catch(error => { clearTimeout(timer); this.pending.delete(requestId); reject(error) })
      signal?.addEventListener('abort', () => {
        if (!this.pending.delete(requestId)) return
        clearTimeout(timer)
        void this.sendCancel(request, 'request cancelled')
        reject(new Error('Request cancelled.'))
      }, { once: true })
    })
    if (!response.ok) throw new Error(response.error?.message ?? 'Worker request failed.')
    return response.result as DebugRpcResults[M]
  }

  subscribe(streams: readonly DebugStream[], listener: (envelope: DebugStreamEnvelope) => void): () => void {
    for (const stream of streams) (this.subscriptions.get(stream) ?? this.newSubscription(stream)).add(listener)
    return () => { for (const stream of streams) this.subscriptions.get(stream)?.delete(listener) }
  }

  getStatus(): WorkerManagerSnapshot { return this.snapshot() }
  async shutdown(reason = 'shutdown'): Promise<void> { await this.stop(reason) }

  private newSubscription(stream: DebugStream): Set<(envelope: DebugStreamEnvelope) => void> { const set = new Set<(envelope: DebugStreamEnvelope) => void>(); this.subscriptions.set(stream, set); return set }

  private async waitForReady(): Promise<WorkerReadyEnvelope> {
    return new Promise((resolve, reject) => {
      const check = (): void => { if (this.ready) resolve(this.ready); else if (this.exitPromise) this.exitPromise.then(exit => reject(new Error(`Worker exited before handshake (${exit.code ?? exit.signal ?? exit.error ?? 'unknown'}).`))) }
      const interval = setInterval(check, 5)
      check()
      this.exitPromise?.finally(() => clearInterval(interval))
    })
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > DEBUG_SANDBOX_LIMITS.maxFrameBytes) return
    let value: unknown
    try { value = JSON.parse(line) } catch { return }
    if (!value || typeof value !== 'object') return
    if ((value as { kind?: unknown }).kind === 'ready') { this.ready = value as WorkerReadyEnvelope; return }
    if ((value as { kind?: unknown }).kind === 'stream') {
      const envelope = value as DebugStreamEnvelope
      try { assertBoundedJson(envelope, 'stream'); this.onStream?.(envelope); for (const listener of this.subscriptions.get(envelope.stream) ?? []) listener(envelope) } catch { /* malformed stream is isolated to the worker */ }
      return
    }
    if ((value as { kind?: unknown }).kind !== 'response') return
    try { validateWorkerResponse(value as WorkerResponse) } catch { return }
    const response = value as WorkerResponse
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    pending.resolve(response)
  }

  private async enqueue(value: unknown): Promise<void> {
    if (this.queuedWrites >= this.options.maxQueuedFrames) throw new Error('Worker stdio backpressure limit exceeded.')
    assertBoundedJson(value, 'worker frame')
    this.queuedWrites++
    this.writeChain = this.writeChain.then(async () => {
      if (!this.child) throw new Error('Worker is unavailable.')
      const writable = this.child.stdin
      const frame = `${JSON.stringify(value)}\n`
      if (!writable.write(frame)) await onceDrain(writable)
    }).finally(() => { this.queuedWrites-- })
    return this.writeChain
  }

  private async sendCancel(request: WorkerRequest, reason: string): Promise<void> {
    const cancellation: RequestCancellation = { protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'cancel', requestId: request.requestId, owner: { ownerId: request.owner.ownerId, sessionId: request.owner.sessionId }, reason }
    try { await this.enqueue(cancellation) } catch { /* process failure already handles the request */ }
  }

  private async forceKill(reason: string): Promise<void> {
    const child = this.child
    if (!child) return
    this.reader?.close()
    this.reader = undefined
    try { child.stdin.destroy() } catch { /* child may already be gone */ }
    try { child.kill('SIGKILL') } catch { /* child may already be gone */ }
    this.child = undefined
    this.ready = undefined
    this.onLog?.(`worker force-killed: ${reason}`)
  }

  private recordExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): WorkerExit {
    const exit: WorkerExit = { code, signal, ...(error ? { error: error.message } : {}), stderr: this.stderr, unexpected: !this.stopping }
    this.lastExit = exit
    const unexpected = !this.stopping
    if (unexpected) {
      this.setStatus('failed', error?.message ?? `worker exited (${code ?? signal ?? 'unknown'})`)
      this.rejectPending(new Error('Worker exited unexpectedly.'))
      if (this.restartCount < this.options.maxRestarts) {
        this.restartCount++
        void this.start().catch(restartError => this.setStatus('failed', `restart failed: ${errorMessage(restartError)}`))
      }
    }
    this.child = undefined
    this.reader?.close()
    this.reader = undefined
    return exit
  }

  private rejectPending(error: Error): void { for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id) } }
  private setStatus(status: WorkerStatus, reason?: string): void { this.status = status; this.changedAt = this.now(); if (reason) this.lastExit = this.lastExit ? { ...this.lastExit, unexpected: this.lastExit.unexpected } : undefined }
  private snapshot(): WorkerManagerSnapshot { return { status: this.status, generation: this.generation, ...(this.child?.pid ? { pid: this.child.pid } : {}), ...(this.lastExit ? { lastExit: this.lastExit } : {}), changedAt: this.changedAt } }
}

export { WorkerManager as SupervisorWorkerManager }

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
function onceDrain(stream: Writable): Promise<void> { return new Promise(resolve => stream.once('drain', resolve)) }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
