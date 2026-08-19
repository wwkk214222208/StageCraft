export type RoomPhase =
  | 'awaiting-player-input'
  | 'collecting-decisions'
  | 'drafting'
  | 'awaiting-approval'
  | 'consulting-director'
  | 'role-speaking'
  /** 群聊模式：角色台词附带的世界变更申请待玩家确认（与台词审批绑定，批准台词时一并落地） */
  | 'world-change-approval'

/** 游玩模式：director = 导演模式（现状流程）；chat = 无导演串行群聊（角色发言→审批→在场消化） */
export type RoomMode = 'director' | 'chat'

/** 思维链强度档位：off = 关闭（不产思考）；brief/standard/deep = 思考深度递增 */
export type ThinkingStrength = 'off' | 'brief' | 'standard' | 'deep'

/** 单次模型调用的 token 用量（用于前端小字展示；不计费） */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  /** 缓存命中的输入 token 数（provider usage.prompt_tokens_details.cached_tokens） */
  cachedTokens?: number
  /** 本次调用耗时（毫秒） */
  durationMs?: number
}

export type ParticipationMode = 'required' | 'optional' | 'excluded'
export type DecisionStatus = 'pending' | 'completed' | 'abstained' | 'unavailable'

export interface Role {
  id: string
  name: string
  portraitRef: string
  currentState: string
  presence: 'present' | 'absent' | 'unavailable'
  /** 按时间标签组织的剧情记忆时间线（Heptalon 风格）：时间标签 → 事件列表；初始记忆存于「过去」桶 */
  memoryTimeline: Record<string, string[]>
  /** 结构化私有记忆；新存档的 canonical 记忆来源。 */
  memories?: NpcMemory[]
  /** 剧本阶段配置的初始记忆；开局时写入结构化记忆记录。 */
  initialMemories?: InitialMemory[]
  /** 该角色对其他角色的印象（姓名 → 文字）；随剧情可被角色自己更新，也可在角色设置中修改 */
  impressions?: Record<string, string>
  /** 长期目标（独立字段，私密：Director 看不到，仅供角色自己）；替代旧版写在 selfModel 私有段的文本解析 */
  goals?: string[]
  selfModel: string
  providerId?: string
  modelOverride?: string
  /** 该角色思维链强度（缺省 = 跟随默认，见角色默认设置） */
  thinkingStrength?: ThinkingStrength
}

export interface Decision {
  roleId: string
  participation: ParticipationMode
  status: DecisionStatus
  brief?: string
  privateReaction?: string
  /** 该角色本回合对外展示的身份/形象（角色主动上报，导演可见；如伪装、隐瞒或显露身份） */
  publicIdentity?: string
  /** 生成该决策时的模型思维链（reasoning/thinking），可空 */
  thinking?: string
  /** 该角色本轮通过工具调用更新/删除的他人印象（姓名 → 文字；null 表示删除） */
  impressions?: Record<string, string | null>
  /** 生成该决策时的模型 token 用量 */
  usage?: TokenUsage
  error?: string
}

export interface ReactionPreview {
  turnId: string
  roleId: string
  text: string
  createdAt: string
}

export interface PendingMindUpdate {
  roleId: string
  turnId: string
  privateReaction: string
  createdAt: string
}

export interface IntentHandling {
  roleId: string
  intentId: string
  result: 'used' | 'partially-used' | 'deferred' | 'blocked' | 'superseded'
  note?: string
}

export interface SettingProposal {
  id: string
  text: string
  basis?: string
  status: 'proposed' | 'accepted' | 'rejected'
}

/** 导演提议新建的人物（随草稿提交，玩家批准草稿时创建） */
export interface RoleProposal {
  id: string
  name: string
  portraitRef: string
  currentState: string
  presence: 'present' | 'absent' | 'unavailable'
  selfModel: string
  memoryTimeline: Record<string, string[]>
  goals?: string[]
}

export interface SceneUpdates {
  time?: string
  location?: string
}

export interface Draft {
  id: string
  turnId: string
  text: string
  stateUpdates: Record<string, string>
  settingProposals: SettingProposal[]
  intentHandling: IntentHandling[]
  openQuestions: string[]
  /** 导演提议新建的人物（玩家批准草稿时创建） */
  roleProposals?: RoleProposal[]
  /** 导演提议的场景时间/地点更新，玩家批准后生效 */
  sceneUpdates?: SceneUpdates
  /** 生成草稿时的导演思维链（reasoning/thinking），可空 */
  thinking?: string
  /** 生成草稿时的模型 token 用量 */
  usage?: TokenUsage
  createdAt: string
}

export interface Scene {
  id: string
  turnId: string
  text: string
  /** 发言者：角色 id 或 'player'；未设置（旧数据 / 导演正文 / 开场）按旁白处理 */
  speaker?: string
  /** 正文类别；旧数据缺省时按 system/旁白兼容显示。 */
  kind?: 'dialogue' | 'player' | 'narration' | 'system'
  /** 若正文由世界变更落地而来，关联其稳定审计记录。 */
  worldChangeId?: string
  /** 本段正文发布当时的场景时间（快照） */
  sceneTime?: string
  /** 本段正文发布当时的场景地点（快照） */
  sceneLocation?: string
  /** 产生该段正文的模型 token 用量（导演草稿调用；群聊模式下为发言调用） */
  usage?: TokenUsage
  createdAt: string
}

export interface ConsultationMessage {
  role: 'player' | 'director'
  text: string
  /** 导演回复的模型 token 用量（仅 director 消息可能有） */
  usage?: TokenUsage
  /** 导演回复附带的思维链（生成后保留，供开关控制展示） */
  thinking?: string
  createdAt: string
}

export interface UsageSnapshot {
  requests: number
  promptTokens: number
  completionTokens: number
}

export interface PlayerCharacter {
  name: string
  persona: string
  currentState: string
  /** 主角肖像引用（上传/URL 导入后写入；缺省时前端回退到 /assets/default.svg） */
  portraitRef?: string
}

/** 世界书条目：`roles` 缺省或为空数组 = 常开（注入所有角色）；否则只注入列出的角色 */
export interface LoreEntry {
  name: string
  content: string
  roles?: string[]
}

/** 群聊模式下待审批的台词（pending speech；存储为 rooms.speech JSON） */
export interface ChatSpeech {
  roleId: string
  /** 发言正文（玩家可在审批前编辑） */
  text: string
  thinking?: string
  usage?: TokenUsage
  turnId: string
  /** 可选：随台词一并提请玩家确认的世界变更申请（批准台词时落地） */
  worldChange?: WorldChangeRequest
}

/**
 * 群聊模式下的世界变更申请：由角色 AI 在发言时或导演在对话中提出，
 * 玩家批准后落地（更新场景时间/地点、切换角色进场/离场、创建新人物）。
 */
export interface WorldChangeRequest {
  /** 提议的新场景时间（无变化不填） */
  sceneTime?: string
  /** 提议的新场景地点（无变化不填） */
  sceneLocation?: string
  /** 提议引入的新人物（复用导演模式 roleProposals 结构，批准后创建） */
  roleProposals?: RoleProposal[]
  /** 提议的角色进场/离场切换（批准后生效） */
  rolePresence?: Array<{ roleId: string; presence: 'present' | 'absent' | 'unavailable' }>
  /** 简短理由，供玩家了解为何提出这项变更 */
  reason?: string
}

export interface WorldChangeRecord {
  id: string
  roomId: string
  turnId?: string
  source: 'speech' | 'director'
  status: 'proposed' | 'approved' | 'rejected' | 'superseded'
  request: WorldChangeRequest
  approvedRequest?: WorldChangeRequest
  beforeSceneTime?: string
  afterSceneTime?: string
  beforeSceneLocation?: string
  afterSceneLocation?: string
  narrationSceneId?: string
  createdAt: string
  approvedAt?: string
  rejectedAt?: string
}

/** 世界变更落地后导演写的一段叙述（导演风格 narration scene，非对话气泡） */
export interface WorldNarration {
  text: string
  usage?: TokenUsage
}

export type MemorySource = 'story' | 'world_change' | 'role_reaction' | 'manual' | 'import'
export type MemoryStatus = 'active' | 'superseded' | 'retracted' | 'archived'
/** LLM 与剧本编辑器使用的最小记忆协议：只记录发生时间和记忆内容。 */
export interface MemoryDigestEntry { occurredAt?: string; text: string }
/** 剧本中的角色初始记忆；不含运行期 ID 与审计字段。 */
export interface InitialMemory extends MemoryDigestEntry {}
export interface MemoryDigest { entries?: MemoryDigestEntry[] }
export interface NpcMemory { id: string; roomId: string; roleId: string; sceneId?: string; turnId?: string; worldChangeId?: string; occurredAt: string; occurredLocation?: string; source: MemorySource; text: string; visibility: 'private'; status: MemoryStatus; supersedes: string[]; supersededBy?: string; dedupeKey: string; createdAt: string; updatedAt: string }

export interface RoomSnapshot {
  id: string
  title: string
  /** 当前剧本 id（rooms.story_id；重开/新建时写入） */
  storyId?: string
  /** 游玩模式：director / chat（新开剧本时选择，Room 级） */
  mode: RoomMode
  /** 沉浸模式：跳过审批，玩家输入后自动走完并发布（AI 主导） */
  autoPublish: boolean
  /** 群聊模式下待审批的台词（仅 phase == awaiting-approval && mode == chat 时存在） */
  speech?: ChatSpeech
  /** 群聊模式下随台词一并待玩家确认的世界变更申请（phase == world-change-approval 时存在） */
  pendingWorldChange?: WorldChangeRequest
  /** 待确认的世界变更落地后导演要写的一段叙述（导演对话建议时预先产出；批准后写为 narration scene） */
  pendingNarration?: string
  playerCharacter: PlayerCharacter
  phase: RoomPhase
  revision: number
  playerContribution?: string
  /** 当前场景时间（如「傍晚」），随草稿批准更新 */
  sceneTime?: string
  /** 当前场景地点 */
  sceneLocation?: string
  consultations: ConsultationMessage[]
  roles: Role[]
  reactions: ReactionPreview[]
  decisions: Decision[]
  draft?: Draft
  scenes: Scene[]
  lastError?: string
  /** 世界书条目（运行期覆盖；重开剧本回剧本文件的 lore） */
  lore: LoreEntry[]
}

export interface SubmitTurnInput {
  text: string
  requiredRoleIds?: string[]
}
