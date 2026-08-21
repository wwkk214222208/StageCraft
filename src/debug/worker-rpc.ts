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
  redactDebugValue,
  assertBoundedJson,
  authorizeDebugRpc,
  type DebugRpcError,
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
const METHODS = new Set<DebugRpcMethod>([
  'worker.status', 'worker.stop', 'worker.kill', 'worker.restart', 'worker.recover',
  'fiber.reload', 'core.view.get', 'core.command.dispatch', 'debug.subscribe', 'inspector.endpoint.get',
  'debug.status', 'debug.core.view', 'debug.core.events', 'debug.workflows', 'debug.pending-requests',
  'debug.creator.previews', 'debug.consultations.current-turn', 'debug.room.snapshot', 'debug.cancel-request',
  'debug.reload-plugin', 'debug.flush',
])
const COMMANDS = new Set(['submit-text', 'select-role', 'approve', 'reject', 'edit-proposal', 'choose', 'cancel', 'retry', 'restart', 'role-management'])

export class WorkerRpcServer {
  private readonly input: Readable
  private readonly output: Writable
  private readonly owner: DebugOwner
  private boundOwner?: Pick<DebugOwner, 'ownerId' | 'sessionId'>
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
  private readonly eventHistory: import('../core/protocol.ts').CoreEvent[] = []
  private readonly pluginFibers = new Map<string, { dispose(): Promise<void> | void }>()

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
    this.attachComposition(this.composition)
    this.generation++
    this.setStatus('running')
    this.write({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'ready', generation: this.generation, ...(this.pid ? { pid: this.pid } : {}), changedAt: this.now() })
    this.lineReader = createInterface({ input: this.input })
    this.lineReader.on('line', line => { void this.handleLine(line) })
  }

  private attachComposition(composition: WorkerComposition): void {
    composition.core.subscribe(event => {
      const diagnosticEvent = redactDebugValue(event) as unknown as import('../core/protocol.ts').CoreEvent
      this.eventHistory.push(diagnosticEvent)
      while (this.eventHistory.length > 256) this.eventHistory.shift()
      this.emit({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'stream', stream: 'core.event', sequence: ++this.sequence, revision: event.revision, event: diagnosticEvent })
      this.emit({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'stream', stream: 'core.view', sequence: ++this.sequence, revision: composition.core.getView().revision, view: redactDebugValue(composition.core.getView()) as unknown as import('../core/protocol.ts').CoreView })
    })
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
      try {
        validateCancellation(value as RequestCancellation)
        const cancellation = value as RequestCancellation
        if (this.boundOwner && (cancellation.owner.ownerId !== this.boundOwner.ownerId || cancellation.owner.sessionId !== this.boundOwner.sessionId)) throw unauthorized('Debug owner/session is not authorized for this worker.')
        this.pending.get(cancellation.requestId)?.abort(cancellation.reason ?? 'cancelled')
      } catch (error) { this.writeError('invalid-cancel', 'worker.status', errorMessage(error), errorCode(error)) }
      return
    }
    try {
      validateWorkerRequest(value as WorkerRequest)
      const request = value as WorkerRequest
      if (!METHODS.has(request.method)) throw new Error('Unsupported worker method.')
      authorizeDebugRpc(request.owner, request.method)
      if (this.boundOwner && (request.owner.ownerId !== this.boundOwner.ownerId || request.owner.sessionId !== this.boundOwner.sessionId)) throw new Error('Debug owner/session is not authorized for this worker.')
      this.boundOwner ??= { ownerId: request.owner.ownerId, sessionId: request.owner.sessionId }
      const controller = new AbortController()
      this.pending.set(request.requestId, controller)
      try {
        const result = await this.dispatch(request, controller.signal)
        this.write({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'response', requestId: request.requestId, owner: { ownerId: request.owner.ownerId, sessionId: request.owner.sessionId }, method: request.method, ok: true, result } as WorkerResponse)
      } catch (error) {
        const cancelled = controller.signal.aborted
        const code = cancelled ? 'cancelled' : errorCode(error)
        this.write({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'response', requestId: request.requestId, owner: { ownerId: request.owner.ownerId, sessionId: request.owner.sessionId }, method: request.method, ok: false, error: { code, message: errorMessage(error), retryable: cancelled } } as WorkerResponse)
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
    if (request.method === 'core.view.get' || request.method === 'debug.core.view') return redactDebugValue(this.composition.core.getView())
    if (request.method === 'debug.status') return this.snapshot()
    if (request.method === 'debug.core.events') {
      const limit = request.params.limit ?? 64
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error('Event limit must be an integer from 1 to 256.')
      return { events: this.eventHistory.slice(-limit) }
    }
    if (request.method === 'debug.workflows') return { workflows: redactDebugValue(this.composition.core.getView().workflows) }
    if (request.method === 'debug.pending-requests') return { requestIds: [...this.pending.keys()] }
    if (request.method === 'debug.creator.previews') throw unsupported('Creator preview provider is not installed.')
    if (request.method === 'debug.consultations.current-turn') throw unsupported('Consultation provider is not installed.')
    if (request.method === 'debug.room.snapshot') {
      const roomId = request.params.roomId
      if (roomId !== undefined) throw unsupported('Room selection is not available in this single-room worker.')
      return redactDebugValue(this.composition.core.getView().state)
    }
    if (request.method === 'debug.cancel-request') {
      const controller = this.pending.get(request.params.requestId)
      if (!controller) throw notFound('Request not found for this owner/session.')
      controller.abort(request.params.reason ?? 'debug cancellation')
      return { cancelled: true, requestId: request.params.requestId }
    }
    if (request.method === 'debug.reload-plugin') {
      const pluginId = request.params.pluginId
      const fiber = this.pluginFibers.get(pluginId)
      if (fiber) {
        await fiber.dispose()
        this.pluginFibers.delete(pluginId)
      }
      // StageCraft 在 worker 内以单一 composition 运行：重载即重建 composition。
      const old = this.composition
      this.composition = undefined
      if (old) await old.close()
      const next = await this.createComposition()
      this.composition = next
      this.attachComposition(next)
      this.generation++
      this.setStatus('running')
      return { pluginId, reloaded: true, generation: this.generation }
    }
    if (request.method === 'fiber.reload') throw unsupported('Cordis fiber reload is not exposed by this worker boundary.')
    if (request.method === 'debug.flush') { await new Promise<void>(resolve => setImmediate(resolve)); return { flushed: true } }
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
  private writeError(requestId: string, method: string, message: string, code: DebugRpcError['code'] = 'invalid-request'): void { this.write({ protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'response', requestId, owner: { ownerId: this.owner.ownerId, sessionId: this.owner.sessionId }, method, ok: false, error: { code, message } }) }
}

export async function runWorkerRpcServer(options: WorkerRpcServerOptions): Promise<WorkerRpcServer> {
  const server = new WorkerRpcServer(options)
  await server.start()
  return server
}

function unsupported(message: string): Error { return Object.assign(new Error(message), { code: 'unsupported' as const }) }
function notFound(message: string): Error { return Object.assign(new Error(message), { code: 'not-found' as const }) }
function unauthorized(message: string): Error { return Object.assign(new Error(message), { code: 'unauthorized' as const }) }
function errorCode(error: unknown): DebugRpcError['code'] {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
  return ['unsupported', 'not-found', 'unauthorized'].includes(String(code)) ? code as DebugRpcError['code'] : 'internal'
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
