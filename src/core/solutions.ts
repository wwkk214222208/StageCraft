import type { RoomPhase } from '../types.ts'
import type { InteractionRequest, WorkflowDefinition, WorkflowInstance } from './protocol.ts'

export const chatSpeechWorkflow: WorkflowDefinition = {
  id: 'stagecraft.chat.speech',
  version: '1.0.0',
  initialStep: 'awaiting-player-input',
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

const phaseToStep: Partial<Record<RoomPhase, string>> = {
  'awaiting-player-input': 'awaiting-player-input',
  'role-speaking': 'role-speaking',
  'awaiting-approval': 'awaiting-approval',
  'world-change-approval': 'world-change-approval',
}

export function workflowInstanceFromRoom(room: { id: string; phase: RoomPhase; revision: number }): WorkflowInstance {
  const now = new Date().toISOString()
  return {
    id: `workflow:${room.id}:chat.speech`,
    definitionId: chatSpeechWorkflow.id,
    definitionVersion: chatSpeechWorkflow.version,
    step: phaseToStep[room.phase] ?? room.phase,
    status: room.phase === 'awaiting-player-input' ? 'waiting' : 'running',
    locals: { roomId: room.id, legacyPhase: room.phase, roomRevision: room.revision },
    pendingInteractionIds: [],
    pendingModelRequestIds: [],
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  }
}

export function interactionFromRoom(room: { id: string; phase: RoomPhase; revision: number }): InteractionRequest | undefined {
  const step = phaseToStep[room.phase]
  if (step === 'awaiting-player-input') {
    return { id: `interaction:${room.id}:player-input`, kind: 'text', title: '玩家行动', description: '输入本轮行动或发言。', fields: [{ id: 'text', type: 'textarea', label: '内容', required: true }], submitLabel: '提交', cancelable: false, createdAt: new Date().toISOString() }
  }
  if (step === 'awaiting-approval') {
    return { id: `interaction:${room.id}:speech-approval`, kind: 'approval', title: '批准角色台词', description: '确认或编辑角色刚生成的台词。', options: [{ id: 'approve', label: '批准' }, { id: 'reject', label: '拒绝' }], submitLabel: '批准', cancelable: true, createdAt: new Date().toISOString() }
  }
  if (step === 'world-change-approval') {
    return { id: `interaction:${room.id}:world-change-approval`, kind: 'approval', title: '批准世界变更', description: '确认角色提出的时间、地点或角色状态变化。', options: [{ id: 'approve', label: '批准' }, { id: 'reject', label: '拒绝' }], submitLabel: '批准', cancelable: true, createdAt: new Date().toISOString() }
  }
  return undefined
}
