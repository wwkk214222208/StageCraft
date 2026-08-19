import type { RoomMode, RoomPhase, SubmitTurnInput, WorldChangeRequest } from '../types.ts'
import type { InteractionRequest, WorkflowDefinition, WorkflowInstance } from './protocol.ts'
import type { CoreCommandHandler, CoreSolutionPlugin, CoreSolutionProjectionProvider, CoreSolutionHost, CoreStateProjectionProvider, Disposable } from './plugins.ts'
import { defaultStateCategories, projectRoomSnapshot } from './state.ts'

type WorkflowRoom = { id: string; mode: RoomMode; phase: RoomPhase; revision: number; roles?: Role[]; draft?: unknown; speech?: unknown; pendingWorldChange?: unknown }

export const chatSpeechWorkflow: WorkflowDefinition = {
  id: 'stagecraft.chat.speech', version: '1.0.0', initialStep: 'awaiting-player-input',
  steps: {
    'awaiting-player-input': { id: 'awaiting-player-input', actions: [{ type: 'human-interaction', interactionKind: 'text', label: '提交行动' }] },
    'role-speaking': { id: 'role-speaking', actions: [{ type: 'model-interaction', capability: 'role.speech', contractId: 'chat.speech', promptProfile: 'chat.speech', stream: true }] },
    'awaiting-approval': { id: 'awaiting-approval', actions: [{ type: 'human-interaction', interactionKind: 'approval', label: '批准台词' }] },
    'world-change-approval': { id: 'world-change-approval', actions: [{ type: 'human-interaction', interactionKind: 'approval', label: '批准世界变更' }] },
  },
  transitions: [
    { from: 'awaiting-player-input', event: 'role.speech.requested', to: 'role-speaking' },
    { from: 'role-speaking', event: 'role.speech.generated', to: 'awaiting-approval' },
    { from: 'role-speaking', event: 'world-change.proposed', to: 'world-change-approval' },
    { from: 'role-speaking', event: 'speech.approved', to: 'awaiting-player-input' },
    { from: 'awaiting-approval', event: 'world-change.proposed', to: 'world-change-approval' },
    { from: 'awaiting-approval', event: 'speech.approved', to: 'awaiting-player-input' },
    { from: 'world-change-approval', event: 'world-change.approved', to: 'awaiting-player-input' },
    { from: 'world-change-approval', event: 'speech.approved', to: 'awaiting-player-input' },
    { from: 'world-change-approval', event: 'speech.rejected', to: 'awaiting-player-input' },
  ],
}

/** 群聊中玩家向导演提出建议、等待导演答复或审批导演的世界变更。 */
export const chatDirectorWorkflow: WorkflowDefinition = {
  id: 'stagecraft.chat.director', version: '1.0.0', initialStep: 'awaiting-suggestion',
  steps: {
    'awaiting-suggestion': { id: 'awaiting-suggestion', actions: [{ type: 'human-interaction', interactionKind: 'text', label: '向导演建议' }] },
    'director-consulting': { id: 'director-consulting', actions: [{ type: 'model-interaction', capability: 'director.chat', contractId: 'chat.director', promptProfile: 'chat.director', stream: true }] },
    'awaiting-world-change-approval': { id: 'awaiting-world-change-approval', actions: [{ type: 'human-interaction', interactionKind: 'approval', label: '批准导演建议的世界变更' }] },
  },
  transitions: [
    { from: 'awaiting-suggestion', event: 'director.suggestion.submitted', to: 'director-consulting' },
    { from: 'director-consulting', event: 'director.reply.generated', to: 'awaiting-suggestion' },
    { from: 'director-consulting', event: 'world-change.proposed', to: 'awaiting-world-change-approval' },
    { from: 'awaiting-world-change-approval', event: 'world-change.approved', to: 'awaiting-suggestion' },
  ],
}

/** 导演模式的既有决策→草稿→批准流程。 */
export const directorTurnWorkflow: WorkflowDefinition = {
  id: 'stagecraft.director.turn', version: '1.0.0', initialStep: 'awaiting-player-input',
  steps: {
    'awaiting-player-input': { id: 'awaiting-player-input', actions: [{ type: 'human-interaction', interactionKind: 'text', label: '提交行动' }] },
    'collecting-decisions': { id: 'collecting-decisions', actions: [{ type: 'model-interaction', capability: 'role.decision', contractId: 'role.decision', promptProfile: 'role.decision', stream: true }] },
    drafting: { id: 'drafting', actions: [{ type: 'model-interaction', capability: 'director.draft', contractId: 'director.draft', promptProfile: 'director.draft', stream: true }] },
    'awaiting-approval': { id: 'awaiting-approval', actions: [{ type: 'human-interaction', interactionKind: 'approval', label: '批准草稿' }] },
    'consulting-director': { id: 'consulting-director', actions: [{ type: 'human-interaction', interactionKind: 'text', label: '与导演讨论' }, { type: 'model-interaction', capability: 'director.chat', contractId: 'director.consult', promptProfile: 'director.consult', stream: true }] },
  },
  transitions: [
    { from: 'awaiting-player-input', event: 'player.contribution.submitted', to: 'collecting-decisions' },
    { from: 'collecting-decisions', event: 'role.decision.completed', to: 'drafting' },
    { from: 'drafting', event: 'director.draft.generated', to: 'awaiting-approval' },
    { from: 'awaiting-approval', event: 'draft.approved', to: 'awaiting-player-input' },
    { from: 'awaiting-approval', event: 'draft.rejected', to: 'awaiting-player-input' },
    { from: 'awaiting-approval', event: 'director.consulted', to: 'consulting-director' },
  ],
}

/** 群聊领域端口。实现位于 Core 外侧，方案只依赖这些稳定业务动作。 */
export interface StageCraftChatPort {
  submitContribution?(roomId: string, text: string): Promise<void>
  speak(roomId: string, roleId: string, feedback?: string): Promise<void>
  approveSpeech(roomId: string, text: string, worldChange?: WorldChangeRequest | null): Promise<void>
  rejectSpeech(roomId: string): Promise<void>
  retrySpeak?(roomId: string): Promise<void>
  directorChat(roomId: string, text: string): Promise<void>
  approveWorldChange(roomId: string, worldChange?: WorldChangeRequest | null): Promise<void>
  rejectWorldChange(roomId: string): Promise<void>
  cancel(roomId: string): void
}

export interface StageCraftDirectorPort {
  submitTurn(roomId: string, input: SubmitTurnInput): Promise<void>
  proceedToDraft(roomId: string): Promise<void>
  rejectDraft(roomId: string): Promise<void>
  retryDirector(roomId: string): Promise<void>
  reconsiderReaction(roomId: string, roleId: string, feedback: string): Promise<void>
  consult(roomId: string, draftId: string, playerText: string, context?: string): Promise<void>
  finishConsultation(roomId: string): void
  redraft(roomId: string, draftId: string): Promise<void>
  approve(roomId: string, draftId: string, text: string, stateUpdates: Record<string, string>, sceneUpdates?: { time?: string; location?: string }): void
  cancel(roomId: string): void
}

const chatSpeechPhaseToStep: Partial<Record<RoomPhase, string>> = {
  'awaiting-player-input': 'awaiting-player-input', 'role-speaking': 'role-speaking', 'awaiting-approval': 'awaiting-approval', 'world-change-approval': 'world-change-approval',
}

function instance(room: WorkflowRoom, definition: WorkflowDefinition, step: string, status: WorkflowInstance['status'], locals: Record<string, unknown> = {}): WorkflowInstance {
  const now = new Date().toISOString()
  return {
    id: `workflow:${room.id}:${definition.id.replace('stagecraft.', '')}`, definitionId: definition.id, definitionVersion: definition.version, step, status,
    locals: { roomId: room.id, legacyPhase: room.phase, roomRevision: room.revision, ...locals }, pendingInteractionIds: [], pendingModelRequestIds: [], retryCount: 0, createdAt: now, updatedAt: now,
  }
}

/** 将一个旧房间映射为其活跃工作流和可并行待命的工作流。 */
export function workflowInstancesFromRoom(room: WorkflowRoom): WorkflowInstance[] {
  if (room.mode === 'director') {
    const directorStep = room.phase === 'drafting' ? 'awaiting-approval' : room.phase
    return [instance(room, directorTurnWorkflow, directorStep, directorStep === 'awaiting-player-input' || directorStep === 'awaiting-approval' || directorStep === 'consulting-director' || directorStep === 'collecting-decisions' ? 'waiting' : 'running')]
  }
  const speechStep = chatSpeechPhaseToStep[room.phase] ?? room.phase
  // speak() 先切换到 role-speaking、稍后才写入 speech；该阶段必须立即让导演休眠。
  const speechActive = speechStep === 'role-speaking' || (Boolean(room.speech) && ['awaiting-approval', 'world-change-approval'].includes(speechStep))
  // idle 时两条 workflow 都可待命；只有角色台词正在生成/审批时才让导演 workflow 休眠。
  // 无角色台词的 world-change-approval 属于导演流程，此时 speech workflow 休眠。
  const directorWorldChange = room.phase === 'world-change-approval' && !speechActive
  const workflows = [instance(room, chatSpeechWorkflow, speechStep, speechStep === 'awaiting-player-input' || speechStep === 'awaiting-approval' || speechStep === 'world-change-approval' ? 'waiting' : 'running', { dormant: directorWorldChange })]
  workflows.push(instance(room, chatDirectorWorkflow, directorWorldChange ? 'awaiting-world-change-approval' : 'awaiting-suggestion', 'waiting', { dormant: speechActive }))
  return workflows
}

/** 兼容旧调用方：返回房间主工作流。 */
export function workflowInstanceFromRoom(room: WorkflowRoom): WorkflowInstance {
  return workflowInstancesFromRoom(room)[0]
}

export function directorSuggestionInteraction(roomId: string): InteractionRequest {
  return textInteraction(roomId, 'director-suggestion', '向导演建议', '描述希望推进的时间、场景或世界变化。', '发送')
}

export function interactionFromRoom(room: WorkflowRoom): InteractionRequest | undefined {
  if (room.mode === 'director') {
    if (room.phase === 'awaiting-player-input') return textInteraction(room.id, 'player-input', '玩家行动', '输入本轮行动或发言。', '提交')
    if (room.phase === 'collecting-decisions') return approvalInteraction(room.id, 'decision-approval', '确认角色反馈', '确认角色反馈后进入导演起草。')
    if (room.phase === 'awaiting-approval') return approvalInteraction(room.id, 'draft-approval', '批准场景草稿', '确认、编辑或要求重新起草当前导演草稿。')
    if (room.phase === 'consulting-director') return textInteraction(room.id, 'director-consult', '与导演讨论', '说明需要调整的剧情、设定或草稿问题。', '发送')
    return undefined
  }
  if (room.phase === 'awaiting-player-input') return roleSelectInteraction(room.id, room.roles ?? [])
  if (room.phase === 'awaiting-approval') return approvalInteraction(room.id, 'speech-approval', '批准角色台词', '确认或编辑角色刚生成的台词。')
  if (room.phase === 'world-change-approval') return approvalInteraction(room.id, 'world-change-approval', '批准世界变更', '确认角色或导演提出的时间、地点或角色状态变化。')
  return undefined
}

/** 默认 StageCraft 玩法方案：把既有三条固定 Workflow 和房间兼容投影装配进 Core。 */
export class StageCraftSolutionPlugin implements CoreSolutionPlugin {
  readonly id = 'stagecraft.solution'
  private readonly chat?: StageCraftChatPort
  private readonly director?: StageCraftDirectorPort
  private readonly defaultRoomId?: string

  constructor(options: { chat?: StageCraftChatPort; director?: StageCraftDirectorPort; defaultRoomId?: string } = {}) {
    this.chat = options.chat
    this.director = options.director
    this.defaultRoomId = options.defaultRoomId
  }

  install(host: CoreSolutionHost): Disposable {
    const registrations = [
      ...defaultStateCategories.map(category => host.registerStateCategory(category)),
      host.registerStateProjection(stagecraftStateProjection),
      host.registerWorkflow(chatSpeechWorkflow),
      host.registerWorkflow(chatDirectorWorkflow),
      host.registerWorkflow(directorTurnWorkflow),
      host.registerProjection(stagecraftProjection),
      ...(this.chat ? [host.registerCommandHandler(stagecraftChatCommandHandler(this.chat, this.defaultRoomId))] : []),
      ...(this.director ? [host.registerCommandHandler(stagecraftDirectorCommandHandler(this.director, this.defaultRoomId))] : []),
    ]
    return {
      dispose: async () => {
        for (const registration of registrations.reverse()) await registration.dispose()
      },
    }
  }
}

function stagecraftChatCommandHandler(chat: StageCraftChatPort, defaultRoomId?: string): CoreCommandHandler {
  const payloadOf = (command: import('./protocol.ts').HumanCommand): Record<string, unknown> => command.payload && typeof command.payload === 'object' ? command.payload as Record<string, unknown> : {}
  const roomIdOf = (command: import('./protocol.ts').HumanCommand, payload: Record<string, unknown>): string => typeof payload.roomId === 'string' && payload.roomId.trim() ? payload.roomId : String(command.sessionId ?? defaultRoomId ?? '')
  const worldChangeOf = (payload: Record<string, unknown>): WorldChangeRequest | null | undefined => payload.worldChange && typeof payload.worldChange === 'object' ? payload.worldChange as WorldChangeRequest : payload.worldChange === null ? null : undefined
  return {
    id: 'stagecraft.chat.command-handler',
    canHandle(command) {
      const payload = payloadOf(command)
      const action = String(payload.action ?? '')
      const interaction = command.interactionId ?? ''
      const chatInteraction = interaction.endsWith(':role-select') || interaction.endsWith(':speech-approval') || interaction.endsWith(':world-change-approval') || interaction.endsWith(':director-suggestion')
      const chatPayload = payload.scope === 'chat' || payload.mode === 'chat' || ['chat-speech', 'speech', 'world-change', 'director-chat', 'cancel-turn'].includes(action)
      if (command.type === 'select-role' || command.type === 'choose') return payload.scope !== 'director' && payload.mode !== 'director' && (chatInteraction || chatPayload || !payload.scope)
      if (command.type === 'cancel' || command.type === 'retry') return chatInteraction || chatPayload
      if (command.type === 'submit-text') return interaction.endsWith(':director-suggestion') || action === 'director-chat' || action === 'chat-contribution'
      if (command.type === 'approve' || command.type === 'reject') {
        return ['speech', 'world-change'].includes(action) || interaction.endsWith(':speech-approval') || interaction.endsWith(':world-change-approval')
      }
      return false
    },
    async handle(command) {
      const payload = payloadOf(command)
      const action = String(payload.action ?? '')
      const roomId = roomIdOf(command, payload)
      if (!roomId) throw new Error('Chat command requires roomId.')
      if (command.type === 'select-role' || command.type === 'choose') {
        await chat.speak(roomId, String(payload.roleId ?? ''), String(payload.feedback ?? ''))
        return
      }
      if (command.type === 'submit-text') {
        if (action === 'chat-contribution') {
          if (!chat.submitContribution) throw new Error('Chat contribution is not supported.')
          await chat.submitContribution(roomId, String(payload.text ?? ''))
          return
        }
        await chat.directorChat(roomId, String(payload.text ?? ''))
        return
      }
      if (command.type === 'cancel') {
        chat.cancel(roomId)
        return
      }
      if (command.type === 'retry') {
        if (!chat.retrySpeak) throw new Error('Chat retry is not supported.')
        await chat.retrySpeak(roomId)
        return
      }
      const worldChange = worldChangeOf(payload)
      const approvalAction = String(payload.action ?? (command.interactionId?.endsWith(':world-change-approval') ? 'world-change' : 'speech'))
      if (command.type === 'approve') {
        if (approvalAction === 'world-change') await chat.approveWorldChange(roomId, worldChange)
        else await chat.approveSpeech(roomId, String(payload.text ?? ''), worldChange)
        return
      }
      if (approvalAction === 'world-change') await chat.rejectWorldChange(roomId)
      else await chat.rejectSpeech(roomId)
    },
  }
}

function stagecraftDirectorCommandHandler(director: StageCraftDirectorPort, defaultRoomId?: string): CoreCommandHandler {
  const payloadOf = (command: import('./protocol.ts').HumanCommand): Record<string, unknown> => command.payload && typeof command.payload === 'object' ? command.payload as Record<string, unknown> : {}
  const roomIdOf = (command: import('./protocol.ts').HumanCommand, payload: Record<string, unknown>): string => typeof payload.roomId === 'string' && payload.roomId.trim() ? payload.roomId : String(command.sessionId ?? defaultRoomId ?? '')
  const directorScope = (command: import('./protocol.ts').HumanCommand, payload: Record<string, unknown>): boolean => {
    if (payload.scope === 'chat' || payload.mode === 'chat') return false
    const action = String(payload.action ?? '')
    const interaction = command.interactionId ?? ''
    return payload.scope === 'director' || payload.mode === 'director' || interaction.endsWith(':player-input') || interaction.endsWith(':decision-approval') || interaction.endsWith(':draft-approval') || interaction.endsWith(':director-consult') || ['director-turn', 'director-proceed', 'director-retry', 'draft-approval', 'reconsider-reaction', 'director-consult', 'consult-finish', 'redraft', 'cancel-turn'].includes(action)
  }
  return {
    id: 'stagecraft.director.command-handler',
    canHandle(command) {
      const payload = payloadOf(command)
      if (!directorScope(command, payload)) return false
      const action = String(payload.action ?? '')
      if (command.type === 'submit-text') return ['director-turn', 'director-proceed', 'director-consult'].includes(action) || (command.interactionId ?? '').endsWith(':player-input') || (command.interactionId ?? '').endsWith(':director-consult')
      if (command.type === 'retry') return ['director-retry', 'reconsider-reaction', 'redraft'].includes(action)
      if (command.type === 'cancel') return action === 'cancel-turn' || (command.interactionId ?? '').endsWith(':player-input') || (command.interactionId ?? '').endsWith(':draft-approval')
      if (command.type === 'approve' || command.type === 'reject') return ['decisions', 'draft-approval', 'consult-finish'].includes(action) || (command.interactionId ?? '').endsWith(':decision-approval') || (command.interactionId ?? '').endsWith(':draft-approval')
      return false
    },
    async handle(command) {
      const payload = payloadOf(command)
      const roomId = roomIdOf(command, payload)
      if (!roomId) throw new Error('Director command requires roomId.')
      const action = String(payload.action ?? '')
      if (command.type === 'submit-text' && (action === 'director-turn' || (command.interactionId ?? '').endsWith(':player-input'))) {
        await director.submitTurn(roomId, { text: String(payload.text ?? ''), requiredRoleIds: Array.isArray(payload.requiredRoleIds) ? payload.requiredRoleIds.map(String) : [] })
        return
      }
      if (command.type === 'submit-text' && action === 'director-proceed') { await director.proceedToDraft(roomId); return }
      if (command.type === 'submit-text' && (action === 'director-consult' || (command.interactionId ?? '').endsWith(':director-consult'))) {
        await director.consult(roomId, String(payload.draftId ?? ''), String(payload.text ?? ''), String(payload.context ?? ''))
        return
      }
      if ((command.type === 'approve' || command.type === 'reject') && (action === 'decisions' || (command.interactionId ?? '').endsWith(':decision-approval'))) {
        if (command.type === 'approve') await director.proceedToDraft(roomId)
        else await director.rejectDraft(roomId)
        return
      }
      if (command.type === 'retry' && action === 'director-retry') { await director.retryDirector(roomId); return }
      if (command.type === 'retry' && action === 'reconsider-reaction') { await director.reconsiderReaction(roomId, String(payload.roleId ?? ''), String(payload.feedback ?? '')); return }
      if (command.type === 'retry' && action === 'redraft') { await director.redraft(roomId, String(payload.draftId ?? '')); return }
      if (command.type === 'cancel') { director.cancel(roomId); return }
      if ((command.type === 'approve' || command.type === 'reject') && action === 'consult-finish') { director.finishConsultation(roomId); return }
      if (command.type === 'approve' && (action === 'draft-approval' || (command.interactionId ?? '').endsWith(':draft-approval'))) {
        director.approve(roomId, String(payload.draftId ?? ''), String(payload.text ?? ''), payload.stateUpdates && typeof payload.stateUpdates === 'object' ? payload.stateUpdates as Record<string, string> : {}, payload.sceneUpdates && typeof payload.sceneUpdates === 'object' ? payload.sceneUpdates as { time?: string; location?: string } : undefined)
        return
      }
      if (command.type === 'reject' && (action === 'draft-approval' || (command.interactionId ?? '').endsWith(':draft-approval'))) { await director.rejectDraft(roomId); return }
      throw new Error(`Unsupported director command: ${command.type}/${action}`)
    },
  }
}

const stagecraftStateProjection: CoreStateProjectionProvider = {
  id: 'stagecraft.state-projection',
  project(room) {
    return projectRoomSnapshot(room).categories
  },
}

const stagecraftProjection: CoreSolutionProjectionProvider = {
  id: 'stagecraft.room-projection',
  project(room) {
    const workflows = workflowInstancesFromRoom(room)
    const interactions: InteractionRequest[] = []
    const interaction = interactionFromRoom(room)
    if (interaction) interactions.push(interaction)
    if (room.mode === 'chat' && workflows.some(item => item.definitionId === chatDirectorWorkflow.id && item.step === 'awaiting-suggestion' && item.locals.dormant !== true)) {
      interactions.push(directorSuggestionInteraction(room.id))
    }
    return { workflows, interactions }
  },
  interactionBelongsToWorkflow(interaction, workflow) {
    const isSpeech = workflow.definitionId === chatSpeechWorkflow.id && workflow.locals.dormant !== true
    const isActiveSpeech = isSpeech
    const isDirectorChat = workflow.definitionId === chatDirectorWorkflow.id && workflow.locals.dormant !== true
    const isDirectorTurn = workflow.definitionId === directorTurnWorkflow.id
    if (interaction.id.endsWith(':role-select')) return isSpeech && workflow.step === 'awaiting-player-input'
    if (interaction.id.endsWith(':director-suggestion')) return isDirectorChat && workflow.step === 'awaiting-suggestion'
    if (interaction.id.endsWith(':player-input')) return isDirectorTurn && workflow.step === 'awaiting-player-input'
    if (interaction.id.endsWith(':decision-approval')) return isDirectorTurn && workflow.step === 'collecting-decisions'
    if (interaction.id.endsWith(':draft-approval')) return isDirectorTurn && workflow.step === 'awaiting-approval'
    if (interaction.id.endsWith(':director-consult')) return isDirectorTurn && workflow.step === 'consulting-director'
    if (interaction.id.endsWith(':speech-approval')) return isActiveSpeech && workflow.step === 'awaiting-approval'
    if (interaction.id.endsWith(':world-change-approval')) {
      return (isActiveSpeech && workflow.step === 'world-change-approval') || (isDirectorChat && workflow.step === 'awaiting-world-change-approval')
    }
    return false
  },
}

function textInteraction(roomId: string, suffix: string, title: string, description: string, submitLabel: string): InteractionRequest {
  return { id: `interaction:${roomId}:${suffix}`, kind: 'text', title, description, fields: [{ id: 'text', type: 'textarea', label: '内容', required: true }], submitLabel, cancelable: false, createdAt: new Date().toISOString() }
}
function roleSelectInteraction(roomId: string, roles: Role[]): InteractionRequest {
  const options = roles.filter(role => role.presence === 'present').map(role => ({ id: role.id, label: role.name, value: role.id }))
  return { id: `interaction:${roomId}:role-select`, kind: 'role-select', title: '选择角色发言', description: '选择一名在场角色，由其生成下一段台词。', options, submitLabel: '发言', cancelable: false, createdAt: new Date().toISOString() }
}
function approvalInteraction(roomId: string, suffix: string, title: string, description: string): InteractionRequest {
  return { id: `interaction:${roomId}:${suffix}`, kind: 'approval', title, description, options: [{ id: 'approve', label: '批准' }, { id: 'reject', label: '拒绝' }], submitLabel: '批准', cancelable: true, createdAt: new Date().toISOString() }
}
