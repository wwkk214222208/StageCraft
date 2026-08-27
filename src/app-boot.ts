/**
 * StageCraft 应用启动器：把 Store + RoomRuntime + ModelGateway + node:http
 * 服务器组装成一个自包含应用，供两种宿主复用：
 *   - 独立入口 src/server.ts（npm run dev）
 *   - dsh-rp 插件壳（Cordis/dsh profile 里跑同一套应用，核心零改动）
 *
 * 本模块负责生产组合根：独立入口创建 Cordis Context，DSH 可传入宿主 Context。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.ts'
import { NodeSqliteRepository } from './platform/node-sqlite-repository.ts'
import { RoomRuntime } from './room-runtime.ts'
import { ModelGateway, createRealWorkers, reloadPrompts, routeFromEnvironment } from './model-gateway.ts'
import { createStoryPackage, listStoryPackages, loadStoryPackage, resolveStoryAssetFile, saveStoryAsPackage, saveStoryPackage, storyAssetsDir, storyPortraitUrl, type StoryPackage } from './story-packages.ts'
import { collectStoryArchiveEntries, createStoredZip } from './story-package-archive.ts'
import type { RoomSnapshot } from './types.ts'
import { ProviderConfigStore, type ProviderConfig } from './provider-config.ts'
import { PROMPT_PRESET_SCOPES, deletePromptPreset, getPromptPresetState, listIdeologyFiles, listPromptPresets, loadGameplayScenario, loadPrompts, removeIdeologyFile, renameIdeologyFile, saveIdeologyFile, setActiveIdeologyFile, setPromptPresetForScope, setPromptsFilePath, setUserPromptsDir, updatePromptPreset, loadPrivateToggles, savePrivateToggle, mergePrivateToggles, type PromptTemplates } from './prompts.ts'
import { importStCard } from './st-card-import.ts'
import { CreatorWorkbenchService } from './creator-workbench-service.ts'
import { CoreRuntimeSkeleton } from './core/runtime.ts'
import { ModelGatewayRouterAdapter } from './core/model-router-adapter.ts'
import { DefaultCorePluginContainer } from './core/container.ts'
import { HttpHumanCorePlugin } from './core/http-human-plugin.ts'
import { BillingStore } from './billing.ts'
import { StageCraftSolutionPlugin } from './core/solutions.ts'
import { StoreCoreStateRepository } from './core/store-state-repository.ts'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { coreRuntimeCordisPlugin, createStageCraftService, humanCordisPlugin, llmCordisPlugin, solutionCordisPlugin, stageCraftServicePlugin, stateRepositoryCordisPlugin } from './core/cordis-plugins.ts'
import { REMOTE_SESSION_COOKIE, RemoteAccessService, isLoopbackAddress, isLoopbackHost, type RemoteAccessOptions } from './remote-access.ts'
import { DshStorySessionService } from './dsh-story-session.ts'

/** 把 SillyTavern 预设 JSON 转成 StageCraft 预设（本地确定性转换，不调用模型）。 */
function convertSillyTavernPreset(source: string, message: string): { reply: string; preset: Record<string, unknown>; warnings: string[]; mapping: Array<Record<string, string>> } {
  let input: any
  try { input = JSON.parse(source) } catch { throw new Error('ST 预设不是有效 JSON。') }
  if (!input || typeof input !== 'object' || !Array.isArray(input.prompts)) throw new Error('未找到 ST 预设 prompts 数组。')
  const byId = new Map(input.prompts.map((item: any) => [String(item.identifier ?? item.id ?? ''), item]))
  const nativeIdentifiers = new Set(['main', 'nsfw', 'dialogueExamples', 'chatHistory', 'worldInfoBefore', 'worldInfoAfter', 'enhanceDefinitions', 'charDescription', 'charPersonality', 'scenario', 'personaDescription'])
  const promptOrders = Array.isArray(input.prompt_order) ? input.prompt_order.flatMap((group: any) => Array.isArray(group?.order) ? group.order : []) : []
  const orderedIds = promptOrders.length ? promptOrders.filter((item: any) => item?.enabled !== false).map((item: any) => String(item.identifier ?? '')) : input.prompts.map((item: any) => String(item.identifier ?? item.id ?? ''))
  const orderedUniqueIds = [...new Set(orderedIds.filter(id => byId.has(id)))]
  const allPromptIds = input.prompts.map((item: any) => String(item.identifier ?? item.id ?? '')).filter((id: string) => byId.has(id))
  const ids = [...orderedUniqueIds, ...allPromptIds.filter((id: string) => !orderedUniqueIds.includes(id))]
  const importedIds = ids.filter(id => !nativeIdentifiers.has(id))
  const skippedNative = ids.length - importedIds.length
  const nodes = importedIds.map((id, index) => { const item = byId.get(id); const role = item.role === 'user' ? 'user' : 'system'; return { id: `st-${id || index + 1}`, name: String(item.name ?? id ?? `ST 节点 ${index + 1}`), content: String(item.content ?? ''), type: role, enabled: item.enabled !== false, editable: true, removable: true } })
  const regexRules = Array.isArray(input.extensions?.regex_scripts) ? input.extensions.regex_scripts.map((rule: any, index: number) => ({ id: `st-regex-${index + 1}`, name: String(rule.scriptName ?? rule.name ?? `ST 正则 ${index + 1}`), pattern: String(rule.find ?? rule.regex ?? ''), replacement: String(rule.replace ?? rule.replacement ?? ''), enabled: rule.disabled !== true })) : []
  const preset: Record<string, unknown> = { id: `preset-${Date.now()}`, name: String(input.name ?? 'ST 导入预设'), enabled: false, modes: ['director', 'chat'], nodes, regexRules, scenarios: {} }
  const warnings = ['已使用本地确定性转换，未让模型重写 ST 预设内容。']
  const omittedPromptCount = input.prompts.filter((item: any) => !ids.includes(String(item.identifier ?? item.id ?? ''))).length
  if (omittedPromptCount > 0) warnings.push(`有 ${omittedPromptCount} 个 ST 节点未纳入导入。`)
  if (skippedNative > 0) warnings.push(`已识别并跳过 ${skippedNative} 个 ST 原生系统字段（按 identifier 字段判断）。`)
  if (input.squash_system_messages === true) warnings.push('ST 的 squash_system_messages 不直接转换；StageCraft 保留独立节点。')
  if (input.assistant_prefill || input.continue_prefill) warnings.push('ST 的 prefill/continue 行为不直接转换为提示词节点。')
  return { reply: `已转换《${String(input.name ?? 'ST 预设')}》：${nodes.length} 个提示词节点、${regexRules.length} 条正则规则。${message ? `请求：${message}` : ''}`, preset, warnings, mapping: nodes.map(node => ({ source: node.id.replace(/^st-/, ''), target: node.id })) }
}


/** Provider replacement transaction: preflight must run before tearing down the old route. */
export async function switchProviderSafely<T>(assertReady: () => void, disposeOld: () => Promise<void> | void, installNew: () => T): Promise<T> {
  assertReady()
  await disposeOld()
  return installNew()
}
/** 生产 LLM 路由的无秘密选择规则：请求显式 route 优先于角色覆盖。 */
export function resolveRouteProviderId(request: { route?: { providerId?: string } }, roleProviderId?: string, defaultProviderId?: string): string | undefined {
  return request.route?.providerId ?? roleProviderId ?? defaultProviderId
}

export function resolveRouteModel(request: { route?: { model?: string } }, roleModelOverride?: string, fallbackModel?: string): string | undefined {
  return request.route?.model ?? roleModelOverride ?? fallbackModel
}

export interface TavernOptions {
  /** Optional host Cordis context. DSH supplies this; standalone mode creates one. */
  ctx?: Context
  /** 仓库根目录（默认：本文件所在目录的上一级） */
  root?: string
  /** public/ 静态资源目录（默认 <root>/public） */
  publicRoot?: string
  /** stories/ 剧本目录（默认 <root>/stories） */
  storiesRoot?: string
  /** save/ 存档目录（默认 <root>/save） */
  saveRoot?: string
  /** data/ 数据目录（默认 <root>/data） */
  dataDir?: string
  /** prompts.json 路径（默认 <root>/prompts/prompts.json） */
  promptsFilePath?: string
  /**
   * 用户数据根目录（插件模式：AppData 下，卸载重装不丢数据）。
   * 提供时 save/data/prompts 落在 <userDataRoot> 下；stories 优先读
   * <userDataRoot>/stories，缺失时回退 <root>/stories 并拷贝默认剧本。
   * 未提供时维持 <root> 下的传统布局。
   */
  userDataRoot?: string
  /** 初始剧本 id（默认 'eldoria'） */
  storyId?: string
  /** 监听端口（默认 process.env.PORT ?? 8787；0 = 系统分配） */
  port?: number
  /** 监听主机（默认 process.env.HOST ?? '127.0.0.1'） */
  host?: string
  /** Development-only LAN transport; disabled by default and does not provide TLS. */
  remoteAccess?: RemoteAccessOptions | boolean
  /** 可插拔记忆数据源；缺省用 SQLite（npc_memories 表）。注入自定义实现即可替换记忆引擎。 */
  memoryStore?: import('./memory-store.ts').MemoryStore
}

export interface TavernApp {
  /** Cordis host context; never disposed when supplied by an external host. */
  readonly ctx: Context
  store: Store
  runtime: RoomRuntime
  core: CoreRuntimeSkeleton
  container: DefaultCorePluginContainer
  roomId: string
  gateway: ModelGateway | undefined
  billing: BillingStore
  providerStore: ProviderConfigStore
  server: Server
  /** Local operator API for pairing-code creation and session revocation. */
  remoteAccess: RemoteAccessService
  /** 关闭 HTTP 服务器（立即断开 SSE 等长连接）并关闭数据库 */
  close(): Promise<void>
}

export function parsePort(value: string | number | undefined, name = 'PORT'): number {
  const text = String(value ?? '')
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be an integer from 0 to 65535.`)
  const port = Number(text)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error(`${name} must be an integer from 0 to 65535.`)
  return port
}

export async function startTavern(options: TavernOptions = {}): Promise<TavernApp> {
  const ctx = options.ctx ?? new Context()
  // 独立启动（src/server.ts）无 DSH 宿主：剧本助手与提示词预设管理依赖 DSH 会话，独立模式关闭。
  const isStandalone = options.ctx === undefined
  const appFibers: Fiber[] = []
  const trackFiber = (fiber: Fiber): Fiber => { appFibers.push(fiber); return fiber }
  const untrackFiber = (fiber: Fiber): void => {
    const index = appFibers.lastIndexOf(fiber)
    if (index >= 0) appFibers.splice(index, 1)
  }
  const root = options.root ?? fileURLToPath(new URL('..', import.meta.url))
  const publicRoot = options.publicRoot ?? join(root, 'public')
  const userDataRoot = options.userDataRoot
  // 用户可写资产目录（头像等上传内容）：userDataRoot/public/assets，不随构建产物清空；
  // 无 userDataRoot（独立模式）时回退到 publicRoot/assets（与旧行为一致）。
  const userPublicRoot = userDataRoot ? join(userDataRoot, 'public') : undefined
  if (userPublicRoot) mkdirSync(join(userPublicRoot, 'assets'), { recursive: true })
  const storiesRoot = userDataRoot ? join(userDataRoot, 'stories') : options.storiesRoot ?? join(root, 'stories')
  // 剧本检索/加载的附加源：userDataRoot 模式下 bundle 默认剧本作兜底（AppData 是主源）
  const bundleStoriesDirs: string[] = userDataRoot ? [join(root, 'stories')] : []
  const saveRoot = userDataRoot ? join(userDataRoot, 'save') : options.saveRoot ?? join(root, 'save')
  const dataDir = userDataRoot ? join(userDataRoot, 'data') : options.dataDir ?? join(root, 'data')
  const billing = new BillingStore(join(dataDir, 'billing-prices.json'), join(dataDir, 'billing-stats.json'))
  // 提示词模板始终来自包内（只读发布资源）；用户自定义提示词（custom）落在 userDataRoot。
  const promptsFilePath = options.promptsFilePath ?? join(root, 'prompts', 'prompts.json')
  const host = options.host ?? process.env.HOST ?? '127.0.0.1'
  const port = options.port === undefined ? parsePort(process.env.PORT ?? '8787') : parsePort(options.port)
  const remoteAccess = new RemoteAccessService({
    ...(typeof options.remoteAccess === 'boolean' ? { enabled: options.remoteAccess } : (options.remoteAccess ?? {})),
    ...(userDataRoot ? { persistencePath: join(dataDir, 'remote-sessions.json') } : {}),
  })
  if (!isLoopbackHost(host) && !remoteAccess.enabled) throw new Error('Non-loopback listening requires remote access to be explicitly enabled.')
  mkdirSync(saveRoot, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  // userDataRoot 模式：把包内默认剧本/供应商模板拷贝到用户数据目录（首次启动）。
  // 提示词模板留在包内只读；用户自定义提示词目录（custom）放 AppData。
  if (userDataRoot) {
    mkdirSync(storiesRoot, { recursive: true })
    mkdirSync(join(userDataRoot, 'prompts'), { recursive: true })
    setUserPromptsDir(join(userDataRoot, 'prompts', 'custom'))
    const copyIfMissing = (from: string, to: string): void => {
      if (existsSync(to) || !existsSync(from)) return
      copyFileSync(from, to)
      console.log(`已初始化用户数据：${to}`)
    }
    // 默认剧本目录（stories/default/，含示范资产目录）：整体镜像到用户数据，之后由用户数据优先
    const bundleDefaultStories = join(root, 'stories', 'default')
    if (existsSync(bundleDefaultStories) && !existsSync(join(storiesRoot, 'default'))) {
      cpSync(bundleDefaultStories, join(storiesRoot, 'default'), { recursive: true })
      console.log(`已初始化用户数据：${join(storiesRoot, 'default')}`)
    }
    for (const entry of readdirSync(join(root, 'stories'), { withFileTypes: true })) {
      if (entry.name === 'default') continue
      const from = join(root, 'stories', entry.name)
      const to = join(storiesRoot, entry.name)
      if (entry.isDirectory()) {
        if (!existsSync(to)) { cpSync(from, to, { recursive: true }); console.log(`已初始化用户数据：${to}`) }
      } else {
        copyIfMissing(from, to)
      }
    }
    copyIfMissing(join(root, 'providers.example.json'), join(dataDir, 'providers.example.json'))
  }

    // 更名迁移：旧库 character-tavern.sqlite → stagecraft.sqlite（保留数据）
  const legacyDb = join(dataDir, 'character-tavern.sqlite')
  const dbPath = join(dataDir, 'stagecraft.sqlite')
  if (!existsSync(dbPath) && existsSync(legacyDb)) {
    for (const suffix of ['', '-wal', '-shm']) {
      const from = `${legacyDb}${suffix}`
      if (existsSync(from)) renameSync(from, `${dbPath}${suffix}`)
    }
    console.log('检测到旧数据库，已迁移到 stagecraft.sqlite。')
  }
  const store = new NodeSqliteRepository(dbPath, options.memoryStore ? { memoryStore: options.memoryStore } : {})
  // 提示词文件路径（AppData 等）注入模块级单例，ModelGateway 装配前必须设置。
  setPromptsFilePath(promptsFilePath)

  const debugListeners = new Set<(text: string) => void>()
  const debugLog = join(dataDir, 'server.log')
  function emitDebug(text: string): void {
    const line = `[${new Date().toISOString()}] ${text}`
    appendFileSync(debugLog, `${line}\n`, 'utf8')
    console.log(line)
    for (const listener of debugListeners) listener(text)
  }

  // 配置文件（data/providers.json）不进仓库；不存在时用 providers.example.json 生成默认
  let providerStore: ProviderConfigStore
  let envRoute: ReturnType<typeof routeFromEnvironment>
  try {
    const providerFilePath = join(dataDir, 'providers.json')
    providerStore = new ProviderConfigStore(providerFilePath)
    envRoute = routeFromEnvironment()
    if (providerStore.list().length === 0 && envRoute.apiKey) providerStore.save({ id: 'environment', name: '环境变量', baseUrl: envRoute.baseUrl, apiKey: envRoute.apiKey, models: [envRoute.model], selectedModel: envRoute.model, responseFormat: envRoute.responseFormat })
  } catch (error) {
    try { store.close() } catch { /* preserve the startup error */ }
    throw error
  }

  let roomId: string
  try {
    // 无有效模型配置（无 provider 或全部缺 apiKey）时默认群聊模式（chat，无导演），
    // 避免导演模式在模拟网关下不可用；有真实配置时保持导演模式。
    const hasRealProvider = providerStore.list().some(config => Boolean(config.apiKey) && !/在这里填写|你的_API_Key|你的_Key/i.test(config.apiKey))
    const defaultMode = hasRealProvider ? 'director' as const : 'chat' as const
    roomId = store.seed(loadStoryPackage(storiesRoot, options.storyId ?? 'eldoria', bundleStoriesDirs), { mode: defaultMode })
    store.recoverInterruptedRooms()
  } catch (error) {
    try { store.close() } catch { /* preserve the startup error */ }
    throw error
  }

  let gateway: ModelGateway | undefined
  let llmFiber: Fiber | undefined
  let providerActivation = Promise.resolve()
  function gatewayFromProvider(config: ProviderConfig, model: string): ModelGateway {
    return new ModelGateway({ name: config.name, baseUrl: config.baseUrl, apiKey: config.apiKey, model, timeoutMs: envRoute.timeoutMs, responseFormat: config.responseFormat, toolCalling: config.toolCalling !== false }, { onSummary: emitDebug, onDetail: emitDebug, logRawFinalContent: process.env.RP_LOG_MODEL_FINAL_CONTENT === '1', onUsage: (usage, route) => { const cost = billing.record(route.name ?? 'default', route.model, usage); return cost ? { ...usage, cost } : usage } })
  }
  async function installProvider(config: ProviderConfig | undefined): Promise<void> {
    // 占位符 apiKey（示例模板）视为未配置，避免用假密钥发起真实模型请求。
    if (!config?.apiKey || /在这里填写|你的_API_Key|你的_Key/i.test(config.apiKey)) { gateway = undefined; return }
    const defaults = providerStore.defaults()
    const directorModel = defaults.directorModel ?? config.selectedModel ?? config.models[0] ?? envRoute.model
    const nextGateway = gatewayFromProvider(config, directorModel)
    const adapter = new ModelGatewayRouterAdapter(nextGateway, request => {
      const roleId = request.route?.role
      if (!roleId) return nextGateway
      const role = runtime.get(roomId).roles.find(item => item.id === roleId)
      const selectedProviderId = resolveRouteProviderId(request, role?.providerId, providerStore.getDefaultRole()?.id)
      const selectedProvider = selectedProviderId ? providerStore.get(selectedProviderId) : providerStore.getDefaultRole()
      if (!selectedProvider?.apiKey) return nextGateway
      const defaultsForRole = providerStore.defaults()
      const fallbackModel = selectedProvider.id === providerStore.getDefaultRole()?.id ? defaultsForRole.defaultRoleModel : undefined
      return gatewayFromProvider(selectedProvider, resolveRouteModel(request, role?.modelOverride, fallbackModel ?? selectedProvider.selectedModel ?? selectedProvider.models[0] ?? envRoute.model)!)
    })
    const fiber = ctx.plugin(llmCordisPlugin(adapter))
    await fiber
    llmFiber = fiber
    try {
      runtime.setWorkers(createRealWorkers(nextGateway, role => {
        const defaults = providerStore.defaults()
        const fallbackProvider = providerStore.getDefaultRole()
        const selectedProvider = role.providerId ? providerStore.get(role.providerId) : fallbackProvider
        if (!selectedProvider?.apiKey) return nextGateway
        const fallbackModel = selectedProvider.id === fallbackProvider?.id ? defaults.defaultRoleModel : undefined
        return gatewayFromProvider(selectedProvider, role.modelOverride ?? fallbackModel ?? selectedProvider.selectedModel ?? selectedProvider.models[0] ?? envRoute.model)
      }, { directorThinkingStrength: providerStore.directorThinking(), directorProviderId: config.id, directorModel, requestModel: request => core.requestModel(request), cancelModel: requestId => core.cancel(requestId) }))
    } catch (error) {
      untrackFiber(fiber)
      llmFiber = undefined
      await fiber.dispose()
      throw error
    }
    gateway = nextGateway
    trackFiber(fiber)
  }
  function activateProvider(config = providerStore.getDirector()): Promise<void> {
    if (closed) return Promise.reject(new Error('Tavern app is closed.'))
    const activation = providerActivation.then(async () => {
      await switchProviderSafely(
        () => runtime.assertWorkersSwitchAllowed(),
        async () => {
          const previous = llmFiber
          llmFiber = undefined
          if (previous) {
            untrackFiber(previous)
            await previous.dispose()
          }
        },
        async () => { await installProvider(config) },
      )
    })
    providerActivation = activation.catch(() => undefined)
    return activation
  }
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const humanCore = new HttpHumanCorePlugin()
  const runtime = new RoomRuntime(store, undefined, core)
  const creatorWorkbench = new CreatorWorkbenchService({ read: () => loadStoryPackage(storiesRoot, options.storyId ?? 'eldoria', bundleStoriesDirs), write: (next, previous) => { if (JSON.stringify(loadStoryPackage(storiesRoot, next.id, bundleStoriesDirs)) !== JSON.stringify(previous)) throw new Error('Creator preview conflict: StoryPackage changed since preview.'); saveStoryPackage(storiesRoot, next) } }, roomId)
  const stagecraft = createStageCraftService(core, roomId, container, repository => core.attachStateRepository(repository))
  const nativeSessions = ctx.get('sessions', false) as any
  const dshStorySessions = new DshStorySessionService(id => loadStoryPackage(storiesRoot, id, bundleStoriesDirs), nativeSessions, () => ctx.get('apiProxy', false) as any, storiesRoot)
  const systemPrompt = ctx.get('systemPrompt', false) as { section?: (section: { name: string; order: number; text: string | ((context: { agent?: { id?: string } }) => string) }) => void } | undefined
  if (systemPrompt?.section) {
    try {
      systemPrompt.section({
        name: 'stagecraft:story-context',
        order: 150,
        text: assemble => {
          const agentId = assemble.agent?.id ?? ''
          if (!agentId.startsWith('creator-')) return ''
          return dshStorySessions.storyContext(agentId)
        },
      })
    } catch { /* 系统提示服务不可用时，剧本上下文回退为用户消息内联 */ }
  }
  const solution = new StageCraftSolutionPlugin({ chat: runtime.getChatService(), director: runtime.getDirectorService(), management: runtime.getManagementService(), defaultRoomId: roomId })
  async function compensateStartFailure(): Promise<void> {
    for (const fiber of [...appFibers].reverse()) {
      try { await fiber.dispose() } catch { /* preserve the startup error */ }
    }
    appFibers.length = 0
    try { creatorWorkbench.dispose() } catch { /* preserve the startup error */ }
    try { runtime.dispose() } catch { /* preserve the startup error */ }
    try { await container.dispose() } catch { /* preserve the startup error */ }
    try { store.close() } catch { /* preserve the startup error */ }
  }
  try {
    const serviceFiber = ctx.plugin(stageCraftServicePlugin(stagecraft))
    await serviceFiber
    trackFiber(serviceFiber)
    for (const plugin of [
      coreRuntimeCordisPlugin(),
      stateRepositoryCordisPlugin(new StoreCoreStateRepository(store)),
      humanCordisPlugin(humanCore),
      solutionCordisPlugin(solution),
    ]) {
      const fiber = ctx.plugin(plugin)
      await fiber
      trackFiber(fiber)
    }
  } catch (error) {
    await compensateStartFailure()
    throw error
  }
  try {
    const restoredCoreState = core.restoreState(roomId)
    const initialRoom = runtime.get(roomId)
    // 即使是恢复后的相同 revision 也提交一次：事件 INSERT OR IGNORE 保证幂等，
    // 同时让内存投影与 Repository 的 snapshot/event 保持一致。
    core.projectRoom(initialRoom, restoredCoreState ? 'app-boot:restore' : 'app-boot:init')
    // 首次启动没有旧路由可等待，保持旧行为：startTavern 返回前同步装配 gateway/workers。
    if (providerStore.getDirector()?.apiKey) await installProvider(providerStore.getDirector())
  } catch (error) {
    await compensateStartFailure()
    throw error
  }

  let managementCommandSequence = 0
  async function dispatchManagement(operation: string, payload: Record<string, unknown> = {}): Promise<void> {
    await core.dispatch({ id: `management-${++managementCommandSequence}`, actor: 'operator', type: 'role-management', payload: { roomId, operation, ...payload } })
  }
  async function dispatchRestart(story: StoryPackage, options: { mode?: import('./types.ts').RoomMode; autoPublish?: boolean } = {}): Promise<void> {
    await core.dispatch({ id: `management-restart-${++managementCommandSequence}`, actor: 'operator', type: 'restart', payload: { roomId, story, ...options } })
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    try {
      if (await remoteAccess.handlePairing(request, response, url)) return
      const protectedPath = ['/api', '/assets', '/custom', '/story-assets'].some(prefix => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
      const requiresAuthorization = protectedPath && (remoteAccess.authenticateLoopback || !isLoopbackAddress(request.socket.remoteAddress))
      if (requiresAuthorization && !remoteAccess.authorizeRequest(request)) return json(response, 401, { error: 'Unauthorized' })
      // 会话吊销：带 token（Bearer 或远程会话 Cookie）= 该会话自注销；本机（loopback）无 token 调用 = 清空所有已配对会话。
      if (url.pathname === '/api/remote/revoke' && request.method === 'POST') {
        const token = remoteAccess.sessionToken(request)
        if (token) remoteAccess.revokeSession(token)
        else remoteAccess.revokeAllSessions()
        response.setHeader('Set-Cookie', `${REMOTE_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/room') return json(response, 200, publicRoomSnapshot(runtime.get(url.searchParams.get('id') ?? roomId)))
      
      // 新架构：Core Runtime 协议端点由 HumanCoreInteractionPlugin 处理。
      if (await humanCore.handle(request, response, url)) return

      // Authenticated private-device synchronization. API keys are intentionally
      // included here because this endpoint is reachable only with a paired token.
      if (url.pathname === '/api/remote/sync' && request.method === 'GET') {
        const saves = listSaves().flatMap(name => {
          try { return [{ name, archive: JSON.parse(readFileSync(join(saveRoot, `${name}.json`), 'utf8')) }] } catch { return [] }
        })
        const stories = listStoryPackages(storiesRoot, bundleStoriesDirs).map(item => {
          try { return loadStoryPackage(storiesRoot, item.id, bundleStoriesDirs) } catch { return item }
        })
        return json(response, 200, {
          version: 1,
          generatedAt: new Date().toISOString(),
          room: runtime.exportArchive(roomId),
          saves,
          stories,
          providers: providerStore.exportPrivate(),
          prompts: { presets: getPromptPresetState(promptsFilePath), privateToggles: loadPrivateToggles(promptsFilePath) },
        })
      }
      if (url.pathname === '/api/remote/sync' && request.method === 'PUT') {
        const body = await readJson(request)
        if (body.version !== 1) throw new Error('不支持的同步数据版本。')
        if (body.providers && typeof body.providers === 'object') {
          providerStore.importPrivate(body.providers as any)
          await activateProvider(providerStore.getDirector())
        }
        if (body.room && typeof body.room === 'object') await dispatchManagement('import-archive', { archive: body.room })
        if (Array.isArray(body.saves)) for (const item of body.saves) {
          const name = String(item?.name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim()
          if (name && item?.archive && typeof item.archive === 'object') writeFileSync(join(saveRoot, `${name}.json`), `${JSON.stringify(item.archive, null, 2)}\n`, 'utf8')
        }
        if (Array.isArray(body.stories)) for (const story of body.stories) if (story && typeof story === 'object' && String((story as any).id ?? '').trim()) saveStoryPackage(storiesRoot, story as StoryPackage)
        const prompts = body.prompts && typeof body.prompts === 'object' ? body.prompts as any : undefined
        if (prompts?.privateToggles && typeof prompts.privateToggles === 'object') {
          for (const [presetId, nodes] of Object.entries(prompts.privateToggles)) for (const [nodeId, enabled] of Object.entries(nodes as any)) savePrivateToggle(promptsFilePath, presetId, nodeId, enabled === true)
        }
        const presetSource = prompts?.presets
        if (presetSource && typeof presetSource === 'object') {
          const presets = Array.isArray(presetSource) ? presetSource : (Array.isArray((presetSource as any).presets) ? (presetSource as any).presets : [])
          for (const preset of presets) if (preset && typeof preset === 'object' && String((preset as any).id ?? '').trim()) updatePromptPreset(preset as any, promptsFilePath)
        }
        return json(response, 200, { ok: true, files: listSaves() })
      }
      
      if (url.pathname === '/api/archive/export' && request.method === 'GET') {
        const body = Buffer.from(`${JSON.stringify(runtime.exportArchive(roomId), null, 2)}\n`, 'utf8')
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${encodeURIComponent(roomId)}.json"`, 'Content-Length': body.length, 'Cache-Control': 'no-store' })
        response.end(body)
        return
      }
      if (url.pathname === '/api/archive/import' && request.method === 'POST') { await dispatchManagement('import-archive', { archive: await readJson(request) }); return json(response, 200, { ok: true }) }
      if (url.pathname === '/api/archive/save' && request.method === 'POST') {
        const body = await readJson(request)
        let name = String(body.name ?? '').trim()
        if (!name) {
          // 默认命名：剧本名-游玩模式-编号（同前缀存档序号递增，避免覆盖）
          const current = runtime.get(roomId)
          const title = ((current?.title ?? '').trim() || current?.storyId || '剧本')
          const mode = current?.mode === 'chat' ? '群聊' : '导演'
          const base = `${title}-${mode}-`
          const samePrefix = listSaves().filter(file => file.startsWith(base)).length
          name = `${base}${String(samePrefix + 1).padStart(2, '0')}`
        }
        name = name.replace(/[\\/:*?"<>|]/g, '_').trim() || `存档-${Date.now()}`
        const archive = runtime.exportArchive(roomId)
        writeFileSync(join(saveRoot, `${name}.json`), `${JSON.stringify(archive, null, 2)}\n`, 'utf8')
        return json(response, 200, { ok: true, name, files: listSaves() })
      }
      if (url.pathname === '/api/archive/list' && request.method === 'GET') return json(response, 200, { files: listSaves() })
      if (url.pathname === '/api/archive/load' && request.method === 'POST') {
        const body = await readJson(request)
        const file = String(body.name ?? '').replace(/[\\/:*?"<>|]/g, '_')
        const path = join(saveRoot, `${file}.json`)
        if (!file || !existsSync(path)) throw new Error('存档不存在。')
        await dispatchManagement('import-archive', { archive: JSON.parse(readFileSync(path, 'utf8')) })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/archive/delete' && request.method === 'POST') {
        const body = await readJson(request)
        const file = String(body.name ?? '').replace(/[\\/:*?"<>|]/g, '_')
        const path = join(saveRoot, `${file}.json`)
        if (!file || !existsSync(path)) throw new Error('存档不存在。')
        rmSync(path)
        return json(response, 200, { ok: true, files: listSaves() })
      }
      // ── 状态回滚 / 分支（点击正文记录触发）──
      if (url.pathname === '/api/state/scene-revision' && request.method === 'POST') {
        const body = await readJson(request)
        const revision = store.sceneRevisionOf(roomId, String(body.sceneId ?? ''))
        if (revision === undefined) throw new Error('正文记录不存在。')
        return json(response, 200, { ok: true, revision, current: store.currentRevision(roomId) })
      }
      if (url.pathname === '/api/state/rollback' && request.method === 'POST') {
        const body = await readJson(request)
        const revision = typeof body.revision === 'number' ? body.revision : store.sceneRevisionOf(roomId, String(body.sceneId ?? ''))
        if (typeof revision !== 'number') throw new Error('回滚点无效。')
        if (runtime.get(roomId).phase !== 'awaiting-player-input') throw new Error('回合进行中无法回滚；请先取消当前回合。')
        // 通过 Core 事件流重置（仅审计）；业务数据直接按 revision 截断
        store.rollbackToRevision(roomId, revision)
        core.projectRoom(runtime.get(roomId)!, 'rollback')
        return json(response, 200, { ok: true, revision })
      }
      if (url.pathname === '/api/state/branch' && request.method === 'POST') {
        const body = await readJson(request)
        const revision = typeof body.revision === 'number' ? body.revision : store.sceneRevisionOf(roomId, String(body.sceneId ?? ''))
        if (typeof revision !== 'number') throw new Error('分支点无效。')
        if (runtime.get(roomId).phase !== 'awaiting-player-input') throw new Error('回合进行中无法分支；请先取消当前回合。')
        // 1) 先存档当前状态（分支存档）
        const archive = runtime.exportArchive(roomId)
        const name = `分支-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
        writeFileSync(join(saveRoot, `${name}.json`), `${JSON.stringify(archive, null, 2)}\n`, 'utf8')
        // 2) 再回滚
        store.rollbackToRevision(roomId, revision)
        core.projectRoom(runtime.get(roomId)!, 'branch')
        return json(response, 200, { ok: true, revision, branch: name, files: listSaves() })
      }
      if (url.pathname === '/api/story/get' && request.method === 'GET') return json(response, 200, loadStoryPackage(storiesRoot, String(url.searchParams.get('id') ?? ''), bundleStoriesDirs))
      if (url.pathname === '/api/story/import' && request.method === 'POST') {
        const data = await readBody(request, 64 * 1024 * 1024)
        const id = `story-${Date.now()}`
        const story = (await import('./story-package-archive.ts')).importStoryArchive(data, storiesRoot, id)
        return json(response, 200, { ok: true, id: story.id, title: story.title })
      }
      if (url.pathname === '/api/story/export' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') ?? '').trim()
        if (!id) throw new Error('缺少剧本 id。')
        const story = loadStoryPackage(storiesRoot, id, bundleStoriesDirs)
        const archive = createStoredZip(collectStoryArchiveEntries(story, storyAssetsDir(storiesRoot, id, bundleStoriesDirs)))
        response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${encodeURIComponent(story.title || id)}.zip"`, 'Content-Length': archive.length, 'Cache-Control': 'no-store' })
        response.end(archive)
        return
      }
      if (isStandalone && url.pathname.startsWith('/api/agent/') && url.pathname !== '/api/agent/capability') return json(response, 503, { error: '独立模式未启用 DSH 会话功能（剧本助手 / 预设助手）。' })
      if (url.pathname === '/api/agent/capability' && request.method === 'GET') return json(response, 200, dshStorySessions.capability())
      if (url.pathname === '/api/agent/session' && request.method === 'GET') {
        return json(response, 200, await dshStorySessions.list(String(url.searchParams.get('owner') ?? ''), url.searchParams.get('storyId') ?? undefined))
      }
      if (url.pathname === '/api/agent/session' && request.method === 'POST') {
        const body = await readJson(request); return json(response, 200, await dshStorySessions.open(String(body.owner ?? ''), String(body.storyId ?? options.storyId ?? 'eldoria')))
      }
      if (url.pathname === '/api/agent/session' && request.method === 'DELETE') {
        const body = await readJson(request); dshStorySessions.close(String(body.owner ?? ''), String(body.sessionId ?? '')); return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/agent/archive' && request.method === 'POST') {
        const body = await readJson(request); await dshStorySessions.archive(String(body.owner ?? ''), String(body.sessionId ?? '')); return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/agent/history' && request.method === 'POST') {
        const body = await readJson(request); return json(response, 200, await dshStorySessions.history(String(body.owner ?? ''), String(body.sessionId ?? '')))
      }
      if (url.pathname === '/api/agent/models' && request.method === 'POST') {
        const body = await readJson(request); return json(response, 200, await dshStorySessions.models(String(body.owner ?? ''), String(body.sessionId ?? '')))
      }
      if (url.pathname === '/api/agent/model' && request.method === 'POST') {
        const body = await readJson(request); return json(response, 200, await dshStorySessions.selectModel(String(body.owner ?? ''), String(body.sessionId ?? ''), { provider: String(body.provider ?? ''), model: String(body.model ?? ''), ...(body.reasoningEffort ? { reasoningEffort: String(body.reasoningEffort) } : {}) }))
      }
      if (url.pathname === '/api/agent/message' && request.method === 'POST') {
        const body = await readJson(request); return json(response, 200, await dshStorySessions.prompt(String(body.owner ?? ''), String(body.sessionId ?? ''), String(body.text ?? body.request ?? ''), String(body.storyId ?? '')))
      }
      if (url.pathname === '/api/creator/preview' && request.method === 'POST') {
        const body = await readJson(request)
        const kind = String(body.kind ?? 'text') as import('./creator-contracts.ts').CreatorSourceKind
        const preview = await creatorWorkbench.preview({ kind, name: body.name ? String(body.name) : undefined, content: String(body.content ?? ''), contentType: body.contentType ? String(body.contentType) : undefined })
        return json(response, 200, preview)
      }
      if (url.pathname === '/api/creator/apply' && request.method === 'POST') {
        const body = await readJson(request)
        return json(response, 200, creatorWorkbench.apply(body))
      }
      if (url.pathname === '/api/creator/revert' && request.method === 'POST') {
        const body = await readJson(request)
        return json(response, 200, { ok: true, story: creatorWorkbench.revert(String(body.previewId ?? '')) })
      }
      if (url.pathname === '/api/story/save' && request.method === 'POST') {
        const body = await readJson(request)
        const story = body.story as StoryPackage
        if (!story?.id) throw new Error('剧本缺少 id。')
        saveStoryPackage(storiesRoot, story)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/story/save-as' && request.method === 'POST') {
        const body = await readJson(request)
        const source = body.story as StoryPackage
        if (!source?.id) throw new Error('剧本缺少内容。')
        const saved = saveStoryAsPackage(storiesRoot, source, String(body.id ?? '').trim() || `story-${Date.now()}`, body.title ? String(body.title) : undefined)
        return json(response, 200, { ok: true, id: saved.id, title: saved.title })
      }
      if (url.pathname === '/api/stories' && request.method === 'GET') return json(response, 200, listStoryPackages(storiesRoot, bundleStoriesDirs))
      if (url.pathname === '/api/stories' && request.method === 'POST') {
        const body = await readJson(request)
        const story = createStoryPackage(storiesRoot, { title: body.title ? String(body.title) : undefined, ...(body.opening ? { opening: String(body.opening) } : {}), ...(body.sceneTime ? { sceneTime: String(body.sceneTime) } : {}), ...(body.sceneLocation ? { sceneLocation: String(body.sceneLocation) } : {}) })
        return json(response, 200, { ok: true, id: story.id, title: story.title })
      }
      if (url.pathname === '/api/stories' && request.method === 'DELETE') {
        const id = String(url.searchParams.get('id') ?? '')
        if (!id) throw new Error('缺少剧本 id。')
        const target = join(storiesRoot, 'custom', `${id}.json`)
        if (!existsSync(target)) throw new Error('默认或外部剧本不可删除，仅可删除玩家自建剧本（AppData/custom）。')
        rmSync(target)
        const assetsDir = join(storiesRoot, 'custom', `${id}.assets`)
        if (existsSync(assetsDir)) rmSync(assetsDir, { recursive: true, force: true })
        return json(response, 200, { ok: true, id })
      }
      if (url.pathname === '/api/providers' && request.method === 'GET') return json(response, 200, { providers: providerStore.list(), defaults: providerStore.defaults() })
      if (url.pathname === '/api/providers/save' && request.method === 'POST') {
        const body = await readJson(request)
        const existing = providerStore.get(String(body.id ?? ''))
        const config: ProviderConfig = { id: String(body.id), name: String(body.name), baseUrl: String(body.baseUrl).replace(/\/$/, ''), apiKey: String(body.apiKey ?? '') || existing?.apiKey || '', models: Array.isArray(body.models) ? body.models.map(String) : existing?.models ?? [], selectedModel: body.selectedModel ? String(body.selectedModel) : existing?.selectedModel, responseFormat: body.responseFormat === 'json_schema' ? 'json_schema' : body.responseFormat === 'none' ? 'none' : 'json_object', toolCalling: body.toolCalling !== false }
        providerStore.save(config)
        await activateProvider(config)
        return json(response, 200, { providers: providerStore.list(), defaults: providerStore.defaults(), active: gateway?.usage() ?? { route: '模拟', model: '模拟' } })
      }
      if (url.pathname === '/api/providers/delete' && request.method === 'POST') {
        const body = await readJson(request)
        const removed = providerStore.remove(String(body.id ?? ''))
        if (!removed) throw new Error('Provider 配置不存在。')
        await activateProvider()
        return json(response, 200, { providers: providerStore.list(), defaults: providerStore.defaults(), active: gateway?.usage() ?? { route: '模拟', model: '模拟' } })
      }
      if (url.pathname === '/api/providers/discover' && request.method === 'POST') {
        const body = await readJson(request)
        return json(response, 200, await providerStore.discoverModels(String(body.id)))
      }
      if (url.pathname === '/api/providers/default-role' && request.method === 'POST') {
        const body = await readJson(request)
        providerStore.setDefaultRole(String(body.id), body.model ? String(body.model) : undefined)
        await activateProvider()
        return json(response, 200, { providers: providerStore.list(), defaults: providerStore.defaults() })
      }
      if (url.pathname === '/api/providers/director' && request.method === 'POST') {
        const body = await readJson(request)
        providerStore.setDirector(String(body.id), body.model ? String(body.model) : undefined)
        await activateProvider()
        return json(response, 200, { providers: providerStore.list(), defaults: providerStore.defaults() })
      }
      if (url.pathname === '/api/providers/director-thinking' && request.method === 'POST') {
        const body = await readJson(request)
        const thinking = String(body.thinking ?? '') as import('./types.ts').ThinkingStrength
        providerStore.setDirectorThinking(thinking)
        await activateProvider()
        return json(response, 200, { ok: true, defaults: providerStore.defaults() })
      }
      if (url.pathname === '/api/usage') { const usage = gateway?.usage(true) ?? { route: '模拟', model: '模拟', requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalDurationMs: 0, avgDurationMs: 0, mode: 'fake' }; return json(response, 200, { ...usage, billing: billing.getStats() }) }
      if (url.pathname === '/api/billing' && request.method === 'GET') return json(response, 200, { prices: billing.getPrices(), stats: billing.getStats() })
      if (url.pathname === '/api/billing/prices' && request.method === 'PUT') { const body = await readJson(request); return json(response, 200, { prices: billing.savePrices(body), stats: billing.getStats() }) }
      if (url.pathname === '/api/billing/reset' && request.method === 'POST') { billing.resetStats(); return json(response, 200, billing.getStats()) }
      if (url.pathname === '/api/prompts/presets' && request.method === 'GET') { const presetState = getPromptPresetState(promptsFilePath); return json(response, 200, { ...presetState, presets: mergePrivateToggles(presetState.presets, loadPrivateToggles(promptsFilePath)), modes: [{ id: 'director', name: '导演模式' }, { id: 'chat', name: '群聊模式' }], promptTemplates: loadPrompts(promptsFilePath), gameplayScenarios: Object.fromEntries(PROMPT_PRESET_SCOPES.map(scope => [scope, loadGameplayScenario(scope, promptsFilePath)])) }) }
      if (url.pathname === '/api/prompts/private-toggles' && request.method === 'GET') return json(response, 200, loadPrivateToggles(promptsFilePath))
      if (url.pathname === '/api/prompts/private-toggles' && request.method === 'PUT') {
        const body = await readJson(request)
        const presetId = String(body.presetId ?? '')
        const nodeId = String(body.nodeId ?? '')
        if (!presetId || !nodeId) throw new Error('缺少 presetId 或 nodeId。')
        const toggles = savePrivateToggle(promptsFilePath, presetId, nodeId, body.enabled === true)
        const presetState = getPromptPresetState(promptsFilePath)
        return json(response, 200, { ok: true, presets: mergePrivateToggles(presetState.presets, toggles) })
      }
      if (url.pathname === '/api/prompts/presets' && request.method === 'PUT') {
        const body = await readJson(request)
        if (body.scope && body.activePresetId) return json(response, 200, setPromptPresetForScope(String(body.scope) as import('./prompts.ts').PromptPresetScope, String(body.activePresetId), promptsFilePath))
        const preset = body.preset && typeof body.preset === 'object' ? body.preset : body
        if ((preset as { id?: string })?.id === 'default') throw new Error('默认方案不可覆盖保存，请另存为。')
        return json(response, 200, { ok: true, ...getPromptPresetState(promptsFilePath), presets: updatePromptPreset(preset, promptsFilePath) })
      }
      if (url.pathname === '/api/prompts/presets' && request.method === 'DELETE') return json(response, 200, { ok: true, presets: deletePromptPreset(String(url.searchParams.get('id') ?? ''), promptsFilePath) })
       if (url.pathname === '/api/prompts/presets/export' && request.method === 'GET') {
         const id = String(url.searchParams.get('id') ?? '').trim()
         const preset = mergePrivateToggles(getPromptPresetState(promptsFilePath).presets, loadPrivateToggles(promptsFilePath)).find(item => item.id === id)
         if (!preset) throw new Error('提示词预设不存在。')
         const body = Buffer.from(`${JSON.stringify({ format: 'stagecraft-prompt-preset', version: 1, preset }, null, 2)}\n`, 'utf8')
         response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${encodeURIComponent(preset.name || id)}.json"`, 'Content-Length': body.length, 'Cache-Control': 'no-store' })
         response.end(body)
         return
       }
      if (url.pathname === '/api/prompts/import-st' && request.method === 'POST') {
        const body = await readJson(request)
        return json(response, 200, { ok: true, result: convertSillyTavernPreset(String(body.source ?? '').slice(0, 8_000_000), String(body.message ?? '')) })
      }
      if (url.pathname === '/api/prompts' && request.method === 'GET') {
        return json(response, 200, { files: listIdeologyFiles(promptsFilePath), presets: listPromptPresets(promptsFilePath) })
      }
      if (url.pathname === '/api/prompts' && request.method === 'POST') {
        const body = await readJson(request)
        // 只允许写入 prompts/custom/ 下的 json 文件名（防路径穿越）
        const name = /^[\w\u4e00-\u9fff-]+(\.json)?$/.test(String(body.name ?? '')) ? String(body.name).replace(/\.json$/, '') : 'ideology'
        saveIdeologyFile(name, { roleIdeals: String(body.role ?? ''), directorIdeals: String(body.director ?? '') }, promptsFilePath)
        if (body.activate !== false) setActiveIdeologyFile(name, promptsFilePath)
        reloadPrompts()
        return json(response, 200, { ok: true, files: listIdeologyFiles(promptsFilePath) })
      }
      if (url.pathname === '/api/prompts/rename' && request.method === 'POST') {
        const body = await readJson(request)
        const ok = renameIdeologyFile(String(body.from ?? ''), String(body.to ?? ''), promptsFilePath)
        if (ok) reloadPrompts()
        return json(response, ok ? 200 : 400, { ok, files: ok ? listIdeologyFiles(promptsFilePath) : [] })
      }
      if (url.pathname === '/api/prompts' && request.method === 'DELETE') {
        const ok = removeIdeologyFile(String(url.searchParams.get('name') ?? ''), promptsFilePath)
        if (ok) reloadPrompts()
        return json(response, ok ? 200 : 400, { ok, files: ok ? listIdeologyFiles(promptsFilePath) : [] })
      }
      if (url.pathname === '/api/events') return events(request, response, url.searchParams.get('id') ?? roomId)
      if (url.pathname === '/api/thinking-events') return thinkingEvents(request, response, url.searchParams.get('id') ?? roomId)
      if (url.pathname === '/api/debug-events') return debugEvents(request, response)
      if (url.pathname === '/api/restart' && request.method === 'POST') {
        const body = await readJson(request)
        const story = loadStoryPackage(storiesRoot, String(body.storyId ?? ''), bundleStoriesDirs)
        const mode = body.mode === 'chat' || body.mode === 'director' ? body.mode : undefined
        await dispatchRestart(story, { ...(mode ? { mode } : {}), ...(typeof body.autoPublish === 'boolean' ? { autoPublish: body.autoPublish } : {}) })
        return json(response, 200, { ok: true, roomId })
      }
      if (url.pathname === '/api/room-config' && request.method === 'POST') {
        const body = await readJson(request)
        const mode = body.mode === 'chat' || body.mode === 'director' ? body.mode : undefined
        const speechMode = body.speechMode === 'manual' || body.speechMode === 'director' || body.speechMode === 'all' ? body.speechMode : undefined
        const hidePlayerSpeech = typeof body.hidePlayerSpeech === 'boolean' ? body.hidePlayerSpeech : undefined
        await dispatchManagement('set-room-config', { ...(mode ? { mode } : {}), ...(typeof body.autoPublish === 'boolean' ? { autoPublish: body.autoPublish } : {}), ...(speechMode ? { speechMode } : {}), ...(typeof hidePlayerSpeech === 'boolean' ? { hidePlayerSpeech } : {}) })
        return json(response, 200, { ok: true, room: runtime.get(roomId) })
      }
      if (url.pathname === '/api/chat/speak' && request.method === 'POST') {
        const body = await readJson(request)
        await core.dispatch({ id: `legacy-chat-speak-${Date.now()}`, actor: 'player', type: 'select-role', payload: { roomId, scope: 'chat', action: 'chat-speech', roleId: String(body.roleId ?? ''), feedback: String(body.feedback ?? '') } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/chat/director-decide' && request.method === 'POST') {
        await core.dispatch({ id: `legacy-chat-director-decide-${Date.now()}`, actor: 'player', type: 'select-role', payload: { roomId, scope: 'chat', action: 'director-role-selection' } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/chat/speak-all' && request.method === 'POST') {
        await core.dispatch({ id: `legacy-chat-speak-all-${Date.now()}`, actor: 'player', type: 'select-role', payload: { roomId, scope: 'chat', action: 'chat-speech-all' } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/chat/approve-speech' && request.method === 'POST') {
        const body = await readJson(request)
        const wc = body?.worldChange
        await core.dispatch({ id: `legacy-chat-approve-${Date.now()}`, actor: 'player', type: 'approve', payload: { roomId, scope: 'chat', action: 'speech', text: String(body?.text ?? ''), worldChange: (wc && typeof wc === 'object') ? wc as import('./types.ts').WorldChangeRequest : null } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/chat/reject-speech' && request.method === 'POST') {
        await core.dispatch({ id: `legacy-chat-reject-${Date.now()}`, actor: 'player', type: 'reject', payload: { roomId, scope: 'chat', action: 'speech' } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/chat/retry' && request.method === 'POST') {
        await core.dispatch({ id: `legacy-chat-retry-${Date.now()}`, actor: 'player', type: 'retry', payload: { roomId, scope: 'chat', action: 'chat-speech' } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/chat/director-chat' && request.method === 'POST') {
        const body = await readJson(request)
        await core.dispatch({ id: `legacy-director-chat-${Date.now()}`, actor: 'player', type: 'submit-text', payload: { roomId, scope: 'chat', action: 'director-chat', text: String(body?.text ?? '') } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/world-change/approve' && request.method === 'POST') {
        const body = await readJson(request)
        const wc = body?.worldChange
        await core.dispatch({ id: `legacy-world-change-approve-${Date.now()}`, actor: 'player', type: 'approve', payload: { roomId, scope: 'chat', action: 'world-change', worldChange: (wc && typeof wc === 'object') ? wc as import('./types.ts').WorldChangeRequest : null } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/world-change/reject' && request.method === 'POST') {
        await core.dispatch({ id: `legacy-world-change-reject-${Date.now()}`, actor: 'player', type: 'reject', payload: { roomId, scope: 'chat', action: 'world-change' } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/st-cards/import' && request.method === 'POST') {
        const body = await readJson(request)
        const result = importStCard(String(body.content ?? ''), String(body.filename ?? 'card.json'))
        await dispatchManagement('create-role', { role: result.role })
        // 角色书条目并入房间世界书（按名称去重，避免重复导入叠加）
        if (result.lore.length > 0) {
          const current = runtime.get(roomId).lore ?? []
          const existingNames = new Set(current.map(entry => entry.name))
          await dispatchManagement('save-lore', { lore: [...current, ...result.lore.filter(entry => !existingNames.has(entry.name))] })
        }
        return json(response, 200, { ok: true, role: result.role, mapped: result.mapped, loreAdded: result.lore.length })
      }
      if (url.pathname === '/api/turn' && request.method === 'POST') {
        const body = await readJson(request)
        await core.dispatch({ id: `legacy-turn-${Date.now()}`, actor: 'player', type: 'submit-text', payload: { roomId, scope: runtime.get(roomId).mode, action: runtime.get(roomId).mode === 'chat' ? 'chat-contribution' : 'director-turn', text: String(body.text ?? ''), requiredRoleIds: Array.isArray(body.requiredRoleIds) ? body.requiredRoleIds.map(String) : [] } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/director/proceed' && request.method === 'POST') {
        await core.dispatch({ id: `legacy-director-proceed-${Date.now()}`, actor: 'player', type: 'submit-text', payload: { roomId, scope: 'director', action: 'director-proceed' } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/director/retry' && request.method === 'POST') {
        await core.dispatch({ id: `legacy-director-retry-${Date.now()}`, actor: 'player', type: 'retry', payload: { roomId, scope: 'director', action: 'director-retry' } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/approve' && request.method === 'POST') {
        const body = await readJson(request)
        const sceneUpdates = body.sceneUpdates && typeof body.sceneUpdates === 'object' ? { ...(typeof (body.sceneUpdates as Record<string, unknown>).time === 'string' ? { time: (body.sceneUpdates as Record<string, unknown>).time as string } : {}), ...(typeof (body.sceneUpdates as Record<string, unknown>).location === 'string' ? { location: (body.sceneUpdates as Record<string, unknown>).location as string } : {}) } : undefined
        await core.dispatch({ id: `legacy-approve-${Date.now()}`, actor: 'player', type: 'approve', payload: { roomId, scope: 'director', action: 'draft-approval', draftId: String(body.draftId), text: String(body.text), stateUpdates: body.stateUpdates && typeof body.stateUpdates === 'object' ? body.stateUpdates as Record<string, string> : {}, sceneUpdates } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/reactions/reconsider' && request.method === 'POST') {
        const body = await readJson(request)
        await core.dispatch({ id: `legacy-reconsider-${Date.now()}`, actor: 'player', type: 'retry', payload: { roomId, scope: 'director', action: 'reconsider-reaction', roleId: String(body.roleId), feedback: String(body.feedback ?? '') } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/player-character' && request.method === 'POST') {
        const body = await readJson(request)
        await dispatchManagement('update-player-character', { name: String(body.name ?? ''), persona: String(body.persona ?? ''), currentState: String(body.currentState ?? '') })
        return json(response, 200, { ok: true, room: runtime.get(roomId) })
      }
      if (url.pathname === '/api/player/avatar' && request.method === 'POST') {
        const body = await readJson(request)
        const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : ''
        const url = typeof body.url === 'string' ? body.url : ''
        if (!dataUrl && !url) throw new Error('缺少头像数据（dataUrl 或 url）。')
        const portraitRef = await saveAvatar('player', dataUrl || '', url || '')
        await dispatchManagement('set-player-avatar', { portraitRef })
        return json(response, 200, { ok: true, portraitRef })
      }
      if (url.pathname === '/api/roles/memories' && request.method === 'GET') {
        const roleId = String(url.searchParams.get('roleId') ?? '')
        return json(response, 200, { memories: runtime.get(roomId).roles.find(role => role.id === roleId)?.memories ?? [] })
      }
      if (url.pathname === '/api/roles/memories' && request.method === 'POST') {
        const body = await readJson(request); const roleId = String(body.roleId ?? ''); const entries = Array.isArray(body.entries) ? body.entries : []
        await dispatchManagement('store-memories', { roleId, entries }); return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/memories/retract' && request.method === 'POST') {
        const body = await readJson(request); await dispatchManagement('retract-memory', { memoryId: String(body.memoryId) }); return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/memories/update' && request.method === 'POST') {
        const body = await readJson(request); await dispatchManagement('update-memory', { memoryId: String(body.memoryId), entry: body.entry ?? {} }); return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/memories/reorder' && request.method === 'POST') {
        const body = await readJson(request)
        const memoryIds = Array.isArray(body.memoryIds) ? body.memoryIds.map(String) : []
        if (!memoryIds.length) throw new Error('缺少记忆顺序列表。')
        await dispatchManagement('reorder-memories', { roleId: String(body.roleId ?? ''), memoryIds })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/memories/supersede' && request.method === 'POST') {
        const body = await readJson(request); await dispatchManagement('supersede-memory', { memoryId: String(body.memoryId), entry: body.entry ?? {} }); return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/intervene' && request.method === 'POST') {
        const body = await readJson(request)
        await dispatchManagement('intervene-role', { roleId: String(body.roleId), selfModel: String(body.selfModel ?? ''), memories: Array.isArray(body.memories) ? body.memories as import('./types.ts').InitialMemory[] : undefined, config: { providerId: body.providerId ? String(body.providerId) : undefined, modelOverride: body.modelOverride ? String(body.modelOverride) : undefined, ...(typeof body.impressions === 'string' ? { impressions: JSON.parse(body.impressions) as Record<string, string> } : {}), ...(typeof body.goals === 'string' ? { goals: JSON.parse(body.goals) as string[] } : {}), ...(body.thinkingStrength ? { thinkingStrength: String(body.thinkingStrength) as import('./types.ts').ThinkingStrength } : {}) } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/create' && request.method === 'POST') {
        const body = await readJson(request)
        const id = String(body.id ?? '').trim() || `role-${Date.now()}`
        // 新建角色肖像：dataURL（已前端 3:4 裁剪）或 URL 都落盘为资产文件，portraitRef 存可访问地址
        let portraitRef = String(body.portraitRef ?? '/assets/default.svg')
        const rawPortrait = String(body.portraitRef ?? '')
        if (rawPortrait.startsWith('data:image/') || (/^https?:\/\//i.test(rawPortrait) && rawPortrait !== '/assets/default.svg')) {
          portraitRef = await saveAvatar(id, rawPortrait.startsWith('data:image/') ? rawPortrait : '', rawPortrait.startsWith('data:image/') ? '' : rawPortrait)
        }
        await dispatchManagement('create-role', { role: { id, name: String(body.name ?? '').trim(), portraitRef, currentState: String(body.currentState ?? '刚刚进入当前场景。'), presence: ['present', 'absent', 'unavailable'].includes(String(body.presence)) ? String(body.presence) as 'present' | 'absent' | 'unavailable' : 'present', selfModel: String(body.selfModel ?? ''), ...(Array.isArray(body.memories) ? { memories: body.memories as import('./types.ts').InitialMemory[] } : {}), ...(typeof body.goals === 'string' ? { goals: JSON.parse(body.goals) as string[] } : {}) } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/delete' && request.method === 'POST') {
        const body = await readJson(request)
        await dispatchManagement('delete-role', { roleId: String(body.roleId) })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/presence' && request.method === 'POST') {
        const body = await readJson(request)
        const presence = String(body.presence)
        if (!['present', 'absent', 'unavailable'].includes(presence)) throw new Error('无效的在场状态。')
        await dispatchManagement('set-role-presence', { roleId: String(body.roleId), presence })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/thinking' && request.method === 'POST') {
        const body = await readJson(request)
        const thinking = String(body.thinking ?? '') as import('./types.ts').ThinkingStrength
        await dispatchManagement('set-role-thinking', { roleId: String(body.roleId), thinkingStrength: thinking })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/reorder' && request.method === 'POST') {
        const body = await readJson(request)
        const roleIds = Array.isArray(body.roleIds) ? body.roleIds.map(String) : []
        if (roleIds.length === 0) throw new Error('缺少角色顺序列表。')
        await dispatchManagement('reorder-roles', { roleIds })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/avatar' && request.method === 'POST') {
        const body = await readJson(request)
        const roleId = String(body.roleId ?? '')
        const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : ''
        const url = typeof body.url === 'string' ? body.url : ''
        if (!dataUrl && !url) throw new Error('缺少头像数据（dataUrl 或 url）。')
        const storyId = typeof body.storyId === 'string' && body.storyId.trim() ? body.storyId.trim() : undefined
        const portraitRef = await saveAvatar(roleId, dataUrl || '', url || '', storyId)
        // 剧本编辑模式（storyId）：只落盘文件并返回路径，由前端写入剧本角色；
        // 运行时模式：更新运行时角色的 portraitRef。
        if (body.skipDispatch !== true && !storyId) await dispatchManagement('set-role-avatar', { roleId, portraitRef })
        return json(response, 200, { ok: true, portraitRef })
      }
      if (url.pathname === '/api/scene' && request.method === 'POST') {
        const body = await readJson(request)
        await dispatchManagement('update-scene', { ...(typeof body.time === 'string' ? { time: body.time } : {}), ...(typeof body.location === 'string' ? { location: body.location } : {}) })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/state' && request.method === 'POST') {
        const body = await readJson(request)
        const roleId = String(body.roleId ?? '')
        const currentState = String(body.currentState ?? '')
        if (!roleId) throw new Error('缺少角色 id。')
        await dispatchManagement('set-role-state', { roleId, currentState })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/director/setting' && request.method === 'POST') {
        const body = await readJson(request)
        const text = String(body.text ?? '').trim()
        if (!text) throw new Error('设定内容为空。')
        await dispatchManagement('set-director-setting', { text })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/story/sync-role' && request.method === 'POST') {
        const body = await readJson(request)
        const storyId = String(body.storyId ?? '')
        const roleId = String(body.roleId ?? '')
        const room = runtime.get(roomId)
        if (room.phase !== 'awaiting-player-input') throw new Error('同步剧本需要在空闲时进行。')
        const role = room.roles.find(item => item.id === roleId)
        if (!role) throw new Error('角色不存在。')
        const story = loadStoryPackage(storiesRoot, storyId, bundleStoriesDirs)
        const index = story.roles.findIndex(item => item.id === roleId)
        const updated = { id: role.id, name: role.name, portraitRef: role.portraitRef, currentState: role.currentState, presence: role.presence, memories: (role.memories ?? []).map(memory => ({ text: memory.text, occurredAt: memory.occurredAt })), selfModel: role.selfModel, ...(role.impressions && Object.keys(role.impressions).length ? { impressions: role.impressions } : index >= 0 && story.roles[index].impressions ? { impressions: story.roles[index].impressions } : {}), ...(role.providerId ? { providerId: role.providerId } : {}), ...(role.modelOverride ? { modelOverride: role.modelOverride } : {}) }
        if (index >= 0) story.roles[index] = updated; else story.roles.push(updated)
        saveStoryPackage(storiesRoot, story)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/story/sync-roles' && request.method === 'POST') {
        const body = await readJson(request)
        const storyId = String(body.storyId ?? '')
        const room = runtime.get(roomId)
        if (room.phase !== 'awaiting-player-input') throw new Error('同步剧本需要在空闲时进行。')
        const story = loadStoryPackage(storiesRoot, storyId, bundleStoriesDirs)
        const storyImpressions = new Map(story.roles.map(item => [item.id, item.impressions]))
        story.roles = room.roles.map(role => ({
          id: role.id, name: role.name, portraitRef: role.portraitRef, currentState: role.currentState, presence: role.presence,
          memories: (role.memories ?? []).map(memory => ({ text: memory.text, occurredAt: memory.occurredAt })), selfModel: role.selfModel,
          ...(role.impressions && Object.keys(role.impressions).length ? { impressions: role.impressions } : storyImpressions.get(role.id) ? { impressions: storyImpressions.get(role.id) } : {}),
          ...(role.providerId ? { providerId: role.providerId } : {}),
          ...(role.modelOverride ? { modelOverride: role.modelOverride } : {}),
        }))
        saveStoryPackage(storiesRoot, story)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/lore' && request.method === 'POST') {
        const body = await readJson(request)
        const lore = Array.isArray(body.lore) ? (body.lore as unknown[]).map(item => {
          const entry = item as Record<string, unknown>
          return { name: String(entry.name ?? ''), content: String(entry.content ?? ''), ...(Array.isArray(entry.roles) ? { roles: entry.roles.map(String) } : {}) }
        }).filter(entry => entry.name && entry.content) : []
        await dispatchManagement('save-lore', { lore })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/consult' && request.method === 'POST') {
        const body = await readJson(request)
        await core.dispatch({ id: `legacy-consult-${Date.now()}`, actor: 'player', type: 'submit-text', payload: { roomId, scope: 'director', action: 'director-consult', draftId: String(body.draftId), text: String(body.text ?? ''), context: String(body.context ?? '') } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/consult/finish' && request.method === 'POST') {
        await core.dispatch({ id: `legacy-consult-finish-${Date.now()}`, actor: 'player', type: 'approve', payload: { roomId, scope: 'director', action: 'consult-finish' } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/redraft' && request.method === 'POST') {
        const body = await readJson(request)
        await core.dispatch({ id: `legacy-redraft-${Date.now()}`, actor: 'player', type: 'retry', payload: { roomId, scope: 'director', action: 'redraft', draftId: String(body.draftId) } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/cancel-turn' && request.method === 'POST') {
        await core.dispatch({ id: `legacy-cancel-turn-${Date.now()}`, actor: 'player', type: 'cancel', payload: { roomId, scope: runtime.get(roomId).mode, action: 'cancel-turn' } })
        return json(response, 200, { ok: true })
      }
      if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/story-assets/')) return asset(response, url.pathname)
      if (url.pathname === '/' || url.pathname === '/index.html') return serveIndex(response)
      // 浏览器直连配对页：手机浏览器打开 http://<IP>:<端口>/ 未配对时跳转至此。
      // 静态资源缓存策略：HTML 一律 no-store（每次导航强制拿最新，修复手机缓存旧页面看不到新功能）；
      // 带内容哈希 ?v= 引用的资源 immutable 长缓存（内容一变 URL 即变，浏览器必然重新下载）；
      // 无版本号引用的 JS（core-*.js 由 app.js import）no-cache 强制重新验证。
      if (url.pathname === '/pair') return staticFile(response, 'pair.html', 'text/html; charset=utf-8', 'no-store')
      if (url.pathname === '/app.js') return staticFile(response, 'app.js', 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable')
      if (url.pathname === '/core-client.js') return staticFile(response, 'core-client.js', 'text/javascript; charset=utf-8', 'no-cache')
      if (url.pathname === '/core-interactions.js') return staticFile(response, 'core-interactions.js', 'text/javascript; charset=utf-8', 'no-cache')
      if (url.pathname === '/core-interactions.css') return staticFile(response, 'core-interactions.css', 'text/css; charset=utf-8', 'public, max-age=31536000, immutable')
      if (url.pathname === '/style.css') return staticFile(response, 'style.css', 'text/css; charset=utf-8', 'public, max-age=31536000, immutable')
      json(response, 404, { error: 'Not found' })
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  function debugEvents(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const send = (text: string) => response.write(`event: summary\ndata: ${JSON.stringify({ text, at: new Date().toISOString() })}\n\n`)
    send('调试摘要通道已连接。')
    debugListeners.add(send)
    request.on('close', () => debugListeners.delete(send))
  }

  function events(request: IncomingMessage, response: ServerResponse, id: string): void {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const send = (value: unknown) => response.write(`event: room\ndata: ${JSON.stringify(value)}\n\n`)
    // 与 /api/room 一致：归一化角色字段，避免首帧 null/undefined 覆盖已渲染的角色详情。
    send(publicRoomSnapshot(runtime.get(id)))
    const unsubscribe = runtime.subscribe(id, value => send(publicRoomSnapshot(value)))
    const ping = setInterval(() => response.write(': ping\n\n'), 20_000)
    request.on('close', () => { clearInterval(ping); unsubscribe() })
  }

  /** SSE：模型思维链增量（角色决策 / Director 草稿的 reasoning 流） */
  function thinkingEvents(request: IncomingMessage, response: ServerResponse, id: string): void {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const send = (value: unknown) => response.write(`event: thinking\ndata: ${JSON.stringify(value)}\n\n`)
    const unsubscribe = runtime.subscribeThinking(id, send)
    const ping = setInterval(() => response.write(': ping\n\n'), 20_000)
    request.on('close', () => { clearInterval(ping); unsubscribe() })
  }

  function asset(response: ServerResponse, path: string): void {
    const name = path.endsWith('aria.svg') ? 'aria.svg' : path.endsWith('mira.svg') ? 'mira.svg' : 'noel.svg'
    // 故事包自包含资产（/story-assets/<id>/<file>）：从故事包资产目录读（AppData 优先，bundle 兜底）
    if (path.startsWith('/story-assets/')) {
      const filePath = resolveStoryAssetFile(storiesRoot, path, bundleStoriesDirs)
      if (filePath) {
        const ext = extname(filePath).toLowerCase()
        const type = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/svg+xml'
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' })
        createReadStream(filePath).pipe(response)
        return
      }
      response.writeHead(404); response.end(); return
    }
    // 先查用户可写目录（上传的头像，AppData），再查 bundle public（默认资源）
    for (const base of [userPublicRoot, publicRoot]) {
      if (!base) continue
      const filePath = join(base, path)
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const ext = extname(filePath).toLowerCase()
        const type = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/svg+xml'
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' })
        createReadStream(filePath).pipe(response)
        return
      }
    }
    // 兜底：内联生成的首字母 SVG（aria/mira/noel 及未知路径）
    response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' })
    response.end(portraitSvg(name))
  }

  const MAX_AVATAR_BYTES = 8 * 1024 * 1024 // 8MB 上限

  /** 保存角色头像：dataUrl（文件上传）或 url（远程导入），返回可访问的 portraitRef。
   *  storyId 提供时写入该故事包的资产目录（自包含，可随作品分发），否则写入用户头像目录。 */
  async function saveAvatar(roleId: string, dataUrl: string, url: string, storyId?: string): Promise<string> {
    let buffer: Buffer
    let ext: string
    if (dataUrl) {
      const match = dataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s)
      if (!match) throw new Error('不支持的头像格式（仅 png/jpeg/gif/webp）。')
      buffer = Buffer.from(match[2], 'base64')
      ext = match[1] === 'image/jpeg' ? '.jpg' : match[1].replace('image/', '.')
    } else {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      let response: Response
      try {
        response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) throw new Error(`远程图片拉取失败：HTTP ${response.status}`)
      const contentType = response.headers.get('content-type') ?? ''
      const type = contentType.split(';')[0].trim().toLowerCase()
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) throw new Error(`远程内容不是图片：${type || '未知类型'}`)
      buffer = Buffer.from(await response.arrayBuffer())
      ext = type === 'image/jpeg' ? '.jpg' : type.replace('image/', '.')
    }
    if (buffer.length === 0) throw new Error('头像数据为空。')
    if (buffer.length > MAX_AVATAR_BYTES) throw new Error('头像超过 8MB 上限。')
    const safeId = roleId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const fileName = `avatar-${safeId}-${Date.now()}${ext}`
    // 剧本编辑模式（storyId）：写入故事包资产目录（自包含，随作品分发），返回 /story-assets/<id>/<file>
    if (storyId) {
      const assetsDir = storyAssetsDir(storiesRoot, storyId, bundleStoriesDirs)
      mkdirSync(assetsDir, { recursive: true })
      writeFileSync(join(assetsDir, fileName), buffer)
      return `/story-assets/${encodeURIComponent(storyId)}/${fileName}`
    }
    // 运行时角色头像：写入用户可写目录（AppData，构建不丢）；独立模式回退 publicRoot/assets。
    const targetAssets = userPublicRoot ? join(userPublicRoot, 'assets') : join(publicRoot, 'assets')
    mkdirSync(targetAssets, { recursive: true })
    writeFileSync(join(targetAssets, fileName), buffer)
    return `/assets/${fileName}`
  }

  /** 内容哈希缓存失效：index 里对 /app.js 等静态资源附加 ?v=<sha256 前 12 位>，
   *  文件内容一变 URL 就变，浏览器必然重新下载；未变则稳定复用缓存。 */
  function assetHash(name: string): string {
    const path = join(publicRoot, name)
    if (!existsSync(path)) return '0'
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
  }

  function serveIndex(response: ServerResponse): void {
    const path = join(publicRoot, 'index.html')
    if (!existsSync(path)) { response.writeHead(404); response.end(); return }
    const html = readFileSync(path, 'utf8')
      .replaceAll('__APP_HASH__', assetHash('app.js'))
      .replaceAll('__STYLE_HASH__', assetHash('style.css'))
      .replaceAll('__CORE_CSS_HASH__', assetHash('core-interactions.css'))
      .replaceAll('__MODE_FLAG__', isStandalone ? 'true' : 'false')
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(html)
  }

  function staticFile(response: ServerResponse, name: string, type: string, cacheControl?: string): void {
    const path = join(publicRoot, name)
    if (!existsSync(path)) { response.writeHead(404); response.end(); return }
    const headers: Record<string, string> = { 'Content-Type': type }
    if (cacheControl) headers['Cache-Control'] = cacheControl
    response.writeHead(200, headers)
    createReadStream(path).pipe(response)
  }

  function portraitSvg(name: string): string {
    const data: Record<string, [string, string, string]> = {
      'aria.svg': ['A', '#433253', '#f0c5a7'], 'mira.svg': ['M', '#245c68', '#e2b55a'], 'noel.svg': ['N', '#4d5a37', '#c9d3b0'],
    }
    const [letter, bg, tone] = data[name] ?? data['noel.svg']
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><rect width="160" height="160" fill="${bg}"/><circle cx="80" cy="63" r="34" fill="${tone}"/><path d="M28 158c8-39 26-57 52-57s44 18 52 57" fill="${tone}"/><text x="80" y="145" text-anchor="middle" font-family="serif" font-size="26" fill="${bg}">${letter}</text></svg>`
  }

  function publicRoomSnapshot(room: RoomSnapshot): RoomSnapshot {
    // 角色字段完整传给前端：角色设置弹窗需要 selfModel/goals/impressions/memories，
    // 剥离会导致弹窗显示 undefined。字段做 null 兜底避免字面 undefined/null。
    return {
      ...room,
      roles: room.roles.map(role => ({
        ...role,
        name: role.name ?? '',
        currentState: role.currentState ?? '',
        presence: role.presence ?? 'present',
        portraitRef: role.portraitRef ?? '/assets/default.svg',
        selfModel: role.selfModel ?? '',
        goals: role.goals ?? [],
        impressions: role.impressions ?? {},
        memories: role.memories ?? [],
      })),
    }
  }

  function json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(value))
  }

  async function readBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
    const chunks: Buffer[] = []; let total = 0
    for await (const chunk of request) { const part = Buffer.from(chunk); total += part.length; if (total > maximum) throw new Error('请求文件过大。'); chunks.push(part) }
    return Buffer.concat(chunks)
  }
  async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> { return JSON.parse((await readBody(request, 4 * 1024 * 1024)).toString('utf8') || '{}') as Record<string, unknown> }

  function listSaves(): string[] {
    try {
      return readdirSync(saveRoot).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).sort().reverse()
    } catch {
      return []
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
      const onListening = (): void => {
        server.off('error', onError)
        const address = server.address()
        const actualPort = typeof address === 'object' && address ? address.port : port
        console.log(`StageCraft running at http://${host}:${actualPort} (room: ${roomId})`)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  } catch (error) {
    try {
      await new Promise<void>(resolve => {
        server.close(() => resolve())
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      })
    } catch { /* preserve the startup error */ }
    await compensateStartFailure()
    throw error
  }

  let closed = false
  return {
    ctx,
    store,
    runtime,
    core,
    roomId,
    get gateway() { return gateway },
    billing,
    providerStore,
    container,
    server,
    remoteAccess,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      let firstError: unknown
      try {
        await new Promise<void>((resolve, reject) => {
          server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())
          // 立即断开 SSE 等长连接，否则 close 回调会一直等待
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        })
      } catch (error) {
        firstError = error
      }
      try {
        await providerActivation
      } catch (error) {
        firstError ??= error
      }
      try {
        const current = llmFiber
        llmFiber = undefined
        if (current) {
          untrackFiber(current)
          await current.dispose()
        }
      } catch (error) {
        firstError ??= error
      }
      try {
        for (const fiber of [...appFibers].reverse()) {
          try { await fiber.dispose() } catch (error) { firstError ??= error }
        }
        appFibers.length = 0
      } catch (error) {
        firstError ??= error
      }
      try {
        creatorWorkbench.dispose()
      } catch (error) {
        firstError ??= error
      }
      try {
        runtime.dispose()
      } catch (error) {
        firstError ??= error
      }
      try { await container.dispose() } catch (error) { firstError ??= error }
      try {
        store.close()
      } catch (error) {
        firstError ??= error
      }
      if (firstError) throw firstError
    },
  }
}
