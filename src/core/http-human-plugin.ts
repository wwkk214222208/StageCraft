import type { IncomingMessage, ServerResponse } from 'node:http'
import type { URL } from 'node:url'
import { CORE_PROTOCOL_VERSION, MAX_SUPPORTED_PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION } from './protocol.ts'
import type { CoreEvent, CoreEventEnvelope, CoreHealth, CoreRuntimePort, HumanCommand } from './protocol.ts'
import type { Disposable, HumanCoreInteractionPlugin } from './plugins.ts'

export interface HttpHumanCorePluginOptions {
  /** envelope 上下文（§3.4）：提供权威 roomId；requestId→turnId 映射用于回合作用域过滤。缺省 roomId 为空串。 */
  roomId?: () => string
  turnIdForRequest?: (requestId: string) => string | undefined
}

interface CoreSseClient {
  response: ServerResponse
  protocol: '1.1' | '1.0'
}

/**
 * Node HTTP 人-核心交互插件。
 *
 * 它只依赖 CoreRuntimePort 和 node:http，不访问 Store、RoomRuntime 或具体业务
 * 路由。组合根通过 handle() 将匹配到的 Core 协议端点交给它处理。
 *
 * 协议 1.1（Q5 逐连接整形）：服务端内部统一使用 1.1 canonical shape，仅在 HTTP/SSE
 * 边界按客户端声明的 `x-core-protocol-version` 输出——1.0 客户端收到旧 CoreEvent 与
 * {ok:true,view}，1.1 客户端收到 envelope/receipt。缺省（无头）按 1.0 处理。
 */
export class HttpHumanCorePlugin implements HumanCoreInteractionPlugin {
  readonly id = 'stagecraft.human.http'
  private core?: CoreRuntimePort
  private unsubscribe?: () => void
  private readonly clients = new Set<CoreSseClient>()
  private heartbeat?: ReturnType<typeof setInterval>
  private readonly roomId?: () => string
  private readonly turnIdForRequest?: (requestId: string) => string | undefined

  constructor(options: HttpHumanCorePluginOptions = {}) {
    this.roomId = options.roomId
    this.turnIdForRequest = options.turnIdForRequest
  }

  get activeSseCount(): number {
    return this.clients.size
  }

  install(core: CoreRuntimePort): Disposable {
    if (this.core) throw new Error('HTTP human plugin is already installed.')
    this.core = core
    this.unsubscribe = core.subscribe(event => this.publish(event))
    // 1.1 心跳：注释行对旧 EventSource 透明；用于中间代理保持连接并支持空闲探测。
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (client.response.destroyed || client.response.writableEnded) continue
        client.response.write(': heartbeat\n\n')
      }
    }, 15_000)
    this.heartbeat.unref?.()
    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined }
        this.unsubscribe?.()
        this.unsubscribe = undefined
        this.core = undefined
        for (const client of this.clients) client.response.end()
        this.clients.clear()
      },
    }
  }

  async dispatch(command: HumanCommand): Promise<void> {
    const core = this.requireCore()
    await core.dispatch(command)
  }

  /** 1.1 canonical envelope：type/payload 与 CoreEvent 同源，requestId/turnId 用于跨帧关联。 */
  buildEnvelope(event: CoreEvent): CoreEventEnvelope {
    const requestId = 'requestId' in event && typeof event.requestId === 'string' ? event.requestId : undefined
    return {
      protocolVersion: CORE_PROTOCOL_VERSION,
      roomId: this.roomId?.() ?? '',
      revision: event.revision,
      turnId: requestId !== undefined ? this.turnIdForRequest?.(requestId) : undefined,
      requestId,
      type: event.type,
      payload: event,
      createdAt: new Date().toISOString(),
    }
  }

  publish(event: CoreEvent): void {
    if (!this.core) return
    for (const client of this.clients) {
      if (client.response.destroyed || client.response.writableEnded) {
        this.clients.delete(client)
        continue
      }
      const payload = client.protocol === '1.1'
        ? `data: ${JSON.stringify(this.buildEnvelope(event))}\n\n`
        : `data: ${JSON.stringify(event)}\n\n`
      client.response.write(payload)
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/core/')) return false
    this.requireCore()
    if (url.pathname === '/api/core/health' && request.method === 'GET') {
      this.sendJson(response, 200, this.health())
      return true
    }
    if (url.pathname === '/api/core/capabilities' && request.method === 'GET') {
      const capabilities = this.requireCore().getCapabilities?.() ?? [{ id: 'core.protocol', supported: true, mode: 'full' as const }]
      this.sendJson(response, 200, { capabilities })
      return true
    }
    if (url.pathname === '/api/core/cancel' && request.method === 'POST') {
      const body = await this.readJson(request)
      const requestId = String(body.requestId ?? '')
      if (!requestId) throw new Error('cancel requires a requestId.')
      await this.requireCore().cancel(requestId)
      this.sendJson(response, 200, { ok: true, requestId })
      return true
    }
    if (url.pathname === '/api/core/view' && request.method === 'GET') {
      this.sendJson(response, 200, this.requireCore().getView())
      return true
    }
    if (url.pathname === '/api/core/commands' && request.method === 'POST') {
      const command = await this.readJson(request) as unknown as HumanCommand
      const clientProtocol = this.clientProtocol(request)
      if (clientProtocol === '1.1') {
        let receipt
        try {
          await this.dispatch(command)
          const view = this.requireCore().getView()
          receipt = { requestId: command.id, status: 'accepted' as const, revision: view.revision, view }
        } catch (error) {
          receipt = { requestId: command.id, status: 'rejected' as const, error: { code: 'command_failed', message: error instanceof Error ? error.message : String(error) } }
        }
        this.sendJson(response, 200, receipt)
        return true
      }
      await this.dispatch(command)
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
      this.clients.add({ response, protocol: this.clientProtocol(request) })
      const cleanup = (): void => {
        for (const client of this.clients) if (client.response === response) this.clients.delete(client)
        request.off('close', cleanup)
        response.off('close', cleanup)
      }
      request.once('close', cleanup)
      response.once('close', cleanup)
      return true
    }
    return false
  }

  private health(): CoreHealth {
    const provided = this.requireCore().getHealth?.()
    if (provided) return provided
    // 通用桌面 server 未实现 getHealth 时的诚实下限：版本与支持范围真实，bundle/plugin 哈希留空。
    return {
      protocolVersion: CORE_PROTOCOL_VERSION,
      minSupportedProtocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
      maxSupportedProtocolVersion: MAX_SUPPORTED_PROTOCOL_VERSION,
      bridgeVersion: 'stagecraft.http-human',
      coreBundleVersion: 'unspecified',
      coreBundleHash: '',
      pluginSetHash: '',
      stateSchemaVersion: '',
      status: 'ready',
      startedAt: new Date().toISOString(),
    }
  }

  private clientProtocol(request: IncomingMessage): '1.1' | '1.0' {
    const declared = String(request.headers['x-core-protocol-version'] ?? '').trim()
    return declared === CORE_PROTOCOL_VERSION ? '1.1' : '1.0'
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
