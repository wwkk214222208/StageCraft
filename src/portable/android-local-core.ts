/**
 * Android 本地（WebView 内）组合根：在保留既有 StageCraftEmbeddedCore 会话面的同时，
 * 暴露 StageCraftLocalCore —— 供打包的完整 Web UI（public/）本地复用。
 *
 * - 同一组共享服务（chat/director/management）与 CoreRuntimeSkeleton 在页面内运行；
 * - 模型生成走与桌面同一个 createRealWorkers（gameplay 提示词渲染 + 预设管线）→ Android 原生传输（凭据在 Java）；
 * - 富 API 门面与 PC 端 RoomRuntime 同名同参，local-runtime-web-entry.js 直接调用。
 */
import { CORE_PROTOCOL_VERSION, type CoreEvent, type CoreView, type HumanCommand, type ModelRequest, type ModelResult } from '../core/protocol.ts'
import { createAndroidComposition, type AndroidComposition } from './android-composition.ts'
import type { RoomSnapshot, RoomMode, WorldChangeRequest, ThinkingStrength, Role, LoreEntry, ConsultationMessage, Decision, Draft, PlayerCharacter } from '../types.ts'
import type { StoryPackage } from '../story-packages.ts'
import type { WorkerSet } from '../workers.ts'
import { createModelStreamAccumulator, createRealWorkers, parseModelCompleteResponse, parseModelJson, type ModelGateway } from '../model-gateway.ts'
import { resolveProviderForRequest, type ProviderRoutingEntry } from '../provider-routing.ts'
import { setPromptStorage } from '../prompts.ts'
import { createAndroidPromptStorage } from './android-prompt-storage.ts'
import { CoreProtocolPortableHandler, handlePortableApi, type ApiRequest, type ApiResponse } from './api-handler.ts'
import { CoreBusinessPortableHandler, CORE_BUSINESS_ROUTES, type CoreFacade } from './core-business-handlers.ts'
import { validateManifest, manifestHash } from '../plugin-bootstrap.ts'
import type { PluginManifest, QuarantineRecord } from '../plugin-contract.ts'

export const ANDROID_CORE_BUNDLE_VERSION = '1.1.0'
export const ANDROID_CORE_BRIDGE_VERSION = '1'
export const PROVIDER_SECRET_KEY = 'local.provider.default'
export const LOCAL_ROOM_ID = 'android-local-room'

/**
 * W6：Android 内置插件候选集（构建期确定；与桌面 manifest 契约同源）。
 * 组合根装配（android-composition）的 4 类内置插件：solution/llm/state/human。
 * manifest 由 plugin-bootstrap.ts 的校验规则核对（manifestHash 与 plan 比对）。
 */
export const BUILTIN_PLUGIN_MANIFESTS: readonly PluginManifest[] = Object.freeze([
  {
    id: 'stagecraft.solution', version: '1.0.0', kind: 'solution',
    title: 'StageCraft Solution（Chat/Director/Management）',
    description: '内置聊天/导演/管理解决方案插件',
  },
  {
    id: 'stagecraft.llm.android', version: '1.0.0', kind: 'llm',
    title: 'Android Native LLM Router',
    description: 'Android 原生模型路由（凭据在 Java Keystore）',
  },
  {
    id: 'stagecraft.state.android', version: '1.0.0', kind: 'repository',
    title: 'Android State Repository',
    description: 'Android SQLite 状态仓库',
  },
  {
    id: 'stagecraft.human.http', version: '1.0.0', kind: 'human',
    title: 'Core Protocol Human Adapter',
    description: 'Core 协议人机交互适配（HTTP/SSE）',
  },
])

type Json = Record<string, unknown>
type ResultValue = Record<string, unknown>

/** Android 本地模型供应商配置（凭据在 Java Keystore）。 */
export interface LocalProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
  responseFormat?: 'json_object' | 'none'
}

const SYNC_OPERATIONS = new Set([
  'asset.read', 'asset.write', 'asset.remove',
  'secret.get', 'secret.set', 'secret.remove',
  'core-state.commit', 'core-state.restore',
  'stagecraft.room.get', 'stagecraft.repository', 'stories.list', 'story.read',
  'model.cancel',
])

/** WebView 入口：安装本地组合根与富 API 门面。 */
export function installLocalCore(global: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  const native = (global.StageCraftNative ?? {}) as Record<string, unknown>
  if (global.StageCraftNative === undefined || typeof native.invokeSync !== 'function' || typeof native.invokeAsync !== 'function') {
    throw new Error('Android local Core requires the native operations bridge (invokeSync + invokeAsync).')
  }
  const invokeSync = (operation: string, input: Json = {}): unknown => {
    const method = native.invokeSync as (name: string, value: string) => string
    const raw = method.call(native, operation, JSON.stringify(input))
    if (typeof raw !== 'string' || raw.length > 16 * 1024 * 1024) throw new Error('Android bridge response is invalid or too large.')
    let parsed: unknown
    // 桥契约：原生侧必须始终返回 JSON 文本。裸标量（如未加引号的 turn id）在这里无处遁形，报出片段便于定位。
    try { parsed = JSON.parse(raw) } catch { throw new Error(`Android bridge response is not valid JSON for ${operation}. Response starts with: ${JSON.stringify(raw.slice(0, 120))}`) }
    if (parsed && typeof parsed === 'object' && 'error' in parsed && (parsed as { error?: unknown }).error !== null) {
      const message = (parsed as { error?: { message?: string } }).error?.message ?? 'Native operation failed.'
      throw new Error(message)
    }
    return parsed
  }
  // 提示词 IO 注入：与桌面同一套运行时行为（渲染/预设/过滤），仅数据存取走 Android 侧实现。
  setPromptStorage(createAndroidPromptStorage({ invokeSync: (operation, input = {}) => invokeSync(operation, input) }))

  // ── 异步桥（model.request / story.read）──
  let asyncSequence = 0
  const pendingAsync = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; onStreamPayload?: (payload: string) => void }>()
  const invokeAsync = (operation: string, input: Json, hooks?: { onStreamPayload?: (payload: string) => void }): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      const callbackId = `local-${Date.now().toString(36)}-${++asyncSequence}`
      pendingAsync.set(callbackId, { resolve, reject, onStreamPayload: hooks?.onStreamPayload })
      const method = native.invokeAsync as (name: string, value: string, callbackId: string) => void
      method.call(native, operation, JSON.stringify(input), callbackId)
    })
  }
  // 结果回调容器必须落在页面全局（window === globalThis）：Java evaluateJavascript 总是调用
  // window.StageCraftNativeResult.handle(...)。同时保留 global 上的一份，便于测试注入自定义全局。
  const resultHandler = Object.freeze({
    handle(callbackId: string, resultJson: string): void {
      const entry = pendingAsync.get(callbackId)
      if (!entry) return
      let value: unknown
      try { value = JSON.parse(resultJson) as unknown } catch { return }
      if (value && typeof value === 'object') {
        const result = value as ResultValue
        if (result.error) {
          pendingAsync.delete(callbackId)
          entry.reject(new Error(typeof result.error === 'object' && result.error !== null && typeof (result.error as { message?: unknown }).message === 'string' ? (result.error as { message: string }).message : 'Native operation failed.'))
          return
        }
        if (typeof result.streamPayload === 'string') {
          entry.onStreamPayload?.(result.streamPayload)
          return
        }
      }
      pendingAsync.delete(callbackId)
      entry.resolve(value)
    },
  })
  global.StageCraftNativeResult = resultHandler
  globalThis.StageCraftNativeResult = resultHandler

  // ── 供应商配置（凭据只存 Java Keystore 加密的 secret，不落在页面存储）──
  /** 供应商表读取：{providers, defaults}（多供应商）。 */
  const readProviderMeta = (): { providers: Array<Record<string, unknown>>; defaults: Record<string, unknown> } => {
    const raw = invokeSync('secret.get', { key: 'local.provider.meta' }) as { found?: boolean; value?: string } | undefined
    if (raw?.found && typeof raw.value === 'string') {
      try {
        const meta = JSON.parse(raw.value) as { providers?: unknown; defaults?: unknown }
        if (meta && typeof meta === 'object') {
          return { providers: Array.isArray(meta.providers) ? meta.providers : [], defaults: meta.defaults && typeof meta.defaults === 'object' ? meta.defaults as Record<string, unknown> : {} }
        }
      } catch { /* 损坏按空表处理 */ }
    }
    return { providers: [], defaults: {} }
  }
  /** 模型供应商解析：共享桌面路由语义（角色请求 → route.providerId → 角色默认；导演请求 → route.providerId → 导演默认 → 角色默认兜底）。 */
  const readProvider = (request?: ModelRequest): LocalProviderConfig | undefined => {
    const meta = readProviderMeta()
    const resolved = resolveProviderForRequest(meta.providers as ProviderRoutingEntry[], meta.defaults, request)
    const selected = resolved.provider
    if (selected) {
      const model = typeof selected.selectedModel === 'string' ? selected.selectedModel : ''
      if (model.trim()) {
        return { baseUrl: selected.baseUrl, apiKey: selected.apiKey, model: model.trim(), responseFormat: selected.responseFormat === 'none' ? 'none' : 'json_object' }
      }
    }
    // 旧命名快照回退（offline.provider.default → local.provider.default），迁移到表
    const raw = invokeSync('secret.get', { key: PROVIDER_SECRET_KEY }) as { found?: boolean; value?: string } | undefined
    if (raw?.found && typeof raw.value === 'string') {
      try {
        const parsed = JSON.parse(raw.value) as Partial<LocalProviderConfig>
        if (parsed && typeof parsed.baseUrl === 'string' && typeof parsed.apiKey === 'string' && typeof parsed.model === 'string'
          && parsed.baseUrl.trim() && parsed.apiKey.trim() && parsed.model.trim()) {
          return { baseUrl: parsed.baseUrl.trim(), apiKey: parsed.apiKey.trim(), model: parsed.model.trim(), responseFormat: parsed.responseFormat === 'none' ? 'none' : 'json_object' }
        }
      } catch { /* 非法配置按未配置处理 */ }
    }
    return undefined
  }
  const writeProvider = (config: LocalProviderConfig): void => {
    invokeSync('secret.set', { key: PROVIDER_SECRET_KEY, value: JSON.stringify(config) })
  }

  const endpointFor = (base: string): string => {
    const normalized = base.trim().replace(/\/+$/, '')
    if (/\/chat\/completions$/i.test(normalized)) return normalized
    return `${normalized}/chat/completions`
  }

  const toOpenAiBody = (request: ModelRequest, config: LocalProviderConfig): Json => {
    const messages: Array<{ role: string; content: string }> = []
    if (request.prompt?.system) messages.push({ role: 'system', content: request.prompt.system })
    for (const message of request.prompt?.messages ?? []) {
      if (message.content) messages.push({ role: message.role, content: message.content })
    }
    if (request.prompt?.user) messages.push({ role: 'user', content: request.prompt.user })
    const body: Json = { model: config.model, messages, stream: request.stream !== false }
    if (request.tool) body.tools = [{ type: 'function', function: request.tool }]
    if (config.responseFormat !== 'none') body.response_format = { type: 'json_object' }
    return body
  }

  const modelRequest = (request: ModelRequest, hooks?: { onThinking?: (text: string) => void }): Promise<ModelResult> => {
    const config = readProvider(request)
    if (!config) return Promise.reject(new Error('未配置模型供应商：点击「连接」→ 管理供应商，新建供应商并填写接口地址、API Key 与模型名。'))
    const stream = createModelStreamAccumulator({ onThinking: hooks?.onThinking })
    return invokeAsync('model.request', { requestId: request.requestId, endpoint: endpointFor(config.baseUrl), apiKey: config.apiKey, ...toOpenAiBody(request, config) }, { onStreamPayload: payload => stream.push(payload) }).then(value => {
      if (value && typeof value === 'object' && (value as ResultValue).streamComplete === true) {
        const complete = stream.result()
        const output = complete.toolArguments || complete.content
        return normalizeModelResult({
          requestId: request.requestId,
          ...(output ? { output } : {}),
          ...(complete.reasoning ? { thinking: complete.reasoning } : {}),
          ...(complete.usage ? { usage: { promptTokens: complete.usage.prompt_tokens ?? 0, completionTokens: complete.usage.completion_tokens ?? 0 } } : {}),
        })
      }
      if (value && typeof value === 'object' && typeof (value as ResultValue).responseBody === 'string') {
        let responseBody: unknown
        try { responseBody = JSON.parse((value as ResultValue).responseBody as string) }
        catch { throw new Error('模型接口返回的完整响应不是有效 JSON，请检查接口地址、代理或模型兼容性。') }
        const complete = parseModelCompleteResponse(responseBody)
        if (complete.reasoning) hooks?.onThinking?.(complete.reasoning)
        const output = complete.toolArguments || complete.content
        return normalizeModelResult({
          requestId: request.requestId,
          ...(output ? { output } : {}),
          ...(complete.reasoning ? { thinking: complete.reasoning } : {}),
          ...(complete.usage ? { usage: { promptTokens: complete.usage.prompt_tokens ?? 0, completionTokens: complete.usage.completion_tokens ?? 0 } } : {}),
        })
      }
      return normalizeModelResult(value)
    }) as Promise<ModelResult>
  }

  /** 模型返回解析：与桌面 ModelGateway 同一套容错（剥围栏/截取片段），避免裸 JSON.parse 抛原生错误。 */
  const normalizeModelResult = (value: unknown): ModelResult => {
    const result = (value ?? {}) as ModelResult
    if (typeof result.output === 'string') {
      const text = result.output
      try { result.output = parseModelJson(text) } catch { throw new Error('模型返回不是有效的 JSON，请改用支持 json_object 的模型或检查接口地址/模型名。') }
      if (result.output === null || typeof result.output !== 'object') throw new Error(`模型返回内容不是 JSON 对象：${text.slice(0, 80)}`)
    }
    return result
  }

  const operations = {
    invoke<T = unknown>(operation: string, input: Json = {}, callbacks?: { onThinking?: (text: string) => void }): T | Promise<T> {
      // 思维链增量必须透传给 modelRequest：否则累加器的 onThinking 为空，
      // 流式 reasoning 无处可去，只能等最终结果一次性出现（安卓端"无法即时显示"的根因）。
      if (operation === 'model.request') return modelRequest(input as unknown as ModelRequest, callbacks) as Promise<T>
      if (SYNC_OPERATIONS.has(operation)) return Promise.resolve(invokeSync(operation, input) as T)
      return invokeAsync(operation, input) as Promise<T>
    },
    invokeSync<T = unknown>(operation: string, input: Json = {}): T {
      return invokeSync(operation, input) as T
    },
  }

  // 双端同一套生成内核：与桌面 createRealWorkers 完全同源（gameplay 提示词渲染 + 预设管线），
  // 仅模型 IO 不同——requestModel 走 Android 原生传输（Java 持有凭据与网络）。
  const workers: WorkerSet = createRealWorkers(undefined as unknown as ModelGateway, () => undefined as unknown as ModelGateway, {
    // 与桌面端同构：模型请求经 Core LLM 路由（NativeCoreLlmRouter）下发，由它发布
    // model.started / model.thinking.delta，服务层据此把思维链逐段推给 UI。
    // 此前这里直接调 modelRequest，等于绕过 Core 事件总线——思维链只能随最终结果
    // 一次性出现，正是"安卓端无法即时显示流式思维链"的根因。
    // （requireComposition 在下方定义；模型请求只发生在 start() 之后，此处惰性引用安全。）
    requestModel: request => requireComposition().core.requestModel(request),
    cancelModel: (requestId?: string): Promise<void> => requireComposition().core.cancel(requestId ?? ''),
  })

  // ── 组合与消息流 ──
  let sink: ((message: unknown) => void) | undefined
  let composition: AndroidComposition | undefined
  let coreListenerInstalled = false
  const emit = (message: unknown): void => sink?.(JSON.stringify(message))
  const start = (nextSink: (message: string) => void): void => {
    sink = nextSink
    composition ??= createAndroidComposition(operations, { roomId: LOCAL_ROOM_ID, workers, onMessage: message => emit(message) })
    if (!coreListenerInstalled) {
      coreListenerInstalled = true
      composition.core.subscribe((event: CoreEvent) => emit({ type: 'core.event', event }))
    }
    composition.start()
  }
  const requireComposition = (): AndroidComposition => {
    if (!composition) throw new Error('本地核心未启动。')
    return composition
  }

  // ── 富 API 门面（与 PC 端 RoomRuntime 同名同参）──
  const facade: Record<string, unknown> = {
    getRoom: (): RoomSnapshot => requireComposition().getRoom(),
    getView: (): CoreView => requireComposition().core.getView(),
    dispatchCommand: (command: HumanCommand): Promise<void> => requireComposition().dispatch(command),
    cancel: (requestId?: string): Promise<void> => requireComposition().cancel(requestId),
    refresh: (): void => requireComposition().refresh(),
    getProvider: (): { configured: boolean } & Partial<LocalProviderConfig> => {
      // 无请求上下文时按角色默认语义解析（与既有 UI 展示一致）
      const config = readProvider({ route: { role: 'default' } })
      return config ? { configured: true, baseUrl: config.baseUrl, model: config.model } : { configured: false }
    },
    setProvider: (config: LocalProviderConfig): void => {
      if (!config || typeof config.baseUrl !== 'string' || typeof config.apiKey !== 'string' || typeof config.model !== 'string' || !config.baseUrl.trim() || !config.apiKey.trim() || !config.model.trim()) {
        throw new Error('供应商配置必须是 { baseUrl, apiKey, model } 且不能为空。')
      }
      writeProvider({ baseUrl: config.baseUrl.trim(), apiKey: config.apiKey.trim(), model: config.model.trim(), responseFormat: config.responseFormat === 'none' ? 'none' : 'json_object' })
      emit({ type: 'provider.changed' })
    },
    story: (id: string): Promise<StoryPackage> => Promise.resolve(invokeSync('story.read', { id })).then(value => JSON.parse(String((value as { value?: string }).value ?? '')) as StoryPackage),
    stories: (): Array<{ id: string; title: string; mode: string; custom: boolean }> => {
      const result = invokeSync('stories.list', {}) as { stories?: Array<{ id: string; title: string; mode: string; custom: boolean }> }
      return Array.isArray(result?.stories) ? result.stories : []
    },
    submitTurn: (input: { text: string; requiredRoleIds?: string[] }): Promise<void> => {
      const core = requireComposition()
      const room = core.getRoom()
      if (room.mode === 'chat') return core.chat.submitContribution(LOCAL_ROOM_ID, input.text)
      return core.director.submitTurn(LOCAL_ROOM_ID, input)
    },
    speak: (roleId: string, feedback = ''): Promise<void> => requireComposition().chat.speak(LOCAL_ROOM_ID, roleId, feedback),
    speakAll: (): Promise<void> => requireComposition().chat.speakAll(LOCAL_ROOM_ID),
    directorDecide: (): Promise<void> => requireComposition().chat.directorDecide(LOCAL_ROOM_ID),
    rejectSpeech: (): Promise<void> => requireComposition().chat.rejectSpeech(LOCAL_ROOM_ID),
    retrySpeak: (): Promise<void> => requireComposition().chat.retrySpeak(LOCAL_ROOM_ID),
    approveSpeech: (text: string, worldChangeOverride?: WorldChangeRequest | null): Promise<void> => requireComposition().chat.approveSpeech(LOCAL_ROOM_ID, text, worldChangeOverride ?? null),
    directorChat: (text: string): Promise<void> => requireComposition().chat.directorChat(LOCAL_ROOM_ID, text),
    approveWorldChange: (override?: WorldChangeRequest | null): Promise<void> => requireComposition().chat.approveWorldChange(LOCAL_ROOM_ID, override ?? null),
    rejectWorldChange: (): Promise<void> => requireComposition().chat.rejectWorldChange(LOCAL_ROOM_ID),
    cancelTurn: (): void => {
      const core = requireComposition()
      if (core.getRoom().mode === 'chat') core.chat.cancel(LOCAL_ROOM_ID)
      else core.director.cancel(LOCAL_ROOM_ID)
    },
    proceedToDraft: (): Promise<void> => requireComposition().director.proceedToDraft(LOCAL_ROOM_ID),
    rejectDraft: (): Promise<void> => requireComposition().director.rejectDraft(LOCAL_ROOM_ID),
    retryDirector: (): Promise<void> => requireComposition().director.retryDirector(LOCAL_ROOM_ID),
    reconsiderReaction: (roleId: string, feedback: string): Promise<void> => requireComposition().director.reconsiderReaction(LOCAL_ROOM_ID, roleId, feedback),
    restart: (story: StoryPackage, options?: { mode?: RoomMode; autoPublish?: boolean }): void => requireComposition().management.restart(LOCAL_ROOM_ID, story, options ?? {}),
    setRoomConfig: (config: { mode?: RoomMode; autoPublish?: boolean; speechMode?: string; hidePlayerSpeech?: boolean }): void => requireComposition().management.setRoomConfig(LOCAL_ROOM_ID, config as never),
    updatePlayerCharacter: (player: PlayerCharacter): void => requireComposition().management.updatePlayerCharacter(LOCAL_ROOM_ID, { name: player.name, persona: player.persona, currentState: player.currentState }),
    setPlayerAvatar: (portraitRef: string): void => requireComposition().management.setPlayerAvatar(LOCAL_ROOM_ID, portraitRef),
    interveneRole: (roleId: string, selfModel: string, config: Json = {}): void => requireComposition().management.interveneRole(LOCAL_ROOM_ID, roleId, selfModel, config),
    storeNpcMemories: (roleId: string, entries: Array<{ id?: string; text?: string; occurredAt?: string }>): void => requireComposition().management.storeNpcMemories(LOCAL_ROOM_ID, roleId, entries),
    retractNpcMemory: (memoryId: string): void => requireComposition().management.retractNpcMemory(LOCAL_ROOM_ID, memoryId),
    updateNpcMemory: (memoryId: string, entry: { text?: string; occurredAt?: string }): void => requireComposition().management.updateNpcMemory(LOCAL_ROOM_ID, memoryId, entry),
    reorderNpcMemories: (roleId: string, memoryIds: string[]): void => requireComposition().management.reorderNpcMemories(LOCAL_ROOM_ID, roleId, memoryIds),
    supersedeNpcMemory: (memoryId: string, entry: { text: string; occurredAt: string }): void => requireComposition().management.supersedeNpcMemory(LOCAL_ROOM_ID, memoryId, entry),
    saveLore: (lore: LoreEntry[]): void => requireComposition().management.saveLore(LOCAL_ROOM_ID, lore),
    createRole: (role: Parameters<import('../stagecraft-repository.ts').StageCraftRepository['createRole']>[1]): void => requireComposition().management.createRole(LOCAL_ROOM_ID, role),
    deleteRole: (roleId: string): void => requireComposition().management.deleteRole(LOCAL_ROOM_ID, roleId),
    setRolePresence: (roleId: string, presence: Role['presence']): void => requireComposition().management.setRolePresence(LOCAL_ROOM_ID, roleId, presence),
    setRoleThinking: (roleId: string, thinkingStrength: ThinkingStrength): void => requireComposition().management.setRoleThinking(LOCAL_ROOM_ID, roleId, thinkingStrength),
    reorderRoles: (roleIds: string[]): void => requireComposition().management.reorderRoles(LOCAL_ROOM_ID, roleIds),
    setRoleAvatar: (roleId: string, portraitRef: string): void => requireComposition().management.setRoleAvatar(LOCAL_ROOM_ID, roleId, portraitRef),
    setRoleCurrentState: (roleId: string, currentState: string): void => requireComposition().management.setRoleCurrentState(LOCAL_ROOM_ID, roleId, currentState),
    setDirectorSetting: (text: string): void => requireComposition().management.setDirectorSetting(LOCAL_ROOM_ID, text),
    updateScene: (updates: { time?: string; location?: string }): void => requireComposition().management.updateScene(LOCAL_ROOM_ID, updates),
    consult: (draftId: string, playerText: string, context = ''): Promise<void> => requireComposition().director.consult(LOCAL_ROOM_ID, draftId, playerText, context),
    finishConsultation: (): void => requireComposition().director.finishConsultation(LOCAL_ROOM_ID),
    redraft: (draftId: string): Promise<void> => requireComposition().director.redraft(LOCAL_ROOM_ID, draftId),
    approve: (draftId: string, text: string, stateUpdates: Record<string, string>, sceneUpdates?: { time?: string; location?: string }): void => requireComposition().director.approve(LOCAL_ROOM_ID, draftId, text, stateUpdates, sceneUpdates),
  }

  // ── W4/W6 合流：可移植 API handler（协议端点 + 业务 handler 语义单一来源）──
  // 组合根 core（CoreRuntimeSkeleton）即 CoreRuntimePort：dispatch/getView/cancel/subscribe/invokeUiAction。
  // health/capabilities 由 Java 侧 CoreDataServer 承载（真实 bundle 身份/能力矩阵），handler 的可选链
  // getHealth/getCapabilities 不调用（Android 侧不提供），commands/cancel/ui-action 语义与桌面完全同构。
  // W6：业务 handler 由 registry handlerId 驱动（CoreBusinessPortableHandler），调组合根 facade。
  let portableHandler: CoreProtocolPortableHandler | undefined
  let businessHandler: CoreBusinessPortableHandler | undefined
  const requirePortableHandler = (): CoreProtocolPortableHandler => {
    let handler = portableHandler
    if (!handler) {
      const core = requireComposition().core
      handler = new CoreProtocolPortableHandler(core, { roomId: () => LOCAL_ROOM_ID })
      portableHandler = handler
    }
    return handler
  }
  const requireBusinessHandler = (): CoreBusinessPortableHandler => {
    let handler = businessHandler
    if (!handler) {
      const facade = localCore as unknown as CoreFacade
      handler = new CoreBusinessPortableHandler(facade, CORE_BUSINESS_ROUTES)
      businessHandler = handler
    }
    return handler
  }
  /** 供 core-host-bridge 调用的协议端点分发：返回 Promise<{status, body}>（body 为 JSON 文本）。 */
  const handlePortableRequest = async (method: string, path: string, headersJson: string, bodyJson: string): Promise<{ status: number; body: string }> => {
    const headers: Record<string, string> = {}
    try {
      const parsed = JSON.parse(headersJson || '{}') as Record<string, unknown>
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value === 'string') headers[name.toLowerCase()] = value
      }
    } catch { /* 非法 headers 按空表处理 */ }
    const request: ApiRequest = {
      method,
      url: path,
      headers,
      body: bodyJson ? new TextEncoder().encode(bodyJson) : undefined,
      signal: AbortSignal.timeout(20_000),
    }
    let response: ApiResponse
    try {
      // 协议端点优先；未命中时业务 handler（registry 驱动）兜底
      response = await handlePortableApi([requirePortableHandler(), requireBusinessHandler()], request)
    } catch (error) {
      return { status: 500, body: JSON.stringify({ error: { code: 'internal_error', message: error instanceof Error ? error.message : String(error) } }) }
    }
    if (response.body instanceof Uint8Array) {
      return { status: response.status, body: new TextDecoder().decode(response.body) }
    }
    return { status: response.status, body: '' }
  }

  // ── W6：PluginLaunchPlan 消费与隔离回报（阶段 5；D2 管理层独立于 Core）──
  // Core 组合根接收主进程的不可变 PluginLaunchPlan（§2.4），校验 enabled 插件的 manifest
  // 身份（manifestHash），隔离失败记录；隔离结果经消息流（connection 消息）回报主进程，
  // 由 PluginManager 持久化。运行期不热替换（改配置 → 主进程重启 Core）。
  let appliedPlanHash = ''
  const applyLaunchPlan = (planJson: string): void => {
    try {
      const plan = JSON.parse(planJson) as { protocolVersion?: string; pluginSetHash?: string; plugins?: Array<{ id: string; version: string; manifestHash: string; enabled: boolean }> }
      if (!plan || plan.protocolVersion !== '1.1') {
        emit({ type: 'plugin-report', ok: false, error: 'launch plan 协议版本不匹配' })
        return
      }
      const quarantine: QuarantineRecord[] = []
      for (const plugin of plan.plugins ?? []) {
        if (!plugin.enabled) continue
        // 内置插件候选集的 manifest 校验（W3 深度校验唯一实现；此处只核对身份与清单形状）
        const candidate = BUILTIN_PLUGIN_MANIFESTS.find(manifest => manifest.id === plugin.id)
        if (!candidate) {
          quarantine.push({ pluginId: plugin.id, manifestVersion: plugin.version, manifestHash: plugin.manifestHash, reason: `插件不在 Android 构建候选集内：${plugin.id}`, stage: 'manifest', at: new Date().toISOString() })
          continue
        }
        const errors = validateManifest(candidate)
        if (errors.length > 0) {
          quarantine.push({ pluginId: plugin.id, manifestVersion: plugin.version, manifestHash: plugin.manifestHash, reason: `manifest 校验失败：${errors.join('；')}`, stage: 'manifest', at: new Date().toISOString() })
          continue
        }
        if (manifestHash(candidate) !== plugin.manifestHash) {
          quarantine.push({ pluginId: plugin.id, manifestVersion: plugin.version, manifestHash: plugin.manifestHash, reason: `manifest 哈希不匹配：构建 ${manifestHash(candidate)} ≠ plan ${plugin.manifestHash}`, stage: 'manifest', at: new Date().toISOString() })
          continue
        }
      }
      appliedPlanHash = plan.pluginSetHash ?? ''
      emit({ type: 'plugin-report', ok: true, pluginSetHash: appliedPlanHash, quarantine })
    } catch (error) {
      emit({ type: 'plugin-report', ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const localCore = Object.assign({
    bundleVersion: ANDROID_CORE_BUNDLE_VERSION,
    bridgeVersion: ANDROID_CORE_BRIDGE_VERSION,
    protocolVersion: CORE_PROTOCOL_VERSION,
    roomId: LOCAL_ROOM_ID,
    /** W6-1：原生端口同步调用（story/archive/preset/secret/billing；CoreBusinessHandler 用）。 */
    invokeSync: (operation: string, input: Json = {}): unknown => invokeSync(operation, input),
    start,
    stop: (): void => { composition?.stop(); sink = undefined },
    reconnect: (): void => composition?.start(),
    refresh: (): void => composition?.refresh(),
    dispatch: (commandJson: string): void => dispatch(commandJson),
    cancel: (requestId?: string): void => { void composition?.cancel(requestId).catch(() => {}) },
    dispose: (): void => { composition?.dispose(); composition = undefined; sink = undefined },
    /** W4 合流：协议端点分发（core-host-bridge 调用）。 */
    handlePortableRequest,
    /** W6：接受 PluginLaunchPlan 并回报隔离记录（主进程经桥下发）。 */
    applyLaunchPlan,
  }, facade)
  global.StageCraftLocalCore = Object.freeze(localCore)

  // 兼容既有 StageCraftEmbeddedCore 会话面（配对页 ?mode=local 迷你渲染器 / 旧调用方）
  global.StageCraftEmbeddedCore = Object.freeze({
    bundleVersion: ANDROID_CORE_BUNDLE_VERSION,
    bridgeVersion: ANDROID_CORE_BRIDGE_VERSION,
    protocolVersion: CORE_PROTOCOL_VERSION,
    start,
    stop: () => { composition?.stop(); sink = undefined },
    reconnect: () => composition?.start(),
    refresh: () => composition?.refresh(),
    dispatch,
    cancel: (requestId?: string) => { void composition?.cancel(requestId).catch(() => {}) },
    dispose: () => { composition?.dispose(); composition = undefined; sink = undefined },
  })

  function dispatch(commandJson: string): void {
    if (!composition) return
    try { void composition.dispatch(JSON.parse(commandJson) as HumanCommand).catch(error => emit({ type: 'connection.error', message: error instanceof Error ? error.message : String(error) })) }
    catch (error) { emit({ type: 'connection.error', message: error instanceof Error ? error.message : String(error) }) }
  }
}

const nativeAtLoad = typeof globalThis !== 'undefined' ? (globalThis as { StageCraftNative?: Record<string, unknown> }).StageCraftNative : undefined
// 仅当原生桥提供 invokeAsync 时安装本地核心；旧客户端（无异步桥）保留既有表面由 android-core.ts 提供。
if (nativeAtLoad && typeof nativeAtLoad.invokeAsync === 'function') installLocalCore()
