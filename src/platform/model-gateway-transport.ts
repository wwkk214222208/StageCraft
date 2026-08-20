import type { ModelGateway } from '../model-gateway.ts'
import type { ModelTransport, ModelTransportRequest, ModelTransportResult } from '../core/platform.ts'

/** Existing ModelGateway exposed through the portable transport contract. */
export class ModelGatewayTransport implements ModelTransport {
  private readonly gateway: ModelGateway

  constructor(gateway: ModelGateway) { this.gateway = gateway }

  async request(request: ModelTransportRequest): Promise<ModelTransportResult> {
    let thinking = ''
    let usage: unknown
    try {
      const callbacks = {
        onThinking: (text: string) => { thinking += text },
        onUsage: (value: unknown) => { usage = value },
      }
      const output = request.stream === false
        ? await this.gateway.complete(request.prompt.system, request.prompt.user, request.contract.id, request.contract.schema, request.tool, callbacks, { thinkingStrength: request.thinkingStrength, requestId: request.requestId })
        : await this.gateway.completeStreaming(request.prompt.system, request.prompt.user, request.contract.id, request.contract.schema, request.tool, callbacks, {}, { thinkingStrength: request.thinkingStrength, requestId: request.requestId })
      return { requestId: request.requestId, output, ...(thinking ? { thinking } : {}), ...(usage ? { usage } : {}) }
    } catch (error) {
      return { requestId: request.requestId, output: null, error: error instanceof Error ? error.message : String(error) }
    }
  }

  cancel(requestId: string): void { this.gateway.cancelRequest(requestId) }
}
