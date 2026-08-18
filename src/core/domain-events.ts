import type { StateEvent } from './protocol.ts'
import type { ChatSpeech, WorldChangeRequest } from '../types.ts'

export type DomainEventType =
  | 'player.contribution.submitted'
  | 'role.speech.requested'
  | 'role.speech.generated'
  | 'speech.approved'
  | 'speech.rejected'
  | 'world-change.proposed'
  | 'world-change.approved'
  | 'world-change.rejected'
  | 'scene.published'
  | 'director.suggestion.submitted'
  | 'director.reply.generated'

export interface DomainEventPayloads {
  'player.contribution.submitted': { roomId: string; text: string }
  'role.speech.requested': { roomId: string; roleId: string; turnId?: string }
  'role.speech.generated': { roomId: string; speech: ChatSpeech }
  'speech.approved': { roomId: string; text: string; worldChange?: WorldChangeRequest | null }
  'speech.rejected': { roomId: string; roleId?: string; turnId?: string }
  'world-change.proposed': { roomId: string; change: WorldChangeRequest; source: 'speech' | 'director' }
  'world-change.approved': { roomId: string; change: WorldChangeRequest }
  'world-change.rejected': { roomId: string; change?: WorldChangeRequest }
  'scene.published': { roomId: string; sceneId?: string; speaker?: string; text: string }
  'director.suggestion.submitted': { roomId: string; text: string }
  'director.reply.generated': { roomId: string; text: string }
}

export type DomainEvent = {
  [Type in DomainEventType]: StateEvent & { type: Type; payload: DomainEventPayloads[Type] }
}[DomainEventType]

const domainEventTypes = new Set<DomainEventType>([
  'player.contribution.submitted', 'role.speech.requested', 'role.speech.generated', 'speech.approved', 'speech.rejected',
  'world-change.proposed', 'world-change.approved', 'world-change.rejected', 'scene.published', 'director.suggestion.submitted', 'director.reply.generated',
])

export function isDomainEvent(event: StateEvent): event is DomainEvent {
  return domainEventTypes.has(event.type as DomainEventType)
}

export function domainEvent<Type extends DomainEventType>(type: Type, payload: DomainEventPayloads[Type], causedBy?: string): DomainEvent {
  return {
    id: `${type}:${crypto.randomUUID()}`,
    type,
    source: 'system',
    payload,
    ...(causedBy ? { causedBy } : {}),
    createdAt: new Date().toISOString(),
  } as DomainEvent
}
