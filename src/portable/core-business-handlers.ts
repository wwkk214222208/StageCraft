/**
 * W6：Core 业务 handler 挂载（计划 §1.4 / 阶段 4；registry 驱动，禁止复制 app-boot.ts 路由串）。
 *
 * 本模块把 registry 中 core owner 的业务路由（room/turn/chat/director/roles/providers/story/
 * prompt/archive 等）映射到 Core WebView 组合根 facade（StageCraftLocalCore 的富 API 门面）。
 *
 * 结构：
 *  - `CoreBusinessHandlers`：handlerId → 实现 的声明表（handlerId 是 registry 的键，不是路由串）；
 *  - 每个实现以 (facade, body) 调用组合根方法，返回 {status, body}；
 *  - `buildPortableCoverage` 交叉验证：表中 handlerId 必须与 registry core 业务路由一一对应（测试强制）。
 *
 * 未挂载的 handlerId 由 CoreDataServer 返回稳定 handler_not_mounted（W5-5），本模块只挂已实现者。
 */

import type { ApiRequest, ApiResponse, PortableApiHandler } from './api-handler.ts'
import { jsonResponse, readJsonBody } from './api-handler.ts'
import { API_ROUTES } from '../api-route-registry.ts'

/** 组合根 facade 的可用方法签名（与 android-local-core.ts 的 localCore 对齐）。 */
export interface CoreFacade {
  /** W6-1：原生端口同步调用（story/archive/preset/secret/billing 等 core-native 操作，经 CoreNativeBridge）。 */
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
/** W6-1 逐条裁决：明确 unsupported 的稳定错误（评审允许路径；前端 DEGRADED 表已有容错）。 */
const unsupported = (message: string): { status: number; body: unknown } => ({
  status: 503,
  body: { error: { code: 'unsupported_capability', message } },
})
const stringOf = (body: Record<string, unknown>, key: string): string => typeof body[key] === 'string' ? body[key] as string : ''
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
 * 业务 handler 声明表（W6 合流契约：handlerId 与 registry 一一对应，测试强制无漂移）。
 * 所有实现只调组合根 facade，不复制 app-boot.ts 路由串。
 */
export const CORE_BUSINESS_HANDLERS: readonly CoreBusinessHandlerEntry[] = [
  // ── 房间 ──
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
    await facade.consult(stringOf(body, 'draftId'), stringOf(body, 'playerText'), stringOf(body, 'context'))
    return ok({ ok: true })
  } },
  { handlerId: 'workflow.consult.finish', impl: facade => { facade.finishConsultation(); return ok({ ok: true }) } },
  { handlerId: 'workflow.redraft', impl: async (facade, body) => { await facade.redraft(stringOf(body, 'draftId')); return ok({ ok: true }) } },
  { handlerId: 'workflow.reactions.reconsider', impl: async (facade, body) => {
    await facade.reconsiderReaction(stringOf(body, 'roleId'), stringOf(body, 'feedback'))
    return ok({ ok: true })
  } },
  { handlerId: 'workflow.world-change.approve', impl: async (facade, body) => {
    await facade.approveWorldChange(body.override ?? null)
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
  { handlerId: 'role.thinking', impl: (facade, body) => { facade.setRoleThinking(stringOf(body, 'roleId'), stringOf(body, 'thinkingStrength')); return ok({ ok: true }) } },
  { handlerId: 'role.reorder', impl: (facade, body) => { facade.reorderRoles(stringArray(body, 'roleIds')); return ok({ ok: true }) } },
  { handlerId: 'role.state', impl: (facade, body) => { facade.setRoleCurrentState(stringOf(body, 'roleId'), stringOf(body, 'currentState')); return ok({ ok: true }) } },
  { handlerId: 'role.intervene', impl: (facade, body) => {
    facade.interveneRole(stringOf(body, 'roleId'), stringOf(body, 'selfModel'), body.config as Record<string, unknown> | undefined)
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
  { handlerId: 'role.memories.list', impl: facade => {
    const room = facade.getRoom() as { roles?: Array<{ id?: string; memories?: unknown[] }> } | null
    const roles = Array.isArray(room?.roles) ? room.roles : []
    return ok(roles.map(role => ({ roleId: role.id ?? '', memories: Array.isArray(role.memories) ? role.memories : [] })))
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
  { handlerId: 'provider.list', impl: facade => ok(facade.getProvider()) },
  { handlerId: 'provider.save', impl: (facade, body) => {
    const config = body.config && typeof body.config === 'object' ? body.config as Record<string, unknown> : body
    facade.setProvider({
      baseUrl: stringOf(config, 'baseUrl'),
      apiKey: stringOf(config, 'apiKey'),
      model: stringOf(config, 'model'),
      responseFormat: stringOf(config, 'responseFormat') || undefined,
    })
    return ok({ ok: true })
  } },

  // ── 故事 ──
  { handlerId: 'story.list', impl: facade => ok({ stories: facade.stories() }) },
  { handlerId: 'story.get', impl: async (facade, body) => { const story = await facade.story(stringOf(body, 'id')); return ok({ story }) } },

  // ── W6-1 补挂：故事写入/导入导出（经原生端口 core-native 操作）──
  { handlerId: 'story.create', impl: (facade, body) => {
    const result = facade.invokeSync('story.create', { title: stringOf(body, 'title'), opening: body.opening ?? '', playerCharacter: body.playerCharacter ?? {}, roles: Array.isArray(body.roles) ? body.roles : [] })
    return ok(result ?? { ok: true })
  } },
  { handlerId: 'story.delete', impl: (facade, body) => { facade.invokeSync('story.delete', { id: stringOf(body, 'id') }); return ok({ ok: true }) } },
  { handlerId: 'story.save', impl: (facade, body) => { facade.invokeSync('story.save', { story: body.story ?? body }); return ok({ ok: true }) } },
  { handlerId: 'story.save-as', impl: (facade, body) => { facade.invokeSync('story.saveAs', { story: body.story ?? body }); return ok({ ok: true }) } },
  { handlerId: 'story.import', impl: (facade, body) => { facade.invokeSync('archive.import', { archive: body.archive ?? body }); return ok({ ok: true }) } },
  { handlerId: 'story.export', impl: (facade, body) => { const result = facade.invokeSync('archive.export', { storyId: stringOf(body, 'storyId') }); return ok(result ?? { ok: true }) } },

  // ── W6-1 补挂：存档（经原生端口）──
  { handlerId: 'archive.list', impl: facade => { const result = facade.invokeSync('archive.list', {}) as { files?: unknown[] } | null; return ok(result ?? { files: [] }) } },
  { handlerId: 'archive.save', impl: (facade, body) => { facade.invokeSync('archive.save', { name: stringOf(body, 'name'), archive: body.archive ?? {} }); return ok({ ok: true, name: stringOf(body, 'name') }) } },
  { handlerId: 'archive.load', impl: (facade, body) => { const result = facade.invokeSync('archive.load', { name: stringOf(body, 'name') }); return ok(result ?? { ok: true }) } },
  { handlerId: 'archive.delete', impl: (facade, body) => { facade.invokeSync('archive.delete', { name: stringOf(body, 'name') }); return ok({ ok: true }) } },
  { handlerId: 'archive.export', impl: (facade, body) => { const result = facade.invokeSync('archive.export', { storyId: stringOf(body, 'storyId') }); return ok(result ?? { ok: true }) } },
  { handlerId: 'archive.import', impl: (facade, body) => { facade.invokeSync('archive.import', { archive: body.archive ?? body }); return ok({ ok: true }) } },

  // ── W6-1 补挂：供应商扩展（经原生端口 secret）──
  { handlerId: 'provider.delete', impl: (facade, body) => {
    // 删除后回退默认：组合根 setProvider 重新解析（无默认时保持未配置）
    facade.invokeSync('secret.remove', { key: 'local.provider.meta' })
    return ok({ ok: true })
  } },
  { handlerId: 'provider.default-role', impl: (facade, body) => {
    const meta = facade.invokeSync('secret.get', { key: 'local.provider.meta' }) as { found?: boolean; value?: string } | null
    const parsed = meta?.found && meta.value ? JSON.parse(meta.value) as { defaults?: Record<string, unknown> } : { defaults: {} }
    parsed.defaults = { ...(parsed.defaults ?? {}), role: stringOf(body, 'providerId') }
    facade.invokeSync('secret.set', { key: 'local.provider.meta', value: JSON.stringify(parsed) })
    return ok({ ok: true })
  } },
  { handlerId: 'provider.director', impl: (facade, body) => {
    const meta = facade.invokeSync('secret.get', { key: 'local.provider.meta' }) as { found?: boolean; value?: string } | null
    const parsed = meta?.found && meta.value ? JSON.parse(meta.value) as { defaults?: Record<string, unknown> } : { defaults: {} }
    parsed.defaults = { ...(parsed.defaults ?? {}), director: stringOf(body, 'providerId') }
    facade.invokeSync('secret.set', { key: 'local.provider.meta', value: JSON.stringify(parsed) })
    return ok({ ok: true })
  } },
  { handlerId: 'provider.director-thinking', impl: (facade, body) => {
    // 导演思考强度：与角色 thinking 同语义（组合根无独立设置，映射为默认强度持久化）
    const meta = facade.invokeSync('secret.get', { key: 'local.provider.meta' }) as { found?: boolean; value?: string } | null
    const parsed = meta?.found && meta.value ? JSON.parse(meta.value) as { defaults?: Record<string, unknown> } : { defaults: {} }
    parsed.defaults = { ...(parsed.defaults ?? {}), directorThinking: stringOf(body, 'strength') || 'balanced' }
    facade.invokeSync('secret.set', { key: 'local.provider.meta', value: JSON.stringify(parsed) })
    return ok({ ok: true })
  } },

  // ── W6-1 补挂：计费/用量（经原生端口 secret 持久化；billing 为本地模拟）──
  { handlerId: 'billing.summary', impl: facade => {
    const raw = facade.invokeSync('secret.get', { key: 'local.billing.state' }) as { found?: boolean; value?: string } | null
    const state = raw?.found && raw.value ? JSON.parse(raw.value) as Record<string, unknown> : {}
    return ok({ billing: state.billing ?? { totalCost: 0 }, usage: state.usage ?? { turns: 0, tokens: 0 } })
  } },
  { handlerId: 'billing.prices.get', impl: facade => {
    const raw = facade.invokeSync('secret.get', { key: 'local.billing.prices' }) as { found?: boolean; value?: string } | null
    return ok(raw?.found && raw.value ? JSON.parse(raw.value) : { prices: [] })
  } },
  { handlerId: 'billing.prices.put', impl: (facade, body) => { facade.invokeSync('secret.set', { key: 'local.billing.prices', value: JSON.stringify(body) }); return ok({ ok: true }) } },
  { handlerId: 'billing.reset', impl: facade => { facade.invokeSync('secret.set', { key: 'local.billing.state', value: JSON.stringify({ billing: { totalCost: 0 }, usage: { turns: 0, tokens: 0 } }) }); return ok({ ok: true }) } },
  { handlerId: 'billing.usage', impl: facade => {
    const raw = facade.invokeSync('secret.get', { key: 'local.billing.state' }) as { found?: boolean; value?: string } | null
    const state = raw?.found && raw.value ? JSON.parse(raw.value) as { usage?: Record<string, unknown> } : {}
    return ok(state.usage ?? { turns: 0, tokens: 0 })
  } },

  // ── W6-1 补挂：提示词预设（经原生端口 preset）──
  { handlerId: 'prompt.presets.list', impl: facade => {
    const result = facade.invokeSync('preset.list', {}) as { presets?: unknown[] } | null
    return ok(result ?? { presets: [] })
  } },
  { handlerId: 'prompt.presets.put', impl: (facade, body) => { facade.invokeSync('preset.save', { preset: body.preset ?? body }); return ok({ ok: true }) } },
  { handlerId: 'prompt.presets.delete', impl: (facade, body) => { facade.invokeSync('preset.delete', { id: stringOf(body, 'id') }); return ok({ ok: true }) } },
  { handlerId: 'prompt.presets.export', impl: facade => {
    const result = facade.invokeSync('preset.list', {}) as { presets?: unknown[] } | null
    return ok({ presets: result?.presets ?? [] })
  } },
  { handlerId: 'prompt.private-toggles.get', impl: () => ok({}) },
  { handlerId: 'prompt.private-toggles.put', impl: (facade, body) => {
    facade.invokeSync('secret.set', { key: 'local.prompt.private-toggles', value: JSON.stringify(body.toggles ?? body) })
    return ok({ ok: true })
  } },

  // ── W6-1 逐条裁决（明确 unsupported + 前端 DEGRADED 容错；评审允许路径）──
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
 * W6：业务 handler 的 PortableApiHandler 适配（与 CoreProtocolPortableHandler 并列，
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
      // 声明了路由但未挂载：稳定 handler_not_mounted（与 CoreDataServer W5-5 同语义）
      return jsonResponse(503, { error: { code: 'handler_not_mounted', message: 'core handler not mounted yet', handlerId: route.handlerId } })
    }
    try {
      const body = await readJsonBody(request)
      const params = extractParams(route.pattern, path)
      const result = await impl(this.facade, body, params)
      return jsonResponse(result.status, result.body)
    } catch (error) {
      return jsonResponse(500, { error: { code: 'handler_failed', message: error instanceof Error ? error.message : String(error) } })
    }
  }
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

/** W6：校验挂载覆盖——表中 handlerId 与给定 core 业务路由一一对应（测试强制无漂移）。 */
export function buildBusinessCoverage(
  routes: ReadonlyArray<{ handlerId: string; method: string; pattern: string; owner: string }>,
): Array<{ handlerId: string; mounted: boolean }> {
  const mounted = new Set(CORE_BUSINESS_HANDLERS.map(entry => entry.handlerId))
  return routes
    .filter(route => route.owner === 'core' && !route.pattern.startsWith('/api/core/'))
    .map(route => ({ handlerId: route.handlerId, mounted: mounted.has(route.handlerId) }))
}

/**
 * W6：registry 驱动的业务路由表（与 api-route-registry.json 同源，构建期确定）。
 * 只含 core owner 且非协议端点的业务路由；CoreBusinessPortableHandler 用它在分发时
 * 把 method/path 反查为 handlerId（不复制 app-boot.ts 路由串）。
 */
export const CORE_BUSINESS_ROUTES: ReadonlyArray<{ handlerId: string; method: string; pattern: string }> = Object.freeze(
  API_ROUTES
    .filter(route => route.owner === 'core' && !route.pattern.startsWith('/api/core/'))
    .map(route => ({ handlerId: route.handlerId, method: route.method, pattern: route.pattern })),
)
