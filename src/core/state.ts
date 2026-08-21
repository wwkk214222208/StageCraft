import type { RoomSnapshot } from '../types.ts'
import type { StateEvent } from './protocol.ts'
import { systemClock, type Clock } from './platform.ts'

export interface StateCategoryDefinition {
  id: string
  label: string
  description?: string
  enabled?: boolean
  extensible?: boolean
  reducer?: (current: unknown, event: StateEvent) => unknown
}

export interface CoreStateSnapshot {
  revision: number
  categories: Record<string, unknown>
}

export const defaultStateCategories: StateCategoryDefinition[] = [
  { id: 'room', label: '房间', extensible: true },
  { id: 'world', label: '世界', extensible: true },
  { id: 'entities', label: '实体', extensible: true },
  { id: 'narrative', label: '叙事', extensible: true },
  { id: 'memory', label: '记忆', extensible: true },
  { id: 'goals', label: '目标', extensible: true },
  { id: 'workflow', label: '工作流', extensible: true },
  { id: 'runtime', label: '运行时', extensible: true },
]

/**
 * 将现有 RoomSnapshot 投影为 Core State。
 * 这是只读兼容层：不改变旧快照形状，也不把内部 SQLite 字段暴露给 adapter。
 */
export function projectRoomSnapshot(room: RoomSnapshot): CoreStateSnapshot {
  return {
    revision: room.revision,
    categories: {
      room: {
        id: room.id,
        title: room.title,
        storyId: room.storyId,
        mode: room.mode,
        autoPublish: room.autoPublish,
        phase: room.phase,
        revision: room.revision,
        playerContribution: room.playerContribution,
        playerCharacter: room.playerCharacter,
      },
      world: {
        time: room.sceneTime,
        location: room.sceneLocation,
        pendingWorldChange: room.pendingWorldChange,
        pendingNarration: room.pendingNarration,
      },
      entities: {
        roles: room.roles,
        reactions: room.reactions,
        decisions: room.decisions,
        speech: room.speech,
      },
      narrative: {
        scenes: room.scenes,
        draft: room.draft,
        consultations: room.consultations,
      },
      memory: {
        roleTimelines: Object.fromEntries(room.roles.map(role => [role.id, (role.memories ?? []).map(memory => memory.text)])),
        impressions: Object.fromEntries(room.roles.map(role => [role.id, role.impressions ?? {}])),
      },
      goals: Object.fromEntries(room.roles.map(role => [role.id, role.goals ?? []])),
      workflow: {
        phase: room.phase,
        pendingSpeech: room.speech,
        pendingWorldChange: room.pendingWorldChange,
      },
      runtime: {
        revision: room.revision,
      },
    },
  }
}

/** 将 Store-backed domain service 的完整房间投影转换为统一 StateEvent，供 Core 投影与事务仓储使用。 */
export function roomSnapshotEvent(room: RoomSnapshot, causedBy = 'core.project-room', categories = projectRoomSnapshot(room).categories, clock: Clock = systemClock): StateEvent {
  return {
    id: `state-snapshot-${room.id}-${room.revision}`,
    type: 'room.snapshot.projected',
    source: 'system',
    causedBy,
    payload: { revision: room.revision, categories },
    createdAt: clock.now(),
  }
}
