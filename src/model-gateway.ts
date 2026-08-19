import type { ConsultationMessage, Decision, Draft, Role } from './types.ts'
import { loadPrompts, renderPrompt, type PromptTemplates } from './prompts.ts'
import { buildThinkingParams } from './thinking-params.ts'

let prompts: PromptTemplates | undefined
function getPrompts(): PromptTemplates {
  prompts ??= loadPrompts()
  return prompts
}

/** 提示词被编辑保存后调用，使下次调用重新从文件加载 */
export function reloadPrompts(): void {
  prompts = undefined
}

export interface ModelRoute {
  name?: string
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  responseFormat: 'json_object' | 'json_schema' | 'none'
  toolCalling?: boolean
}

export interface ModelGatewayOptions {
  fetchImpl?: typeof fetch
  onSummary?: (text: string) => void
  logRawFinalContent?: boolean
}

export interface StreamingCallbacks {
  /** 思维链增量（reasoning_content / thinking / reasoning / content[].thinking） */
  onThinking?: (text: string) => void
  /** 可见正文增量（content 或 tool 参数） */
  onContent?: (text: string) => void
  /** 单次调用完成的 token 用量与耗时（非流式与流式均触发；供前端小字展示） */
  onUsage?: (usage: import('./types.ts').TokenUsage) => void
}

/** 调用级选项：思维链强度（决定向请求体注入的 OpenAI 兼容思考参数或提示词引导） */
export interface CompleteOptions {
  thinkingStrength?: import('./types.ts').ThinkingStrength
}

export class ModelGateway {
  private readonly route: ModelRoute
  private readonly fetchImpl: typeof fetch
  private readonly onSummary?: (text: string) => void
  private readonly logRawFinalContent: boolean
  private requests = 0
  private promptTokens = 0
  private completionTokens = 0
  private cachedTokens = 0
  private totalDurationMs = 0
  private readonly activeControllers = new Set<AbortController>()

  cancelActiveRequests(): void { for (const controller of this.activeControllers) controller.abort() }

  constructor(route: ModelRoute, options: ModelGatewayOptions = {}) {
    this.route = route
    this.fetchImpl = options.fetchImpl ?? fetch
    this.onSummary = options.onSummary
    this.logRawFinalContent = options.logRawFinalContent ?? false
  }

  usage(includeMetrics = false): { route: string; model: string; requests: number; promptTokens: number; completionTokens: number; cachedTokens?: number; totalDurationMs?: number; avgDurationMs?: number } {
    const base = { route: this.route.name ?? 'default', model: this.route.model, requests: this.requests, promptTokens: this.promptTokens, completionTokens: this.completionTokens }
    return includeMetrics ? { ...base, cachedTokens: this.cachedTokens, totalDurationMs: this.totalDurationMs, avgDurationMs: this.requests > 0 ? Math.round(this.totalDurationMs / this.requests) : 0 } : base
  }

  async complete<T>(system: string, user: string, schemaName: string, schema: object, tool?: { name: string; description: string; parameters: object }, callbacks: StreamingCallbacks = {}, options: CompleteOptions = {}): Promise<T> {
    const startedAt = Date.now()
    this.requests += 1
    this.onSummary?.(`开始模型请求：${schemaName} | ${this.route.name ?? 'default'} / ${this.route.model}`)
    const controller = new AbortController()
    this.activeControllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), this.route.timeoutMs)
    try {
      const responseFormat = this.route.responseFormat === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
        : this.route.responseFormat === 'json_object' ? { type: 'json_object' } : undefined
      const endpoint = `${this.route.baseUrl.replace(/\/$/, '')}/chat/completions`
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${this.route.apiKey}` }
      // 思维链强度：注入 OpenAI 兼容思考参数，或（匹配不上/原生不可用）在 system 末尾追加提示词引导
      const thinking = buildThinkingParams(this.route.model, options.thinkingStrength ?? 'standard')
      const effectiveSystem = thinking.promptSuffix ? `${system}${thinking.promptSuffix}` : system
      const messages = [
        { role: 'system', content: effectiveSystem },
        { role: 'user', content: user },
      ]
      const baseBody = { model: this.route.model, ...(responseFormat ? { response_format: responseFormat } : {}), ...(thinking.body ?? {}), messages }
      const toolBody = tool && this.route.toolCalling !== false
        ? { model: this.route.model, messages, tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }] }
        : baseBody
      let response = await this.fetchImpl(endpoint, { method: 'POST', signal: controller.signal, headers, body: JSON.stringify(toolBody) })
      if (!response.ok && tool && this.route.toolCalling !== false && (response.status === 400 || response.status === 422)) {
        const detail = await response.text()
        if (/tool|function|choice/i.test(detail)) {
          this.onSummary?.(`工具请求被拒绝 HTTP ${response.status}：${detail.slice(0, 500)}`)
          this.onSummary?.(`工具调用不受支持，回退 JSON：${schemaName}`)
          response = await this.fetchImpl(endpoint, { method: 'POST', signal: controller.signal, headers, body: JSON.stringify(baseBody) })
        } else {
          throw new Error(`Model HTTP ${response.status}: ${detail.slice(0, 500)}`)
        }
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500)
        this.onSummary?.(`模型请求失败：HTTP ${response.status}`)
        throw new Error(`Model HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      this.onSummary?.(`模型已返回：${schemaName}`)
      const body = await response.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }; choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> }
      const cached = body.usage?.prompt_tokens_details?.cached_tokens
      this.cachedTokens += cached ?? 0
      const callUsage: import('./types.ts').TokenUsage | undefined = body.usage?.prompt_tokens !== undefined || body.usage?.completion_tokens !== undefined
        ? { promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0, ...(cached ? { cachedTokens: cached } : {}) }
        : undefined
      this.promptTokens += body.usage?.prompt_tokens ?? 0
      this.completionTokens += body.usage?.completion_tokens ?? 0
      if (callUsage) callbacks.onUsage?.({ ...callUsage, durationMs: Date.now() - startedAt })
      const message = body.choices?.[0]?.message
      const toolCall = message?.tool_calls?.[0]
      const toolArguments = toolCall?.function?.arguments
      const content = toolArguments ?? message?.content
      const reasoning = extractReasoningFromMessage(message)
      if (reasoning) callbacks.onThinking?.(reasoning)
      this.onSummary?.(toolArguments ? `模型返回工具参数：${schemaName}` : `模型返回文本内容：${schemaName}`)
      if (!content) throw new Error('Model response did not contain tool arguments or message content.')
      if (this.logRawFinalContent) console.log(`[model final content][${schemaName}]\n${content}\n[/model final content]`)
      try {
        return parseModelJson(content) as T
      } catch {
        throw new Error(toolArguments ? 'Model tool arguments were not valid JSON.' : 'Model response was not valid JSON.')
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error(`Model request timed out after ${this.route.timeoutMs}ms`)
      throw error
    } finally {
      this.totalDurationMs += Date.now() - startedAt
      clearTimeout(timeout)
      this.activeControllers.delete(controller)
    }
  }

  /**
   * 流式调用：把 SSE 增量按思维链/正文分流，通过 callbacks 实时推送，
   * 结束时拼出完整结果并解析 JSON。与 complete 返回相同结构。
   */
  async completeStreaming<T>(system: string, user: string, schemaName: string, schema: object, tool?: { name: string; description: string; parameters: object }, callbacks: StreamingCallbacks = {}, streamOptions: { graceMs?: number } = {}, options: CompleteOptions = {}): Promise<T> {
    const startedAt = Date.now()
    this.requests += 1
    this.onSummary?.(`开始流式模型请求：${schemaName} | ${this.route.name ?? 'default'} / ${this.route.model}`)
    const controller = new AbortController()
    this.activeControllers.add(controller)
    // 空闲超时：只要还在收到流数据就重置计时器；连续 timeoutMs 无新数据（卡住/断流/首字节迟迟不来）才掐断。
    // 另设宽松总上限（10 分钟）防止无限缓慢吐字永不结束。
    let idleTimer = setTimeout(() => controller.abort(), this.route.timeoutMs)
    const totalTimer = setTimeout(() => controller.abort(), Math.max(this.route.timeoutMs * 5, 600_000))
    const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(), this.route.timeoutMs) }
    try {
      const responseFormat = this.route.responseFormat === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
        : this.route.responseFormat === 'json_object' ? { type: 'json_object' } : undefined
      const endpoint = `${this.route.baseUrl.replace(/\/$/, '')}/chat/completions`
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${this.route.apiKey}` }
      // 思维链强度：注入 OpenAI 兼容思考参数，或（匹配不上/原生不可用）在 system 末尾追加提示词引导
      const thinking = buildThinkingParams(this.route.model, options.thinkingStrength ?? 'standard')
      const effectiveSystem = thinking.promptSuffix ? `${system}${thinking.promptSuffix}` : system
      const messages = [
        { role: 'system', content: effectiveSystem },
        { role: 'user', content: user },
      ]
      const streamBody = { stream: true, model: this.route.model, ...(responseFormat ? { response_format: responseFormat } : {}), ...(thinking.body ?? {}), messages }
      const toolBody = tool && this.route.toolCalling !== false
        ? { stream: true, model: this.route.model, messages, tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }], ...(thinking.body ?? {}) }
        : streamBody
      let response = await this.fetchImpl(endpoint, { method: 'POST', signal: controller.signal, headers, body: JSON.stringify(toolBody) })
      if (!response.ok && tool && this.route.toolCalling !== false && (response.status === 400 || response.status === 422)) {
        const detail = await response.text()
        if (/tool|function|choice/i.test(detail)) {
          this.onSummary?.(`工具请求被拒绝 HTTP ${response.status}：${detail.slice(0, 500)}`)
          this.onSummary?.(`工具调用不受支持，回退 JSON：${schemaName}`)
          response = await this.fetchImpl(endpoint, { method: 'POST', signal: controller.signal, headers, body: JSON.stringify(streamBody) })
        } else {
          throw new Error(`Model HTTP ${response.status}: ${detail.slice(0, 500)}`)
        }
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500)
        this.onSummary?.(`模型请求失败：HTTP ${response.status}`)
        throw new Error(`Model HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        // 兼容非流式响应（部分网关忽略 stream 或测试环境）：按完整 JSON 处理
        const body = await response.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }; choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string; thinking?: string; tool_calls?: Array<{ function?: { arguments?: string } }> } }> }
        const cached = body.usage?.prompt_tokens_details?.cached_tokens
        this.cachedTokens += cached ?? 0
        this.promptTokens += body.usage?.prompt_tokens ?? 0
        this.completionTokens += body.usage?.completion_tokens ?? 0
        if (body.usage?.prompt_tokens !== undefined || body.usage?.completion_tokens !== undefined) {
          callbacks.onUsage?.({ promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0, ...(cached ? { cachedTokens: cached } : {}), durationMs: Date.now() - startedAt })
        }
        const message = body.choices?.[0]?.message
        const toolCall = message?.tool_calls?.[0]
        const toolArguments = toolCall?.function?.arguments
        const content = toolArguments ?? message?.content
        const reasoning = extractReasoningFromMessage(message)
        if (reasoning) callbacks.onThinking?.(reasoning)
        this.onSummary?.(`模型已返回：${schemaName}`)
        if (!content) throw new Error('Model response did not contain tool arguments or message content.')
        if (this.logRawFinalContent) console.log(`[model final content][${schemaName}]\n${content}\n[/model final content]`)
        try {
          return parseModelJson(content) as T
        } catch {
          throw new Error(toolArguments ? 'Model tool arguments were not valid JSON.' : 'Model response was not valid JSON.')
        }
      }
      if (!response.body) throw new Error('Model stream response did not contain a body.')
      const { content, toolArguments, usage, reasoning } = await consumeSseStream(response.body, callbacks, resetIdle, streamOptions.graceMs)
      const cached = usage?.prompt_tokens_details?.cached_tokens
      this.cachedTokens += cached ?? 0
      this.promptTokens += usage?.prompt_tokens ?? 0
      this.completionTokens += usage?.completion_tokens ?? 0
      if (usage?.prompt_tokens !== undefined || usage?.completion_tokens !== undefined) {
        callbacks.onUsage?.({ promptTokens: usage?.prompt_tokens ?? 0, completionTokens: usage?.completion_tokens ?? 0, ...(cached ? { cachedTokens: cached } : {}), durationMs: Date.now() - startedAt })
      }
      const finalContent = toolArguments || content
      this.onSummary?.(toolArguments ? `模型已返回工具参数：${schemaName}` : `模型已返回文本内容：${schemaName}`)
      if (!finalContent) throw new Error('Model stream did not produce tool arguments or message content.')
      if (this.logRawFinalContent) console.log(`[model final content][${schemaName}]\n${finalContent}\n[/model final content]`)
      try {
        return parseModelJson(finalContent) as T
      } catch {
        throw new Error(toolArguments ? 'Model tool arguments were not valid JSON.' : 'Model stream content was not valid JSON.')
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error(`Model stream request timed out after ${this.route.timeoutMs}ms`)
      throw error
    } finally {
      this.totalDurationMs += Date.now() - startedAt
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      this.activeControllers.delete(controller)
    }
  }
}

/** 导演草稿 / 审批时的容错：把 stateUpdates 里的角色显示名映射回角色 id，玩家显示名映射为 player */
export function normalizeStateUpdateKeys(stateUpdates: Record<string, string>, context: { roleNames: Map<string, string>; playerName?: string }): Record<string, string> {
  const fixed: Record<string, string> = {}
  for (const [key, value] of Object.entries(stateUpdates)) {
    if (key === 'player') { fixed.player = value; continue }
    if (context.playerName && key === context.playerName) { fixed.player = value; continue }
    const id = context.roleNames.get(key)
    if (id) { fixed[id] = value; continue }
    fixed[key] = value // 保留原样，交给下游校验决定是否报错
  }
  return fixed
}

function extractReasoningFromMessage(message: { content?: string; reasoning_content?: string; reasoning?: string; thinking?: string } | undefined): string {
  if (!message || typeof message !== 'object') return ''
  const parts = [message.reasoning_content, message.reasoning, message.thinking]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return parts.join('\n\n')
}

/**
 * 读取 SSE 字节流，按事件边界拆行；把思维链增量与正文增量分流，
 * 累计 usage 与完整内容。兼容各 provider 的字段差异。
 *
 * 结束判定（关键：供应商偶发“内容发完但不关流 / 不发 [DONE]”）：
 *   1. 收到 `data: [DONE]` → 立即结束；
 *   2. 收到 `choices[0].finish_reason`（stop/tool_calls/length）→ 语义结束，
 *      再等 graceMs 宽限内的 [DONE]/补发内容；超宽限主动收尾（不报超时）；
 *   3. 流自然 done → 结束；
 *   4. 空闲超时（连续无字节）→ 由调用方 abort（真正的僵死兜底）。
 */
async function consumeSseStream(body: ReadableStream<Uint8Array>, callbacks: StreamingCallbacks, onActivity?: () => void, graceMs = 10_000): Promise<{ content: string; toolArguments: string; reasoning: string; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }; finishReason?: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let toolArguments = ''
  let reasoning = ''
  let usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined
  let finishReason: string | undefined
  let finishedAt = 0
  let pendingRead: Promise<{ done: boolean; value?: Uint8Array }> | null = null
  try {
    while (true) {
      // 语义结束 + 宽限已过仍未 [DONE]/关流：主动收尾，已积累内容视为完整
      if (finishedAt && Date.now() - finishedAt > graceMs) break
      // 语义结束后下一次 read 可能永久挂起（供应商不关流）：与宽限定时竞速
      pendingRead = reader.read()
      let chunk: { done: boolean; value?: Uint8Array } | null
      if (finishedAt) {
        const wait = new Promise<null>(resolve => setTimeout(() => resolve(null), Math.max(0, graceMs - (Date.now() - finishedAt))))
        chunk = await Promise.race([pendingRead, wait])
        if (chunk === null) { pendingRead = null; break }
      } else {
        chunk = await pendingRead
      }
      pendingRead = null
      if (chunk.done) break
      onActivity?.() // 收到任何字节都视为活动，重置空闲超时
      buffer += decoder.decode(chunk.value, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        if (rawEvent.includes('[DONE]')) {
          // 流结束信号：剩余 buffer 不再有语义内容，直接收尾
          buffer = ''
          return { content, toolArguments, reasoning, usage, finishReason }
        }
        const parsed = parseSseEvent(rawEvent, callbacks)
        if (parsed.reasoning) reasoning += parsed.reasoning
        if (parsed.content) content += parsed.content
        if (parsed.toolArguments) toolArguments += parsed.toolArguments
        if (parsed.usage) usage = parsed.usage
        if (parsed.finishReason) {
          finishReason = parsed.finishReason
          finishedAt = Date.now()
        } else if (finishedAt && (parsed.content || parsed.toolArguments)) {
          // finish_reason 之后仍收到新内容：供应商在补发，重置宽限继续等
          finishedAt = Date.now()
        }
      }
    }
    if (buffer.trim()) {
      const parsed = parseSseEvent(buffer, callbacks)
      if (parsed.reasoning) reasoning += parsed.reasoning
      if (parsed.content) content += parsed.content
      if (parsed.toolArguments) toolArguments += parsed.toolArguments
      if (parsed.usage) usage = parsed.usage
    }
  } finally {
    // 竞速失败被放弃的 read() 会在 releaseLock 时 reject，吞掉避免 unhandled rejection
    pendingRead?.catch(() => {})
    reader.releaseLock()
  }
  return { content, toolArguments, reasoning, usage, finishReason }
}

function parseSseEvent(rawEvent: string, callbacks: StreamingCallbacks): { content?: string; toolArguments?: string; reasoning?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }; finishReason?: string } {
  const dataLine = rawEvent.split('\n').map(line => line.trim()).find(line => line.startsWith('data:'))
  if (!dataLine) return {}
  const payload = dataLine.slice(5).trim()
  if (!payload || payload === '[DONE]') return {}
  let json: Record<string, unknown>
  try { json = JSON.parse(payload) } catch { return {} }
  const choices = json.choices as Array<Record<string, unknown>> | undefined
  const choice = choices?.[0]
  const delta = (choice?.delta ?? {}) as Record<string, unknown>
  // 语义结束信号（stop / tool_calls / length）：即使供应商随后不关流，也算正文已结束
  const finishReason = typeof choice?.finish_reason === 'string' && choice.finish_reason ? choice.finish_reason : undefined
  // usage may arrive on the final chunk
  const usageJson = json.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined
  const usage = usageJson && (typeof usageJson.prompt_tokens === 'number' || typeof usageJson.completion_tokens === 'number') ? usageJson : undefined
  // 同一 delta 可能同时携带 thinking 与 content（部分 provider 混合下发），必须分别累计——
  // 不能用“三选一”整体归类，否则 content 会被当成思维链丢掉。
  let reasoning = ''
  let content = ''
  let toolArguments = ''
  // thinking fields: reasoning_content / thinking / reasoning / content[0].thinking[0].text
  const thinkingDelta = firstString(delta.reasoning_content, delta.thinking, delta.reasoning)
  if (thinkingDelta) {
    callbacks.onThinking?.(thinkingDelta)
    reasoning = thinkingDelta
  }
  const deltaContent = delta.content
  if (typeof deltaContent === 'string' && deltaContent) {
    callbacks.onContent?.(deltaContent)
    content = deltaContent
  } else if (Array.isArray(deltaContent)) {
    const thinkingParts = deltaContent
      .filter((part): part is Record<string, unknown> => Boolean(part && typeof part === 'object'))
      .map(part => part.thinking)
      .filter((part): part is Array<Record<string, unknown>> => Array.isArray(part))
      .flatMap(parts => parts.map(part => part.text))
      .filter((part): part is string => typeof part === 'string')
    if (thinkingParts.length > 0) {
      const text = thinkingParts.join('')
      callbacks.onThinking?.(text)
      reasoning += text
    } else {
      // 数组型 content 且不含 thinking 结构：把字符串片段拼为正文
      const textParts = deltaContent.filter((part): part is string => typeof part === 'string')
      if (textParts.length > 0) {
        callbacks.onContent?.(textParts.join(''))
        content = textParts.join('')
      }
    }
  }
  const toolCalls = delta.tool_calls as Array<{ function?: { arguments?: string } }> | undefined
  const argumentsDelta = toolCalls?.[0]?.function?.arguments
  if (typeof argumentsDelta === 'string' && argumentsDelta) {
    callbacks.onContent?.(argumentsDelta)
    toolArguments = argumentsDelta
  }
  return { ...(reasoning ? { reasoning } : {}), ...(content ? { content } : {}), ...(toolArguments ? { toolArguments } : {}), ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}) }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

function parseModelJson(content: string): unknown {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]
  const candidate = fenced ?? trimmed
  try { return JSON.parse(candidate) } catch {}
  const objectStart = candidate.indexOf('{')
  const objectEnd = candidate.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) return JSON.parse(candidate.slice(objectStart, objectEnd + 1))
  const arrayStart = candidate.indexOf('[')
  const arrayEnd = candidate.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) return JSON.parse(candidate.slice(arrayStart, arrayEnd + 1))
  throw new Error('No JSON value found.')
}

export function routeFromEnvironment(env: NodeJS.ProcessEnv = process.env): ModelRoute {
  return {
    name: env.RP_MODEL_ROUTE ?? 'default',
    baseUrl: env.RP_MODEL_BASE_URL ?? 'https://opencode.ai/zen/go/v1',
    apiKey: env.RP_MODEL_API_KEY ?? env.OPENCODE_API_KEY ?? '',
    model: env.RP_MODEL_NAME ?? 'deepseek-v4-flash',
    timeoutMs: Number(env.RP_MODEL_TIMEOUT_MS ?? 120_000),
    responseFormat: env.RP_MODEL_RESPONSE_FORMAT === 'json_schema' ? 'json_schema' : env.RP_MODEL_RESPONSE_FORMAT === 'none' ? 'none' : 'json_object',
  }
}

export const roleDecisionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    brief: { type: 'string' },
    privateReaction: { type: 'string' },
    identity: { type: 'string', description: '可选。本回合你对外展示的身份/形象——当你需要导演知道你现在以什么身份或外表示人时填写（例如伪装成平民、隐瞒自己的真实身份、显露头衔）；没有变化或无需特别说明就不填。' },
    impressions: { type: 'object', description: '可选。本轮互动后你想更新/新增的他人印象（角色姓名 → 印象文字；想删除某条印象时值填空字符串）。只填你确有把握、本轮有依据变化的印象，无变化就省略。', additionalProperties: { type: 'string' } },
  }, required: ['brief', 'privateReaction'],
}

export const directorDraftSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string' },
    stateUpdates: { type: 'object', description: '仅限所有在场角色可观察的外在状态；禁止想法、动机、情绪推断和 Director 推理。', additionalProperties: { type: 'string' } },
    sceneUpdates: { type: 'object', additionalProperties: false, description: '本回合场景的时间/地点更新（随剧情推进而改变时填写；无变化可省略）。', properties: { time: { type: 'string' }, location: { type: 'string' } } },
    settingProposals: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, text: { type: 'string' }, basis: { type: 'string' }, status: { type: 'string', enum: ['proposed', 'accepted', 'rejected'] } }, required: ['id', 'text', 'basis', 'status'] } },
    roleProposals: { type: 'array', description: '需要新建的人物（剧情需要引入新角色时填写；现有角色不填）。', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, portraitRef: { type: 'string' }, currentState: { type: 'string' }, presence: { type: 'string', enum: ['present', 'absent', 'unavailable'] }, selfModel: { type: 'string' }, memoryTimeline: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } }, required: ['id', 'name', 'portraitRef', 'currentState', 'presence', 'selfModel', 'memoryTimeline'] } },
    intentHandling: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { roleId: { type: 'string' }, intentId: { type: 'string' }, result: { type: 'string', enum: ['used', 'partially-used', 'deferred', 'blocked', 'superseded'] }, note: { type: 'string' } }, required: ['roleId', 'intentId', 'result', 'note'] } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  }, required: ['text', 'stateUpdates', 'settingProposals', 'intentHandling', 'openQuestions'],
}

function publicRoleStates(roles: Role[]): string {
  return roles.filter(role => role.presence === 'present').map(role => `${role.name}（${role.id}）：${role.currentState}`).join('\n') || '当前没有其他在场角色。'
}

/** 角色印象注入片段（姓名 → 文字；供角色决策时参考并工具化更新） */
function formatImpressions(role: Role): string {
  const impressions = role.impressions ?? {}
  const lines = Object.entries(impressions).map(([name, text]) => `- ${name}：${text}`)
  return lines.length > 0 ? lines.join('\n') : '（暂无）'
}

/** 场景时间/地点注入片段（Heptalon 风格） */
function formatSceneContext(scene?: { time?: string; location?: string }): string {
  const parts: string[] = []
  if (scene?.time?.trim()) parts.push(`【当前时间】${scene.time.trim()}`)
  if (scene?.location?.trim()) parts.push(`【当前地点】${scene.location.trim()}`)
  return parts.length > 0 ? parts.join('\n') : '时间未设置；地点未设置'
}

/** 世界书注入片段：常开条目（无 roles）+ 指定角色的条目 */
function formatLoreForRole(lore: LoreEntry[], roleId: string): string {
  const entries = (lore ?? []).filter(entry => !entry.roles?.length || entry.roles.includes(roleId))
  if (entries.length === 0) return ''
  return `世界书条目：\n${entries.map(entry => `【${entry.name}】\n${entry.content}`).join('\n\n')}`
}

/** 导演用的全量世界书（含角色限定与隐秘条目），标注可见范围帮助导演把握哪些是秘密 */
function formatLoreAll(lore: LoreEntry[]): string {
  if ((lore ?? []).length === 0) return '（无世界书条目）'
  return (lore ?? []).map(entry => `【${entry.name}】${(entry.roles ?? []).length ? `（仅角色可见：${entry.roles.join('、')}）` : ''}\n${entry.content}`).join('\n\n')
}

/**
 * 从 selfModel 剥离私有段，得到角色卡公开面（供导演把握角色基调）。
 * 私有段起点：`=====` 分隔线（如 `===== 长期目标 =====`）或 `---`/`###` 分隔线；
 * 分隔线之后的内容（如长期目标列表）一律视为私有。单独的关键词行（如「隐藏身份：…」）
 * 不是分隔线，不截断——那是角色卡头部设定，导演持有但不外泄（遵守"你知道的≠世界知道的"）。
 */
function stripPrivateSections(selfModel: string): string {
  const out: string[] = []
  for (const line of String(selfModel ?? '').split('\n')) {
    if (/^=+/.test(line) || /^[#*\-]{3,}\s*$/.test(line)) break
    out.push(line)
  }
  return out.join('\n').trim()
}

/** 在场角色公开人设：id、姓名 + 角色卡公开面（不含记忆、印象与长期目标） */
function formatRolePersonas(roles: Role[]): string {
  const present = roles.filter(role => role.presence === 'present')
  if (present.length === 0) return '（当前没有在场角色）'
  return present.map(role => {
    const persona = stripPrivateSections(role.selfModel)
    return `【${role.id}】${role.name}${persona ? `\n${persona}` : '\n（无公开人设）'}`
  }).join('\n\n')
}

/** 角色自己的长期目标段（私密：只注入给角色自己，Director 不可见）；空填/无目标则空串 */
function formatGoals(role: Role): string {
  const goals = (role.goals ?? []).filter(goal => typeof goal === 'string' && goal.trim())
  if (goals.length === 0) return ''
  return `长期目标（私密，仅你自己知道）：\n${goals.map(goal => `- ${goal.trim()}`).join('\n')}\n\n`
}

/** 角色私有记忆注入片段。结构化记录优先；旧时间线只在尚未迁移时作过渡回退。 */
function formatMemoryTimeline(role: Role): string {
  const memories = (role.memories ?? []).filter(memory => memory.status === 'active' && memory.visibility === 'private')
  if (memories.length > 0) {
    return memories
      .sort((a, b) => b.salience - a.salience || b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30)
      .map(memory => `【${memory.occurredAt}${memory.occurredLocation ? ` · ${memory.occurredLocation}` : ''}｜${memory.kind}｜重要度 ${memory.salience}】\n- ${memory.text}`)
      .join('\n')
  }
  const timeline = role.memoryTimeline ?? {}
  const lines: string[] = []
  for (const [when, events] of Object.entries(timeline)) {
    const label = when.trim() || '未标注时间'
    const items = Array.isArray(events) ? events.filter(event => typeof event === 'string' && event.trim()) : []
    if (items.length === 0) continue
    lines.push(`【${label}】`)
    for (const event of items) lines.push(`- ${event.trim()}`)
  }
  return lines.length > 0 ? lines.join('\n') : '（暂无记忆）'
}

export function createRealWorkers(directorGateway: ModelGateway, gatewayForRole: (role: Role) => ModelGateway = () => directorGateway, options: { directorThinkingStrength?: import('./types.ts').ThinkingStrength } = {}) {
  const roleGateways = new Set<ModelGateway>()
  const directorThinking = options.directorThinkingStrength
  const getRoleGateway = (role: Role) => { const gateway = gatewayForRole(role); roleGateways.add(gateway); return gateway }
  // 缓存键：角色 id + 人设 + 世界书（不变部分）；记忆时间线每回合变化，不参与缓存
  const prefixCache = new Map<string, string>()
  const prefixKey = (role: Role, lore?: LoreEntry[]) => `${role.id}|${role.selfModel}|${JSON.stringify(lore ?? [])}`
  const rolePrefix = (role: Role, lore?: LoreEntry[]) => {
    const key = prefixKey(role, lore)
    const cached = prefixCache.get(key)
    if (cached !== undefined) return cached
    const loreText = formatLoreForRole(lore ?? [], role.id)
    const prefix = renderPrompt(getPrompts().role.prefix, {
      loreText: loreText ? `${loreText}\n` : '',
      roleName: role.name,
      selfModel: role.selfModel,
    })
    prefixCache.set(key, prefix)
    return prefix
  }
  return {
    async decide(role: Role, participation: Decision['participation'], contribution: string, publicRoles: Role[] = [], scene?: { time?: string; location?: string }, onThinking?: (text: string) => void, lore?: LoreEntry[], recentScene?: string): Promise<Decision> {
      if (participation === 'excluded') return { roleId: role.id, participation, status: 'abstained' }
      let thinking = ''
      let usage = { promptTokens: 0, completionTokens: 0 }
      const collectThinking = (text: string) => { thinking += text; onThinking?.(text) }
      const collectUsage = (u: { promptTokens: number; completionTokens: number }) => { usage.promptTokens += u.promptTokens; usage.completionTokens += u.completionTokens }
      const result = await getRoleGateway(role).completeStreaming<{ brief: string; privateReaction: string; impressions?: Record<string, string> }>(
        renderPrompt(getPrompts().role.system, {
          prefix: rolePrefix(role, lore),
          goalsSection: formatGoals(role),
          scene: formatSceneContext(scene),
          recentScene: recentScene || '（尚无已批准正文，本回合为开局）',
          memoryTimeline: formatMemoryTimeline(role),
          impressions: formatImpressions(role),
          currentState: role.currentState,
          publicRoles: publicRoleStates(publicRoles),
        }),
        renderPrompt(getPrompts().role.user, { contribution: contribution || '玩家空过。' }),
        'role_decision', roleDecisionSchema, { name: 'submit_role_decision', description: '提交角色本轮公开意图和私有即时反应。', parameters: roleDecisionSchema },
        { onThinking: collectThinking, onUsage: collectUsage },
        {}, { thinkingStrength: role.thinkingStrength },
      )
      const normalized = normalizeRoleDecision(result)
      if (normalized) return { roleId: role.id, participation, status: 'completed', brief: normalized.brief, privateReaction: normalized.privateReaction, ...(normalized.publicIdentity ? { publicIdentity: normalized.publicIdentity } : {}), ...(normalized.impressions ? { impressions: normalized.impressions } : {}), thinking: thinking || undefined, usage }
      const retry = await getRoleGateway(role).completeStreaming<unknown>(
        renderPrompt(getPrompts().role.retrySystem, { roleName: role.name }),
        renderPrompt(getPrompts().role.retryUser, { contribution: contribution || '玩家空过。' }),
        'minimal_role_decision',
        { type: 'object', additionalProperties: true, properties: { brief: { type: 'string' }, privateReaction: { type: 'string' } }, required: ['brief', 'privateReaction'] },
        { name: 'submit_role_decision', description: '提交角色本轮公开意图和私有即时反应。', parameters: { type: 'object', additionalProperties: true, properties: { brief: { type: 'string' }, privateReaction: { type: 'string' } }, required: ['brief', 'privateReaction'] } },
        { onThinking: collectThinking, onUsage: collectUsage },
        {}, { thinkingStrength: role.thinkingStrength },
      )
      const recovered = normalizeRoleDecision(retry)
      if (!recovered) throw new Error(`Role output is missing a public brief. Received fields: ${receivedFields(retry)}`)
      return { roleId: role.id, participation, status: 'completed', brief: recovered.brief, privateReaction: recovered.privateReaction, ...(recovered.publicIdentity ? { publicIdentity: recovered.publicIdentity } : {}), ...(recovered.impressions ? { impressions: recovered.impressions } : {}), thinking: thinking || undefined, usage }
    },
    async draft(turnId: string, contribution: string, decisions: Decision[], roles: Role[], consultations: ConsultationMessage[] = [], playerCharacter?: import('./types.ts').PlayerCharacter, scene?: { time?: string; location?: string }, onThinking?: (text: string) => void, lore?: LoreEntry[], recentScene?: string, previousDraft?: string): Promise<Draft> {
      const briefs = decisions.filter(item => item.status === 'completed' && item.brief).map(item => `${item.roleId}${item.participation === 'required' ? '（焦点角色）' : ''}: ${item.brief}${item.publicIdentity ? `\n  对外身份/形象：${item.publicIdentity}` : ''}`).join('\n')
      const focalRoles = decisions.filter(item => item.participation === 'required').map(item => item.roleId).join('、') || '无'
      const request = renderPrompt(getPrompts().director.request, {
        scene: formatSceneContext(scene),
        recentScene: recentScene || '（尚无已批准正文，本回合为开局）',
        previousDraft: previousDraft?.trim() ? `【上一版草稿（当前待修订，仅修订时出现）】\n${previousDraft.trim()}\n` : '',
        playerName: playerCharacter?.name ?? '玩家',
        playerPersona: playerCharacter?.persona ?? '',
        playerState: playerCharacter?.currentState ?? '',
        contribution: contribution || '玩家空过。',
        focalRoles,
        briefs,
        roleStates: roles.map(role => `${role.id}（${role.name}）：${role.currentState}`).join('\n'),
        consultations: consultations?.map(message => `${message.role}: ${message.text}`).join('\n') ?? '无',
        loreText: formatLoreAll(lore ?? []),
        rolePersonas: formatRolePersonas(roles),
      })
      let thinking = ''
      let usage = { promptTokens: 0, completionTokens: 0 }
      const collectThinking = (text: string) => { thinking += text; onThinking?.(text) }
      const collectUsage = (u: { promptTokens: number; completionTokens: number }) => { usage.promptTokens += u.promptTokens; usage.completionTokens += u.completionTokens }
      const result = await directorGateway.completeStreaming<unknown>(getPrompts().skills.director, request, 'story_draft', directorDraftSchema, { name: 'submit_story_draft', description: '提交可供玩家审批的场景草稿和结构化状态变化。', parameters: directorDraftSchema }, { onThinking: collectThinking, onUsage: collectUsage }, {}, { thinkingStrength: directorThinking })
      const normalized = normalizeDirectorDraft(result)
      if (normalized) {
        normalized.stateUpdates = normalizeStateUpdateKeys(normalized.stateUpdates, { roleNames: new Map(roles.map(role => [role.name, role.id])), playerName: playerCharacter?.name })
        return { id: `draft-${Date.now()}`, turnId, ...normalized, thinking: thinking || undefined, usage, createdAt: new Date().toISOString() }
      }
      const retry = await directorGateway.completeStreaming<unknown>(
        getPrompts().director.retrySystem,
        renderPrompt(getPrompts().director.retryUser, { request }),
        'minimal_story_draft',
        { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, stateUpdates: { type: 'object' } }, required: ['text', 'stateUpdates'] },
        { name: 'submit_story_draft', description: '提交最小可审批场景草稿。', parameters: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, stateUpdates: { type: 'object' } }, required: ['text', 'stateUpdates'] } },
        { onThinking: collectThinking, onUsage: collectUsage },
        {}, { thinkingStrength: directorThinking },
      )
      const recovered = normalizeDirectorDraft(retry)
      if (!recovered) throw new Error(`Director output is missing non-empty text. Received fields: ${receivedFields(retry)}`)
      recovered.stateUpdates = normalizeStateUpdateKeys(recovered.stateUpdates, { roleNames: new Map(roles.map(role => [role.name, role.id])), playerName: playerCharacter?.name })
      return { id: `draft-${Date.now()}`, turnId, ...recovered, thinking: thinking || undefined, usage, createdAt: new Date().toISOString() }
    },
    cancel(): void { directorGateway.cancelActiveRequests(); for (const role of roleGateways) role.cancelActiveRequests() },
    async consult(draft: Draft, messages: ConsultationMessage[], playerText: string): Promise<{ text: string; usage?: import('./types.ts').TokenUsage }> {
      let usage: import('./types.ts').TokenUsage | undefined
      const collectUsage = (u: { promptTokens: number; completionTokens: number }) => { usage = u }
      const result = await directorGateway.complete<{ text: string }>(
        getPrompts().skills.consultation,
        renderPrompt(getPrompts().consult.user, {
          draftText: draft.text,
          settingProposals: JSON.stringify(draft.settingProposals),
          consultations: messages.map(message => `${message.role}: ${message.text}`).join('\n'),
          playerText,
        }),
        'director_consultation',
        { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
        { name: 'submit_director_consultation', description: '提交导演对玩家咨询的简短回答。', parameters: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] } },
        { onUsage: collectUsage },
        { thinkingStrength: directorThinking },
      )
      if (!result || typeof result.text !== 'string' || !result.text.trim()) throw new Error('Director consultation output is missing text.')
      return { text: result.text, ...(usage ? { usage } : {}) }
    },
    async digest(role: Role, scene: import('./workers.ts').DigestSceneContext): Promise<import('./types.ts').MemoryDigest> {
      const gateway = getRoleGateway(role)
      const entrySchema = {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['fact', 'observation', 'interaction', 'promise', 'relationship', 'belief', 'emotion', 'goal_update'] },
          text: { type: 'string' },
          subjects: { type: 'array', items: { type: 'string' } },
          salience: { type: 'integer', minimum: 1, maximum: 5 },
          confidence: { type: 'number', enum: [0, 0.25, 0.5, 0.75, 1] },
        },
        required: ['kind', 'text', 'subjects', 'salience', 'confidence'],
      }
      const schema = { type: 'object', additionalProperties: false, properties: { entries: { type: 'array', items: entrySchema } }, required: ['entries'] }
      const result = await gateway.completeStreaming<{ entries?: import('./types.ts').MemoryDigestEntry[] }>(
        renderPrompt(getPrompts().role.digestSystem, { roleName: role.name }),
        renderPrompt(getPrompts().role.digestUser, { sceneText: scene.text }),
        'memory_digest',
        schema,
        { name: 'submit_memory_digest', description: '提交该角色从场景正文中提取的结构化私有记忆。', parameters: schema },
        {}, { thinkingStrength: role.thinkingStrength },
      )
      return { entries: Array.isArray(result?.entries) ? result.entries : [] }
    },
    async speak(role: Role, contribution: string, publicRoles: Role[] = [], scene?: { time?: string; location?: string }, onThinking?: (text: string) => void, lore?: LoreEntry[], recentScene?: string): Promise<{ text: string; thinking?: string; usage?: import('./types.ts').TokenUsage; worldChange?: import('./types.ts').WorldChangeRequest }> {
      let thinking = ''
      let usage = { promptTokens: 0, completionTokens: 0 }
      const collectThinking = (text: string) => { thinking += text; onThinking?.(text) }
      const collectUsage = (u: { promptTokens: number; completionTokens: number }) => { usage.promptTokens += u.promptTokens; usage.completionTokens += u.completionTokens }
      const loreText = formatLoreForRole(lore ?? [], role.id)
      const worldChangeSchema = {
        type: 'object', additionalProperties: false,
        properties: {
          sceneTime: { type: 'string', description: '剧情推进导致时间变化时填新的时间；否则省略' },
          sceneLocation: { type: 'string', description: '剧情推进导致地点变化时填新的地点；否则省略' },
          roleProposals: { type: 'array', description: '剧情需要引入当前角色列表之外的新人物时提案；没有就不填。', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, portraitRef: { type: 'string' }, currentState: { type: 'string' }, presence: { type: 'string', enum: ['present', 'absent', 'unavailable'] }, selfModel: { type: 'string' }, memoryTimeline: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } }, required: ['id', 'name', 'portraitRef', 'currentState', 'presence', 'selfModel', 'memoryTimeline'] } },
          reason: { type: 'string', description: '给玩家看的简短理由，说明为何提出这项世界变更（可省略）' },
        },
      }
      const schema = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', description: '角色此刻的完整发言（台词或带台词的行动描述）' }, worldChange: { type: 'object', additionalProperties: false, description: '可选。仅当你认为剧情需要推进时间、改变地点或引入新人物时才填；没有变更就省略。', properties: worldChangeSchema.properties } }, required: ['text'] }
      const result = await getRoleGateway(role).completeStreaming<{ text?: string; worldChange?: import('./types.ts').WorldChangeRequest }>(
        renderPrompt(getPrompts().chat.system, { roleName: role.name, selfModel: role.selfModel, goalsSection: formatGoals(role), ...(loreText ? { worldLore: `相关世界设定：\n${loreText}` } : { worldLore: '' }) }),
        renderPrompt(getPrompts().chat.user, {
          scene: formatSceneContext(scene) || '（尚未设定场景时间地点）',
          recentScene: recentScene || '（尚无已批准正文，这是本局第一次发言）',
          memoryTimeline: formatMemoryTimeline(role),
          publicRoles: publicRoleStates(publicRoles),
          contribution: contribution || '玩家没有说话，只是注视着你。',
        }),
        'chat_speech',
        schema,
        { name: 'submit_chat_speech', description: '提交该角色此刻在群聊中的完整发言（可选附带世界变更申请）。', parameters: schema },
        { onThinking: collectThinking, onUsage: collectUsage },
        {}, { thinkingStrength: role.thinkingStrength },
      )
      const text = result?.text?.trim()
      if (!text) throw new Error(`Role speech is missing text. Received fields: ${receivedFields(result)}`)
      const worldChange = normalizeWorldChange(result?.worldChange)
      return { text, ...(thinking ? { thinking } : {}), usage, ...(worldChange ? { worldChange } : {}) }
    },
    async directorChat(playerText: string, context: import('./workers.ts').DirectorChatContext, onThinking?: (text: string) => void): Promise<{ reply: string; worldChange?: import('./types.ts').WorldChangeRequest; narration?: string; usage?: import('./types.ts').TokenUsage }> {
      let thinking = ''
      let usage = { promptTokens: 0, completionTokens: 0 }
      const collectThinking = (text: string) => { thinking += text; onThinking?.(text) }
      const collectUsage = (u: { promptTokens: number; completionTokens: number }) => { usage.promptTokens += u.promptTokens; usage.completionTokens += u.completionTokens }
      const roleProposalSchema = { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, portraitRef: { type: 'string' }, currentState: { type: 'string' }, presence: { type: 'string', enum: ['present', 'absent', 'unavailable'] }, selfModel: { type: 'string' }, memoryTimeline: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } }, required: ['id', 'name', 'portraitRef', 'currentState', 'presence', 'selfModel', 'memoryTimeline'] }
      const worldChangeSchema = {
        type: 'object', additionalProperties: false,
        properties: {
          sceneTime: { type: 'string', description: '时间变化时填新时间；无变化省略' },
          sceneLocation: { type: 'string', description: '地点变化时填新地点；无变化省略' },
          roleProposals: { type: 'array', description: '需要引入新人物时提案；没有省略。', items: roleProposalSchema },
          rolePresence: { type: 'array', description: '需要切换已有角色进场/离场时列出；没有省略。', items: { type: 'object', additionalProperties: false, properties: { roleId: { type: 'string' }, presence: { type: 'string', enum: ['present', 'absent', 'unavailable'] } }, required: ['roleId', 'presence'] } },
          reason: { type: 'string', description: '给玩家看的简短理由（可省略）' },
        },
      }
      const schema = {
        type: 'object', additionalProperties: false,
        properties: {
          reply: { type: 'string', description: '对玩家这句自然语言建议/提问的回复（不写正文、不替角色发言）' },
          worldChange: { type: 'object', additionalProperties: false, description: '可选。玩家建议（或你判断剧情需要）时间/地点变化、人物进出场、新人物时提交；没有变更省略。', properties: worldChangeSchema.properties },
          narration: { type: 'string', description: '可选。若提交了 worldChange，同时写一段该变更被批准后要发布的导演风格叙述（第三人称环境/事件描写，不用对话气泡、不替角色说台词）；无变更则省略。' },
        },
        required: ['reply'],
      }
      const result = await directorGateway.completeStreaming<{ reply?: string; worldChange?: import('./types.ts').WorldChangeRequest; narration?: string }>(
        renderPrompt(getPrompts().chat.directorChatSystem, {
          scene: formatSceneContext({ time: context.sceneTime, location: context.sceneLocation }) || '（尚未设定场景时间地点）',
          recentScene: context.recentScene || '（尚无已批准正文）',
          roles: context.roles.map(role => `${role.name}（${role.id}，${role.presence === 'present' ? '在场' : role.presence === 'absent' ? '离场' : '不可用'}）：${role.currentState}`).join('\n'),
          lore: formatLoreAll(context.lore ?? []),
          history: (context.history ?? []).map(message => `${message.role === 'player' ? '玩家' : '导演'}：${message.text}`).join('\n'),
        }),
        renderPrompt(getPrompts().chat.directorChatUser, { playerText: playerText.trim() || '（玩家没有说话）' }),
        'chat_director_chat',
        schema,
        { name: 'submit_director_chat', description: '提交导演对玩家建议的回复（可选附带世界变更申请与叙述）。', parameters: schema },
        { onThinking: collectThinking, onUsage: collectUsage },
        {}, { thinkingStrength: directorThinking },
      )
      const reply = result?.reply?.trim()
      if (!reply) throw new Error(`Director reply is missing text. Received fields: ${receivedFields(result)}`)
      const worldChange = normalizeWorldChange(result?.worldChange)
      const narration = typeof result?.narration === 'string' && result.narration.trim() ? result.narration.trim() : undefined
      return { reply, ...(thinking ? { thinking } : {}), usage, ...(worldChange ? { worldChange } : {}), ...(worldChange && narration ? { narration } : {}) }
    },
  }
}

/**
 * 归一化角色发言附带的世界变更申请：只保留非空的有效变更字段，
 * 空对象/无有效变更返回 undefined（表示本发言不附带世界变更）。
 */
function normalizeWorldChange(raw: unknown): import('./types.ts').WorldChangeRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const result: import('./types.ts').WorldChangeRequest = {}
  const sceneTime = typeof value.sceneTime === 'string' ? value.sceneTime.trim() : ''
  const sceneLocation = typeof value.sceneLocation === 'string' ? value.sceneLocation.trim() : ''
  if (sceneTime) result.sceneTime = sceneTime
  if (sceneLocation) result.sceneLocation = sceneLocation
  if (typeof value.reason === 'string' && value.reason.trim()) result.reason = value.reason.trim()
  const proposalsRaw = value.roleProposals ?? value.role_proposals
  if (Array.isArray(proposalsRaw)) {
    const proposals = proposalsRaw.map((item): import('./types.ts').RoleProposal | undefined => {
      if (!item || typeof item !== 'object') return undefined
      const p = item as Record<string, unknown>
      const id = typeof p.id === 'string' ? p.id.trim() : ''
      const name = typeof p.name === 'string' ? p.name.trim() : ''
      const currentState = typeof p.currentState === 'string' ? p.currentState.trim() : ''
      const selfModel = typeof p.selfModel === 'string' ? p.selfModel.trim() : ''
      if (!id || !name || !currentState || !selfModel) return undefined
      const presence = p.presence === 'present' || p.presence === 'absent' || p.presence === 'unavailable' ? p.presence : 'present'
      const portraitRef = typeof p.portraitRef === 'string' && p.portraitRef.trim() ? p.portraitRef.trim() : '/assets/default.svg'
      const memoryRaw = p.memoryTimeline ?? p.memory_timeline
      const memoryTimeline = memoryRaw && typeof memoryRaw === 'object' && !Array.isArray(memoryRaw)
        ? Object.fromEntries(Object.entries(memoryRaw as Record<string, unknown>).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).map(item => String(item ?? '').trim()).filter(Boolean)]))
        : {}
      return { id, name, portraitRef, currentState, presence, selfModel, memoryTimeline, ...(Array.isArray(p.goals) ? { goals: p.goals.map(item => String(item ?? '').trim()).filter(Boolean) } : {}) }
    }).filter((item): item is import('./types.ts').RoleProposal => Boolean(item))
    if (proposals.length > 0) result.roleProposals = proposals
  }
  const presenceRaw = value.rolePresence ?? value.role_presence
  if (Array.isArray(presenceRaw)) {
    const presence = presenceRaw.map((item): { roleId: string; presence: 'present' | 'absent' | 'unavailable' } | undefined => {
      if (!item || typeof item !== 'object') return undefined
      const p = item as Record<string, unknown>
      const roleId = typeof p.roleId === 'string' ? p.roleId.trim() : typeof p.role_id === 'string' ? String(p.role_id).trim() : ''
      const presence = p.presence === 'present' || p.presence === 'absent' || p.presence === 'unavailable' ? p.presence : undefined
      if (!roleId || !presence) return undefined
      return { roleId, presence }
    }).filter((item): item is { roleId: string; presence: 'present' | 'absent' | 'unavailable' } => Boolean(item))
    if (presence.length > 0) result.rolePresence = presence
  }
  if (result.sceneTime || result.sceneLocation || result.roleProposals || result.rolePresence || result.reason) return result
  return undefined
}

function normalizeRoleDecision(result: unknown): { brief: string; privateReaction: string; publicIdentity?: string; impressions?: Record<string, string | null> } | undefined {  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined
  const value = result as Record<string, unknown>
  const brief = ['brief', 'intent', 'publicIntent', 'public_intent', 'response', 'text'].map(key => value[key]).find(item => typeof item === 'string' && item.trim()) as string | undefined
  if (!brief) return undefined
  const privateReaction = ['privateReaction', 'private_reaction', 'reaction', 'thought'].map(key => value[key]).find(item => typeof item === 'string')
  const identity = ['identity', 'publicIdentity', 'public_identity', 'outwardIdentity', 'presentedAs'].map(key => value[key]).find(item => typeof item === 'string' && item.trim()) as string | undefined
  const impressionsRaw = value.impressions ?? value.impression_updates
  const impressions = impressionsRaw && typeof impressionsRaw === 'object' && !Array.isArray(impressionsRaw)
    ? Object.fromEntries(Object.entries(impressionsRaw as Record<string, unknown>).map(([name, text]) => [name, typeof text === 'string' && text.trim() ? text.trim() : null])) as Record<string, string | null>
    : undefined
  return { brief, privateReaction: typeof privateReaction === 'string' ? privateReaction : '', ...(identity ? { publicIdentity: identity.trim() } : {}), ...(impressions && Object.keys(impressions).length > 0 ? { impressions } : {}) }
}

function normalizeDirectorDraft(result: unknown): Omit<Draft, 'id' | 'turnId' | 'createdAt'> | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined
  const value = result as Record<string, unknown>
  const text = ['text', 'prose', 'content', 'story', 'draft'].map(key => value[key]).find(item => typeof item === 'string' && item.trim()) as string | undefined
  if (!text) return undefined
  const stateUpdates = value.stateUpdates ?? value.state_updates ?? value.roleStates ?? value.currentStates ?? {}
  if (!stateUpdates || typeof stateUpdates !== 'object' || Array.isArray(stateUpdates)) return undefined
  const intentHandling = Array.isArray(value.intentHandling) ? value.intentHandling : objectIntentHandling(value.intentHandling)
  const sceneUpdatesRaw = value.sceneUpdates ?? value.scene_updates ?? {}
  const sceneUpdates = sceneUpdatesRaw && typeof sceneUpdatesRaw === 'object' && !Array.isArray(sceneUpdatesRaw)
    ? { ...(typeof (sceneUpdatesRaw as Record<string, unknown>).time === 'string' && (sceneUpdatesRaw as Record<string, unknown>).time ? { time: (sceneUpdatesRaw as Record<string, unknown>).time as string } : {}), ...(typeof (sceneUpdatesRaw as Record<string, unknown>).location === 'string' && (sceneUpdatesRaw as Record<string, unknown>).location ? { location: (sceneUpdatesRaw as Record<string, unknown>).location as string } : {}) }
    : undefined
  return {
    text,
    stateUpdates: stateUpdates as Record<string, string>,
    ...(sceneUpdates && Object.keys(sceneUpdates).length > 0 ? { sceneUpdates } : {}),
    settingProposals: Array.isArray(value.settingProposals) ? value.settingProposals : [],
    ...(Array.isArray(value.roleProposals) ? { roleProposals: value.roleProposals as import('./types.ts').RoleProposal[] } : {}),
    intentHandling,
    openQuestions: Array.isArray(value.openQuestions) ? value.openQuestions : [],
  }
}

function objectIntentHandling(value: unknown): Array<{ roleId: string; intentId: string; result: 'used'; note: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([roleId, note]) => ({ roleId, intentId: `provider-${roleId}`, result: 'used', note }))
}

function receivedFields(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'none'
  return Object.keys(result as Record<string, unknown>).slice(0, 12).join(', ') || 'none'
}
