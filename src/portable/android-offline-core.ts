/**
 * Android 离线（WebView 内）组合根：在保留既有 StageCraftEmbeddedCore 会话面的同时，
 * 暴露 StageCraftOfflineCore —— 供打包的完整 Web UI（public/）离线复用。
 *
 * - 同一组共享服务（chat/director/management）与 CoreRuntimeSkeleton 在页面内运行；
 * - 模型生成走真实 workers（self-contained 提示词）→ Android 原生传输（凭据在 Java）；
 * - 富 API 门面与 PC 端 RoomRuntime 同名同参，local-runtime-web-entry.js 直接调用。
 */
import { CORE_PROTOCOL_VERSION, type CoreEvent, type CoreView, type HumanCommand, type ModelRequest, type ModelResult } from '../core/protocol.ts'
import { createAndroidComposition, type AndroidComposition } from './android-composition.ts'
import { createOfflineWorkers, type OfflineModelPort, type OfflineProviderConfig } from './offline-workers.ts'
import type { RoomSnapshot, RoomMode, WorldChangeRequest, ThinkingStrength, Role, LoreEntry, ConsultationMessage, Decision, Draft, PlayerCharacter } from '../types.ts'
import type { StoryPackage } from '../story-packages.ts'
import type { WorkerSet } from '../workers.ts'
import { setPromptStorage } from '../prompts.ts'
import { createAndroidPromptStorage } from './android-prompt-storage.ts'

export const ANDROID_CORE_BUNDLE_VERSION = '1.1.0'
export const ANDROID_CORE_BRIDGE_VERSION = '1'
export const PROVIDER_SECRET_KEY = 'offline.provider.default'
export const OFFLINE_ROOM_ID = 'android-local-room'

type Json = Record<string, unknown>
type ResultValue = Record<string, unknown>

const SYNC_OPERATIONS = new Set([
  'asset.read', 'asset.write', 'asset.remove',
  'secret.get', 'secret.set', 'secret.remove',
  'core-state.commit', 'core-state.restore',
  'stagecraft.room.get', 'stagecraft.repository', 'stories.list', 'story.read',
  'model.cancel',
])

/** WebView 入口：安装离线组合根与富 API 门面。 */
export function installOfflineCore(global: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  const native = (global.StageCraftNative ?? {}) as Record<string, unknown>
  if (global.StageCraftNative === undefined || typeof native.invokeSync !== 'function' || typeof native.invokeAsync !== 'function') {
    throw new Error('Android offline Core requires the native operations bridge (invokeSync + invokeAsync).')
  }
  const invokeSync = (operation: string, input: Json = {}): unknown => {
    const method = native.invokeSync as (name: string, value: string) => string
    const raw = method.call(native, operation, JSON.stringify(input))
    if (typeof raw !== 'string' || raw.length > 16 * 1024 * 1024) throw new Error('Android bridge response is invalid or too large.')
    const parsed = JSON.parse(raw) as unknown
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
  const pendingAsync = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; onThinking?: (text: string) => void }>()
  const invokeAsync = (operation: string, input: Json, hooks?: { onThinking?: (text: string) => void }): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      const callbackId = `offline-${Date.now().toString(36)}-${++asyncSequence}`
      pendingAsync.set(callbackId, { resolve, reject, onThinking: hooks?.onThinking })
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
        if (typeof result.thinkingDelta === 'string') {
          entry.onThinking?.(result.thinkingDelta)
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
  const readProvider = (): OfflineProviderConfig | undefined => {
    const raw = invokeSync('secret.get', { key: PROVIDER_SECRET_KEY }) as { found?: boolean; value?: string } | undefined
    if (!raw?.found || typeof raw.value !== 'string' || !raw.value) return undefined
    try {
      const parsed = JSON.parse(raw.value) as Partial<OfflineProviderConfig>
      if (parsed && typeof parsed.baseUrl === 'string' && typeof parsed.apiKey === 'string' && typeof parsed.model === 'string'
        && parsed.baseUrl.trim() && parsed.apiKey.trim() && parsed.model.trim()) {
        return { baseUrl: parsed.baseUrl.trim(), apiKey: parsed.apiKey.trim(), model: parsed.model.trim(), responseFormat: parsed.responseFormat === 'none' ? 'none' : 'json_object' }
      }
    } catch { /* 非法配置按未配置处理 */ }
    return undefined
  }
  const writeProvider = (config: OfflineProviderConfig): void => {
    invokeSync('secret.set', { key: PROVIDER_SECRET_KEY, value: JSON.stringify(config) })
  }

  const endpointFor = (base: string): string => {
    const normalized = base.trim().replace(/\/+$/, '')
    if (/\/chat\/completions$/i.test(normalized)) return normalized
    return `${normalized}/chat/completions`
  }

  const toOpenAiBody = (request: ModelRequest, config: OfflineProviderConfig): Json => {
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
    const config = readProvider()
    if (!config) return Promise.reject(new Error('未配置模型供应商：点击「连接」→ 管理供应商，新建供应商并填写接口地址、API Key 与模型名。'))
    return invokeAsync('model.request', { requestId: request.requestId, endpoint: endpointFor(config.baseUrl), apiKey: config.apiKey, ...toOpenAiBody(request, config) }, hooks).then(normalizeModelResult) as Promise<ModelResult>
  }

  /** Java 原生传输把模型正文以字符串返回；按契约解析为对象（json_object 响应）。 */
  const normalizeModelResult = (value: unknown): ModelResult => {
    const result = (value ?? {}) as ModelResult
    if (typeof result.output === 'string') {
      const text = result.output
      try { result.output = JSON.parse(text) } catch { throw new Error('模型返回不是有效的 JSON，请改用支持 json_object 的模型或检查接口地址/模型名。') }
      if (result.output === null || typeof result.output !== 'object') throw new Error(`模型返回内容不是 JSON 对象：${text.slice(0, 80)}`)
    }
    return result
  }

  const operations = {
    invoke<T = unknown>(operation: string, input: Json = {}): T | Promise<T> {
      if (operation === 'model.request') return modelRequest(input as unknown as ModelRequest) as Promise<T>
      if (SYNC_OPERATIONS.has(operation)) return Promise.resolve(invokeSync(operation, input) as T)
      return invokeAsync(operation, input) as Promise<T>
    },
    invokeSync<T = unknown>(operation: string, input: Json = {}): T {
      return invokeSync(operation, input) as T
    },
  }

  const port: OfflineModelPort = {
    request: (request, hooks) => modelRequest(request, hooks),
    cancel: (requestId?: string): Promise<void> => {
      try { invokeSync('model.cancel', { requestId: requestId ?? '' }) } catch { /* 忽略取消失败 */ }
      return Promise.resolve()
    },
  }
  const workers: WorkerSet = createOfflineWorkers(port, { directorThinkingStrength: undefined, roleThinkingStrength: undefined })

  // ── 组合与消息流 ──
  let sink: ((message: unknown) => void) | undefined
  let composition: AndroidComposition | undefined
  let coreListenerInstalled = false
  const emit = (message: unknown): void => sink?.(JSON.stringify(message))
  const start = (nextSink: (message: string) => void): void => {
    sink = nextSink
    composition ??= createAndroidComposition(operations, { roomId: OFFLINE_ROOM_ID, workers, onMessage: message => emit(message) })
    if (!coreListenerInstalled) {
      coreListenerInstalled = true
      composition.core.subscribe((event: CoreEvent) => emit({ type: 'core.event', event }))
    }
    composition.start()
  }
  const requireComposition = (): AndroidComposition => {
    if (!composition) throw new Error('离线核心未启动。')
    return composition
  }

  // ── 富 API 门面（与 PC 端 RoomRuntime 同名同参）──
  const facade: Record<string, unknown> = {
    getRoom: (): RoomSnapshot => requireComposition().getRoom(),
    getView: (): CoreView => requireComposition().core.getView(),
    dispatchCommand: (command: HumanCommand): Promise<void> => requireComposition().dispatch(command),
    cancel: (requestId?: string): Promise<void> => requireComposition().cancel(requestId),
    refresh: (): void => requireComposition().refresh(),
    getProvider: (): { configured: boolean } & Partial<OfflineProviderConfig> => {
      const config = readProvider()
      return config ? { configured: true, baseUrl: config.baseUrl, model: config.model } : { configured: false }
    },
    setProvider: (config: OfflineProviderConfig): void => {
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
      if (room.mode === 'chat') return core.chat.submitContribution(OFFLINE_ROOM_ID, input.text)
      return core.director.submitTurn(OFFLINE_ROOM_ID, input)
    },
    speak: (roleId: string, feedback = ''): Promise<void> => requireComposition().chat.speak(OFFLINE_ROOM_ID, roleId, feedback),
    speakAll: (): Promise<void> => requireComposition().chat.speakAll(OFFLINE_ROOM_ID),
    directorDecide: (): Promise<void> => requireComposition().chat.directorDecide(OFFLINE_ROOM_ID),
    rejectSpeech: (): Promise<void> => requireComposition().chat.rejectSpeech(OFFLINE_ROOM_ID),
    retrySpeak: (): Promise<void> => requireComposition().chat.retrySpeak(OFFLINE_ROOM_ID),
    approveSpeech: (text: string, worldChangeOverride?: WorldChangeRequest | null): Promise<void> => requireComposition().chat.approveSpeech(OFFLINE_ROOM_ID, text, worldChangeOverride ?? null),
    directorChat: (text: string): Promise<void> => requireComposition().chat.directorChat(OFFLINE_ROOM_ID, text),
    approveWorldChange: (override?: WorldChangeRequest | null): Promise<void> => requireComposition().chat.approveWorldChange(OFFLINE_ROOM_ID, override ?? null),
    rejectWorldChange: (): Promise<void> => requireComposition().chat.rejectWorldChange(OFFLINE_ROOM_ID),
    cancelTurn: (): void => {
      const core = requireComposition()
      if (core.getRoom().mode === 'chat') core.chat.cancel(OFFLINE_ROOM_ID)
      else core.director.cancel(OFFLINE_ROOM_ID)
    },
    proceedToDraft: (): Promise<void> => requireComposition().director.proceedToDraft(OFFLINE_ROOM_ID),
    rejectDraft: (): Promise<void> => requireComposition().director.rejectDraft(OFFLINE_ROOM_ID),
    retryDirector: (): Promise<void> => requireComposition().director.retryDirector(OFFLINE_ROOM_ID),
    reconsiderReaction: (roleId: string, feedback: string): Promise<void> => requireComposition().director.reconsiderReaction(OFFLINE_ROOM_ID, roleId, feedback),
    restart: (story: StoryPackage, options?: { mode?: RoomMode; autoPublish?: boolean }): void => requireComposition().management.restart(OFFLINE_ROOM_ID, story, options ?? {}),
    setRoomConfig: (config: { mode?: RoomMode; autoPublish?: boolean; speechMode?: string; hidePlayerSpeech?: boolean }): void => requireComposition().management.setRoomConfig(OFFLINE_ROOM_ID, config as never),
    updatePlayerCharacter: (player: PlayerCharacter): void => requireComposition().management.updatePlayerCharacter(OFFLINE_ROOM_ID, { name: player.name, persona: player.persona, currentState: player.currentState }),
    setPlayerAvatar: (portraitRef: string): void => requireComposition().management.setPlayerAvatar(OFFLINE_ROOM_ID, portraitRef),
    interveneRole: (roleId: string, selfModel: string, config: Json = {}): void => requireComposition().management.interveneRole(OFFLINE_ROOM_ID, roleId, selfModel, config),
    storeNpcMemories: (roleId: string, entries: Array<{ id?: string; text?: string; occurredAt?: string }>): void => requireComposition().management.storeNpcMemories(OFFLINE_ROOM_ID, roleId, entries),
    retractNpcMemory: (memoryId: string): void => requireComposition().management.retractNpcMemory(OFFLINE_ROOM_ID, memoryId),
    updateNpcMemory: (memoryId: string, entry: { text?: string; occurredAt?: string }): void => requireComposition().management.updateNpcMemory(OFFLINE_ROOM_ID, memoryId, entry),
    reorderNpcMemories: (roleId: string, memoryIds: string[]): void => requireComposition().management.reorderNpcMemories(OFFLINE_ROOM_ID, roleId, memoryIds),
    supersedeNpcMemory: (memoryId: string, entry: { text: string; occurredAt: string }): void => requireComposition().management.supersedeNpcMemory(OFFLINE_ROOM_ID, memoryId, entry),
    saveLore: (lore: LoreEntry[]): void => requireComposition().management.saveLore(OFFLINE_ROOM_ID, lore),
    createRole: (role: Parameters<import('../stagecraft-repository.ts').StageCraftRepository['createRole']>[1]): void => requireComposition().management.createRole(OFFLINE_ROOM_ID, role),
    deleteRole: (roleId: string): void => requireComposition().management.deleteRole(OFFLINE_ROOM_ID, roleId),
    setRolePresence: (roleId: string, presence: Role['presence']): void => requireComposition().management.setRolePresence(OFFLINE_ROOM_ID, roleId, presence),
    setRoleThinking: (roleId: string, thinkingStrength: ThinkingStrength): void => requireComposition().management.setRoleThinking(OFFLINE_ROOM_ID, roleId, thinkingStrength),
    reorderRoles: (roleIds: string[]): void => requireComposition().management.reorderRoles(OFFLINE_ROOM_ID, roleIds),
    setRoleAvatar: (roleId: string, portraitRef: string): void => requireComposition().management.setRoleAvatar(OFFLINE_ROOM_ID, roleId, portraitRef),
    setRoleCurrentState: (roleId: string, currentState: string): void => requireComposition().management.setRoleCurrentState(OFFLINE_ROOM_ID, roleId, currentState),
    setDirectorSetting: (text: string): void => requireComposition().management.setDirectorSetting(OFFLINE_ROOM_ID, text),
    updateScene: (updates: { time?: string; location?: string }): void => requireComposition().management.updateScene(OFFLINE_ROOM_ID, updates),
    consult: (draftId: string, playerText: string, context = ''): Promise<void> => requireComposition().director.consult(OFFLINE_ROOM_ID, draftId, playerText, context),
    finishConsultation: (): void => requireComposition().director.finishConsultation(OFFLINE_ROOM_ID),
    redraft: (draftId: string): Promise<void> => requireComposition().director.redraft(OFFLINE_ROOM_ID, draftId),
    approve: (draftId: string, text: string, stateUpdates: Record<string, string>, sceneUpdates?: { time?: string; location?: string }): void => requireComposition().director.approve(OFFLINE_ROOM_ID, draftId, text, stateUpdates, sceneUpdates),
  }

  const offlineCore = Object.assign({
    bundleVersion: ANDROID_CORE_BUNDLE_VERSION,
    bridgeVersion: ANDROID_CORE_BRIDGE_VERSION,
    protocolVersion: CORE_PROTOCOL_VERSION,
    roomId: OFFLINE_ROOM_ID,
    start,
    stop: (): void => { composition?.stop(); sink = undefined },
    reconnect: (): void => composition?.start(),
    refresh: (): void => composition?.refresh(),
    dispatch: (commandJson: string): void => dispatch(commandJson),
    cancel: (requestId?: string): void => { void composition?.cancel(requestId).catch(() => {}) },
    dispose: (): void => { composition?.dispose(); composition = undefined; sink = undefined },
  }, facade)
  global.StageCraftOfflineCore = Object.freeze(offlineCore)

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
// 仅当原生桥提供 invokeAsync 时安装离线核心；旧客户端（无异步桥）保留既有表面由 android-core.ts 提供。
if (nativeAtLoad && typeof nativeAtLoad.invokeAsync === 'function') installOfflineCore()