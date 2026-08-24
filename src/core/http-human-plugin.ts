import type { IncomingMessage, ServerResponse } from 'node:http'
import type { URL } from 'node:url'
import type { CoreEvent, CoreRuntimePort, HumanCommand } from './protocol.ts'
import type { Disposable, HumanCoreInteractionPlugin } from './plugins.ts'

/**
 * Node HTTP 人-核心交互插件。
 *
 * 它只依赖 CoreRuntimePort 和 node:http，不访问 Store、RoomRuntime 或具体业务
 * 路由。组合根通过 handle() 将匹配到的三条 Core 协议端点交给它处理。
 */
export class HttpHumanCorePlugin implements HumanCoreInteractionPlugin {
  readonly id = 'stagecraft.human.http'
  private core?: CoreRuntimePort
  private unsubscribe?: () => void
  private readonly clients = new Set<ServerResponse>()

  get activeSseCount(): number {
    return this.clients.size
  }

  install(core: CoreRuntimePort): Disposable {
    if (this.core) throw new Error('HTTP human plugin is already installed.')
    this.core = core
    this.unsubscribe = core.subscribe(event => this.publish(event))
    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        this.unsubscribe?.()
        this.unsubscribe = undefined
        this.core = undefined
        for (const response of this.clients) {
          response.end()
        }
        this.clients.clear()
      },
    }
  }

  async dispatch(command: HumanCommand): Promise<void> {
    const core = this.requireCore()
    await core.dispatch(command)
  }

  publish(event: CoreEvent): void {
    if (!this.core) return
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const response of this.clients) {
      if (response.destroyed || response.writableEnded) {
        this.clients.delete(response)
        continue
      }
      response.write(payload)
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/core/')) return false
    this.requireCore()
    if (url.pathname === '/api/core/view' && request.method === 'GET') {
      this.sendJson(response, 200, this.requireCore().getView())
      return true
    }
    if (url.pathname === '/api/core/commands' && request.method === 'POST') {
      const command = await this.readJson(request)
      await this.dispatch(command as HumanCommand)
      this.sendJson(response, 200, { ok: true, view: this.requireCore().getView() })
      return true
    }
    if (url.pathname === '/api/core/ui/action' && request.method === 'POST') {
      const body = await this.readJson(request)
      const core = this.requireCore()
      const actionId = String(body.actionId ?? '')
      const input = body.input
      const owner = String(body.owner ?? '')
      // CoreRuntimePort 不含 UI 能力；只有实现了 CoreExtensionPort 的 core（如 CoreRuntimeSkeleton）支持。
      const invoke = (core as { invokeUiAction?: (actionId: string, input: unknown, owner: string) => Promise<unknown> }).invokeUiAction
      if (typeof invoke !== 'function') throw new Error('UI action is not available on this core.')
      const output = await invoke(actionId, input, owner)
      this.sendJson(response, 200, { ok: true, actionId, output: structuredClone(output ?? null) })
      return true
    }
    if (url.pathname === '/api/core/events' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      // 首个注释块用于立即刷新 headers；EventSource 会忽略 SSE 注释，协议仍只广播 data 事件。
      response.write(': connected\n\n')
      this.clients.add(response)
      const cleanup = (): void => {
        this.clients.delete(response)
        request.off('close', cleanup)
        response.off('close', cleanup)
      }
      request.once('close', cleanup)
      response.once('close', cleanup)
      return true
    }
    return false
  }

  private requireCore(): CoreRuntimePort {
    if (!this.core) throw new Error('HTTP human plugin is not installed.')
    return this.core
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(value))
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
  }
}
