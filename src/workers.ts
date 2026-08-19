import type { ConsultationMessage, Draft, LoreEntry, PlayerCharacter, Decision, Role } from './types.ts'

export interface SceneContext {
  time?: string
  location?: string
  /** 非秘密的 Core thinking 关联信息，仅用于实时事件回传。 */
  roomId?: string
  turnId?: string
}

/** 已批准正文的服务端场景快照。记忆 Worker 只能读取这些上下文，不能自行决定关联信息。 */
export interface DigestSceneContext {
  id: string
  turnId: string
  text: string
  sceneTime?: string
  sceneLocation?: string
  source: 'role_reaction' | 'world_change'
  worldChangeId?: string
}

/** 群聊模式导演对话/叙述所需的房间上下文摘要 */
export interface DirectorChatContext {
  sceneTime?: string
  sceneLocation?: string
  playerName: string
  playerContribution?: string
  /** 最近已批准正文（上一轮发生的事） */
  recentScene?: string
  roles: Role[]
  lore?: LoreEntry[]
  /** 导演与该玩家的对话记录（自然语言建议与回复） */
  history?: ConsultationMessage[]
  /** 非秘密的 Core thinking 关联信息，仅用于实时事件回传。 */
  roomId?: string
  turnId?: string
}

export interface WorkerSet {
  decide(role: Role, participation: Decision['participation'], contribution: string, publicRoles?: Role[], scene?: SceneContext, onThinking?: (text: string) => void, lore?: LoreEntry[]): Promise<Decision>
  draft(turnId: string, contribution: string, decisions: Decision[], roles: Role[], consultations?: ConsultationMessage[], playerCharacter?: PlayerCharacter, scene?: SceneContext, onThinking?: (text: string) => void, lore?: LoreEntry[], recentScene?: string, previousDraft?: string): Promise<Draft>
  consult?(draft: Draft, messages: ConsultationMessage[], playerText: string, requestContext?: { roomId?: string; turnId?: string }): Promise<{ text: string; usage?: import('./types.ts').TokenUsage }>
  /** 群聊模式：角色消化一条已批准正文，产出结构化私有记忆。 */
  digest?(role: Role, scene: DigestSceneContext): Promise<import('./types.ts').MemoryDigest>
  /** 群聊模式：无导演发言协议——产出角色此刻的完整发言（台词/带台词的行动），非决策式简短回应 */
  speak?(role: Role, contribution: string, publicRoles?: Role[], scene?: SceneContext, onThinking?: (text: string) => void, lore?: LoreEntry[], recentScene?: string): Promise<{ text: string; thinking?: string; usage?: import('./types.ts').TokenUsage; worldChange?: import('./types.ts').WorldChangeRequest }>
  /**
   * 群聊模式：导演与玩家的世界状态对话——一次调用同时产出自然语言回复、
   * 可选世界变更申请（worldChange）与变更落地后要写的叙述（narration）。
   * 叙述仅在导演对话产出的变更被确认/生效后使用；角色台词附带的世界变更
   * 由角色自己的发言描写覆盖，不需要导演补写。
   */
  directorChat?(playerText: string, context: DirectorChatContext, onThinking?: (text: string) => void): Promise<{ reply: string; thinking?: string; worldChange?: import('./types.ts').WorldChangeRequest; narration?: string; usage?: import('./types.ts').TokenUsage }>
  /** request-scoped cancellation is required for Core; legacy workers may only support all-active cancellation. */
  cancel?(requestId?: string): void
  supportsRequestCancellation?: boolean
}

export const fakeWorkers: WorkerSet = {
  decide: runFakeRole,
  draft: runFakeDirector,
  consult: runFakeConsultation,
  digest: runFakeDigest,
  speak: runFakeSpeak,
  directorChat: runFakeDirectorChat,
}

/** 群聊导演对话的 fake：默认不产世界变更，仅给出自然语言回复 */
export async function runFakeDirectorChat(playerText: string, _context: DirectorChatContext): Promise<{ reply: string; usage?: import('./types.ts').TokenUsage }> {
  await delay(300)
  const focus = playerText.trim().slice(0, 60) || '世界状态'
  return {
    reply: `（导演）关于「${focus}」：我记下了。你可以继续描述你希望推进的时间、场景变化、人物进出场或新人物，我会整理成世界变更申请供你确认。`,
    usage: { promptTokens: 900, completionTokens: 50 },
  }
}

/** 群聊发言的 fake：完整对话式发言（一段有来有往的台词/行动），不是一句话动作 */
export async function runFakeSpeak(role: Role, contribution: string): Promise<{ text: string; thinking?: string; usage?: import('./types.ts').TokenUsage }> {
  await delay(400)
  const focus = contribution.trim() || '眼前的寂静'
  const thinking = `${role.name} 在心里掂量着怎么接住眼前的话头，考虑自己的立场和语气。`
  const opener = role.id === 'aria'
    ? `（她停下手里的事，视线越过烛火落在你身上）`
    : `（Mira 往炉火边靠了靠，声音带着夜里特有的松弛）`
  const text = `${opener}「${focus.slice(0, 40)}……这话我接得住。听我说——这片林子里的规矩和你想的不太一样：夜里赶路的人，往往不是被兽害死的，是被自己的火把害死的。你歇一夜，明早我带你认认路。」`
  return { text, thinking, usage: { promptTokens: 1200, completionTokens: 60 } }
}

export async function runFakeRole(role: Role, participation: Decision['participation'], contribution: string): Promise<Decision> {
  if (participation === 'excluded') {
    return { roleId: role.id, participation, status: 'abstained' }
  }
  await delay(350 + role.id.length * 65)
  const focus = contribution.trim() || '玩家暂时没有直接介入'
  const brief = role.id === 'aria'
    ? `Aria 保持克制地回应“${focus.slice(0, 56)}”，先观察玩家的真实意图，并避免暴露自己的不安。`
    : `Mira 用轻松的方式接住“${focus.slice(0, 56)}”，同时留意 Aria 的反应是否异常。`
  return {
    roleId: role.id,
    participation,
    status: 'completed',
    brief,
    privateReaction: `${role.name} 将这一刻记为需要继续观察的信号。`,
  }
}

export async function runFakeDirector(turnId: string, contribution: string, decisions: Decision[], roles: Role[]): Promise<Draft> {
  await delay(600)
  const active = decisions.filter(decision => decision.status === 'completed' && decision.brief)
  const aria = active.find(decision => decision.roleId === 'aria')
  const mira = active.find(decision => decision.roleId === 'mira')
  const lines = [
    contribution.trim() || '玩家没有立刻介入，祭典主厅的音乐仍在远处回响。',
    aria?.brief ? `\n${aria.brief}` : '',
    mira?.brief ? `\n${mira.brief}` : '',
    '\n烛火在高窗投下摇曳的影子，空气里有一瞬间的停顿，仿佛每个人都在等待下一句话。',
  ].filter(Boolean)
  const ariaRole = roles.find(role => role.id === 'aria')
  const stateUpdates: Record<string, string> = {}
  if (ariaRole) {
    stateUpdates.aria = `${ariaRole.currentState} 此刻她的注意力明显落在玩家身上。`
  }
  return {
    id: `draft-${Date.now()}`,
    turnId,
    text: lines.join('\n'),
    stateUpdates,
    settingProposals: [],
    intentHandling: active.map(decision => ({ roleId: decision.roleId, intentId: `${decision.roleId}-primary`, result: 'used' as const })),
    openQuestions: [],
    createdAt: new Date().toISOString(),
    usage: { promptTokens: 2400, completionTokens: 120 },
  }
}

async function runFakeConsultation(draft: Draft, _messages: ConsultationMessage[], playerText: string): Promise<{ text: string; usage?: import('./types.ts').TokenUsage }> {
  await delay(120)
  return { text: `我理解你的问题是“${playerText.trim().slice(0, 120)}”。当前正文仍是待审批版本；你可以要求我据此重写，或者结束咨询并直接审批现有草稿。`, usage: { promptTokens: 900, completionTokens: 40 } }
}

async function runFakeDigest(role: Role, scene: DigestSceneContext): Promise<import('./types.ts').MemoryDigest> {
  await delay(200)
  const snippet = scene.text.trim().slice(0, 40)
  return {
    entries: [{
      text: `${role.name} 经历了场景「${snippet}」，将其记为值得留意的经过。`,
    }],
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
