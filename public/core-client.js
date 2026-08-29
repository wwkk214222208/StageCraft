/** Browser adapter for the CoreConnection wire protocol (1.0/1.1). */

/** 协议版本头：1.1 server 按此做逐连接整形（Q5）；1.0 server 忽略。 */
const CORE_PROTOCOL_VERSION = '1.1'

class SseDataParser {
  buffer = ''
  previousChunkEndedWithCarriageReturn = false

  push(text, emit) {
    if (!text) return
    if (this.previousChunkEndedWithCarriageReturn) {
      this.previousChunkEndedWithCarriageReturn = false
      if (text.startsWith('\n')) text = text.slice(1)
      if (!text) return
    }
    this.previousChunkEndedWithCarriageReturn = text.endsWith('\r')
    this.buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    let boundary
    while ((boundary = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (data) emit(data)
    }
  }
}

/** 1.1 envelope 判别：protocolVersion+roomId+payload 三元组不会出现在 raw CoreEvent 上。 */
function isEnvelope(value) {
  return Boolean(value) && typeof value === 'object' && 'payload' in value && 'protocolVersion' in value && 'roomId' in value
}

/**
 * §3.4 消费规则：revision 单调、thinking delta 按 requestId 关联、envelope 带 turnId 时按当前回合过滤。
 * 未提供或事件未携带的关联字段放行（无法判定 ≠ 判定失败）。
 */
export function coreEventShouldDeliver(message, { revision, turnId, requestId } = {}) {
  if (!message || message.type !== 'core.event') return true
  const event = message.event
  const eventRevision = message.envelope ? message.envelope.revision : event.revision
  if (revision !== undefined && revision !== null && typeof eventRevision === 'number' && eventRevision < revision) return false
  if (requestId !== undefined && requestId !== null && event.type === 'model.thinking.delta' && event.requestId !== requestId) return false
  if (turnId !== undefined && turnId !== null && message.envelope && message.envelope.turnId !== undefined && message.envelope.turnId !== turnId) return false
  return true
}

export class CoreClient {
  constructor({
    viewPath = '/api/core/view',
    commandPath = '/api/core/commands',
    eventsPath = '/api/core/events',
    healthPath = '/api/core/health',
    cancelPath = '/api/core/cancel',
    capabilitiesPath = '/api/core/capabilities',
    session = '',
    fetchImpl = fetch,
    reconnectInitialMs = 250,
    reconnectMaxMs = 5000,
  } = {}) {
    this.viewPath = viewPath
    this.commandPath = commandPath
    this.eventsPath = eventsPath
    this.healthPath = healthPath
    this.cancelPath = cancelPath
    this.capabilitiesPath = capabilitiesPath
    this.session = session
    this.fetchImpl = fetchImpl
    this.reconnectInitialMs = reconnectInitialMs
    this.reconnectMaxMs = reconnectMaxMs
    this.view = null
    this.listeners = new Set()
    this.controller = null
    this.generation = 0
    this.closed = false
    this.lastRevision = Number.NEGATIVE_INFINITY
    this.negotiatedVersion = '1.0'
  }

  headers(extra = {}) {
    return { ...extra, ...(this.session ? { authorization: `Bearer ${this.session}` } : {}), 'x-core-protocol-version': CORE_PROTOCOL_VERSION }
  }

  async getView(signal) {
    const response = await this.fetchImpl(this.viewPath, { headers: this.headers({ accept: 'application/json' }), signal })
    if (!response.ok) throw new Error(`Core View request failed: ${response.status}`)
    this.view = await response.json()
    return structuredClone(this.view)
  }

  async dispatch(command) {
    const response = await this.fetchImpl(this.commandPath, {
      method: 'POST', headers: this.headers({ 'content-type': 'application/json', accept: 'application/json' }), body: JSON.stringify(structuredClone(command)),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || `Core Command failed: ${response.status}`)
    if (body.view) this.view = structuredClone(body.view)
    return structuredClone(body)
  }

  /**
   * 回执语义（§3.3）：提交后连接失败 → unknown-after-disconnect（调用方禁止重放非幂等命令）；
   * 服务端明确拒绝 → rejected；1.0 legacy {ok:true,view} 归一化为 accepted。
   */
  async dispatchWithReceipt(command) {
    let body
    try {
      const response = await this.fetchImpl(this.commandPath, {
        method: 'POST', headers: this.headers({ 'content-type': 'application/json', accept: 'application/json' }), body: JSON.stringify(structuredClone(command)),
      })
      body = await response.json()
      if (!response.ok) return { requestId: command.id, status: 'rejected', error: { code: 'command_rejected', message: body.error || `Core Command failed: ${response.status}` } }
    } catch (error) {
      return { requestId: command.id, status: 'unknown-after-disconnect', error: { code: 'connection_lost', message: error instanceof Error ? error.message : String(error) } }
    }
    if (body && typeof body.status === 'string') {
      if (body.view) this.view = structuredClone(body.view)
      return structuredClone(body)
    }
    if (body.view) this.view = structuredClone(body.view)
    return { requestId: command.id, status: 'accepted', revision: body.view ? body.view.revision : undefined, view: body.view ? structuredClone(body.view) : undefined }
  }

  /** 1.1 服务端返回 CoreHealth；1.0 legacy 或网络失败返回 null（不视为错误）。 */
  async getHealth() {
    try {
      const response = await this.fetchImpl(this.healthPath, { headers: this.headers({ accept: 'application/json' }) })
      if (!response.ok) return null
      return await response.json()
    } catch {
      return null
    }
  }

  async getCapabilities() {
    try {
      const response = await this.fetchImpl(this.capabilitiesPath, { headers: this.headers({ accept: 'application/json' }) })
      if (!response.ok) return []
      const body = await response.json()
      return Array.isArray(body.capabilities) ? structuredClone(body.capabilities) : []
    } catch {
      return []
    }
  }

  /** 1.0 legacy 无 cancel 端点：返回 false，不视为错误。 */
  async cancel(requestId) {
    try {
      const response = await this.fetchImpl(this.cancelPath, {
        method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ requestId }),
      })
      return response.ok
    } catch {
      return false
    }
  }

  subscribe(listener) {
    if (this.closed) throw new Error('Core client is closed.')
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.#connect('initial', 0).catch(() => {})
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.#abort()
    }
  }

  reconnect() {
    if (this.closed) return Promise.reject(new Error('Core client is closed.'))
    this.#abort()
    return this.#connect('manual', 0)
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.#abort()
    this.listeners.clear()
  }

  async #connect(reason, attempt) {
    if (this.closed || this.listeners.size === 0) return this.view
    const generation = ++this.generation
    const controller = new AbortController()
    this.controller = controller
    let eventStream
    try {
      // 先探测版本（有 health → 1.1；无 → 1.0 legacy），再订阅。
      await this.#negotiate()
      // Subscribe first so events occurring during the full-view fetch are buffered.
      const response = await this.fetchImpl(this.eventsPath, { headers: this.headers({ accept: 'text/event-stream' }), signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`Core Events failed: ${response.status}`)
      eventStream = response.body
      const view = await this.getView(controller.signal)
      if (generation !== this.generation) return view
      // resync 之后才接受增量：revision 地板重置为权威 view revision（§3.4）。
      this.lastRevision = view.revision
      this.#notify({ type: 'core.resync', reason, revision: view.revision, view })
      this.#consume(eventStream, generation).catch(() => this.#retry(generation, attempt + 1))
      return view
    } catch (error) {
      try { await eventStream?.cancel() } catch {}
      if (generation === this.generation && !controller.signal.aborted) this.#retry(generation, attempt + 1)
      throw error
    }
  }

  async #negotiate() {
    try {
      const response = await this.fetchImpl(this.healthPath, { headers: this.headers({ accept: 'application/json' }) })
      if (!response.ok) { this.negotiatedVersion = '1.0'; return }
      const health = await response.json()
      this.negotiatedVersion = health && health.protocolVersion === '1.0' ? '1.0' : '1.1'
    } catch {
      this.negotiatedVersion = '1.0'
    }
  }

  async #consume(stream, generation) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    const parser = new SseDataParser()
    try {
      while (!this.closed && generation === this.generation) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error('Core event stream closed.')
        parser.push(decoder.decode(chunk.value, { stream: true }), data => {
          try {
            const parsed = JSON.parse(data)
            if (isEnvelope(parsed)) {
              const revision = typeof parsed.revision === 'number' ? parsed.revision : undefined
              if (revision !== undefined) {
                if (revision < this.lastRevision) return
                this.lastRevision = revision
              }
              this.#notify({ type: 'core.event', event: parsed.payload, envelope: parsed })
              return
            }
            if (parsed && typeof parsed.revision === 'number') {
              if (parsed.revision < this.lastRevision) return
              this.lastRevision = parsed.revision
            }
            this.#notify(parsed)
          } catch {}
        })
      }
    } finally {
      try { await reader.cancel() } catch {}
    }
  }

  #retry(generation, attempt) {
    if (this.closed || generation !== this.generation || this.listeners.size === 0) return
    const delay = Math.min(this.reconnectMaxMs, this.reconnectInitialMs * 2 ** Math.max(0, attempt - 1))
    setTimeout(() => { if (!this.closed && generation === this.generation) this.#connect('reconnect', attempt).catch(() => {}) }, delay)
  }

  #abort() {
    this.generation++
    this.controller?.abort()
    this.controller = null
  }

  #notify(value) {
    const safe = structuredClone(value)
    for (const listener of this.listeners) listener(structuredClone(safe))
  }
}
