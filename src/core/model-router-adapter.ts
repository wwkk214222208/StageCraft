import type { ModelGateway } from '../model-gateway.ts'
import type { CoreEvent, ModelRequest, ModelResult } from './protocol.ts'
import type { CoreLlmRouterHost, CoreLlmRouterPlugin, Disposable } from './plugins.ts'

/** 将现有 ModelGateway 包装为 Core-LLM 路由插件，保留工具调用和思维强度配置。 */
export class ModelGatewayRouterAdapter implements CoreLlmRouterPlugin {
  readonly id = 'stagecraft.llm.model-gateway'
  private host?: CoreLlmRouterHost
  private readonly requests = new Set<string>()
  private readonly gateway: ModelGateway
  private readonly routeGateway?: (request: ModelRequest) => ModelGateway
  private readonly activeGateways = new Map<string, ModelGateway>()

  constructor(gateway: ModelGateway, routeGateway?: (request: ModelRequest) => ModelGateway) {
    this.gateway = gateway
    this.routeGateway = routeGateway
  }

  install(host: CoreLlmRouterHost): Disposable {
    this.host = host
    return {
      dispose: () => {
        this.host = undefined
        this.gateway.cancelActiveRequests()
        for (const gateway of this.activeGateways.values()) gateway.cancelActiveRequests()
        this.activeGateways.clear()
      },
    }
  }

  async request(request: ModelRequest): Promise<void> {
    if (!this.host) throw new Error('ModelGateway router is not installed.')
    const gateway = this.routeGateway?.(request) ?? this.gateway
    this.requests.add(request.requestId)
    this.activeGateways.set(request.requestId, gateway)
    this.publish({ type: 'model.started', revision: 0, request })
    try {
      let thinking = ''
      let usage: import('../types.ts').TokenUsage | undefined
      const callbacks = {
        onThinking: (text: string) => { thinking += text; this.publish({ type: 'model.thinking.delta', revision: 0, requestId: request.requestId, text }) },
        onUsage: (value: import('../types.ts').TokenUsage) => { usage = value },
      }
      const result = request.stream === false
        ? await gateway.complete(request.prompt.system, request.prompt.user, request.contract.id, request.contract.schema, request.tool, callbacks, { thinkingStrength: request.thinkingStrength, requestId: request.requestId })
        : await gateway.completeStreaming(request.prompt.system, request.prompt.user, request.contract.id, request.contract.schema, request.tool, callbacks, {}, { thinkingStrength: request.thinkingStrength, requestId: request.requestId })
      const includeTelemetry = request.metadata?.includeTelemetry === true
      const modelResult: ModelResult = { requestId: request.requestId, output: result, ...(includeTelemetry && thinking ? { thinking } : {}), ...(includeTelemetry && usage ? { usage } : {}) }
      await this.host.submitModelResult(modelResult)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result: ModelResult = { requestId: request.requestId, output: null, error: message }
      await this.host.submitModelResult(result)
      throw error
    } finally {
      this.requests.delete(request.requestId)
      this.activeGateways.delete(request.requestId)
    }
  }

  async cancel(requestId: string): Promise<void> {
    // ModelGateway 支持 requestId 级 AbortController；无 requestId 时才使用兼容的全量取消。
    if (!requestId) {
      this.gateway.cancelActiveRequests()
      for (const gateway of this.activeGateways.values()) gateway.cancelActiveRequests()
      return
    }
    const gateway = this.activeGateways.get(requestId)
    if (this.requests.has(requestId)) {
      if (gateway?.cancelRequest) gateway.cancelRequest(requestId)
      else gateway?.cancelActiveRequests()
    }
  }

  private publish(event: CoreEvent): void {
    this.host?.publishModelEvent(event)
  }
}
