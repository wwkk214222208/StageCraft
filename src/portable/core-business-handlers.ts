/**
 * Core 业务 handler 挂载（计划 §1.4 / 阶段 4；registry 驱动，禁止复制 app-boot.ts 路由串）。
 *
 * 本模块把 registry 中 core owner 的业务路由（room/turn/chat/director/roles/providers/story/
 * prompt/archive 等）映射到 Core WebView 组合根 facade（StageCraftLocalCore 的富 API 门面）。
 *
 * 结构：
 *  - `CoreBusinessHandlers`：handlerId → 实现 的声明表（handlerId 是 registry 的键，不是路由串）；
 *  - 每个实现以 (facade, body) 调用组合根方法，返回 {status, body}；
 *  - `buildPortableCoverage` 交叉验证：表中 handlerId 必须与 registry core 业务路由一一对应（测试强制）。
 *
 * 未挂载的 handlerId 由 CoreDataServer 返回稳定 handler_not_mounted，本模块只挂已实现者。
 */

import type { ApiRequest, ApiResponse, PortableApiHandler } from './api-handler.ts'
import { jsonResponse, readJsonBody } from './api-handler.ts'
import { API_ROUTES } from '../api-route-registry.ts'

/** 组合根 facade 的可用方法签名（与 android-local-core.ts 的 localCore 对齐）。 */
export interface CoreFacade {
  /** 原生端口同步调用（story/archive/preset/secret/billing 等 core-native 操作，经 CoreNativeBridge）。 */
  invokeSync: (operation: string, input?: Record<string, unknown>) => unknown
  getRoom: () => unknown
  getView: () => unknown
  submitTurn: (input: { text: string; requiredRoleIds?: string[] }) => Promise<unknown>
  cancelTurn: () => void
  speak: (roleId: string, feedback?: string) => Promise<unknown>
  speakAll: () => Promise<unknown>
  directorDecide: () => Promise<unknown>
  rejectSpeech: () => Promise<unknown>
  retrySpeak: () => Promise<unknown>
  approveSpeech: (text: string, worldChangeOverride?: unknown | null) => Promise<unknown>
  directorChat: (text: string) => Promise<unknown>
  approveWorldChange: (override?: unknown | null) => Promise<unknown>
  rejectWorldChange: () => Promise<unknown>
  proceedToDraft: () => Promise<unknown>
  rejectDraft: () => Promise<unknown>
  retryDirector: () => Promise<unknown>
  reconsiderReaction: (roleId: string, feedback: string) => Promise<unknown>
  consult: (draftId: string, playerText: string, context?: string) => Promise<unknown>
  finishConsultation: () => void
  redraft: (draftId: string) => Promise<unknown>
  approve: (draftId: string, text: string, stateUpdates: Record<string, string>, sceneUpdates?: { time?: string; location?: string }) => void
  setRoomConfig: (config: { mode?: string; autoPublish?: boolean; speechMode?: string; hidePlayerSpeech?: boolean }) => void
  updatePlayerCharacter: (player: { name?: string; persona?: string; currentState?: string }) => void
  setPlayerAvatar: (portraitRef: string) => void
  updateScene: (updates: { time?: string; location?: string }) => void
  saveLore: (lore: unknown[]) => void
  setDirectorSetting: (text: string) => void
  createRole: (role: unknown) => void
  deleteRole: (roleId: string) => void
  setRolePresence: (roleId: string, presence: string) => void
  setRoleThinking: (roleId: string, thinkingStrength: string) => void
  reorderRoles: (roleIds: string[]) => void
  setRoleAvatar: (roleId: string, portraitRef: string) => void
  setRoleCurrentState: (roleId: string, currentState: string) => void
  interveneRole: (roleId: string, selfModel: string, config?: Record<string, unknown>) => void
  storeNpcMemories: (roleId: string, entries: unknown[]) => void
  retractNpcMemory: (memoryId: string) => void
  updateNpcMemory: (memoryId: string, entry: unknown) => void
  reorderNpcMemories: (roleId: string, memoryIds: string[]) => void
  supersedeNpcMemory: (memoryId: string, entry: unknown) => void
  getProvider: () => { configured: boolean } & Record<string, unknown>
  setProvider: (config: { baseUrl: string; apiKey: string; model: string; responseFormat?: string }) => void
  stories: () => unknown[]
  story: (id: string) => Promise<unknown>
  restart: (story: unknown, options?: { mode?: string; autoPublish?: boolean }) => void
}

/** 业务 handler 实现：输入 body JSON，输出 {status, body}。 */
export type BusinessHandlerImpl = (facade: CoreFacade, body: Record<string, unknown>, params: Record<string, string>) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }

/** registry 驱动声明表：handlerId → 实现。 */
export interface CoreBusinessHandlerEntry {
  handlerId: string
  impl: BusinessHandlerImpl
}

const ok = (value: unknown): { status: number; body: unknown } => ({ status: 200, body: value })
/** 业务错误契约 = 400 {error: string}（与桌面 app-boot 外层 catch 一致）。 */
const err = (message: string): { status: number; body: unknown } => ({ status: 400, body: { error: message } })
/** 明确 unsupported 的稳定错误（评审允许路径；前端 DEGRADED 表已有容错）。 */
const unsupported = (message: string): { status: number; body: unknown } => ({
  status: 503,
  body: { error: { code: 'unsupported_capability', message } },
})
const stringOf = (body: Record<string, unknown>, key: string): string => typeof body[key] === 'string' ? body[key] as string : ''

/** 读供应商 meta（secret local.provider.meta → {providers, defaults}）。 */
function readProviderMeta(facade: CoreFacade): { providers: unknown[]; defaults: Record<string, unknown> } {
  const raw = facade.invokeSync('secret.get', { key: 'local.provider.meta' }) as { found?: boolean; value?: string } | null
  if (raw?.found && raw.value) {
    try {
      const parsed = JSON.parse(raw.value) as { providers?: unknown; defaults?: unknown }
      return {
        providers: Array.isArray(parsed.providers) ? parsed.providers : [],
        defaults: parsed.defaults && typeof parsed.defaults === 'object' ? parsed.defaults as Record<string, unknown> : {},
      }
    } catch { /* 损坏按空表 */ }
  }
  return { providers: [], defaults: {} }
}

/** 组装桌面契约的 provider 状态（剥 apiKey → hasApiKey）。 */
function providerState(facade: CoreFacade): Record<string, unknown> {
  const meta = readProviderMeta(facade)
  const providers = (meta.providers as Array<Record<string, unknown>>).map(p => {
    const clean: Record<string, unknown> = { ...p }
    delete clean.apiKey
    clean.hasApiKey = Boolean(p.hasApiKey) || Boolean(p.apiKey)
    return clean
  })
  return {
    providers,
    defaults: {
      defaultRoleProviderId: meta.defaults.defaultRoleProviderId ?? meta.defaults.role ?? '',
      defaultRoleModel: meta.defaults.defaultRoleModel ?? '',
      directorProviderId: meta.defaults.directorProviderId ?? meta.defaults.director ?? '',
      directorModel: meta.defaults.directorModel ?? '',
      assistantProviderId: meta.defaults.assistantProviderId ?? '',
      assistantModel: meta.defaults.assistantModel ?? '',
      ...(meta.defaults.directorThinkingStrength ? { directorThinkingStrength: meta.defaults.directorThinkingStrength } : {}),
    },
  }
}
const stringArray = (body: Record<string, unknown>, key: string): string[] => Array.isArray(body[key]) ? (body[key] as unknown[]).filter((item): item is string => typeof item === 'string') : []
const recordOf = (body: Record<string, unknown>, key: string): Record<string, string> => {
  const value = body[key]
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === 'string') result[k] = v
    return result
  }
  return {}
}

/**
 * 业务 handler 声明表（合流契约：handlerId 与 registry 一一对应，测试强制无漂移）。
 * 所有实现只调组合根 facade，不复制 app-boot.ts 路由串。
 */
export const CORE_BUSINESS_HANDLERS: readonly CoreBusinessHandlerEntry[] = [
  // ── 房间 ──
  { handlerId: 'room.restart', impl: async (facade, body) => {
    // 重开剧本（业务语义，与桌面一致）——清除当前回合/草稿/已批准正文，
    // 按 storyId/mode/autoPublish 重开房间。原 Android registry 误映射为
    // host.restart（重启 Core 进程）导致每次重开=Core 重启+数据面断连，已修正。
    const storyId = stringOf(body, 'storyId') || ''
    if (!storyId) return err('storyId 缺失')
    const story = await facade.story(storyId)
    if (!story) return err('剧本不存在: ' + storyId)
    const options: { mode?: string; autoPublish?: boolean } = {}
    if (body.mode === 'chat' || body.mode === 'director') options.mode = body.mode
    if (typeof body.autoPublish === 'boolean') options.autoPublish = body.autoPublish
    facade.restart(story, options)
    return ok({ ok: true })
  } },
  { handlerId: 'room.snapshot', impl: facade => ok(facade.getRoom()) },
  { handlerId: 'room.config', impl: (facade, body) => {
    const config: { mode?: string; autoPublish?: boolean; speechMode?: string; hidePlayerSpeech?: boolean } = {}
    if (typeof body.mode === 'string') config.mode = body.mode
    if (typeof body.autoPublish === 'boolean') config.autoPublish = body.autoPublish
    if (typeof body.speechMode === 'string') config.speechMode = body.speechMode
    if (typeof body.hidePlayerSpeech === 'boolean') config.hidePlayerSpeech = body.hidePlayerSpeech
    facade.setRoomConfig(config)
    return ok({ ok: true })
  } },
  { handlerId: 'room.scene', impl: (facade, body) => {
    const updates: { time?: string; location?: string } = {}
    if (typeof body.time === 'string') updates.time = body.time
    if (typeof body.location === 'string') updates.location = body.location
    facade.updateScene(updates)
    return ok({ ok: true })
  } },
  { handlerId: 'room.lore', impl: (facade, body) => {
    const lore = Array.isArray(body.lore) ? body.lore : (Array.isArray(body.entries) ? body.entries : [])
    facade.saveLore(lore)
    return ok({ ok: true })
  } },

  // ── 回合 ──
  { handlerId: 'turn.start', impl: async (facade, body) => {
    const input: { text: string; requiredRoleIds?: string[] } = { text: stringOf(body, 'text') }
    const required = stringArray(body, 'requiredRoleIds')
    if (required.length > 0) input.requiredRoleIds = required
    await facade.submitTurn(input)
    return ok({ ok: true, view: facade.getView() })
  } },
  { handlerId: 'turn.cancel', impl: facade => { facade.cancelTurn(); return ok({ ok: true }) } },

  // ── 聊天 ──
  { handlerId: 'chat.speak', impl: async (facade, body) => { await facade.speak(stringOf(body, 'roleId'), stringOf(body, 'feedback')); return ok({ ok: true }) } },
  { handlerId: 'chat.speak-all', impl: async facade => { await facade.speakAll(); return ok({ ok: true }) } },
  { handlerId: 'chat.retry', impl: async facade => { await facade.retrySpeak(); return ok({ ok: true }) } },
  { handlerId: 'chat.approve-speech', impl: async (facade, body) => {
    const text = stringOf(body, 'text')
    const override = body.worldChange ?? null
    await facade.approveSpeech(text, override)
    return ok({ ok: true })
  } },
  { handlerId: 'chat.reject-speech', impl: async facade => { await facade.rejectSpeech(); return ok({ ok: true }) } },
  { handlerId: 'chat.director-chat', impl: async (facade, body) => { await facade.directorChat(stringOf(body, 'text')); return ok({ ok: true }) } },
  { handlerId: 'chat.director-decide', impl: async facade => { await facade.directorDecide(); return ok({ ok: true }) } },

  // ── 导演 ──
  { handlerId: 'director.proceed', impl: async facade => { await facade.proceedToDraft(); return ok({ ok: true }) } },
  { handlerId: 'director.retry', impl: async facade => { await facade.retryDirector(); return ok({ ok: true }) } },
  { handlerId: 'director.setting', impl: (facade, body) => { facade.setDirectorSetting(stringOf(body, 'text')); return ok({ ok: true }) } },

  // ── 工作流（咨询/审批/草稿）──
  { handlerId: 'workflow.approve', impl: async (facade, body) => {
    const draftId = stringOf(body, 'draftId')
    const text = stringOf(body, 'text')
    facade.approve(draftId, text, recordOf(body, 'stateUpdates'), body.sceneUpdates as { time?: string; location?: string } | undefined)
    return ok({ ok: true })
  } },
  { handlerId: 'workflow.consult', impl: async (facade, body) => {
    // 桌面/前端契约字段是 text（app-boot.ts /api/consult 读 body.text）；playerText 仅作旧调用方兼容回退。
    await facade.consult(stringOf(body, 'draftId'), stringOf(body, 'text') || stringOf(body, 'playerText'), stringOf(body, 'context'))
    return ok({ ok: true })
  } },
  { handlerId: 'workflow.consult.finish', impl: facade => { facade.finishConsultation(); return ok({ ok: true }) } },
  { handlerId: 'workflow.redraft', impl: async (facade, body) => { await facade.redraft(stringOf(body, 'draftId')); return ok({ ok: true }) } },
  { handlerId: 'workflow.reactions.reconsider', impl: async (facade, body) => {
    await facade.reconsiderReaction(stringOf(body, 'roleId'), stringOf(body, 'feedback'))
    return ok({ ok: true })
  } },
  { handlerId: 'workflow.world-change.approve', impl: async (facade, body) => {
    // 桌面/前端契约字段是 worldChange（app-boot.ts /api/world-change/approve 读 body.worldChange）；override 仅作旧调用方兼容回退。
    const worldChange = (body.worldChange && typeof body.worldChange === 'object') ? body.worldChange : (body.override && typeof body.override === 'object' ? body.override : null)
    await facade.approveWorldChange(worldChange)
    return ok({ ok: true })
  } },
  { handlerId: 'workflow.world-change.reject', impl: async facade => { await facade.rejectWorldChange(); return ok({ ok: true }) } },
  { handlerId: 'director.draft-approval', impl: async (facade, body) => {
    await facade.approveSpeech(stringOf(body, 'text'), body.worldChange ?? null)
    return ok({ ok: true })
  } },

  // ── 角色 ──
  { handlerId: 'role.create', impl: (facade, body) => { facade.createRole(body.role ?? body); return ok({ ok: true }) } },
  { handlerId: 'role.delete', impl: (facade, body) => { facade.deleteRole(stringOf(body, 'roleId')); return ok({ ok: true }) } },
  { handlerId: 'role.presence', impl: (facade, body) => { facade.setRolePresence(stringOf(body, 'roleId'), stringOf(body, 'presence')); return ok({ ok: true }) } },
  { handlerId: 'role.thinking', impl: (facade, body) => {
    // 桌面/前端契约字段是 thinking（app-boot.ts /api/roles/thinking 读 body.thinking）；thinkingStrength 仅作旧调用方兼容回退。
    const thinking = stringOf(body, 'thinking') || stringOf(body, 'thinkingStrength')
    if (!['off', 'brief', 'standard', 'deep'].includes(thinking)) return err('无效的思维链强度。')
    facade.setRoleThinking(stringOf(body, 'roleId'), thinking)
    return ok({ ok: true })
  } },
  { handlerId: 'role.reorder', impl: (facade, body) => { facade.reorderRoles(stringArray(body, 'roleIds')); return ok({ ok: true }) } },
  { handlerId: 'role.state', impl: (facade, body) => { facade.setRoleCurrentState(stringOf(body, 'roleId'), stringOf(body, 'currentState')); return ok({ ok: true }) } },
  { handlerId: 'role.intervene', impl: (facade, body) => {
    // 桌面/前端契约是平铺字段（app-boot.ts /api/roles/intervene 读 body.providerId/modelOverride/
    // impressions(JSON 字符串)/goals(JSON 字符串)/thinkingStrength 组装 config）；body.config 仅作旧调用方兼容。
    const config: Record<string, unknown> = {}
    const direct = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config as Record<string, unknown> : null
    if (direct) {
      for (const key of ['providerId', 'modelOverride', 'impressions', 'goals', 'thinkingStrength']) {
        if (direct[key] !== undefined) config[key] = direct[key]
      }
    }
    if (body.providerId) config.providerId = String(body.providerId)
    if (body.modelOverride) config.modelOverride = String(body.modelOverride)
    if (typeof body.impressions === 'string' && body.impressions) {
      try { config.impressions = JSON.parse(body.impressions) as Record<string, string> } catch { /* 非法 JSON 忽略 */ }
    } else if (body.impressions && typeof body.impressions === 'object') {
      config.impressions = body.impressions
    }
    if (typeof body.goals === 'string' && body.goals) {
      try { config.goals = JSON.parse(body.goals) as string[] } catch { /* 非法 JSON 忽略 */ }
    } else if (Array.isArray(body.goals)) {
      config.goals = body.goals
    }
    if (body.thinkingStrength) config.thinkingStrength = String(body.thinkingStrength)
    facade.interveneRole(stringOf(body, 'roleId'), stringOf(body, 'selfModel'), config)
    return ok({ ok: true })
  } },
  { handlerId: 'role.avatar', impl: (facade, body) => { facade.setRoleAvatar(stringOf(body, 'roleId'), stringOf(body, 'portraitRef')); return ok({ ok: true }) } },
  { handlerId: 'role.memories.upsert', impl: (facade, body) => {
    facade.storeNpcMemories(stringOf(body, 'roleId'), Array.isArray(body.entries) ? body.entries : [])
    return ok({ ok: true })
  } },
  { handlerId: 'role.memories.retract', impl: (facade, body) => { facade.retractNpcMemory(stringOf(body, 'memoryId')); return ok({ ok: true }) } },
  { handlerId: 'role.memories.update', impl: (facade, body) => { facade.updateNpcMemory(stringOf(body, 'memoryId'), body.entry ?? {}); return ok({ ok: true }) } },
  { handlerId: 'role.memories.reorder', impl: (facade, body) => { facade.reorderNpcMemories(stringOf(body, 'roleId'), stringArray(body, 'memoryIds')); return ok({ ok: true }) } },
  { handlerId: 'role.memories.supersede', impl: (facade, body) => { facade.supersedeNpcMemory(stringOf(body, 'memoryId'), body.entry ?? {}); return ok({ ok: true }) } },
  // 桌面契约 GET /api/roles/memories?roleId=<id> → {memories: [...]}（未知 roleId → 空数组）
  { handlerId: 'role.memories.list', impl: (facade, body) => {
    const room = facade.getRoom() as { roles?: Array<{ id?: string; memories?: unknown[] }> } | null
    const roles = Array.isArray(room?.roles) ? room.roles : []
    const roleId = stringOf(body, 'roleId')
    if (!roleId) return ok({ memories: [] })
    const role = roles.find(item => item.id === roleId)
    return ok({ memories: Array.isArray(role?.memories) ? role.memories : [] })
  } },

  // ── 玩家 ──
  { handlerId: 'player.character', impl: (facade, body) => {
    facade.updatePlayerCharacter({
      name: stringOf(body, 'name'),
      persona: stringOf(body, 'persona'),
      currentState: stringOf(body, 'currentState'),
    })
    return ok({ ok: true })
  } },
  { handlerId: 'player.avatar', impl: (facade, body) => { facade.setPlayerAvatar(stringOf(body, 'portraitRef')); return ok({ ok: true }) } },

  // ── 供应商 ──
  // 桌面契约 {providers: [{id,name,baseUrl,models,selectedModel,hasApiKey,responseFormat}], defaults: {...}}
  // 从 secret local.provider.meta 组装（与旧 shim providerMetaView 同语义，形状对齐桌面 provider-config.ts）
  { handlerId: 'provider.list', impl: facade => ok(providerState(facade)) },
  { handlerId: 'provider.save', impl: (facade, body) => {
    const config = body.config && typeof body.config === 'object' ? body.config as Record<string, unknown> : body
    // 读取现有 meta，追加/更新供应商
    const meta = readProviderMeta(facade)
    const providers = Array.isArray(meta.providers) ? meta.providers as Array<Record<string, unknown>> : []
    const id = stringOf(config, 'id') || stringOf(config, 'name') || 'provider-' + providers.length
    const existing = providers.findIndex(p => p.id === id)
    const entry: Record<string, unknown> = {
      id,
      name: stringOf(config, 'name') || id,
      baseUrl: stringOf(config, 'baseUrl'),
      models: Array.isArray(config.models) ? config.models : (stringOf(config, 'model') ? [stringOf(config, 'model')] : []),
      selectedModel: stringOf(config, 'selectedModel') || stringOf(config, 'model') || '',
      hasApiKey: Boolean(stringOf(config, 'apiKey')) || Boolean(stringOf(config, 'hasApiKey')),
      responseFormat: stringOf(config, 'responseFormat') || 'json_object',
    }
    if (stringOf(config, 'apiKey')) entry.apiKey = stringOf(config, 'apiKey') // 仅内部存，响应剥掉
    if (existing >= 0) providers[existing] = { ...providers[existing], ...entry }
    else providers.push(entry)
    facade.invokeSync('secret.set', { key: 'local.provider.meta', value: JSON.stringify({ providers, defaults: meta.defaults ?? {} }) })
    // 激活当前供应商（组合根 setProvider 用 baseUrl/apiKey/model）
    facade.setProvider({ baseUrl: entry.baseUrl as string, apiKey: stringOf(config, 'apiKey'), model: entry.selectedModel as string, responseFormat: entry.responseFormat as 'json_object' | 'none' | undefined })
    return ok(providerState(facade))
  } },
  { handlerId: 'provider.delete', impl: (facade, body) => {
    const meta = readProviderMeta(facade)
    const providers = Array.isArray(meta.providers) ? meta.providers as Array<Record<string, unknown>> : []
    const id = stringOf(body, 'id') || stringOf(body, 'providerId')
    const next = providers.filter(p => p.id !== id)
    if (next.length === providers.length) return err('供应商不存在')
    facade.invokeSync('secret.set', { key: 'local.provider.meta', value: JSON.stringify({ providers: next, defaults: meta.defaults ?? {} }) })
    return ok(providerState(facade))
  } },

  // ── 故事 ──
  // 桌面契约 GET /api/stories → 裸数组 [{id,title,custom}]；GET /api/story/get?id= → 裸 StoryPackage
  { handlerId: 'story.list', impl: facade => ok(facade.stories()) },
  { handlerId: 'story.get', impl: async (facade, body) => { const story = await facade.story(stringOf(body, 'id')); return ok(story) } },

  // ── 补挂：故事写入/导入导出（经原生端口 core-native 操作）──
  { handlerId: 'story.create', impl: (facade, body) => {
    const result = facade.invokeSync('story.create', { title: stringOf(body, 'title'), opening: body.opening ?? '', playerCharacter: body.playerCharacter ?? {}, roles: Array.isArray(body.roles) ? body.roles : [] }) as { id?: string; title?: string } | null
    return ok({ ok: true, id: result?.id ?? stringOf(body, 'title'), title: result?.title ?? stringOf(body, 'title') })
  } },
  // 桌面契约 DELETE /api/stories?id= → {ok:true, id}
  { handlerId: 'story.delete', impl: (facade, body) => {
    const id = stringOf(body, 'id')
    if (!id) return err('故事 id 缺失')
    facade.invokeSync('story.delete', { id })
    return ok({ ok: true, id })
  } },
  { handlerId: 'story.save', impl: (facade, body) => {
    const story = (body.story ?? body) as { id?: string }
    if (!story?.id) return err('故事 id 缺失')
    facade.invokeSync('story.save', { story })
    return ok({ ok: true })
  } },
  // save-as 目标 ID 语义与桌面一致——
  // 1) newId/new_id 优先（显式目标）；
  // 2) body.id 与 story.id 不同 → 兼容为显式目标 ID（桌面 app-boot 语义：body.id 即目标）；
  // 3) 完全无显式目标 → 生成 story-<timestamp36>（与原生 saveAs id 规则同形；碰撞重试后缀）。
  // 源 ID 只作复制来源，绝不写源键。
  { handlerId: 'story.save-as', impl: (facade, body) => {
    const story = (body.story ?? body) as { id?: string; title?: string }
    const sourceId = story?.id
    if (!sourceId) return err('故事 id 缺失')
    const explicitNewId = stringOf(body, 'newId') || stringOf(body, 'new_id')
    const bodyId = stringOf(body, 'id')
    // 显式目标：newId 优先；否则 body.id 与 story.id 不同时视为目标（桌面兼容）
    let targetId = explicitNewId
    if (!targetId && bodyId && bodyId !== sourceId) targetId = bodyId
    if (!targetId) {
      // 生成新 ID（时间戳 36 进制 + 随机后缀）；冲突重试（目标键已存在则重生成，最多 5 次）
      const existing = new Set((facade.stories() as Array<{ id?: string }>).map(item => item.id).filter(Boolean))
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = 'story-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
        if (!existing.has(candidate)) { targetId = candidate; break }
      }
      if (!targetId) return err('无法生成唯一故事 ID（重试耗尽）')
    }
    const title = stringOf(body, 'title') || story?.title || targetId
    const copy = { ...(story ?? {}), id: targetId, title }
    facade.invokeSync('story.saveAs', { id: targetId, title, story: copy })
    return ok({ ok: true, id: targetId, title })
  } },
  // story/archive 导入导出是 zip/文件字节，经 SAF 原生通道（NativeBridge.importStoryDocument/
  // exportDocument）承载；gateway 路由返回明确稳定 unsupported，UI 走同一受测入口（不假挂载 JSON 占位）。
  { handlerId: 'story.import', impl: () => unsupported('剧本导入经 SAF 原生通道（文件选择器）') },
  { handlerId: 'story.export', impl: () => unsupported('剧本导出经 SAF 原生通道（创建文档）') },
  { handlerId: 'archive.import', impl: () => unsupported('存档导入经 SAF 原生通道（文件选择器）') },
  { handlerId: 'archive.export', impl: () => unsupported('存档导出经 SAF 原生通道（创建文档）') },

  // ── 补挂：存档（经原生端口）──
  { handlerId: 'archive.list', impl: facade => { const result = facade.invokeSync('archive.list', {}) as { files?: unknown[] } | null; return ok(result ?? { files: [] }) } },
  // 桌面契约 archive.save → {ok:true, name, files:[...]}
  { handlerId: 'archive.save', impl: (facade, body) => {
    const name = stringOf(body, 'name') || '存档-' + new Date().toISOString().slice(0, 10)
    facade.invokeSync('archive.save', { name, archive: body.archive ?? {} })
    const files = (facade.invokeSync('archive.list', {}) as { files?: string[] } | null)?.files ?? []
    return ok({ ok: true, name, files })
  } },
  { handlerId: 'archive.load', impl: (facade, body) => { const result = facade.invokeSync('archive.load', { name: stringOf(body, 'name') }); return ok(result ?? { ok: true }) } },
  // 桌面契约 archive.delete → {ok:true, files:[...]}
  { handlerId: 'archive.delete', impl: (facade, body) => {
    const name = stringOf(body, 'name')
    if (!name) return err('存档名缺失')
    const result = facade.invokeSync('archive.delete', { name }) as { ok?: boolean; error?: { message?: string } } | null
    if (result && result.ok === false) return err(result.error?.message ?? '存档不存在或已删除。')
    const files = (facade.invokeSync('archive.list', {}) as { files?: string[] } | null)?.files ?? []
    return ok({ ok: true, files })
  } },

  // ── 补挂：供应商扩展（经原生端口 secret）──
  { handlerId: 'provider.default-role', impl: (facade, body) => {
    const meta = readProviderMeta(facade)
    const defaults = { ...(meta.defaults ?? {}), defaultRoleProviderId: stringOf(body, 'id') || stringOf(body, 'providerId'), defaultRoleModel: stringOf(body, 'model') || meta.defaults.defaultRoleModel || '' }
    facade.invokeSync('secret.set', { key: 'local.provider.meta', value: JSON.stringify({ providers: meta.providers, defaults }) })
    return ok(providerState(facade))
  } },
  { handlerId: 'provider.director', impl: (facade, body) => {
    const meta = readProviderMeta(facade)
    const defaults = { ...(meta.defaults ?? {}), directorProviderId: stringOf(body, 'id') || stringOf(body, 'providerId'), directorModel: stringOf(body, 'model') || meta.defaults.directorModel || '' }
    facade.invokeSync('secret.set', { key: 'local.provider.meta', value: JSON.stringify({ providers: meta.providers, defaults }) })
    return ok(providerState(facade))
  } },
  { handlerId: 'provider.director-thinking', impl: (facade, body) => {
    const meta = readProviderMeta(facade)
    const defaults = { ...(meta.defaults ?? {}), directorThinkingStrength: stringOf(body, 'thinking') || stringOf(body, 'strength') || meta.defaults.directorThinkingStrength || 'standard' }
    facade.invokeSync('secret.set', { key: 'local.provider.meta', value: JSON.stringify({ providers: meta.providers, defaults }) })
    return ok({ ok: true, defaults })
  } },

  // ── 补挂：计费/用量（经原生端口 secret 持久化；billing 为本地模拟）──
  // 桌面契约 GET /api/billing → {prices: {...}, stats: {...}}（renderBilling 读 data.stats/data.prices）
  { handlerId: 'billing.summary', impl: facade => {
    const pricesRaw = facade.invokeSync('secret.get', { key: 'local.billing.prices' }) as { found?: boolean; value?: string } | null
    const statsRaw = facade.invokeSync('secret.get', { key: 'local.billing.state' }) as { found?: boolean; value?: string } | null
    const prices = pricesRaw?.found && pricesRaw.value ? JSON.parse(pricesRaw.value) : { version: 1, rates: [] }
    const stats = statsRaw?.found && statsRaw.value ? JSON.parse(statsRaw.value) : { version: 1, currency: 'RMB', totalCost: 0, requests: 0, byProvider: [], byModel: [] }
    return ok({ prices, stats })
  } },
  { handlerId: 'billing.prices.get', impl: facade => {
    const raw = facade.invokeSync('secret.get', { key: 'local.billing.prices' }) as { found?: boolean; value?: string } | null
    return ok(raw?.found && raw.value ? JSON.parse(raw.value) : { version: 1, rates: [] })
  } },
  // 桌面契约 PUT /api/billing/prices → {prices, stats}（前端保存后直接 renderBilling）
  { handlerId: 'billing.prices.put', impl: (facade, body) => {
    facade.invokeSync('secret.set', { key: 'local.billing.prices', value: JSON.stringify(body.prices ?? body) })
    const statsRaw = facade.invokeSync('secret.get', { key: 'local.billing.state' }) as { found?: boolean; value?: string } | null
    const stats = statsRaw?.found && statsRaw.value ? JSON.parse(statsRaw.value) : { version: 1, currency: 'RMB', totalCost: 0, requests: 0, byProvider: [], byModel: [] }
    return ok({ prices: body.prices ?? body, stats })
  } },
  // 桌面契约 POST /api/billing/reset → 裸 stats 对象
  { handlerId: 'billing.reset', impl: facade => {
    const emptyStats = { version: 1, currency: 'RMB', totalCost: 0, requests: 0, updatedAt: new Date().toISOString(), byProvider: [], byModel: [] }
    facade.invokeSync('secret.set', { key: 'local.billing.state', value: JSON.stringify(emptyStats) })
    return ok(emptyStats)
  } },
  { handlerId: 'billing.usage', impl: facade => {
    const raw = facade.invokeSync('secret.get', { key: 'local.billing.state' }) as { found?: boolean; value?: string } | null
    const state = raw?.found && raw.value ? JSON.parse(raw.value) as Record<string, unknown> : {}
    return ok({ route: '模拟', model: '模拟', requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalDurationMs: 0, avgDurationMs: 0, mode: 'fake', billing: state })
  } },

  // ── 补挂：提示词预设（经原生端口 preset）──
  // 桌面契约 GET /api/prompts/presets → {presets, activeByScope, modes, gameplayScenarios}；
  // activeByScope 从 preset.list 的 SQLite 存储读取（非固定空对象）
  { handlerId: 'prompt.presets.list', impl: facade => {
    const result = facade.invokeSync('preset.list', {}) as { presets?: unknown[]; activeByScope?: Record<string, string> } | null
    // gameplayScenarios 从打包资产读取（prompt.gameplay.list 原生端口；非固定空对象）
    const gameplay = facade.invokeSync('prompt.gameplay.list', {}) as { gameplayScenarios?: Record<string, unknown> } | null
    return ok({
      presets: result?.presets ?? [],
      activeByScope: result?.activeByScope ?? {},
      modes: [{ id: 'director', name: '导演模式' }, { id: 'chat', name: '群聊模式' }],
      gameplayScenarios: gameplay?.gameplayScenarios ?? {},
    })
  } },
  // 桌面契约 PUT 两种模式 → 裸 PromptPresetState 或 {ok:true, presets}；
  // 切换当前预设走 preset.active-scope.set 同一 SQLite 存储（合并更新，不覆盖其他 scope）
  { handlerId: 'prompt.presets.put', impl: (facade, body) => {
    if (body.preset) {
      facade.invokeSync('preset.save', { preset: body.preset })
      const result = facade.invokeSync('preset.list', {}) as { presets?: unknown[] } | null
      return ok({ ok: true, presets: result?.presets ?? [] })
    }
    // 切换 scope 的当前预设：读现有 activeByScope → 合并更新 → 写同一 SQLite
    const scope = stringOf(body, 'scope')
    const activePresetId = stringOf(body, 'activePresetId')
    if (!scope || !activePresetId) return err('scope 与 activePresetId 必填')
    const current = (facade.invokeSync('preset.list', {}) as { activeByScope?: Record<string, string> } | null)?.activeByScope ?? {}
    const merged = { ...current, [scope]: activePresetId }
    facade.invokeSync('preset.active-scope.set', { activeByScope: merged })
    const result = facade.invokeSync('preset.list', {}) as { presets?: unknown[]; activeByScope?: Record<string, string> } | null
    return ok({ presets: result?.presets ?? [], activeByScope: result?.activeByScope ?? merged })
  } },
  // 桌面契约 DELETE /api/prompts/presets?id= → {ok:true, presets}
  { handlerId: 'prompt.presets.delete', impl: (facade, body) => {
    const id = stringOf(body, 'id')
    if (!id) return err('预设 id 缺失')
    facade.invokeSync('preset.delete', { id })
    const result = facade.invokeSync('preset.list', {}) as { presets?: unknown[] } | null
    return ok({ ok: true, presets: result?.presets ?? [] })
  } },
  { handlerId: 'prompt.presets.export', impl: () => unsupported('预设导出经 SAF 原生通道（创建文档）') },
  // 桌面契约 GET/PUT /api/prompts/private-toggles（GET 读持久化值）
  { handlerId: 'prompt.private-toggles.get', impl: facade => {
    const raw = facade.invokeSync('secret.get', { key: 'local.prompt.private-toggles' }) as { found?: boolean; value?: string } | null
    return ok(raw?.found && raw.value ? JSON.parse(raw.value) : {})
  } },
  { handlerId: 'prompt.private-toggles.put', impl: (facade, body) => {
    const raw = facade.invokeSync('secret.get', { key: 'local.prompt.private-toggles' }) as { found?: boolean; value?: string } | null
    const current = raw?.found && raw.value ? JSON.parse(raw.value) as Record<string, unknown> : {}
    const presetId = stringOf(body, 'presetId')
    const nodeId = stringOf(body, 'nodeId')
    if (presetId && nodeId) {
      const preset = (current[presetId] && typeof current[presetId] === 'object' ? current[presetId] as Record<string, unknown> : {})
      preset[nodeId] = body.enabled === true || body.enabled === undefined
      current[presetId] = preset
    } else if (body.toggles && typeof body.toggles === 'object') {
      Object.assign(current, body.toggles)
    }
    facade.invokeSync('secret.set', { key: 'local.prompt.private-toggles', value: JSON.stringify(current) })
    const result = facade.invokeSync('preset.list', {}) as { presets?: unknown[] } | null
    return ok({ ok: true, presets: result?.presets ?? [] })
  } },

  // ── 逐条裁决（明确 unsupported + 前端 DEGRADED 容错；评审允许路径）──
  // state.rollback/branch/scene-revision：Android 无正文回滚/分支语义（桌面专属）→ 稳定 unsupported
  { handlerId: 'state.rollback', impl: () => unsupported('正文回滚仅桌面支持（Android 本地无状态分支语义）') },
  { handlerId: 'state.branch', impl: () => unsupported('正文分支仅桌面支持（Android 本地无状态分支语义）') },
  { handlerId: 'state.scene-revision', impl: () => unsupported('正文字段回滚仅桌面支持') },
  // provider.discover：Android 无模型发现服务 → 稳定 unsupported
  { handlerId: 'provider.discover', impl: () => unsupported('模型发现仅桌面支持（Android 手动配置供应商）') },
  // story.sync-role(s)：角色同步是桌面与远程间的同步语义，本地单设备无意义 → 稳定 unsupported
  { handlerId: 'story.sync-role', impl: () => unsupported('角色同步仅远程/桌面同步流程使用') },
  { handlerId: 'story.sync-roles', impl: () => unsupported('角色同步仅远程/桌面同步流程使用') },
  // prompt.import-st：ST 卡导入是桌面创作流程 → 稳定 unsupported
  { handlerId: 'prompt.import-st', impl: () => unsupported('ST 卡导入仅桌面支持') },
  // creator.*：创作者工作台是桌面创作流程（Android 无创作工作台 UI）→ 稳定 unsupported
  { handlerId: 'creator.preview', impl: () => unsupported('创作者工作台仅桌面支持') },
  { handlerId: 'creator.apply', impl: () => unsupported('创作者工作台仅桌面支持') },
  { handlerId: 'creator.revert', impl: () => unsupported('创作者工作台仅桌面支持') },
  // st-cards.import：ST 卡导入仅桌面 → 稳定 unsupported
  { handlerId: 'creator.st-cards.import', impl: () => unsupported('ST 卡导入仅桌面支持') },
]

/**
 * 业务 handler 的 PortableApiHandler 适配（与 CoreProtocolPortableHandler 并列，
 * 由 handlePortableApi 分发）。matches 由 handlerId 反查 registry 派生（避免复制路由串）。
 */
export class CoreBusinessPortableHandler implements PortableApiHandler {
  private readonly facade: CoreFacade
  private readonly routes: ReadonlyArray<{ handlerId: string; method: string; pattern: string }>
  private readonly byHandlerId: Map<string, BusinessHandlerImpl>

  constructor(facade: CoreFacade, routes: ReadonlyArray<{ handlerId: string; method: string; pattern: string }>) {
    this.facade = facade
    this.routes = routes
    this.byHandlerId = new Map(CORE_BUSINESS_HANDLERS.map(entry => [entry.handlerId, entry.impl]))
  }

  matches(method: string, path: string): boolean {
    return this.routes.some(route =>
      route.method === method.toUpperCase() && matchPattern(route.pattern, path))
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    const path = request.url.split('?')[0]
    const method = request.method.toUpperCase()
    const route = this.routes.find(item => item.method === method && matchPattern(item.pattern, path))
    if (!route) return jsonResponse(404, { error: { code: 'not_found', message: `未登记的业务 handler：${method} ${path}` } })
    const impl = this.byHandlerId.get(route.handlerId)
    if (!impl) {
      // 声明了路由但未挂载：稳定 handler_not_mounted（与 CoreDataServer 的未挂载语义一致）
      return jsonResponse(503, { error: { code: 'handler_not_mounted', message: 'core handler not mounted yet', handlerId: route.handlerId } })
    }
    try {
      const body = await readJsonBody(request)
      const params = extractParams(route.pattern, path)
      // query 参数并入 body（GET/DELETE 的 ?id=... 等）；query 优先于 body 同名字段
      const queryParams = parseQuery(request.url)
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined) body[key] = value
      }
      const result = await impl(this.facade, body, params)
      return jsonResponse(result.status, result.body)
    } catch (error) {
      // 业务错误契约 = 400 {error: string}（与桌面 app-boot 外层 catch 一致；前端读 body.error）
      return jsonResponse(400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** 解析 URL query 为参数表（无 query 返回空对象）。 */
export function parseQuery(url: string): Record<string, string> {
  const queryIndex = url.indexOf('?')
  if (queryIndex < 0) return {}
  const params: Record<string, string> = {}
  for (const pair of url.slice(queryIndex + 1).split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const key = eq < 0 ? pair : pair.slice(0, eq)
    const value = eq < 0 ? '' : pair.slice(eq + 1)
    if (key) params[decodeURIComponent(key)] = decodeURIComponent(value)
  }
  return params
}

/** 静态/参数 pattern 匹配（与 RouteRegistry.match 同语义：段数相同、静态段相等）。 */
export function matchPattern(pattern: string, path: string): boolean {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = path.split('/').filter(Boolean)
  if (patternParts.length !== pathParts.length) return false
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith('{')) continue
    if (patternParts[i] !== pathParts[i]) return false
  }
  return true
}

/** 从参数 pattern 提取路径参数。 */
export function extractParams(pattern: string, path: string): Record<string, string> {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = path.split('/').filter(Boolean)
  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    const segment = patternParts[i]
    if (segment.startsWith('{') && segment.endsWith('}')) {
      params[segment.slice(1, -1)] = decodeURIComponent(pathParts[i] ?? '')
    }
  }
  return params
}

/** 校验挂载覆盖——表中 handlerId 与给定 core 业务路由一一对应（测试强制无漂移）。 */
export function buildBusinessCoverage(
  routes: ReadonlyArray<{ handlerId: string; method: string; pattern: string; owner: string }>,
): Array<{ handlerId: string; mounted: boolean }> {
  const mounted = new Set(CORE_BUSINESS_HANDLERS.map(entry => entry.handlerId))
  return routes
    .filter(route => route.owner === 'core' && !route.pattern.startsWith('/api/core/'))
    .map(route => ({ handlerId: route.handlerId, mounted: mounted.has(route.handlerId) }))
}

/**
 * registry 驱动的业务路由表（与 api-route-registry.json 同源，构建期确定）。
 * 只含 core owner 且非协议端点的业务路由；CoreBusinessPortableHandler 用它在分发时
 * 把 method/path 反查为 handlerId（不复制 app-boot.ts 路由串）。
 */
export const CORE_BUSINESS_ROUTES: ReadonlyArray<{ handlerId: string; method: string; pattern: string }> = Object.freeze(
  API_ROUTES
    .filter(route => route.owner === 'core' && !route.pattern.startsWith('/api/core/'))
    .map(route => ({ handlerId: route.handlerId, method: route.method, pattern: route.pattern })),
)
