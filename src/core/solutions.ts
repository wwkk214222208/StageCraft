import type { RoomMode, RoomPhase } from '../types.ts'
import type { InteractionRequest, WorkflowDefinition, WorkflowInstance } from './protocol.ts'

type WorkflowRoom = { id: string; mode: RoomMode; phase: RoomPhase; revision: number; draft?: unknown; speech?: unknown; pendingWorldChange?: unknown }

export const chatSpeechWorkflow: WorkflowDefinition = {
  id: 'stagecraft.chat.speech', version: '1.0.0', initialStep: 'awaiting-player-input',
  steps: {
    'awaiting-player-input': { id: 'awaiting-player-input', actions: [{ type: 'human-interaction', interactionKind: 'text', label: '提交行动' }] },
    'role-speaking': { id: 'role-speaking', actions: [{ type: 'model-interaction', capability: 'role.speech', contractId: 'chat.speech', promptProfile: 'chat.speech', stream: true }] },
    'awaiting-approval': { id: 'awaiting-approval', actions: [{ type: 'human-interaction', interactionKind: 'approval', label: '批准台词' }] },
    'world-change-approval': { id: 'world-change-approval', actions: [{ type: 'human-interaction', interactionKind: 'approval', label: '批准世界变更' }] },
  },
  transitions: [
    { from: 'awaiting-player-input', event: 'role.selected', to: 'role-speaking' },
    { from: 'role-speaking', event: 'speech.generated', to: 'awaiting-approval' },
    { from: 'role-speaking', event: 'world-change.proposed', to: 'world-change-approval' },
    { from: 'awaiting-approval', event: 'speech.approved', to: 'awaiting-player-input' },
    { from: 'world-change-approval', event: 'world-change.approved', to: 'awaiting-player-input' },
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
    { from: 'awaiting-suggestion', event: 'player.suggested', to: 'director-consulting' },
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
    { from: 'awaiting-player-input', event: 'player.submitted', to: 'collecting-decisions' },
    { from: 'collecting-decisions', event: 'decisions.completed', to: 'drafting' },
    { from: 'drafting', event: 'draft.created', to: 'awaiting-approval' },
    { from: 'awaiting-approval', event: 'draft.approved', to: 'awaiting-player-input' },
    { from: 'awaiting-approval', event: 'director.consulted', to: 'consulting-director' },
  ],
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
    return [instance(room, directorTurnWorkflow, room.phase, room.phase === 'awaiting-player-input' || room.phase === 'awaiting-approval' || room.phase === 'consulting-director' ? 'waiting' : 'running')]
  }
  const speechStep = chatSpeechPhaseToStep[room.phase] ?? room.phase
  const speechActive = ['role-speaking', 'awaiting-approval', 'world-change-approval'].includes(speechStep)
  const workflows = [instance(room, chatSpeechWorkflow, speechStep, speechStep === 'awaiting-player-input' || speechStep === 'awaiting-approval' || speechStep === 'world-change-approval' ? 'waiting' : 'running')]
  // 导演咨询与发言共存：非活跃时仅注册为可启动的等待实例，不能重复生成玩家输入控件。
  workflows.push(instance(room, chatDirectorWorkflow, speechActive ? 'awaiting-suggestion' : 'awaiting-suggestion', 'waiting', { dormant: speechActive }))
  return workflows
}

/** 兼容旧调用方：返回房间主工作流。 */
export function workflowInstanceFromRoom(room: WorkflowRoom): WorkflowInstance {
  return workflowInstancesFromRoom(room)[0]
}

export function interactionFromRoom(room: WorkflowRoom): InteractionRequest | undefined {
  if (room.mode === 'director') {
    if (room.phase === 'awaiting-player-input') return textInteraction(room.id, 'player-input', '玩家行动', '输入本轮行动或发言。', '提交')
    if (room.phase === 'awaiting-approval') return approvalInteraction(room.id, 'draft-approval', '批准场景草稿', '确认、编辑或要求重新起草当前导演草稿。')
    if (room.phase === 'consulting-director') return textInteraction(room.id, 'director-consult', '与导演讨论', '说明需要调整的剧情、设定或草稿问题。', '发送')
    return undefined
  }
  if (room.phase === 'awaiting-player-input') return textInteraction(room.id, 'player-input', '玩家行动', '输入行动或选择角色发言；也可向导演建议世界变化。', '提交')
  if (room.phase === 'awaiting-approval') return approvalInteraction(room.id, 'speech-approval', '批准角色台词', '确认或编辑角色刚生成的台词。')
  if (room.phase === 'world-change-approval') return approvalInteraction(room.id, 'world-change-approval', '批准世界变更', '确认角色或导演提出的时间、地点或角色状态变化。')
  return undefined
}

function textInteraction(roomId: string, suffix: string, title: string, description: string, submitLabel: string): InteractionRequest {
  return { id: `interaction:${roomId}:${suffix}`, kind: 'text', title, description, fields: [{ id: 'text', type: 'textarea', label: '内容', required: true }], submitLabel, cancelable: false, createdAt: new Date().toISOString() }
}
function approvalInteraction(roomId: string, suffix: string, title: string, description: string): InteractionRequest {
  return { id: `interaction:${roomId}:${suffix}`, kind: 'approval', title, description, options: [{ id: 'approve', label: '批准' }, { id: 'reject', label: '拒绝' }], submitLabel: '批准', cancelable: true, createdAt: new Date().toISOString() }
}
