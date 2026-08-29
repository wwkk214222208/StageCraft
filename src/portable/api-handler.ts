/**
 * W4：可移植 API handler 层（计划 v0.4 §1.4 方案 B 改良版）。
 *
 * 目标：把与 Node HTTP（IncomingMessage/ServerResponse）无关的业务 handler 抽成
 * 统一 `ApiRequest -> Promise<ApiResponse>` 形状 + 能力端口，桌面与 Android Core
 * 进程复用同一实现，禁止把 Node 文件系统/更新器/远程服务直接搬进 Core 进程。
 *
 * 本模块是"首批"可移植 handler：Core 协议端点（health/view/commands/cancel/
 * capabilities/ui-action）——它们只依赖 CoreRuntimePort，与传输无关。
 * app-boot.ts 的其余桌面路由（main-host/desktop-only）仍留在桌面侧，由 W6 按
 * registry/dispatchPolicy 接入正式 gateway。
 *
 * ApiRequest/ApiResponse 形状与计划 §1.4 一致；SSE 流式响应经 AsyncIterable body。
 */

import type { CoreRuntimePort, HumanCommand } from '../core/protocol.ts'
import { CORE_PROTOCOL_VERSION, MAX_SUPPORTED_PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION } from '../core/protocol.ts'
import type { CoreHealth } from '../core/protocol.ts'

export interface ApiRequest {
  method: string
  url: string
  headers: Readonly<Record<string, string>>
  body?: Uint8Array
  signal: AbortSignal
}

export interface ApiResponse {
  status: number
  headers: Readonly<Record<string, string>>
  body?: Uint8Array | AsyncIterable<Uint8Array>
}

/** 可移植 handler：matches 判定 method/path（path 不含 query），handle 处理。 */
export interface PortableApiHandler {
  matches(method: string, path: string): boolean
  handle(request: ApiRequest): Promise<ApiResponse>
}

/** 分发入口：按 matches 顺序匹配；未命中返回 404。 */
export async function handlePortableApi(
  handlers: readonly PortableApiHandler[],
  request: ApiRequest,
): Promise<ApiResponse> {
  const path = request.url.split('?')[0]
  const method = request.method.toUpperCase()
  for (const handler of handlers) {
    if (handler.matches(method, path)) return handler.handle(request)
  }
  return jsonResponse(404, { error: { code: 'not_found', message: `未登记的可移植 handler：${method} ${path}` } })
}

export function jsonResponse(status: number, value: unknown, extraHeaders: Record<string, string> = {}): ApiResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: new TextEncoder().encode(JSON.stringify(value)),
  }
}

/** 读取 JSON body（空 body 视为 {}）。 */
export async function readJsonBody(request: ApiRequest): Promise<Record<string, unknown>> {
  if (!request.body || request.body.byteLength === 0) return {}
  const text = new TextDecoder().decode(request.body)
  return JSON.parse(text) as Record<string, unknown>
}

/**
 * Core 协议可移植 handler：与 HttpHumanCorePlugin 同逻辑（1.1 receipt/envelope、
 * 1.0 旧形状、cancel、capabilities、ui-action），但不依赖 node:http。
 * 桌面 HTTP adapter 与 Android Core harness 复用同一实现（W4 对等性由测试保证）。
 */
export class CoreProtocolPortableHandler implements PortableApiHandler {
  private readonly core: CoreRuntimePort
  private readonly roomId: () => string
  private readonly turnIdForRequest?: (requestId: string) => string | undefined

  constructor(
    core: CoreRuntimePort,
    options: { roomId?: () => string; turnIdForRequest?: (requestId: string) => string | undefined } = {},
  ) {
    this.core = core
    this.roomId = options.roomId ?? (() => '')
    this.turnIdForRequest = options.turnIdForRequest
  }

  /** 与 HttpHumanCorePlugin.handle 的路径/方法判定一致。 */
  matches(method: string, path: string): boolean {
    if (!path.startsWith('/api/core/')) return false
    switch (path) {
      case '/api/core/health': return method === 'GET'
      case '/api/core/capabilities': return method === 'GET'
      case '/api/core/cancel': return method === 'POST'
      case '/api/core/view': return method === 'GET'
      case '/api/core/commands': return method === 'POST'
      case '/api/core/ui/action': return method === 'POST'
      default: return false
    }
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    const path = request.url.split('?')[0]
    const method = request.method.toUpperCase()
    if (!this.matches(method, path)) return jsonResponse(404, { error: { code: 'not_found', message: `未登记的可移植 handler：${method} ${path}` } })
    const clientProtocol = this.clientProtocol(request)

    if (path === '/api/core/health') return jsonResponse(200, this.health())
    if (path === '/api/core/capabilities') {
      const capabilities = this.core.getCapabilities?.() ?? [{ id: 'core.protocol', supported: true, mode: 'full' as const }]
      return jsonResponse(200, { capabilities })
    }
    if (path === '/api/core/cancel') {
      const body = await readJsonBody(request)
      const requestId = String(body.requestId ?? '')
      if (!requestId) throw new Error('cancel requires a requestId.')
      await this.core.cancel(requestId)
      return jsonResponse(200, { ok: true, requestId })
    }
    if (path === '/api/core/view') return jsonResponse(200, this.core.getView())
    if (path === '/api/core/commands') {
      const command = await readJsonBody(request) as unknown as HumanCommand
      if (clientProtocol === '1.1') {
        let receipt
        try {
          await this.core.dispatch(command)
          const view = this.core.getView()
          receipt = { requestId: command.id, status: 'accepted' as const, revision: view.revision, view }
        } catch (error) {
          receipt = { requestId: command.id, status: 'rejected' as const, error: { code: 'command_failed', message: error instanceof Error ? error.message : String(error) } }
        }
        return jsonResponse(200, receipt)
      }
      await this.core.dispatch(command)
      return jsonResponse(200, { ok: true, view: this.core.getView() })
    }
    // /api/core/ui/action
    const body = await readJsonBody(request)
    const actionId = String(body.actionId ?? '')
    const input = body.input
    const owner = String(body.owner ?? '')
    const invoke = (this.core as { invokeUiAction?: (actionId: string, input: unknown, owner: string) => Promise<unknown> }).invokeUiAction
    if (typeof invoke !== 'function') throw new Error('UI action is not available on this core.')
    const output = await invoke(actionId, input, owner)
    return jsonResponse(200, { ok: true, actionId, output: structuredClone(output ?? null) })
  }

  /** 与 HttpHumanCorePlugin.clientProtocol 一致：声明 1.1 才按 1.1，否则 1.0。 */
  private clientProtocol(request: ApiRequest): '1.1' | '1.0' {
    const declared = String(request.headers['x-core-protocol-version'] ?? '').trim()
    return declared === CORE_PROTOCOL_VERSION ? '1.1' : '1.0'
  }

  private health(): CoreHealth {
    const provided = this.core.getHealth?.()
    if (provided) return provided
    // 与 HttpHumanCorePlugin.health() 同形状（诚实下限：版本/支持范围真实，bundle/plugin 哈希留空）。
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
}
