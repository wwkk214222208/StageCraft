import type { CoreEvent, CoreRuntimePort, CoreView, HumanCommand } from './protocol.ts'

export type CoreConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'disposed'

export type CoreConnectionMessage =
  | { type: 'connection.state'; state: CoreConnectionState; attempt?: number }
  | { type: 'core.resync'; reason: 'initial' | 'manual' | 'reconnect'; revision: number; view: CoreView }
  | { type: 'core.event'; event: CoreEvent }

export interface CoreCommandResult {
  ok: true
  view: CoreView
}

export interface CoreConnection {
  readonly state: CoreConnectionState
  getView(): Promise<CoreView>
  dispatch(command: HumanCommand): Promise<CoreCommandResult>
  subscribe(listener: (message: CoreConnectionMessage) => void): () => void
  reconnect(): Promise<CoreView>
  dispose(): void | Promise<void>
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
type Delay = (milliseconds: number, signal: AbortSignal) => Promise<void>

const clone = <T>(value: T): T => structuredClone(value)

function defaultDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('Aborted'))
    const finish = (): void => { signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('Aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

class SseDataParser {
  private buffer = ''
  private previousChunkEndedWithCarriageReturn = false

  push(text: string, emit: (data: string) => void): void {
    if (!text) return
    if (this.previousChunkEndedWithCarriageReturn) {
      this.previousChunkEndedWithCarriageReturn = false
      if (text.startsWith('\n')) text = text.slice(1)
      if (!text) return
    }
    this.previousChunkEndedWithCarriageReturn = text.endsWith('\r')
    this.buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    let boundary: number
    while ((boundary = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (data) emit(data)
    }
  }
}

export class LocalCoreConnection implements CoreConnection {
  private readonly core: CoreRuntimePort
  private currentState: CoreConnectionState = 'idle'
  private readonly listeners = new Set<(message: CoreConnectionMessage) => void>()
  private unsubscribeCore?: () => void
  private disposed = false

  constructor(core: CoreRuntimePort) { this.core = core }

  get state(): CoreConnectionState { return this.currentState }

  async getView(): Promise<CoreView> {
    this.assertActive()
    return clone(this.core.getView())
  }

  async dispatch(command: HumanCommand): Promise<CoreCommandResult> {
    this.assertActive()
    await this.core.dispatch(clone(command))
    return { ok: true, view: clone(this.core.getView()) }
  }

  subscribe(listener: (message: CoreConnectionMessage) => void): () => void {
    this.assertActive()
    this.listeners.add(listener)
    if (!this.unsubscribeCore) {
      this.unsubscribeCore = this.core.subscribe(event => this.emit({ type: 'core.event', event: clone(event) }))
      this.setState('connected')
      const view = clone(this.core.getView())
      this.emit({ type: 'core.resync', reason: 'initial', revision: view.revision, view })
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.unsubscribeCore?.()
        this.unsubscribeCore = undefined
        this.setState('idle')
      }
    }
  }

  async reconnect(): Promise<CoreView> {
    this.assertActive()
    this.setState('connecting')
    const view = clone(this.core.getView())
    this.setState('connected')
    this.emit({ type: 'core.resync', reason: 'manual', revision: view.revision, view })
    return clone(view)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeCore?.()
    this.unsubscribeCore = undefined
    this.listeners.clear()
    this.currentState = 'disposed'
  }

  private emit(message: CoreConnectionMessage): void {
    const safe = clone(message)
    for (const listener of this.listeners) listener(clone(safe))
  }

  private setState(state: CoreConnectionState): void {
    this.currentState = state
    this.emit({ type: 'connection.state', state })
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Core connection is disposed.')
  }
}

export interface RemoteCoreConnectionOptions {
  baseUrl: string
  session: string
  fetch?: FetchLike
  reconnectInitialMs?: number
  reconnectMaxMs?: number
  delay?: Delay
}

export class RemoteCoreConnection implements CoreConnection {
  private currentState: CoreConnectionState = 'idle'
  private readonly listeners = new Set<(message: CoreConnectionMessage) => void>()
  private readonly fetchImpl: FetchLike
  private readonly baseUrl: string
  private readonly session: string
  private readonly reconnectInitialMs: number
  private readonly reconnectMaxMs: number
  private readonly delay: Delay
  private controller?: AbortController
  private generation = 0
  private connectPromise?: Promise<CoreView>
  private disposed = false
  private lastView?: CoreView

  constructor(options: RemoteCoreConnectionOptions) {
    if (!options.session) throw new Error('Remote Core session is required.')
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.session = options.session
    this.fetchImpl = options.fetch ?? fetch
    this.reconnectInitialMs = Math.max(1, options.reconnectInitialMs ?? 250)
    this.reconnectMaxMs = Math.max(this.reconnectInitialMs, options.reconnectMaxMs ?? 5_000)
    this.delay = options.delay ?? defaultDelay
  }

  get state(): CoreConnectionState { return this.currentState }

  async getView(): Promise<CoreView> {
    this.assertActive()
    const view = await this.requestView()
    this.lastView = clone(view)
    return clone(view)
  }

  async dispatch(command: HumanCommand): Promise<CoreCommandResult> {
    this.assertActive()
    const response = await this.fetchImpl(`${this.baseUrl}/api/core/commands`, {
      method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(clone(command)),
    })
    const body = await this.readJson(response)
    if (!response.ok) throw new Error(this.errorMessage(body, `Core Command failed: ${response.status}`))
    const result = body as CoreCommandResult
    if (result.view) this.lastView = clone(result.view)
    return clone(result)
  }

  subscribe(listener: (message: CoreConnectionMessage) => void): () => void {
    this.assertActive()
    this.listeners.add(listener)
    if (this.listeners.size === 1) void this.connect('initial', 0).catch(() => undefined)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop('idle')
    }
  }

  reconnect(): Promise<CoreView> {
    this.assertActive()
    this.stop('disconnected')
    return this.connect('manual', 0)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    this.controller?.abort()
    this.controller = undefined
    this.connectPromise = undefined
    this.currentState = 'disposed'
    this.listeners.clear()
  }

  private connect(reason: 'initial' | 'manual' | 'reconnect', attempt: number): Promise<CoreView> {
    if (this.connectPromise) return this.connectPromise
    const generation = ++this.generation
    const controller = new AbortController()
    this.controller = controller
    this.setState(reason === 'reconnect' ? 'reconnecting' : 'connecting', attempt)
    const promise = this.open(generation, controller, reason, attempt)
    this.connectPromise = promise
    void promise.finally(() => { if (this.connectPromise === promise) this.connectPromise = undefined }).catch(() => undefined)
    return promise
  }

  private async open(generation: number, controller: AbortController, reason: 'initial' | 'manual' | 'reconnect', attempt: number): Promise<CoreView> {
    let eventStream: ReadableStream<Uint8Array> | undefined
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/core/events`, { headers: this.headers({ accept: 'text/event-stream' }), signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`Core Events failed: ${response.status}`)
      eventStream = response.body
      // Establish the stream first. Bytes arriving while the authoritative view
      // is fetched remain buffered, closing the GET-view/SSE subscription gap.
      const view = await this.requestView(controller.signal)
      if (!this.isCurrent(generation)) throw new Error('Connection superseded.')
      this.lastView = clone(view)
      this.setState('connected')
      this.emit({ type: 'core.resync', reason, revision: view.revision, view })
      void this.consume(eventStream, generation, controller).catch(error => this.handleDisconnect(error, generation, attempt + 1))
      return clone(view)
    } catch (error) {
      try { await eventStream?.cancel() } catch { /* stream setup may already have failed */ }
      if (this.isCurrent(generation)) void this.handleDisconnect(error, generation, attempt + 1)
      throw error
    }
  }

  private async consume(stream: ReadableStream<Uint8Array>, generation: number, controller: AbortController): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    const parser = new SseDataParser()
    try {
      while (this.isCurrent(generation)) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error('Core event stream closed.')
        parser.push(decoder.decode(chunk.value, { stream: true }), data => {
          try { this.emit({ type: 'core.event', event: JSON.parse(data) as CoreEvent }) } catch { /* malformed events are ignored; stream stays usable */ }
        })
      }
    } finally {
      try { await reader.cancel() } catch { /* stream may already be aborted */ }
      if (!controller.signal.aborted && this.isCurrent(generation)) throw new Error('Core event stream closed.')
    }
  }

  private async handleDisconnect(_error: unknown, generation: number, attempt: number): Promise<void> {
    if (!this.isCurrent(generation) || this.listeners.size === 0) return
    this.setState('reconnecting', attempt)
    const milliseconds = Math.min(this.reconnectMaxMs, this.reconnectInitialMs * 2 ** Math.max(0, attempt - 1))
    const controller = this.controller
    if (!controller) return
    try { await this.delay(milliseconds, controller.signal) } catch { return }
    if (!this.isCurrent(generation)) return
    this.controller = undefined
    this.connectPromise = undefined
    void this.connect('reconnect', attempt).catch(() => undefined)
  }

  private async requestView(signal?: AbortSignal): Promise<CoreView> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/core/view`, { headers: this.headers({ accept: 'application/json' }), signal })
    const body = await this.readJson(response)
    if (!response.ok) throw new Error(this.errorMessage(body, `Core View request failed: ${response.status}`))
    return clone(body as CoreView)
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return { ...extra, authorization: `Bearer ${this.session}` }
  }

  private async readJson(response: Response): Promise<unknown> {
    try { return await response.json() } catch { return {} }
  }

  private errorMessage(body: unknown, fallback: string): string {
    return body && typeof body === 'object' && typeof (body as any).error === 'string' ? (body as any).error : fallback
  }

  private emit(message: CoreConnectionMessage): void {
    const safe = clone(message)
    for (const listener of this.listeners) listener(clone(safe))
  }

  private setState(state: CoreConnectionState, attempt?: number): void {
    this.currentState = state
    this.emit({ type: 'connection.state', state, ...(attempt === undefined ? {} : { attempt }) })
  }

  private stop(state: CoreConnectionState): void {
    this.generation++
    this.controller?.abort()
    this.controller = undefined
    this.connectPromise = undefined
    this.setState(state)
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Core connection is disposed.')
  }
}
