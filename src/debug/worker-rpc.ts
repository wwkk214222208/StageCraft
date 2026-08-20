import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { TavernApp } from '../app-boot.ts'
import {
  DEBUG_SANDBOX_LIMITS,
  DEBUG_SANDBOX_PROTOCOL_VERSION,
  type DebugRpcMethod,
  type DebugStream,
  type DebugStreamEnvelope,
  type DebugOwner,
  type WorkerRequest,
  type WorkerResponse,
  type RequestCancellation,
  type WorkerStatus,
  type WorkerStatusSnapshot,
  assertBoundedJson,
  authorizeDebugRpc,
  validateCancellation,
  validateWorkerRequest,
} from './sandbox-protocol.ts'

export interface WorkerComposition {
  core: TavernApp['core']
  close(): Promise<void>
}

export interface WorkerRpcServerOptions {
  input: Readable
  output: Writable
  owner?: DebugOwner
  createComposition: () => Promise<WorkerComposition>
  now?: () => string
  pid?: number
}

const DEFAULT_OWNER: DebugOwner = { ownerId: 'dsh-supervisor', sessionId: 'worker', capabilities: ['debug.read', 'debug.control', 'debug.reload', 'debug.stream'] }
const METHODS = new Set<DebugRpcMethod>(['worker.status', 'worker.stop', 'worker.kill', 'worker.restart', 'worker.recover', 'fiber.reload', 'core.view.get', 'core.command.dispatch', 'debug.subscribe', 'inspector.endpoint.get'])
const COMMANDS = new Set(['submit-text', 'select-role', 'approve', 'reject', 'edit-proposal', 'choose', 'cancel', 'retry', 'restart', 'role-management'])

export class WorkerRpcServer {
  private readonly input: Readable
  private readonly output: Writable
  private readonly owner: DebugOwner
  private readonly createComposition: () => Promise<WorkerComposition>
  private readonly now: () => string
  private readonly pid?: number
  private readonly pending = new Map<string, AbortController>()
  private readonly subscribers = new Map<DebugStream, Set<(envelope: DebugStreamEnvelope) => void>>()
  private sequence = 0
  private generation = 0
  private status: WorkerStatus = 'starting'
  private composition?: WorkerComposition
  private lineReader?: Interface
  private closed = false

  constructor(options: WorkerRpcServerOptions) {
    this.input = options.input
    this.output = options.output
    this.owner = options.owner ?? DEFAULT_OWNER
    this.createComposition = options.createComposition
    this.now = options.now ?? (() => new Date().toISOString())
    this.pid = options.pid
  }

  async start(): Promise<void> {
    this.setStatus('starting')
    this.composition = await this.createComposition()
    this.generation++
    this.composition.core.subscribe(event => {
      this.emit({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'stream', stream: 'core.event', sequence: ++this.sequence, revision: event.revision, event })
      this.emit({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'stream', stream: 'core.view', sequence: ++this.sequence, revision: this.composition!.core.getView().revision, view: this.composition!.core.getView() })
    })
    this.setStatus('running')
    this.write({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'ready', generation: this.generation, ...(this.pid ? { pid: this.pid } : {}), changedAt: this.now() })
    this.lineReader = createInterface({ input: this.input })
    this.lineReader.on('line', line => { void this.handleLine(line) })
  }

  async stop(reason = 'stopped'): Promise<void> {
    if (this.closed) return
    this.setStatus('stopping', reason)
    for (const controller of this.pending.values()) controller.abort(reason)
    this.pending.clear()
    const composition = this.composition
    this.composition = undefined
    if (composition) await composition.close()
    this.closed = true
    this.lineReader?.close()
    this.setStatus('stopped', reason)
  }

  private async handleLine(line: string): Promise<void> {
    if (Buffer.byteLength(line, 'utf8') > DEBUG_SANDBOX_LIMITS.maxFrameBytes) {
      this.write({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'response', requestId: 'invalid-frame', owner: { ownerId: this.owner.ownerId, sessionId: this.owner.sessionId }, method: 'worker.status', ok: false, error: { code: 'invalid-request', message: 'Frame exceeds maximum size.' } })
      return
    }
    let value: unknown
    try { value = JSON.parse(line) } catch { this.writeError('invalid-frame', 'worker.status', 'Frame is not valid JSON.'); return }
    if (value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'cancel') {
      try { validateCancellation(value as RequestCancellation); this.pending.get((value as RequestCancellation).requestId)?.abort((value as RequestCancellation).reason ?? 'cancelled') } catch (error) { this.writeError('invalid-cancel', 'worker.status', errorMessage(error)) }
      return
    }
    try {
      validateWorkerRequest(value as WorkerRequest)
      const request = value as WorkerRequest
      if (!METHODS.has(request.method)) throw new Error('Unsupported worker method.')
      authorizeDebugRpc(request.owner, request.method)
      const controller = new AbortController()
      this.pending.set(request.requestId, controller)
      try {
        const result = await this.dispatch(request, controller.signal)
        this.write({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'response', requestId: request.requestId, owner: { ownerId: request.owner.ownerId, sessionId: request.owner.sessionId }, method: request.method, ok: true, result } as WorkerResponse)
      } catch (error) {
        const cancelled = controller.signal.aborted
        this.write({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'response', requestId: request.requestId, owner: { ownerId: request.owner.ownerId, sessionId: request.owner.sessionId }, method: request.method, ok: false, error: { code: cancelled ? 'cancelled' : 'internal', message: errorMessage(error), retryable: cancelled } } as WorkerResponse)
      } finally { this.pending.delete(request.requestId) }
    } catch (error) {
      this.writeError(typeof (value as { requestId?: unknown })?.requestId === 'string' ? String((value as { requestId: string }).requestId) : 'invalid-request', typeof (value as { method?: unknown })?.method === 'string' ? String((value as { method: string }).method) : 'worker.status', errorMessage(error))
    }
  }

  private async dispatch(request: WorkerRequest, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new Error('Request cancelled.')
    if (request.method === 'worker.status') return this.snapshot()
    if (request.method === 'worker.stop' || request.method === 'worker.kill') { await this.stop(request.params.reason ?? request.method); return this.snapshot() }
    if (request.method === 'worker.restart' || request.method === 'worker.recover') {
      await this.stop(request.params.reason ?? request.method)
      this.closed = false
      await this.start()
      return this.snapshot()
    }
    if (!this.composition) throw new Error('Worker composition is unavailable.')
    if (request.method === 'core.view.get') return this.composition.core.getView()
    if (request.method === 'core.command.dispatch') {
      const command = request.params.command
      if (!command || !COMMANDS.has(command.type)) throw new Error('Command type is not allowlisted.')
      assertBoundedJson(command.payload ?? null, 'command.payload')
      await this.composition.core.dispatch(command)
      return { accepted: true }
    }
    if (request.method === 'debug.subscribe') {
      const streams = request.params.streams.filter(stream => ['logs', 'worker.status', 'core.view', 'core.event'].includes(stream))
      for (const stream of streams) if (!this.subscribers.has(stream)) this.subscribers.set(stream, new Set())
      return { streams, subscribed: true }
    }
    if (request.method === 'inspector.endpoint.get') return null
    throw new Error(`Fiber is not reloadable: ${request.params.fiberId}`)
  }

  private snapshot(): WorkerStatusSnapshot { return { status: this.status, generation: this.generation, ...(this.pid ? { pid: this.pid } : {}), changedAt: this.now() } }
  private setStatus(status: WorkerStatus, reason?: string): void { this.status = status; this.emit({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'stream', stream: 'worker.status', sequence: ++this.sequence, status: this.snapshotWith(status, reason) }) }
  private snapshotWith(status: WorkerStatus, reason?: string): WorkerStatusSnapshot { return { status, generation: this.generation, ...(this.pid ? { pid: this.pid } : {}), ...(reason ? { reason } : {}), changedAt: this.now() } }
  private emit(envelope: DebugStreamEnvelope): void {
    assertBoundedJson(envelope, 'stream')
    if (this.subscribers.has(envelope.stream)) this.write(envelope)
    for (const listener of this.subscribers.get(envelope.stream) ?? []) listener(envelope)
  }
  private write(value: unknown): void { assertBoundedJson(value, 'frame'); this.output.write(`${JSON.stringify(value)}\n`) }
  private writeError(requestId: string, method: string, message: string): void { this.write({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'response', requestId, owner: { ownerId: this.owner.ownerId, sessionId: this.owner.sessionId }, method, ok: false, error: { code: 'invalid-request', message } }) }
}

export async function runWorkerRpcServer(options: WorkerRpcServerOptions): Promise<WorkerRpcServer> {
  const server = new WorkerRpcServer(options)
  await server.start()
  return server
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
