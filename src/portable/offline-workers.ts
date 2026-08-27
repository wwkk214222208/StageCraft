/**
 * 离线（WebView 内）真实模型 WorkerSet。
 *
 * 与 PC 端 createRealWorkers（model-gateway.ts）职责一致：把角色/房间上下文组装成
 * 提示词并调用模型，产出 Decision / Draft / Speech / WorldChange / MemoryDigest 等
 * 共享结构。与 PC 的实现差异：
 *  - 提示词为自包含的精简中文指令（不读取 prompts 文件系统、不走预设流水线）；
 *  - 请求经 NativeModelTransport 走 Android 原生传输（Java 持有凭据与网络）；
 *  - 思维链增量由传输层实时回调，最终 thinking 一并返回用于持久化。
 */
import type { ConsultationMessage, Decision, Draft, LoreEntry, MemoryDigest, PlayerCharacter, Role, TokenUsage, WorldChangeRequest } from '../types.ts'
import type { DirectorChatContext, DigestSceneContext, RoleSelectionContext, SceneContext, WorkerSet } from '../workers.ts'
import type { ModelRequest, ModelResult, ThinkingStrength } from '../core/protocol.ts'

export interface OfflineProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
  responseFormat?: 'json_object' | 'none'
}

export interface OfflineRequestHooks {
  onThinking?: (text: string) => void
}

export interface OfflineModelPort {
  request(request: ModelRequest, hooks?: OfflineRequestHooks): Promise<ModelResult>
  cancel?(requestId?: string): Promise<void>
}

export interface OfflineWorkersOptions {
  directorThinkingStrength?: ThinkingStrength
  roleThinkingStrength?: ThinkingStrength
}

const JSON_OBJECT = 'json_object' as const

function jsonContract<T>(schema: object): { id: string; version: string; schema: object } {
  return { id: 'offline.contract', version: '1.0.0', schema }
}

function toolFor(name: string, description: string, schema: object): { name: string; description: string; parameters: object } {
  return { name, description, parameters: schema }
}

function formatLore(lore?: LoreEntry[]): string {
  if (!lore || lore.length === 0) return '（无世界书）'
  return lore.map(entry => `- ${entry.name}: ${entry.content}`).join('\n')
}

function formatRoleLore(lore: LoreEntry[], roleId: string): string {
  const relevant = lore.filter(entry => !entry.roles || entry.roles.length === 0 || entry.roles.includes(roleId))
  return formatLore(relevant)
}

function formatMemoryTimeline(role: Role): string {
  const memories = Array.isArray(role.memories) ? role.memories : []
  if (memories.length === 0) return '（暂无记忆）'
  return memories.slice(0, 30).map((memory, index) => `- ${memory.occurredAt ?? `事件${index + 1}`}: ${memory.text}`).join('\n')
}

function formatImpressions(role: Role): string {
  const impressions = role.impressions ?? {}
  const entries = Object.entries(impressions)
  return entries.length === 0 ? '（暂无）' : entries.map(([name, text]) => `- ${name}: ${text ?? '（印象已淡去）'}`).join('\n')
}

function formatGoals(role: Role): string {
  const goals = role.goals ?? []
  return goals.length === 0 ? '（暂无长期目标）' : goals.map(goal => `- ${goal}`).join('\n')
}

function formatScene(scene?: SceneContext): string {
  if (!scene) return '（尚未设定场景时间地点）'
  const parts = [scene.sceneTime, scene.sceneLocation].filter(Boolean).join(' · ')
  return parts || '（尚未设定场景时间地点）'
}

function publicRoleStates(roles: Role[]): string {
  if (!roles || roles.length === 0) return '（无其他在场角色）'
  return roles.map(role => `- ${role.name}（${role.id}）：${role.currentState}`).join('\n')
}

function roleBrief(role: Role): string {
  return `姓名：${role.name}\n人设：${role.selfModel}\n当前状态：${role.currentState || '（无）'}`
}

function requireString(value: unknown, field: string, minLength = 1): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length < minLength) throw new Error(`模型输出缺少${field}字段。`)
  return text
}

function normalizeWorldChange(value: unknown, source: string): WorldChangeRequest | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  const result: WorldChangeRequest = {}
  if (typeof input.sceneTime === 'string' && input.sceneTime.trim()) result.sceneTime = input.sceneTime.trim()
  if (typeof input.sceneLocation === 'string' && input.sceneLocation.trim()) result.sceneLocation = input.sceneLocation.trim()
  if (Array.isArray(input.rolePresence)) {
    result.rolePresence = input.rolePresence
      .filter((item): item is { roleId: string; presence: 'present' | 'absent' | 'unavailable' } =>
        Boolean(item && typeof item === 'object' && typeof (item as { roleId?: unknown }).roleId === 'string'
          && ['present', 'absent', 'unavailable'].includes(String((item as { presence?: unknown }).presence))))
      .map(item => ({ roleId: (item as { roleId: string }).roleId, presence: (item as { presence: 'present' | 'absent' | 'unavailable' }).presence }))
  }
  if (input.roleStates && typeof input.roleStates === 'object' && !Array.isArray(input.roleStates)) {
    const states: Record<string, string> = {}
    for (const [roleId, text] of Object.entries(input.roleStates as Record<string, unknown>)) {
      if (typeof text === 'string' && text.trim()) states[roleId] = text.trim()
    }
    if (Object.keys(states).length > 0) result.roleStates = states
  }
  if (Array.isArray(input.roleProposals)) {
    result.roleProposals = input.roleProposals
      .filter((item): item is RoleProposal => Boolean(item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' && typeof (item as { name?: unknown }).name === 'string'))
      .map(item => ({
        id: (item as RoleProposal).id,
        name: (item as RoleProposal).name,
        portraitRef: (item as RoleProposal).portraitRef ?? '/assets/default.svg',
        currentState: (item as RoleProposal).currentState ?? '',
        presence: (item as RoleProposal).presence ?? 'present',
        selfModel: (item as RoleProposal).selfModel ?? '',
        ...(Array.isArray((item as RoleProposal).memories) ? { memories: (item as RoleProposal).memories } : {}),
      }))
    if (result.roleProposals.length === 0) delete result.roleProposals
  }
  if (typeof input.reason === 'string' && input.reason.trim()) result.reason = input.reason.trim()
  if (Object.keys(result).length === 0) return undefined
  return result
}

/** 与 PC 端一致的 thinking→usage→归一化结果组装。 */
export function createOfflineWorkers(port: OfflineModelPort, options: OfflineWorkersOptions = {}): WorkerSet {
  let sequence = 0
  const nextRequestId = (prefix: string): string => `offline:${prefix}:${Date.now()}:${++sequence}`
  const resolveThinking = (request: ModelRequest, thinkingStrength: ThinkingStrength | undefined): ThinkingStrength | undefined => thinkingStrength

  const roleRequest = (request: Omit<ModelRequest, 'requestId' | 'stream' | 'route' | 'metadata' | 'thinkingStrength'>, extra: { route?: ModelRequest['route']; metadata?: ModelRequest['metadata']; thinkingStrength?: ThinkingStrength; requestId: string; stream?: boolean }): Promise<ModelResult> => {
    return port.request({ ...request, requestId: extra.requestId, stream: extra.stream ?? true, route: extra.route, metadata: extra.metadata, thinkingStrength: extra.thinkingStrength ?? request.thinkingStrength }, { onThinking: undefined })
  }

  return {
    supportsRequestCancellation: Boolean(port.cancel),
    async decide(role: Role, participation: Decision['participation'], contribution: string, publicRoles: Role[] = [], scene?: SceneContext, onThinking?: (text: string) => void, lore?: LoreEntry[], recentScene?: string): Promise<Decision> {
      if (participation === 'excluded') return { roleId: role.id, participation, status: 'abstained' }
      let thinking = ''
      let usage: TokenUsage | undefined
      const schema = { type: 'object', additionalProperties: false, properties: { brief: { type: 'string', description: '本回合公开的意图/行动概要，一两句话' }, privateReaction: { type: 'string', description: '私下的即时反应与感受' }, publicIdentity: { type: 'string', description: '可选：本回合对外展示的身份/形象变化' }, impressions: { type: 'object', description: '可选：本回合更新/删除的他人印象（姓名→文字；null 表示删除）', additionalProperties: true } }, required: ['brief', 'privateReaction'] }
      const system = `你是角色「${role.name}」。请完全代入该角色，以第一人称视角思考并作出本回合的决策。\n角色人设：${role.selfModel}\n当前状态：${role.currentState || '（无）'}\n长期目标：${formatGoals(role)}\n他人印象：${formatImpressions(role)}\n私有记忆：\n${formatMemoryTimeline(role)}\n世界书：\n${formatRoleLore(lore ?? [], role.id)}`
      const user = `本回合玩家行动：${contribution || '（玩家空过）'}\n在场角色状态：\n${publicRoleStates(publicRoles)}\n场景：${formatScene(scene)}\n已批准正文（最近）：${recentScene || '（尚无，本回合为开局）'}\n\n请只输出 JSON（不要输出任何解释），字段：brief（公开意图，1-2 句）、privateReaction（私有即时反应，1-2 句）、publicIdentity（可选）、impressions（可选）。`
      const request: ModelRequest = { requestId: nextRequestId('role-decision'), capability: 'role.decision', prompt: { system, user, metadata: { capability: 'role.decision', strategyId: 'offline.director.role-decision' } }, contract: { id: 'role.decision', version: '1.0.0', schema }, tool: toolFor('submit_role_decision', '提交角色本轮公开意图和私有即时反应。', schema), thinkingStrength: resolveThinking(null as unknown as ModelRequest, role.thinkingStrength ?? options.roleThinkingStrength), route: { role: role.id, purpose: 'director.role-decision' }, metadata: { includeTelemetry: false, correlation: { mode: 'director', roomId: scene?.roomId, turnId: scene?.turnId, actor: 'role', roleId: role.id } }, stream: true }
      const result = await port.request(request, { onThinking: text => { thinking += text; onThinking?.(text) } })
      if (result.error) throw new Error(result.error)
      const output = result.output as { brief?: string; privateReaction?: string; publicIdentity?: string; impressions?: Record<string, string | null> } | null | undefined
      usage = result.usage
      if (result.thinking) thinking = result.thinking
      if (!output || typeof output.brief !== 'string' || !output.brief.trim()) throw new Error('角色决策输出缺少 brief 字段。')
      return { roleId: role.id, participation, status: 'completed', brief: output.brief.trim(), privateReaction: typeof output.privateReaction === 'string' && output.privateReaction.trim() ? output.privateReaction.trim() : '', ...(typeof output.publicIdentity === 'string' && output.publicIdentity.trim() ? { publicIdentity: output.publicIdentity.trim() } : {}), ...(output.impressions && typeof output.impressions === 'object' ? { impressions: output.impressions } : {}), ...(thinking ? { thinking } : {}), ...(usage ? { usage } : {}) }
    },
    async draft(turnId: string, contribution: string, decisions: Decision[], roles: Role[], consultations: ConsultationMessage[] = [], playerCharacter?: PlayerCharacter, scene?: SceneContext, onThinking?: (text: string) => void, lore?: LoreEntry[], recentScene?: string, previousDraft?: string): Promise<Draft> {
      let thinking = ''
      let usage: TokenUsage | undefined
      const schema = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', description: '导演风格场景正文（第三人称环境/事件/人物反应描写，不含对话气泡标记，可含角色台词）' }, stateUpdates: { type: 'object', description: '角色状态更新（roleId→最新状态，现在时）', additionalProperties: { type: 'string' } }, settingProposals: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, text: { type: 'string' }, basis: { type: 'string' } }, required: ['id', 'text'] } }, roleProposals: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, portraitRef: { type: 'string' }, currentState: { type: 'string' }, presence: { type: 'string', enum: ['present', 'absent', 'unavailable'] }, selfModel: { type: 'string' } }, required: ['id', 'name', 'portraitRef', 'currentState', 'presence', 'selfModel'] } }, sceneUpdates: { type: 'object', additionalProperties: false, properties: { time: { type: 'string' }, location: { type: 'string' } } } }, required: ['text', 'stateUpdates'] }
      const briefs = decisions.filter(item => item.status === 'completed' && item.brief).map(item => `- ${item.roleId}${item.participation === 'required' ? '（焦点角色）' : ''}：${item.brief}`).join('\n') || '（无）'
      const system = `你是本篇互动故事的导演（Director）。你负责把玩家的行动与各角色的决策编织成一段连贯的场景正文，推进剧情。\n世界书：\n${formatLore(lore)}\n玩家：${playerCharacter?.name ?? '玩家'}——${playerCharacter?.persona ?? ''}（当前状态：${playerCharacter?.currentState ?? ''}）\n角色：\n${roles.map(role => `- ${role.name}（${role.id}）：${role.currentState}`).join('\n')}`
      const user = `场景：${formatScene(scene)}\n最近已批准正文：${recentScene || '（尚无，本回合为开局）'}${previousDraft?.trim() ? `\n【当前待修订草稿】\n${previousDraft.trim()}` : ''}\n玩家行动：${contribution || '（玩家空过）'}\n角色决策：\n${briefs}\n玩家与导演的交流记录：\n${consultations.map(message => `- ${message.role === 'player' ? '玩家' : '导演'}：${message.text}`).join('\n') || '（无）'}\n\n请只输出 JSON（不要任何解释），字段：text（正文，2-4 段，推进剧情、给出新信息或张力）、stateUpdates（角色状态变化，无则 {}）、settingProposals（新设定提案，无则 []）、roleProposals（新人物提案，无则 []）、sceneUpdates（场景时间/地点变化，无则省略）。`
      const result = await port.request({ requestId: nextRequestId('director-draft'), capability: 'director.draft', prompt: { system, user, metadata: { capability: 'director.draft', strategyId: 'offline.director.draft' } }, contract: { id: 'story_draft', version: '1.0.0', schema }, tool: toolFor('submit_story_draft', '提交可供玩家审批的场景草稿和结构化状态变化。', schema), thinkingStrength: options.directorThinkingStrength, route: { purpose: 'director.draft' }, metadata: { includeTelemetry: false, correlation: { mode: 'director', roomId: scene?.roomId, turnId, actor: 'director' } }, stream: true }, { onThinking: text => { thinking += text; onThinking?.(text) } })
      if (result.error) throw new Error(result.error)
      const output = result.output as { text?: string; stateUpdates?: Record<string, string>; settingProposals?: Draft['settingProposals']; roleProposals?: RoleProposal[]; sceneUpdates?: { time?: string; location?: string } } | null | undefined
      usage = result.usage
      if (result.thinking) thinking = result.thinking
      if (!output || !output.text || !output.text.trim()) throw new Error('导演草稿输出缺少 text 字段。')
      return {
        id: `draft-${Date.now()}`, turnId, text: output.text.trim(),
        stateUpdates: output.stateUpdates && typeof output.stateUpdates === 'object' ? output.stateUpdates : {},
        settingProposals: Array.isArray(output.settingProposals) ? output.settingProposals : [],
        intentHandling: [], openQuestions: [],
        ...(Array.isArray(output.roleProposals) && output.roleProposals.length > 0 ? { roleProposals: output.roleProposals } : {}),
        ...(output.sceneUpdates && typeof output.sceneUpdates === 'object' ? { sceneUpdates: output.sceneUpdates } : {}),
        ...(thinking ? { thinking } : {}), ...(usage ? { usage } : {}), createdAt: new Date().toISOString(),
      }
    },
    async consult(draft: Draft, messages: ConsultationMessage[], playerText: string): Promise<{ text: string; usage?: TokenUsage }> {
      const schema = { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }
      const system = `你是本篇互动故事的导演。玩家正在就当前草稿向你咨询或提出要求，请以导演身份简短回应（不写正文、不替角色发言），可以指出如何调整。`
      const user = `当前待审批草稿：\n${draft.text}\n设定提案：${JSON.stringify(draft.settingProposals)}\n交流记录：\n${messages.map(message => `- ${message.role === 'player' ? '玩家' : '导演'}：${message.text}`).join('\n') || '（无）'}\n玩家问题：${playerText}\n\n请只输出 JSON：{"text": "你的回复"}。`
      const result = await port.request({ requestId: nextRequestId('director-consult'), capability: 'director.consult', prompt: { system, user, metadata: { capability: 'director.consult', strategyId: 'offline.director.consult' } }, contract: { id: 'director_consultation', version: '1.0.0', schema }, tool: toolFor('submit_director_consultation', '提交导演对玩家咨询的简短回答。', schema), thinkingStrength: options.directorThinkingStrength, route: { purpose: 'director.consult' }, metadata: { includeTelemetry: false, correlation: { mode: 'director', actor: 'director' } }, stream: false })
      if (result.error) throw new Error(result.error)
      const output = result.output as { text?: string } | null | undefined
      const text = requireString(output?.text, 'text')
      return { text, ...(result.usage ? { usage: result.usage } : {}) }
    },
    async digest(role: Role, scene: DigestSceneContext): Promise<MemoryDigest> {
      const schema = { type: 'object', additionalProperties: false, properties: { entries: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, occurredAt: { type: 'string' } }, required: ['text'] } }, currentState: { type: 'string' } }, required: ['entries'] }
      const system = `你是角色「${role.name}」。请把以下已批准的剧情正文消化为属于你的私有记忆（第一人称视角、记下对你有意义的事情），并给出你最新的状态。`
      const user = `场景时间：${scene.sceneTime ?? '（未知）'}，场景地点：${scene.sceneLocation ?? '（未知）'}\n正文：\n${scene.text}\n\n请只输出 JSON：{"entries":[{"text":"...","occurredAt":"..."}],"currentState":"一句话最新状态（可选）"}。`
      const result = await port.request({ requestId: nextRequestId('memory-digest'), capability: 'memory.digest', prompt: { system, user, metadata: { capability: 'memory.digest', strategyId: 'offline.chat.digest' } }, contract: { id: 'memory_digest', version: '1.0.0', schema }, tool: toolFor('submit_memory_digest', '提交该角色从场景正文中提取的结构化私有记忆与最新状态。', schema), thinkingStrength: role.thinkingStrength ?? options.roleThinkingStrength, route: { role: role.id, purpose: 'chat.memory-digest' }, metadata: { includeTelemetry: false, correlation: { mode: 'chat', roomId: scene.roomId, turnId: scene.turnId, actor: 'role', roleId: role.id } }, stream: false })
      if (result.error) throw new Error(result.error)
      const output = result.output as { entries?: Array<{ text?: string; occurredAt?: string }>; currentState?: string } | null | undefined
      return { entries: Array.isArray(output?.entries) ? output.entries.filter(entry => typeof entry.text === 'string' && entry.text.trim()).map(entry => ({ text: entry.text!.trim(), ...(typeof entry.occurredAt === 'string' && entry.occurredAt.trim() ? { occurredAt: entry.occurredAt.trim() } : {}) })) : [], ...(typeof output?.currentState === 'string' && output.currentState.trim() ? { currentState: output.currentState.trim() } : {}) }
    },
    async speak(role: Role, contribution: string, publicRoles: Role[] = [], scene?: SceneContext, onThinking?: (text: string) => void, lore?: LoreEntry[], recentScene?: string): Promise<{ text: string; thinking?: string; usage?: TokenUsage; worldChange?: WorldChangeRequest }> {
      let thinking = ''
      let usage: TokenUsage | undefined
      const worldChangeSchema = { type: 'object', additionalProperties: false, properties: { sceneTime: { type: 'string' }, sceneLocation: { type: 'string' }, roleProposals: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, portraitRef: { type: 'string' }, currentState: { type: 'string' }, presence: { type: 'string', enum: ['present', 'absent', 'unavailable'] }, selfModel: { type: 'string' } }, required: ['id', 'name', 'portraitRef', 'currentState', 'presence', 'selfModel'] } }, rolePresence: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { roleId: { type: 'string' }, presence: { type: 'string', enum: ['present', 'absent', 'unavailable'] } }, required: ['roleId', 'presence'] } }, roleStates: { type: 'object', additionalProperties: { type: 'string' } }, reason: { type: 'string' } } }
      const schema = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', description: '该角色此刻的完整发言（台词或带台词的行动描述）' }, worldChange: { type: 'object', additionalProperties: false, properties: worldChangeSchema.properties } }, required: ['text'] }
      const system = `你是角色「${role.name}」。请完全代入该角色，用自然、生动的第一人称发言接住当前局面。\n角色人设：${role.selfModel}\n当前状态：${role.currentState || '（无）'}\n私有记忆：\n${formatMemoryTimeline(role)}\n世界书：\n${formatRoleLore(lore ?? [], role.id)}`
      const user = `场景：${formatScene(scene)}\n最近已批准正文：${recentScene || '（尚无已批准正文，这是本局第一次发言）'}\n玩家行动：${contribution || '（玩家没有说话，只是注视着你）'}\n在场角色：\n${publicRoleStates(publicRoles)}\n\n请只输出 JSON：{"text":"完整发言","worldChange":{...可选...}}。除非剧情需要推进时间/变换地点/引入新人物，否则不要提交 worldChange。`
      const result = await port.request({ requestId: nextRequestId('chat-speech'), capability: 'role.speech', prompt: { system, user, metadata: { capability: 'role.speech', strategyId: 'offline.chat.speech' } }, contract: { id: 'chat.speech', version: '1.0.0', schema }, tool: toolFor('submit_chat_speech', '提交该角色此刻的完整发言（可选附带世界变更申请）。', schema), thinkingStrength: role.thinkingStrength ?? options.roleThinkingStrength, route: { role: role.id, purpose: 'chat.speech' }, metadata: { includeTelemetry: false, correlation: { mode: 'chat', roomId: scene?.roomId, turnId: scene?.turnId, actor: 'role', roleId: role.id } }, stream: true }, { onThinking: text => { thinking += text; onThinking?.(text) } })
      if (result.error) throw new Error(result.error)
      const output = result.output as { text?: string; worldChange?: unknown } | null | undefined
      usage = result.usage
      if (result.thinking) thinking = result.thinking
      const text = requireString(output?.text, 'text')
      const worldChange = normalizeWorldChange(output?.worldChange, 'speech')
      return { text, ...(thinking ? { thinking } : {}), ...(usage ? { usage } : {}), ...(worldChange ? { worldChange } : {}) }
    },
    async directorChat(playerText: string, context: DirectorChatContext, onThinking?: (text: string) => void): Promise<{ reply: string; worldChange?: WorldChangeRequest; narration?: string; usage?: TokenUsage }> {
      let thinking = ''
      let usage: TokenUsage | undefined
      const worldChangeSchema = { type: 'object', additionalProperties: false, properties: { sceneTime: { type: 'string' }, sceneLocation: { type: 'string' }, roleProposals: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, portraitRef: { type: 'string' }, currentState: { type: 'string' }, presence: { type: 'string', enum: ['present', 'absent', 'unavailable'] }, selfModel: { type: 'string' } }, required: ['id', 'name', 'portraitRef', 'currentState', 'presence', 'selfModel'] } }, rolePresence: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { roleId: { type: 'string' }, presence: { type: 'string', enum: ['present', 'absent', 'unavailable'] } }, required: ['roleId', 'presence'] } }, roleStates: { type: 'object', additionalProperties: { type: 'string' } }, reason: { type: 'string' } } }
      const schema = { type: 'object', additionalProperties: false, properties: { reply: { type: 'string', description: '对玩家建议/提问的回复（不写正文、不替角色发言）' }, worldChange: { type: 'object', additionalProperties: false, properties: worldChangeSchema.properties }, narration: { type: 'string', description: '若提交了 worldChange，写一段该变更被批准后发布的导演风格叙述' } }, required: ['reply'] }
      const system = `你是互动故事的世界导演（Director），负责管理场景时间、地点、人物进出场与新增人物。玩家会用自然语言向你建议世界状态的变化，请判断是否合理并给出回应。\n世界书：\n${formatLore(context.lore)}\n角色：\n${context.roles.map(role => `- ${role.name}（${role.id}，${role.presence === 'present' ? '在场' : role.presence === 'absent' ? '离场' : '不可用'}）：${role.currentState}`).join('\n')}`
      const user = `场景：${formatScene({ time: context.sceneTime, location: context.sceneLocation })}\n最近已批准正文：${context.recentScene || '（尚无已批准正文）'}\n玩家：${context.playerName}\n玩家建议：${playerText.trim() || '（玩家没有说话）'}\n交流记录：\n${(context.history ?? []).map(message => `- ${message.role === 'player' ? '玩家' : '导演'}：${message.text}`).join('\n') || '（无）'}\n\n请只输出 JSON：{"reply":"回复","worldChange":{...可选...},"narration":"可选叙述"}。玩家建议合理且剧情需要时才提交 worldChange；若提交了 worldChange 请同时写 narration。`
      const result = await port.request({ requestId: nextRequestId('chat-director'), capability: 'director.chat', prompt: { system, user, metadata: { capability: 'director.chat', strategyId: 'offline.chat.director' } }, contract: { id: 'chat.director', version: '1.0.0', schema }, tool: toolFor('submit_director_chat', '提交导演对玩家建议的回复（可选附带世界变更申请与叙述）。', schema), thinkingStrength: options.directorThinkingStrength, route: { purpose: 'chat.director' }, metadata: { includeTelemetry: false, correlation: { mode: 'chat', roomId: context.roomId, turnId: context.turnId, actor: 'director' } }, stream: true }, { onThinking: text => { thinking += text; onThinking?.(text) } })
      if (result.error) throw new Error(result.error)
      const output = result.output as { reply?: string; worldChange?: unknown; narration?: string } | null | undefined
      usage = result.usage
      if (result.thinking) thinking = result.thinking
      const reply = requireString(output?.reply, 'reply')
      const worldChange = normalizeWorldChange(output?.worldChange, 'director')
      const narration = typeof output?.narration === 'string' && output.narration.trim() ? output.narration.trim() : undefined
      return { reply, ...(thinking ? { thinking } : {}), ...(usage ? { usage } : {}), ...(worldChange ? { worldChange } : {}), ...(worldChange && narration ? { narration } : {}) }
    },
    async selectSpeakingRoles(context: RoleSelectionContext, onThinking?: (text: string) => void): Promise<{ roleIds: string[]; reason?: string; usage?: TokenUsage }> {
      let usage: TokenUsage | undefined
      const schema = { type: 'object', additionalProperties: false, properties: { roleIds: { type: 'array', description: '本回合应发言的在场角色 id 列表；无人需要发言时返回空数组', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['roleIds'] }
      const system = `你是互动故事的世界导演。请根据玩家的行动判断本回合哪些在场角色应当发言（优先与玩家行动直接相关、剧情推进需要的角色），最多 2-3 位；玩家行动未涉及任何角色时返回空数组。`
      const user = `场景：${formatScene(context.scene)}\n最近已批准正文：${context.recentScene || '（尚无已批准正文，这是本局第一次发言）'}\n玩家行动：${context.playerContribution?.trim() || '（玩家没有说话，只是注视着众人。）'}\n角色：\n${context.roles.map(role => `- ${role.id}（${role.name}，${role.presence === 'present' ? '在场' : role.presence === 'absent' ? '离场' : '不可用'}）：${role.currentState}`).join('\n')}\n\n请只输出 JSON：{"roleIds":["角色id"],"reason":"简短理由"}。`
      const result = await port.request({ requestId: nextRequestId('chat-role-selection'), capability: 'director.role-selection', prompt: { system, user, metadata: { capability: 'director.role-selection', strategyId: 'offline.chat.role-selection' } }, contract: { id: 'chat.role-selection', version: '1.0.0', schema }, tool: toolFor('submit_role_selection', '提交本回合应发言的角色 id 列表。', schema), thinkingStrength: options.directorThinkingStrength, route: { purpose: 'chat.role-selection' }, metadata: { includeTelemetry: false, correlation: { mode: 'chat', roomId: context.roomId, turnId: context.turnId, actor: 'director' } }, stream: false })
      if (result.error) throw new Error(result.error)
      const output = result.output as { roleIds?: unknown; reason?: string } | null | undefined
      usage = result.usage
      const roleIds = Array.isArray(output?.roleIds) ? output.roleIds.map(String).filter(id => context.roles.some(role => role.id === id && role.presence === 'present')) : []
      const reason = typeof output?.reason === 'string' && output.reason.trim() ? output.reason.trim() : undefined
      return { roleIds, ...(reason ? { reason } : {}), ...(usage ? { usage } : {}) }
    },
    cancel(requestId?: string): void {
      if (port.cancel) void port.cancel(requestId).catch(() => {})
    },
  }
}