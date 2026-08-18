/**
 * 人-核心交互层的浏览器客户端。
 *
 * 第一阶段只维护 CoreView/Event 通道；旧页面仍使用 RoomSnapshot 渲染，避免一次性
 * 改写 UI。后续 renderer 可以直接消费 view 和事件，而不需要改 transport。
 */
export class CoreClient {
  constructor({ viewPath = '/api/core/view', commandPath = '/api/core/commands', eventsPath = '/api/core/events' } = {}) {
    this.viewPath = viewPath
    this.commandPath = commandPath
    this.eventsPath = eventsPath
    this.view = null
    this.listeners = new Set()
    this.eventSource = null
  }

  async getView() {
    const response = await fetch(this.viewPath, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`Core View request failed: ${response.status}`)
    this.view = await response.json()
    return this.view
  }

  async dispatch(command) {
    const response = await fetch(this.commandPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(command),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || `Core Command failed: ${response.status}`)
    if (body.view) this.view = body.view
    return body
  }

  subscribe(listener) {
    this.listeners.add(listener)
    if (!this.eventSource) {
      this.eventSource = new EventSource(this.eventsPath)
      this.eventSource.onmessage = event => this.#receive(event)
      this.eventSource.addEventListener('state.changed', event => this.#receive(event))
      this.eventSource.addEventListener('workflow.changed', event => this.#receive(event))
      this.eventSource.addEventListener('interaction.created', event => this.#receive(event))
      this.eventSource.addEventListener('error', event => this.#receive(event))
    }
    return () => this.listeners.delete(listener)
  }

  close() {
    this.eventSource?.close()
    this.eventSource = null
    this.listeners.clear()
  }

  #receive(event) {
    let value
    try { value = JSON.parse(event.data) } catch { return }
    for (const listener of this.listeners) listener(value)
  }
}
