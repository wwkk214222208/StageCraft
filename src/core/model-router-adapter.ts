import type { ModelGateway } from '../model-gateway.ts'
import type { CoreEvent, ModelRequest, ModelResult } from './protocol.ts'
import type { CoreLlmRouterHost, CoreLlmRouterPlugin, Disposable } from './plugins.ts'

/** 将现有 ModelGateway 包装为 Core-LLM 路由插件；不改变 WorkerSet 调用链。 */
export class ModelGatewayRouterAdapter implements CoreLlmRouterPlugin {
  readonly id = 'stagecraft.llm.model-gateway'
  private host?: CoreLlmRouterHost
  private readonly requests = new Set<string>()
  private readonly gateway: ModelGateway

  constructor(gateway: ModelGateway) {
    this.gateway = gateway
  }

  install(host: CoreLlmRouterHost): Disposable {
    this.host = host
    return {
      dispose: () => {
        this.host = undefined
        this.gateway.cancelActiveRequests()
      },
    }
  }

  async request(request: ModelRequest): Promise<void> {
    if (!this.host) throw new Error('ModelGateway router is not installed.')
    this.requests.add(request.requestId)
    this.publish({ type: 'model.started', revision: 0, request })
    try {
      const callbacks = {
        onThinking: (text: string) => this.publish({ type: 'model.thinking.delta', revision: 0, requestId: request.requestId, text }),
      }
      const result = request.stream === false
        ? await this.gateway.complete(request.prompt.system, request.prompt.user, request.contract.id, request.contract.schema, undefined, callbacks)
        : await this.gateway.completeStreaming(request.prompt.system, request.prompt.user, request.contract.id, request.contract.schema, undefined, callbacks)
      const modelResult: ModelResult = { requestId: request.requestId, output: result }
      await this.host.submitModelResult(modelResult)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result: ModelResult = { requestId: request.requestId, output: null, error: message }
      await this.host.submitModelResult(result)
      this.publish({ type: 'error', revision: 0, requestId: request.requestId, message })
      throw error
    } finally {
      this.requests.delete(request.requestId)
    }
  }

  async cancel(requestId: string): Promise<void> {
    // 当前 ModelGateway 暴露的是 active request 集合级取消；requestId 仍保留在协议中。
    if (this.requests.has(requestId)) this.gateway.cancelActiveRequests()
  }

  private publish(event: CoreEvent): void {
    this.host?.publishModelEvent(event)
  }
}
