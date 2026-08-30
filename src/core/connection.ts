import { CORE_PROTOCOL_VERSION, supportsProtocolVersion } from './protocol.ts'
import type { CoreCapability, CoreEvent, CoreEventEnvelope, CoreHealth, CoreRuntimePort, CoreView, CommandReceipt, HumanCommand } from './protocol.ts'

export type CoreConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'disposed'

export type CoreConnectionMessage =
  | { type: 'connection.state'; state: CoreConnectionState; attempt?: number }
  | { type: 'core.resync'; reason: 'initial' | 'manual' | 'reconnect'; revision: number; view: CoreView }
  /** 1.1 连接携带 envelope（roomId/turnId/requestId 关联元数据）；1.0 legacy 连接不带。 */
  | { type: 'core.event'; event: CoreEvent; envelope?: CoreEventEnvelope }
  | { type: 'connection.error'; message: string; code?: string }

export interface CoreCommandResult {
  ok: true
  view: CoreView
}

export interface CoreConnection {
  readonly state: CoreConnectionState
  /** 协商后的协议版本：本地恒为 CORE_PROTOCOL_VERSION；远程在首次连接时探测（1.0 legacy 或 1.1）。 */
  readonly protocolVersion: string
  getView(): Promise<CoreView>
  dispatch(command: HumanCommand): Promise<CoreCommandResult>
  /** 回执语义（§3.3）：网络错误在提交之后发生时返回 unknown-after-disconnect，绝不重放。 */
  dispatchWithReceipt(command: HumanCommand): Promise<CommandReceipt>
  /** 1.1 握手；1.0 legacy 服务端返回 null。 */
  health(): Promise<CoreHealth | null>
  capabilities(): Promise<CoreCapability[]>
  cancel(requestId: string): Promise<boolean>
  subscribe(listener: (message: CoreConnectionMessage) => void): () => void
  reconnect(): Promise<CoreView>
  dispose(): void | Promise<void>
}

/** 版本支持范围无交集（§3.2）：确定性失败，连接不得自动重试，UI 收到 protocol_incompatible。 */
export class ProtocolIncompatibleError extends Error {
  readonly code = 'protocol_incompatible'
  readonly clientVersion: string
  readonly serverMin: string
  readonly serverMax: string
  constructor(clientVersion: string, serverMin: string, serverMax: string) {
    super(`协议版本无交集：client ${clientVersion} 不在 server 支持范围 [${serverMin}, ${serverMax}] 内，升级方向见 server health。`)
    this.name = 'ProtocolIncompatibleError'
    this.clientVersion = clientVersion
    this.serverMin = serverMin
    this.serverMax = serverMax
  }
}

/** §3.4 关联过滤的状态：UI 侧当前权威 revision / 当前 turn / 关心的 request。 */
export interface CoreEventDeliveryFilter {
  revision?: number
  turnId?: string | null
  requestId?: string | null
}

/**
 * 消费规则（计划 §3.4）：
 * - revision 小于当前权威 revision 的事件直接丢弃；
 * - thinking delta 只进入其 requestId 对应的请求（filter.requestId 非空时）；
 * - envelope 带 turnId 且与当前 turn 不匹配的 reaction/decision/draft/thinking 不得渲染。
 * turnId/requestId 未提供或事件未携带时放行（无法判定 ≠ 判定失败）。
 */
export function shouldDeliverCoreEvent(message: { type: string; event: CoreEvent; envelope?: CoreEventEnvelope }, filter: CoreEventDeliveryFilter): boolean {
  if (message.type !== 'core.event') return true
  const event = message.event
  const revision = message.envelope?.revision ?? event.revision
  if (filter.revision !== undefined && typeof revision === 'number' && revision < filter.revision) return false
  if (filter.requestId !== undefined && filter.requestId !== null && event.type === 'model.thinking.delta' && event.requestId !== filter.requestId) return false
  if (filter.turnId !== undefined && filter.turnId !== null) {
    const envelopeTurnId = message.envelope?.turnId
    if (envelopeTurnId !== undefined && envelopeTurnId !== filter.turnId) return false
  }
  return true
}

/** 判断 SSE data 是否为 1.1 envelope（与 raw CoreEvent 的形状差异：protocolVersion+roomId+payload 三元组）。 */
export function isCoreEventEnvelope(value: unknown): value is CoreEventEnvelope {
  return Boolean(value) && typeof value === 'object'
    && 'payload' in (value as object) && 'protocolVersion' in (value as object) && 'roomId' in (value as object)
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
  get protocolVersion(): string { return CORE_PROTOCOL_VERSION }

  async getView(): Promise<CoreView> {
    this.assertActive()
    return clone(this.core.getView())
  }

  async dispatch(command: HumanCommand): Promise<CoreCommandResult> {
    this.assertActive()
    await this.core.dispatch(clone(command))
    return { ok: true, view: clone(this.core.getView()) }
  }

  /** 同进程分派不存在"结果未知"：成功即 accepted，抛错即 rejected。 */
  async dispatchWithReceipt(command: HumanCommand): Promise<CommandReceipt> {
    this.assertActive()
    try {
      await this.core.dispatch(clone(command))
      const view = clone(this.core.getView())
      return { requestId: command.id, status: 'accepted', revision: view.revision, view }
    } catch (error) {
      return { requestId: command.id, status: 'rejected', error: { code: 'command_failed', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  async health(): Promise<CoreHealth | null> {
    this.assertActive()
    return this.core.getHealth?.() ?? null
  }

  async capabilities(): Promise<CoreCapability[]> {
    this.assertActive()
    return this.core.getCapabilities?.() ?? []
  }

  async cancel(requestId: string): Promise<boolean> {
    this.assertActive()
    await this.core.cancel(requestId)
    return true
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
  private negotiated: '1.1' | '1.0' = '1.0'
  private lastDeliveredRevision = Number.NEGATIVE_INFINITY

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
  /** 探测到 1.1 health 前保守按 1.0 对待；真实版本以最近一次连接的协商结果为准。 */
  get protocolVersion(): string { return this.negotiated }

  async getView(): Promise<CoreView> {
    this.assertActive()
    const view = await this.requestView()
    this.lastView = clone(view)
    return clone(view)
  }

  async dispatch(command: HumanCommand): Promise<CoreCommandResult> {
    const receipt = await this.dispatchWithReceipt(command)
    if (receipt.status === 'unknown-after-disconnect') throw new Error(`Core command result is unknown after disconnect: ${command.id}`)
    if (receipt.status === 'rejected') throw new Error(receipt.error?.message ?? `Core command rejected: ${command.id}`)
    return { ok: true, view: receipt.view ?? this.lastView ?? (await this.getView()) }
  }

  /**
   * 回执语义（§3.3）：提交后连接失败 → unknown-after-disconnect（调用方禁止重放）；
   * 服务端明确拒绝 → rejected；1.0 legacy {ok:true,view} 也归一化为 accepted。
   */
  async dispatchWithReceipt(command: HumanCommand): Promise<CommandReceipt> {
    this.assertActive()
    let body: unknown
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/core/commands`, {
        method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(clone(command)),
      })
      body = await this.readJson(response)
      if (!response.ok) {
        return { requestId: command.id, status: 'rejected', error: { code: 'command_rejected', message: this.errorMessage(body, `Core Command failed: ${response.status}`) } }
      }
    } catch (error) {
      return { requestId: command.id, status: 'unknown-after-disconnect', error: { code: 'connection_lost', message: error instanceof Error ? error.message : String(error) } }
    }
    const candidate = body as { requestId?: string; status?: CommandReceipt['status']; revision?: number; view?: CoreView; error?: { code: string; message: string }; ok?: boolean }
    if (candidate && typeof candidate === 'object' && typeof candidate.status === 'string') {
      const receipt: CommandReceipt = { requestId: candidate.requestId ?? command.id, status: candidate.status }
      if (candidate.revision !== undefined) receipt.revision = candidate.revision
      if (candidate.view) { receipt.view = clone(candidate.view); this.lastView = clone(candidate.view) }
      if (candidate.error) receipt.error = candidate.error
      return receipt
    }
    // 1.0 legacy 形状 {ok:true,view}
    const view = (candidate as { view?: CoreView } | null)?.view
    if (view) this.lastView = clone(view)
    return { requestId: command.id, status: 'accepted', revision: view?.revision, view: view ? clone(view) : undefined }
  }

  /** 1.1 服务端返回 CoreHealth；1.0 legacy（无 health 端点）返回 null。 */
  async health(): Promise<CoreHealth | null> {
    this.assertActive()
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/core/health`, { headers: this.headers({ accept: 'application/json' }) })
      if (!response.ok) return null
      return clone(await response.json()) as CoreHealth
    } catch {
      return null
    }
  }

  async capabilities(): Promise<CoreCapability[]> {
    this.assertActive()
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/core/capabilities`, { headers: this.headers({ accept: 'application/json' }) })
      if (!response.ok) return []
      const body = await response.json() as { capabilities?: CoreCapability[] }
      return Array.isArray(body.capabilities) ? clone(body.capabilities) : []
    } catch {
      return []
    }
  }

  /** 1.1 服务端接受取消并返回 {ok:true}；1.0 legacy 无该端点，返回 false（不视为错误）。 */
  async cancel(requestId: string): Promise<boolean> {
    this.assertActive()
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/core/cancel`, {
        method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ requestId }),
      })
      return response.ok
    } catch {
      return false
    }
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
      // 先探测版本（§3.2）：有 health 且支持范围覆盖本客户端 → 1.1；无 health 或探测失败 → 1.0 legacy。
      await this.negotiateVersion(controller.signal)
      const response = await this.fetchImpl(`${this.baseUrl}/api/core/events`, { headers: this.headers({ accept: 'text/event-stream' }), signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`Core Events failed: ${response.status}`)
      eventStream = response.body
      // Establish the stream first. Bytes arriving while the authoritative view
      // is fetched remain buffered, closing the GET-view/SSE subscription gap.
      const view = await this.requestView(controller.signal)
      if (!this.isCurrent(generation)) throw new Error('Connection superseded.')
      this.lastView = clone(view)
      // revision 地板 = 权威 view revision（§3.4）：SSE 在取 view 期间缓存的旧事件不得发给 UI，
      // 否则上一回合内容会重新显示（评审确认的缺陷）。
      this.lastDeliveredRevision = typeof view.revision === 'number' ? view.revision : Number.NEGATIVE_INFINITY
      this.setState('connected')
      this.emit({ type: 'core.resync', reason, revision: view.revision, view })
      void this.consume(eventStream, generation, controller).catch(error => this.handleDisconnect(error, generation, attempt + 1))
      return clone(view)
    } catch (error) {
      try { await eventStream?.cancel() } catch { /* stream setup may already have failed */ }
      // 版本无交集是确定性失败：不得进入重连循环（否则对 1.2 server 无限重试）。
      if (error instanceof ProtocolIncompatibleError) {
        this.emit({ type: 'connection.error', code: error.code, message: error.message })
        this.stop('disconnected')
        throw error
      }
      if (this.isCurrent(generation)) void this.handleDisconnect(error, generation, attempt + 1)
      throw error
    }
  }

  private async negotiateVersion(signal?: AbortSignal): Promise<void> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/core/health`, { headers: this.headers({ accept: 'application/json' }), signal })
      if (!response.ok) { this.negotiated = '1.0'; return }
      const health = await response.json() as { protocolVersion?: string; minSupportedProtocolVersion?: string; maxSupportedProtocolVersion?: string }
      const serverVersion = typeof health.protocolVersion === 'string' ? health.protocolVersion : '1.0'
      const min = typeof health.minSupportedProtocolVersion === 'string' ? health.minSupportedProtocolVersion : serverVersion
      const max = typeof health.maxSupportedProtocolVersion === 'string' ? health.maxSupportedProtocolVersion : serverVersion
      if (!supportsProtocolVersion(CORE_PROTOCOL_VERSION, min, max)) {
        this.negotiated = '1.0'
        throw new ProtocolIncompatibleError(CORE_PROTOCOL_VERSION, min, max)
      }
      this.negotiated = serverVersion === '1.0' ? '1.0' : '1.1'
    } catch (error) {
      if (error instanceof ProtocolIncompatibleError) throw error
      this.negotiated = '1.0'
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
          try {
            const parsed = JSON.parse(data) as unknown
            if (isCoreEventEnvelope(parsed)) {
              // 1.1：envelope 携带关联元数据；revision 单调过滤（§3.4），旧事件直接丢弃。
              const revision = typeof parsed.revision === 'number' ? parsed.revision : undefined
              if (revision !== undefined) {
                if (revision < this.lastDeliveredRevision) return
                this.lastDeliveredRevision = revision
              }
              this.emit({ type: 'core.event', event: parsed.payload, envelope: parsed })
              return
            }
            const event = parsed as CoreEvent
            if (typeof event.revision === 'number') {
              if (event.revision < this.lastDeliveredRevision) return
              this.lastDeliveredRevision = event.revision
            }
            this.emit({ type: 'core.event', event })
          } catch { /* malformed events are ignored; stream stays usable */ }
        })
      }
    } finally {
      try { await reader.cancel() } catch { /* stream may already be aborted */ }
      if (!controller.signal.aborted && this.isCurrent(generation)) throw new Error('Core event stream closed.')
    }
  }

  private async handleDisconnect(_error: unknown, generation: number, attempt: number): Promise<void> {
    if (_error instanceof ProtocolIncompatibleError) return
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
    // 服务端按此头做逐连接版本整形；1.0 server 忽略之。
    return { ...extra, authorization: `Bearer ${this.session}`, 'x-core-protocol-version': CORE_PROTOCOL_VERSION }
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
