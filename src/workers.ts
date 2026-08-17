import type { ConsultationMessage, Draft, LoreEntry, PlayerCharacter, Decision, Role } from './types.ts'

export interface SceneContext {
  time?: string
  location?: string
}

export interface WorkerSet {
  decide(role: Role, participation: Decision['participation'], contribution: string, publicRoles?: Role[], scene?: SceneContext, onThinking?: (text: string) => void, lore?: LoreEntry[]): Promise<Decision>
  draft(turnId: string, contribution: string, decisions: Decision[], roles: Role[], consultations?: ConsultationMessage[], playerCharacter?: PlayerCharacter, scene?: SceneContext, onThinking?: (text: string) => void, lore?: LoreEntry[], recentScene?: string, previousDraft?: string): Promise<Draft>
  consult?(draft: Draft, messages: ConsultationMessage[], playerText: string): Promise<{ text: string; usage?: import('./types.ts').TokenUsage }>
  /** 群聊模式：角色消化一条已批准正文，产出记忆中事件（时间标签 → 事件列表） */
  digest?(role: Role, sceneText: string): Promise<import('./types.ts').MemoryDigest>
  /** 群聊模式：无导演发言协议——产出角色此刻的完整发言（台词/带台词的行动），非决策式简短回应 */
  speak?(role: Role, contribution: string, publicRoles?: Role[], scene?: SceneContext, onThinking?: (text: string) => void, lore?: LoreEntry[], recentScene?: string): Promise<{ text: string; thinking?: string; usage?: import('./types.ts').TokenUsage }>
  cancel?(): void
}

export const fakeWorkers: WorkerSet = {
  decide: runFakeRole,
  draft: runFakeDirector,
  consult: runFakeConsultation,
  digest: runFakeDigest,
  speak: runFakeSpeak,
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

async function runFakeDigest(role: Role, sceneText: string): Promise<import('./types.ts').MemoryDigest> {
  await delay(200)
  const snippet = sceneText.trim().slice(0, 40)
  return {
    events: {
      '未标注时间': [`${role.name} 经历了场景「${snippet}」，将其记为值得留意的经过。`],
    },
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
