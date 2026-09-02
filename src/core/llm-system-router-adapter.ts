import { parseModelJson } from '../model-gateway.ts'
import type { LlmSystemService } from '../sdk/authoring.ts'
import type { CoreEvent, ModelRequest, ModelResult } from './protocol.ts'
import type { CoreLlmRouterHost, CoreLlmRouterPlugin, Disposable } from './plugins.ts'

/**
 * Thin production bridge from the Core protocol to an LLM System.  Prompt
 * assembly stays in Solution/workers: the exact prompt messages are passed
 * through unchanged and only transport metadata is added for routing.
 */
export class LlmSystemRouterAdapter implements CoreLlmRouterPlugin {
  // Keep the historical Cordis name so existing host probes remain compatible.
  readonly id = 'stagecraft.llm.model-gateway'
  private host?: CoreLlmRouterHost
  private readonly active = new Set<string>()
  private readonly service: LlmSystemService
  private readonly stopOnDispose: boolean
  private readonly timeoutMs?: number

  constructor(service: LlmSystemService, options: { stopOnDispose?: boolean; timeoutMs?: number } = {}) { this.service = service; this.stopOnDispose = options.stopOnDispose ?? true; this.timeoutMs = options.timeoutMs }

  install(host: CoreLlmRouterHost): Disposable {
    this.host = host
    return {
      dispose: async () => {
        this.host = undefined
        if (this.stopOnDispose) await this.service.stop()
      },
    }
  }

  async request(request: ModelRequest): Promise<void> {
    if (!this.host) throw new Error('LLM System router is not installed.')
    if (this.active.has(request.requestId)) throw new Error(`request ID is already active: ${request.requestId}`)
    this.active.add(request.requestId)
    this.publish({ type: 'model.started', revision: 0, request })
    try {
      const selected = await this.service.route({
        providerId: request.route?.providerId,
        // Legacy Core routes carry a provider id. Treat it as an explicit
        // profile selector while allowing the official service to resolve a
        // driver alias when no profile has that id.
        profileId: request.route?.providerId,
        model: request.route?.model,
        role: request.route?.role,
        purpose: request.route?.purpose,
      })
      const messages = request.prompt.messages ?? [
        { role: 'system' as const, content: request.prompt.system },
        { role: 'user' as const, content: request.prompt.user },
      ]
      const tools = request.tool ? [{ type: 'function', function: { name: request.tool.name, description: request.tool.description, parameters: request.tool.parameters } }] : undefined
      const metadata = {
        ...(request.metadata ?? {}),
        llmContract: request.contract,
        timeoutMs: this.timeoutMs,
        thinkingStrength: request.thinkingStrength,
        llmRoute: {
          ...(request.metadata?.llmRoute && typeof request.metadata.llmRoute === 'object' ? request.metadata.llmRoute as Record<string, unknown> : {}),
          jsonSchema: { name: request.contract.id, strict: true, schema: request.contract.schema },
          toolCalling: Boolean(request.tool),
          ...(tools ? { tools } : {}),
          purpose: request.route?.purpose,
          role: request.route?.role,
        },
      }
      let text = ''
      let thinking = ''
      let usage: import('../types.ts').TokenUsage | undefined
      for await (const chunk of this.service.complete({ requestId: request.requestId, messages, providerId: selected.providerId, model: selected.model, credentialProfileId: selected.profileId, metadata })) {
        if (chunk.type === 'text' && chunk.text) text += chunk.text
        if (chunk.type === 'thinking' && chunk.text) {
          thinking += chunk.text
          this.publish({ type: 'model.thinking.delta', revision: 0, requestId: request.requestId, text: chunk.text })
        }
        if (chunk.type === 'usage' && chunk.usage) usage = {
          promptTokens: chunk.usage.inputTokens ?? 0,
          completionTokens: chunk.usage.outputTokens ?? 0,
          ...(chunk.usage.cachedTokens === undefined ? {} : { cachedTokens: chunk.usage.cachedTokens }),
          ...(chunk.usage.durationMs === undefined ? {} : { durationMs: chunk.usage.durationMs }),
          ...(chunk.usage.cost === undefined || chunk.usage.currency === undefined ? {} : { cost: { currency: chunk.usage.currency, total: chunk.usage.cost, input: 0, output: 0, cachedInput: 0, peak: false, provider: selected.providerId, model: selected.model } }),
        }
      }
      const includeTelemetry = request.metadata?.includeTelemetry === true
      const result: ModelResult = { requestId: request.requestId, output: parseModelJson(text), ...(includeTelemetry && thinking ? { thinking } : {}), ...(includeTelemetry && usage ? { usage } : {}) }
      await this.host.submitModelResult(result)
    } catch (error) {
      const result: ModelResult = { requestId: request.requestId, output: null, error: error instanceof Error ? error.message : String(error) }
      await this.host.submitModelResult(result)
      throw error
    } finally {
      this.active.delete(request.requestId)
    }
  }

  async cancel(requestId: string): Promise<void> {
    if (!requestId || !this.active.has(requestId)) return
    await this.service.cancel(requestId)
  }

  private publish(event: CoreEvent): void { this.host?.publishModelEvent(event) }
}
