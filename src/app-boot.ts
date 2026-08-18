/**
 * StageCraft 应用启动器：把 Store + RoomRuntime + ModelGateway + node:http
 * 服务器组装成一个自包含应用，供两种宿主复用：
 *   - 独立入口 src/server.ts（npm run dev）
 *   - dsh-rp 插件壳（Cordis/dsh profile 里跑同一套应用，核心零改动）
 *
 * 本模块保持框架无关：不 import cordis/dsh，只导出纯函数。
 */
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.ts'
import { RoomRuntime } from './room-runtime.ts'
import { ModelGateway, createRealWorkers, reloadPrompts, routeFromEnvironment } from './model-gateway.ts'
import { listStoryPackages, loadStoryPackage, saveStoryPackage, type StoryPackage } from './story-packages.ts'
import { ProviderConfigStore, type ProviderConfig } from './provider-config.ts'
import { listIdeologyFiles, loadPrompts, removeIdeologyFile, renameIdeologyFile, saveIdeologyFile, setActiveIdeologyFile, type PromptTemplates } from './prompts.ts'
import { importStCard } from './st-card-import.ts'
import { CoreRuntimeSkeleton } from './core/runtime.ts'
import type { CoreEvent } from './core/protocol.ts'

export interface TavernOptions {
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
  /** 初始剧本 id（默认 'eldoria'） */
  storyId?: string
  /** 监听端口（默认 process.env.PORT ?? 8787；0 = 系统分配） */
  port?: number
  /** 监听主机（默认 process.env.HOST ?? '127.0.0.1'） */
  host?: string
}

export interface TavernApp {
  store: Store
  runtime: RoomRuntime
  core: CoreRuntimeSkeleton
  roomId: string
  gateway: ModelGateway | undefined
  providerStore: ProviderConfigStore
  server: Server
  /** 关闭 HTTP 服务器（立即断开 SSE 等长连接）并关闭数据库 */
  close(): Promise<void>
}

export function startTavern(options: TavernOptions = {}): TavernApp {
  const root = options.root ?? fileURLToPath(new URL('..', import.meta.url))
  const publicRoot = options.publicRoot ?? join(root, 'public')
  const storiesRoot = options.storiesRoot ?? join(root, 'stories')
  const saveRoot = options.saveRoot ?? join(root, 'save')
  const dataDir = options.dataDir ?? join(root, 'data')
  const promptsFilePath = options.promptsFilePath ?? join(root, 'prompts', 'prompts.json')
  mkdirSync(saveRoot, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

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
  const store = new Store(dbPath)
  let roomId = store.seed(loadStoryPackage(storiesRoot, options.storyId ?? 'eldoria'))
  store.recoverInterruptedRooms()

  const debugListeners = new Set<(text: string) => void>()
  const debugLog = join(dataDir, 'server.log')
  function emitDebug(text: string): void {
    const line = `[${new Date().toISOString()}] ${text}`
    appendFileSync(debugLog, `${line}\n`, 'utf8')
    console.log(line)
    for (const listener of debugListeners) listener(text)
  }

  // 配置文件（data/providers.json）不进仓库；不存在时用 providers.example.json 生成默认
  const providerFilePath = join(dataDir, 'providers.json')
  if (!existsSync(providerFilePath)) {
    const example = join(root, 'providers.example.json')
    if (existsSync(example)) copyFileSync(example, providerFilePath)
  }
  const providerStore = new ProviderConfigStore(providerFilePath)
  const envRoute = routeFromEnvironment()
  if (providerStore.list().length === 0 && envRoute.apiKey) providerStore.save({ id: 'environment', name: '环境变量', baseUrl: envRoute.baseUrl, apiKey: envRoute.apiKey, models: [envRoute.model], selectedModel: envRoute.model, responseFormat: envRoute.responseFormat })

  let gateway: ModelGateway | undefined
  function gatewayFromProvider(config: ProviderConfig, model: string): ModelGateway {
    return new ModelGateway({ name: config.name, baseUrl: config.baseUrl, apiKey: config.apiKey, model, timeoutMs: envRoute.timeoutMs, responseFormat: config.responseFormat, toolCalling: config.toolCalling !== false }, { onSummary: emitDebug, logRawFinalContent: process.env.RP_LOG_MODEL_FINAL_CONTENT === '1' })
  }
  function activateProvider(config = providerStore.getDirector()): void {
    if (!config?.apiKey) { gateway = undefined; return }
    const defaults = providerStore.defaults()
    gateway = gatewayFromProvider(config, defaults.directorModel ?? config.selectedModel ?? config.models[0] ?? envRoute.model)
    runtime.setWorkers(createRealWorkers(gateway, role => {
      const defaults = providerStore.defaults()
      const fallbackProvider = providerStore.getDefaultRole()
      const selectedProvider = role.providerId ? providerStore.get(role.providerId) : fallbackProvider
      if (!selectedProvider?.apiKey) return gateway!
      const fallbackModel = selectedProvider.id === fallbackProvider?.id ? defaults.defaultRoleModel : undefined
      return gatewayFromProvider(selectedProvider, role.modelOverride ?? fallbackModel ?? selectedProvider.selectedModel ?? selectedProvider.models[0] ?? envRoute.model)
    }, { directorThinkingStrength: providerStore.directorThinking() }))
  }
  const core = new CoreRuntimeSkeleton()
  const runtime = new RoomRuntime(store, undefined, core)
  core.attachLegacyRuntime(runtime, roomId)
  core.projectRoom(runtime.get(roomId), 'app-boot:init')
  if (providerStore.getDirector()?.apiKey) activateProvider()

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    try {
      if (url.pathname === '/api/room') return json(response, 200, runtime.get(url.searchParams.get('id') ?? roomId))
      
      // 新架构：Core Runtime 协议端点（兼容层，不替换旧 API）
      if (url.pathname === '/api/core/view' && request.method === 'GET') return json(response, 200, core.getView())
      if (url.pathname === '/api/core/commands' && request.method === 'POST') {
        const command = await readJson(request)
        await core.dispatch(command as import('./core/protocol.ts').HumanCommand)
        return json(response, 200, { ok: true, view: core.getView() })
      }
      if (url.pathname === '/api/core/events' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const unsubscribe = core.subscribe((event: CoreEvent) => {
          response.write(`data: ${JSON.stringify(event)}\n\n`)
        })
        request.on('close', unsubscribe)
        return
      }
      
      if (url.pathname === '/api/archive/export' && request.method === 'GET') return json(response, 200, runtime.exportArchive(roomId))
      if (url.pathname === '/api/archive/import' && request.method === 'POST') { runtime.importArchive(roomId, await readJson(request) as { room?: import('./types.ts').RoomSnapshot }); return json(response, 200, { ok: true }) }
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
        runtime.importArchive(roomId, JSON.parse(readFileSync(path, 'utf8')) as { room?: import('./types.ts').RoomSnapshot })
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
      if (url.pathname === '/api/story/get' && request.method === 'GET') return json(response, 200, loadStoryPackage(storiesRoot, String(url.searchParams.get('id') ?? '')))
      if (url.pathname === '/api/story/save' && request.method === 'POST') {
        const body = await readJson(request)
        const story = body.story as StoryPackage
        if (!story?.id) throw new Error('剧本缺少 id。')
        saveStoryPackage(storiesRoot, story)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/stories' && request.method === 'GET') return json(response, 200, listStoryPackages(storiesRoot))
      if (url.pathname === '/api/providers' && request.method === 'GET') return json(response, 200, { providers: providerStore.list(), defaults: providerStore.defaults() })
      if (url.pathname === '/api/providers/save' && request.method === 'POST') {
        const body = await readJson(request)
        const config: ProviderConfig = { id: String(body.id), name: String(body.name), baseUrl: String(body.baseUrl).replace(/\/$/, ''), apiKey: String(body.apiKey ?? ''), models: Array.isArray(body.models) ? body.models.map(String) : [], selectedModel: body.selectedModel ? String(body.selectedModel) : undefined, responseFormat: body.responseFormat === 'json_schema' ? 'json_schema' : body.responseFormat === 'none' ? 'none' : 'json_object', toolCalling: body.toolCalling !== false }
        providerStore.save(config)
        activateProvider(config)
        return json(response, 200, { providers: providerStore.list(), defaults: providerStore.defaults(), active: gateway?.usage() ?? { route: '模拟', model: '模拟' } })
      }
      if (url.pathname === '/api/providers/discover' && request.method === 'POST') {
        const body = await readJson(request)
        return json(response, 200, await providerStore.discoverModels(String(body.id)))
      }
      if (url.pathname === '/api/providers/default-role' && request.method === 'POST') {
        const body = await readJson(request)
        providerStore.setDefaultRole(String(body.id), body.model ? String(body.model) : undefined)
        activateProvider()
        return json(response, 200, { providers: providerStore.list(), defaults: providerStore.defaults() })
      }
      if (url.pathname === '/api/providers/director' && request.method === 'POST') {
        const body = await readJson(request)
        providerStore.setDirector(String(body.id), body.model ? String(body.model) : undefined)
        activateProvider()
        return json(response, 200, { providers: providerStore.list(), defaults: providerStore.defaults() })
      }
      if (url.pathname === '/api/providers/director-thinking' && request.method === 'POST') {
        const body = await readJson(request)
        const thinking = String(body.thinking ?? '') as import('./types.ts').ThinkingStrength
        providerStore.setDirectorThinking(thinking)
        activateProvider()
        return json(response, 200, { ok: true, defaults: providerStore.defaults() })
      }
      if (url.pathname === '/api/usage') return json(response, 200, gateway?.usage(true) ?? { route: '模拟', model: '模拟', requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalDurationMs: 0, avgDurationMs: 0, mode: 'fake' })
      if (url.pathname === '/api/prompts' && request.method === 'GET') {
        return json(response, 200, { files: listIdeologyFiles(promptsFilePath) })
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
        const story = loadStoryPackage(storiesRoot, String(body.storyId))
        const mode = body.mode === 'chat' || body.mode === 'director' ? body.mode : undefined
        runtime.restart(roomId, story, { ...(mode ? { mode } : {}), ...(typeof body.autoPublish === 'boolean' ? { autoPublish: body.autoPublish } : {}) })
        return json(response, 200, { ok: true, roomId })
      }
      if (url.pathname === '/api/room-config' && request.method === 'POST') {
        const body = await readJson(request)
        const mode = body.mode === 'chat' || body.mode === 'director' ? body.mode : undefined
        runtime.setRoomConfig(roomId, { ...(mode ? { mode } : {}), ...(typeof body.autoPublish === 'boolean' ? { autoPublish: body.autoPublish } : {}) })
        return json(response, 200, { ok: true, room: runtime.get(roomId) })
      }
      if (url.pathname === '/api/chat/speak' && request.method === 'POST') {
        const body = await readJson(request)
        await runtime.speak(roomId, String(body.roleId ?? ''))
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/chat/approve-speech' && request.method === 'POST') {
        const body = await readJson(request)
        const wc = body?.worldChange
        await runtime.approveSpeech(roomId, String(body?.text ?? ''), (wc && typeof wc === 'object') ? wc as import('./types.ts').WorldChangeRequest : null)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/chat/retry' && request.method === 'POST') {
        await runtime.retrySpeak(roomId)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/chat/director-chat' && request.method === 'POST') {
        const body = await readJson(request)
        await runtime.directorChat(roomId, String(body?.text ?? ''))
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/world-change/approve' && request.method === 'POST') {
        const body = await readJson(request)
        const wc = body?.worldChange
        await runtime.approveWorldChange(roomId, (wc && typeof wc === 'object') ? wc as import('./types.ts').WorldChangeRequest : null)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/world-change/reject' && request.method === 'POST') {
        await runtime.rejectWorldChange(roomId)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/st-cards/import' && request.method === 'POST') {
        const body = await readJson(request)
        const result = importStCard(String(body.content ?? ''), String(body.filename ?? 'card.json'))
        runtime.createRole(roomId, result.role)
        // 角色书条目并入房间世界书（按名称去重，避免重复导入叠加）
        if (result.lore.length > 0) {
          const current = runtime.get(roomId).lore ?? []
          const existingNames = new Set(current.map(entry => entry.name))
          runtime.saveLore(roomId, [...current, ...result.lore.filter(entry => !existingNames.has(entry.name))])
        }
        return json(response, 200, { ok: true, role: result.role, mapped: result.mapped, loreAdded: result.lore.length })
      }
      if (url.pathname === '/api/turn' && request.method === 'POST') {
        const body = await readJson(request)
        await runtime.submitTurn(roomId, { text: String(body.text ?? ''), requiredRoleIds: Array.isArray(body.requiredRoleIds) ? body.requiredRoleIds.map(String) : [] })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/director/proceed' && request.method === 'POST') {
        await runtime.proceedToDraft(roomId)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/director/retry' && request.method === 'POST') {
        await runtime.retryDirector(roomId)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/approve' && request.method === 'POST') {
        const body = await readJson(request)
        const sceneUpdates = body.sceneUpdates && typeof body.sceneUpdates === 'object' ? { ...(typeof (body.sceneUpdates as Record<string, unknown>).time === 'string' ? { time: (body.sceneUpdates as Record<string, unknown>).time as string } : {}), ...(typeof (body.sceneUpdates as Record<string, unknown>).location === 'string' ? { location: (body.sceneUpdates as Record<string, unknown>).location as string } : {}) } : undefined
        runtime.approve(roomId, String(body.draftId), String(body.text), body.stateUpdates && typeof body.stateUpdates === 'object' ? body.stateUpdates as Record<string, string> : {}, sceneUpdates)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/reactions/reconsider' && request.method === 'POST') {
        const body = await readJson(request)
        await runtime.reconsiderReaction(roomId, String(body.roleId), String(body.feedback ?? ''))
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/player-character' && request.method === 'POST') {
        const body = await readJson(request)
        runtime.updatePlayerCharacter(roomId, { name: String(body.name ?? ''), persona: String(body.persona ?? ''), currentState: String(body.currentState ?? '') })
        return json(response, 200, { ok: true, room: runtime.get(roomId) })
      }
      if (url.pathname === '/api/player/avatar' && request.method === 'POST') {
        const body = await readJson(request)
        const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : ''
        const url = typeof body.url === 'string' ? body.url : ''
        if (!dataUrl && !url) throw new Error('缺少头像数据（dataUrl 或 url）。')
        const portraitRef = await saveAvatar('player', dataUrl || '', url || '')
        runtime.setPlayerAvatar(roomId, portraitRef)
        return json(response, 200, { ok: true, portraitRef })
      }
      if (url.pathname === '/api/roles/intervene' && request.method === 'POST') {
        const body = await readJson(request)
        runtime.interveneRole(roomId, String(body.roleId), String(body.selfModel ?? ''), JSON.parse(String(body.memoryTimeline ?? '{}')) as Record<string, string[]>, { providerId: body.providerId ? String(body.providerId) : undefined, modelOverride: body.modelOverride ? String(body.modelOverride) : undefined, ...(typeof body.impressions === 'string' ? { impressions: JSON.parse(body.impressions) as Record<string, string> } : {}), ...(typeof body.goals === 'string' ? { goals: JSON.parse(body.goals) as string[] } : {}), ...(body.thinkingStrength ? { thinkingStrength: String(body.thinkingStrength) as import('./types.ts').ThinkingStrength } : {}) })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/create' && request.method === 'POST') {
        const body = await readJson(request)
        const id = String(body.id ?? '').trim() || `role-${Date.now()}`
        runtime.createRole(roomId, { id, name: String(body.name ?? '').trim(), portraitRef: String(body.portraitRef ?? '/assets/default.svg'), currentState: String(body.currentState ?? '刚刚进入当前场景。'), presence: ['present', 'absent', 'unavailable'].includes(String(body.presence)) ? String(body.presence) as 'present' | 'absent' | 'unavailable' : 'present', selfModel: String(body.selfModel ?? ''), memoryTimeline: JSON.parse(String(body.memoryTimeline ?? '{}')) as Record<string, string[]>, ...(typeof body.goals === 'string' ? { goals: JSON.parse(body.goals) as string[] } : {}) })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/delete' && request.method === 'POST') {
        const body = await readJson(request)
        runtime.deleteRole(roomId, String(body.roleId))
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/presence' && request.method === 'POST') {
        const body = await readJson(request)
        const presence = String(body.presence)
        if (!['present', 'absent', 'unavailable'].includes(presence)) throw new Error('无效的在场状态。')
        runtime.setRolePresence(roomId, String(body.roleId), presence as 'present' | 'absent' | 'unavailable')
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/thinking' && request.method === 'POST') {
        const body = await readJson(request)
        const thinking = String(body.thinking ?? '') as import('./types.ts').ThinkingStrength
        runtime.setRoleThinking(roomId, String(body.roleId), thinking)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/reorder' && request.method === 'POST') {
        const body = await readJson(request)
        const roleIds = Array.isArray(body.roleIds) ? body.roleIds.map(String) : []
        if (roleIds.length === 0) throw new Error('缺少角色顺序列表。')
        runtime.reorderRoles(roomId, roleIds)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/avatar' && request.method === 'POST') {
        const body = await readJson(request)
        const roleId = String(body.roleId ?? '')
        const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : ''
        const url = typeof body.url === 'string' ? body.url : ''
        if (!dataUrl && !url) throw new Error('缺少头像数据（dataUrl 或 url）。')
        const portraitRef = await saveAvatar(roleId, dataUrl || '', url || '')
        runtime.setRoleAvatar(roomId, roleId, portraitRef)
        return json(response, 200, { ok: true, portraitRef })
      }
      if (url.pathname === '/api/scene' && request.method === 'POST') {
        const body = await readJson(request)
        runtime.updateScene(roomId, { ...(typeof body.time === 'string' ? { time: body.time } : {}), ...(typeof body.location === 'string' ? { location: body.location } : {}) })
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/roles/state' && request.method === 'POST') {
        const body = await readJson(request)
        const roleId = String(body.roleId ?? '')
        const currentState = String(body.currentState ?? '')
        if (!roleId) throw new Error('缺少角色 id。')
        runtime.setRoleCurrentState(roomId, roleId, currentState)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/director/setting' && request.method === 'POST') {
        const body = await readJson(request)
        const text = String(body.text ?? '').trim()
        if (!text) throw new Error('设定内容为空。')
        runtime.setDirectorSetting(roomId, text)
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
        const story = loadStoryPackage(storiesRoot, storyId)
        const index = story.roles.findIndex(item => item.id === roleId)
        const updated = { id: role.id, name: role.name, portraitRef: role.portraitRef, currentState: role.currentState, presence: role.presence, memoryTimeline: role.memoryTimeline ?? {}, selfModel: role.selfModel, ...(role.impressions && Object.keys(role.impressions).length ? { impressions: role.impressions } : index >= 0 && story.roles[index].impressions ? { impressions: story.roles[index].impressions } : {}), ...(role.providerId ? { providerId: role.providerId } : {}), ...(role.modelOverride ? { modelOverride: role.modelOverride } : {}) }
        if (index >= 0) story.roles[index] = updated; else story.roles.push(updated)
        saveStoryPackage(storiesRoot, story)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/story/sync-roles' && request.method === 'POST') {
        const body = await readJson(request)
        const storyId = String(body.storyId ?? '')
        const room = runtime.get(roomId)
        if (room.phase !== 'awaiting-player-input') throw new Error('同步剧本需要在空闲时进行。')
        const story = loadStoryPackage(storiesRoot, storyId)
        const storyImpressions = new Map(story.roles.map(item => [item.id, item.impressions]))
        story.roles = room.roles.map(role => ({
          id: role.id, name: role.name, portraitRef: role.portraitRef, currentState: role.currentState, presence: role.presence,
          memoryTimeline: role.memoryTimeline ?? {}, selfModel: role.selfModel,
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
        runtime.saveLore(roomId, lore)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/consult' && request.method === 'POST') {
        const body = await readJson(request)
        await runtime.consult(roomId, String(body.draftId), String(body.text ?? ''), String(body.context ?? ''))
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/consult/finish' && request.method === 'POST') {
        runtime.finishConsultation(roomId)
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/redraft' && request.method === 'POST') {
        const body = await readJson(request)
        await runtime.redraft(roomId, String(body.draftId))
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/api/cancel-turn' && request.method === 'POST') {
        runtime.cancelTurn(roomId)
        return json(response, 200, { ok: true })
      }
      if (url.pathname.startsWith('/assets/')) return asset(response, url.pathname)
      if (url.pathname === '/' || url.pathname === '/index.html') return staticFile(response, 'index.html', 'text/html; charset=utf-8')
      if (url.pathname === '/app.js') return staticFile(response, 'app.js', 'text/javascript; charset=utf-8')
      if (url.pathname === '/style.css') return staticFile(response, 'style.css', 'text/css; charset=utf-8')
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
    send(runtime.get(id))
    const unsubscribe = runtime.subscribe(id, send)
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
    // 先查磁盘真实文件（导入的头像 PNG/SVG）
    const filePath = join(publicRoot, path)
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = extname(filePath).toLowerCase()
      const type = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/svg+xml'
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' })
      createReadStream(filePath).pipe(response)
      return
    }
    // 兜底：内联生成的首字母 SVG（aria/mira/noel 及未知路径）
    response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' })
    response.end(portraitSvg(name))
  }

  const MAX_AVATAR_BYTES = 8 * 1024 * 1024 // 8MB 上限

  /** 保存角色头像：dataUrl（文件上传）或 url（远程导入），返回可访问的 portraitRef */
  async function saveAvatar(roleId: string, dataUrl: string, url: string): Promise<string> {
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
    writeFileSync(join(publicRoot, 'assets', fileName), buffer)
    return `/assets/${fileName}`
  }

  function staticFile(response: ServerResponse, name: string, type: string): void {
    const path = join(publicRoot, name)
    if (!existsSync(path)) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': type })
    createReadStream(path).pipe(response)
  }

  function portraitSvg(name: string): string {
    const data: Record<string, [string, string, string]> = {
      'aria.svg': ['A', '#433253', '#f0c5a7'], 'mira.svg': ['M', '#245c68', '#e2b55a'], 'noel.svg': ['N', '#4d5a37', '#c9d3b0'],
    }
    const [letter, bg, tone] = data[name] ?? data['noel.svg']
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><rect width="160" height="160" fill="${bg}"/><circle cx="80" cy="63" r="34" fill="${tone}"/><path d="M28 158c8-39 26-57 52-57s44 18 52 57" fill="${tone}"/><text x="80" y="145" text-anchor="middle" font-family="serif" font-size="26" fill="${bg}">${letter}</text></svg>`
  }

  function json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(value))
  }

  async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
  }

  function listSaves(): string[] {
    try {
      return readdirSync(saveRoot).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).sort().reverse()
    } catch {
      return []
    }
  }

  const host = options.host ?? process.env.HOST ?? '127.0.0.1'
  const port = options.port ?? Number(process.env.PORT ?? 8787)
  server.listen(port, host, () => {
    const address = server.address()
    const actualPort = typeof address === 'object' && address ? address.port : port
    console.log(`StageCraft running at http://${host}:${actualPort} (room: ${roomId})`)
  })

  return {
    store,
    runtime,
    roomId,
    gateway,
    providerStore,
    server,
    close(): Promise<void> {
      return new Promise(resolve => {
        server.close(() => {
          store.close()
          resolve()
        })
        // 立即断开 SSE 等长连接，否则 close 回调会一直等待
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      })
    },
  }
}
