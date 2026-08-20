/** Browser adapter for the CoreConnection wire protocol. */
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

export class CoreClient {
  constructor({ viewPath = '/api/core/view', commandPath = '/api/core/commands', eventsPath = '/api/core/events', session = '', fetchImpl = fetch, reconnectInitialMs = 250, reconnectMaxMs = 5000 } = {}) {
    this.viewPath = viewPath
    this.commandPath = commandPath
    this.eventsPath = eventsPath
    this.session = session
    this.fetchImpl = fetchImpl
    this.reconnectInitialMs = reconnectInitialMs
    this.reconnectMaxMs = reconnectMaxMs
    this.view = null
    this.listeners = new Set()
    this.controller = null
    this.generation = 0
    this.closed = false
  }

  headers(extra = {}) { return { ...extra, ...(this.session ? { authorization: `Bearer ${this.session}` } : {}) } }

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
      // Subscribe first so events occurring during the full-view fetch are buffered.
      const response = await this.fetchImpl(this.eventsPath, { headers: this.headers({ accept: 'text/event-stream' }), signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`Core Events failed: ${response.status}`)
      eventStream = response.body
      const view = await this.getView(controller.signal)
      if (generation !== this.generation) return view
      this.#notify({ type: 'core.resync', reason, revision: view.revision, view })
      this.#consume(eventStream, generation).catch(() => this.#retry(generation, attempt + 1))
      return view
    } catch (error) {
      try { await eventStream?.cancel() } catch {}
      if (generation === this.generation && !controller.signal.aborted) this.#retry(generation, attempt + 1)
      throw error
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
          try { this.#notify(JSON.parse(data)) } catch {}
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
