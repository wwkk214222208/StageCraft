import { createModelStreamAccumulator, parseModelCompleteResponse } from '../model-gateway.ts'
import { buildThinkingParams } from '../thinking-params.ts'
import type { AuthoringContext, LlmSystemStatePort, ProviderChunk, ProviderDriver, ProviderRequest } from '../sdk/authoring.ts'
import type { NativeOperations } from '../platform/composition.ts'

/** LLM-owned state is kept in the Android repository, separate from the Core
 * event snapshot. Secrets use NativeSecretStore/Android Keystore instead. */
export class AndroidLlmStatePort implements LlmSystemStatePort {
  private readonly operations: NativeOperations
  constructor(operations: NativeOperations) { this.operations = operations }
  async read<T>(key: string): Promise<T | undefined> {
    const result = await Promise.resolve(this.operations.invoke<{ value?: T }>('stagecraft.repository', { method: 'llmStateRead', args: [key] }))
    return result?.value
  }
  async write<T>(key: string, value: T): Promise<void> {
    await Promise.resolve(this.operations.invoke('stagecraft.repository', { method: 'llmStateWrite', args: [key, value] }))
  }
  async delete(key: string): Promise<void> {
    await Promise.resolve(this.operations.invoke('stagecraft.repository', { method: 'llmStateDelete', args: [key] }))
  }
}

type AndroidInvoke = NativeOperations & { invokeAsync?: NativeOperations['invoke'] }

/** Native network adapter for the official service. Parsing is shared with the
 * production ModelGateway so SSE/JSON/tool/thinking semantics do not diverge. */
export function createAndroidOpenAiDriver(operations: AndroidInvoke, options: { driverId?: string; models?: readonly string[] } = {}): ProviderDriver {
  const driverId = options.driverId ?? 'android-openai-compatible'
  const active = new Map<string, () => void>()
  return {
    kind: 'provider-driver',
    manifest: Object.freeze({ id: 'stagecraft.provider.android-openai', version: '1.0.0', title: 'Android OpenAI-compatible driver', category: 'provider-driver', apiVersion: '0.1' }),
    driverId, providerId: driverId, models: Object.freeze([...(options.models ?? ['gpt-4o-mini'])]),
    async *request(request: ProviderRequest, _context: AuthoringContext): AsyncIterable<ProviderChunk> {
      const route = (request.metadata as Record<string, unknown> | undefined)?.llmRoute as Record<string, any> | undefined ?? {}
      const baseUrl = String(route.baseUrl ?? '').replace(/\/$/, '')
      if (!baseUrl) throw new Error('Android LLM provider baseUrl is not configured')
      const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`
      const thinking = buildThinkingParams(request.model, route.thinkingStrength ?? 'standard')
      const tools = route.toolCalling && Array.isArray(route.tools) && route.tools.length > 0 ? route.tools : undefined
      const schema = route.jsonSchema && typeof route.jsonSchema === 'object' && typeof route.jsonSchema.name === 'string' && route.jsonSchema.schema && route.jsonSchema.strict === true ? route.jsonSchema : undefined
      const responseFormat = route.responseFormat === 'json_object' ? { type: 'json_object' } : route.responseFormat === 'json_schema' && schema ? { type: 'json_schema', json_schema: schema } : undefined
      const baseBody = { model: request.model, messages: request.messages, stream: true, ...(responseFormat ? { response_format: responseFormat } : {}), ...(thinking.body ?? {}) }
      const toolBody = tools ? { ...baseBody, response_format: undefined, tools } : baseBody
      const controller = new AbortController()
      const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
      const timeout = setTimeout(() => controller.abort(), Number(route.timeoutMs ?? 120_000))
      active.set(request.requestId, () => controller.abort())
      const chunks: ProviderChunk[] = []
      let wake: (() => void) | undefined
      let finished = false
      let failure: unknown
      const emitPayload = (payload: string, accumulator: ReturnType<typeof createModelStreamAccumulator>): void => {
        const parsed = accumulator.push(payload)
        if (parsed.reasoning) chunks.push({ type: 'thinking', text: parsed.reasoning })
        // A few gateways send a placeholder content delta alongside the real
        // tool argument delta. The argument is the structured answer; expose
        // it as text without duplicating the placeholder.
        if (parsed.toolArguments) chunks.push({ type: 'text', text: parsed.toolArguments })
        else if (parsed.content) chunks.push({ type: 'text', text: parsed.content })
        if (parsed.usage) chunks.push({ type: 'usage', usage: { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens, cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens } })
        wake?.(); wake = undefined
      }
      const invoke = async (body: Record<string, unknown>): Promise<unknown> => operations.invoke('model.request', { requestId: request.requestId, endpoint, apiKey: request.credential?.secret, body }, {
        signal,
        onStreamPayload: (payload: string) => emitPayload(payload, accumulator),
      } as any)
      const accumulator = createModelStreamAccumulator()
      const run = (async () => {
        try {
          let result: any
          try { result = await invoke(toolBody) } catch (error) {
            if (!tools || signal.aborted) throw error
            const message = String(error)
            if (!/400|422|tool|function|choice/i.test(message)) throw error
            result = await invoke(baseBody)
          }
          if (result && typeof result === 'object' && 'responseBody' in result) {
            let responseBody: unknown
            try { responseBody = JSON.parse(String((result as any).responseBody)) }
            catch { throw new Error('Android model response was not valid JSON') }
            const parsed = parseModelCompleteResponse(responseBody)
            if (parsed.reasoning) chunks.push({ type: 'thinking', text: parsed.reasoning })
            if (parsed.toolArguments) chunks.push({ type: 'text', text: parsed.toolArguments })
            else if (parsed.content) chunks.push({ type: 'text', text: parsed.content })
            if (parsed.usage) chunks.push({ type: 'usage', usage: { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens, cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens } })
          }
          chunks.push({ type: 'done' })
        } catch (error) { failure = error } finally { finished = true; wake?.(); wake = undefined; clearTimeout(timeout); active.delete(request.requestId) }
      })()
      try {
        while (!finished || chunks.length) {
          if (!chunks.length) await new Promise<void>(resolve => { wake = resolve })
          while (chunks.length) yield chunks.shift()!
          if (signal.aborted && !finished) throw new DOMException('LLM request aborted', 'AbortError')
        }
        await run
        if (failure) throw failure
      } finally { await run.catch(() => undefined); active.delete(request.requestId); clearTimeout(timeout) }
    },
    async cancel(requestId: string) {
      active.get(requestId)?.()
      // Transport cancellation is also the compatibility fallback when the
      // business layer has not attached a model correlation yet.
      // Some legacy NativeOperations implementations expose cancellation as
      // an async callback operation. Give them a short-lived signal so the
      // compatibility call cannot remain pending forever; the real bridge
      // ignores this callback signal and returns its synchronous acknowledgement.
      const cancelSignal = new AbortController()
      const pending = Promise.resolve(operations.invoke('model.cancel', { requestId }, { signal: cancelSignal.signal }))
      queueMicrotask(() => cancelSignal.abort())
      await pending
    },
  }
}
