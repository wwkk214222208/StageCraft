import type { LoreEntry, RoomSnapshot, Role, RoomMode, ThinkingStrength } from './types.ts'
import type { StoryPackage } from './story-packages.ts'
import type { StageCraftRepository } from './stagecraft-repository.ts'
import { systemIds, type IdFactory } from './core/platform.ts'

export interface StageCraftManagementNotifications {
  get(roomId: string): RoomSnapshot
  notify(roomId: string): void
}

export interface StageCraftManagementPort {
  importArchive(roomId: string, archive: { room?: RoomSnapshot }): void
  restart(roomId: string, story: StoryPackage, options?: { mode?: RoomMode; autoPublish?: boolean }): void
  setRoomConfig(roomId: string, config: { mode?: RoomMode; autoPublish?: boolean }): void
  updatePlayerCharacter(roomId: string, player: { name: string; persona: string; currentState: string }): void
  setPlayerAvatar(roomId: string, portraitRef: string): void
  interveneRole(roomId: string, roleId: string, selfModel: string, config?: { providerId?: string; modelOverride?: string; impressions?: Record<string, string>; goals?: string[]; thinkingStrength?: ThinkingStrength }): void
  storeNpcMemories(roomId: string, roleId: string, entries: Array<{ id?: string; text?: string; occurredAt?: string }>): void
  retractNpcMemory(roomId: string, memoryId: string): void
  updateNpcMemory(roomId: string, memoryId: string, entry: { text?: string; occurredAt?: string }): void
  reorderNpcMemories(roomId: string, roleId: string, memoryIds: string[]): void
  supersedeNpcMemory(roomId: string, memoryId: string, entry: { text: string; occurredAt: string }): void
  saveLore(roomId: string, lore: LoreEntry[]): void
  createRole(roomId: string, role: Parameters<StageCraftRepository['createRole']>[1]): void
  deleteRole(roomId: string, roleId: string): void
  setRolePresence(roomId: string, roleId: string, presence: Role['presence']): void
  setRoleThinking(roomId: string, roleId: string, thinkingStrength: ThinkingStrength): void
  reorderRoles(roomId: string, roleIds: string[]): void
  setRoleAvatar(roomId: string, roleId: string, portraitRef: string): void
  setRoleCurrentState(roomId: string, roleId: string, currentState: string): void
  setDirectorSetting(roomId: string, text: string): void
  updateScene(roomId: string, updates: { time?: string; location?: string }): void
}

/** Store-backed management boundary. It is intentionally independent of RoomRuntime. */
export class StageCraftManagementService implements StageCraftManagementPort {
  private readonly store: StageCraftRepository
  private readonly ids: IdFactory
  private readonly notifications: StageCraftManagementNotifications
  private readonly beforeRestart?: (roomId: string) => void

  constructor(store: StageCraftRepository, notifications: StageCraftManagementNotifications, options: { beforeRestart?: (roomId: string) => void; ids?: IdFactory } = {}) {
    this.store = store
    this.ids = options.ids ?? systemIds
    this.notifications = notifications
    this.beforeRestart = options.beforeRestart
  }

  private room(roomId: string): RoomSnapshot { return this.notifications.get(roomId) }
  private idle(roomId: string, message: string): void { if (this.room(roomId).phase !== 'awaiting-player-input') throw new Error(message) }
  private changed(roomId: string): void { this.notifications.notify(roomId) }

  importArchive(roomId: string, archive: { room?: RoomSnapshot }): void {
    this.idle(roomId, '读档需要在空闲时进行。')
    this.store.importRoom(roomId, archive)
    this.changed(roomId)
  }

  restart(roomId: string, story: StoryPackage, options: { mode?: RoomMode; autoPublish?: boolean } = {}): void {
    this.beforeRestart?.(roomId)
    this.store.restartRoom(roomId, story, options)
    this.changed(roomId)
  }

  setRoomConfig(roomId: string, config: { mode?: RoomMode; autoPublish?: boolean }): void { this.store.setRoomConfig(roomId, config); this.changed(roomId) }
  updatePlayerCharacter(roomId: string, player: { name: string; persona: string; currentState: string }): void { this.store.updatePlayerCharacter(roomId, player); this.changed(roomId) }
  setPlayerAvatar(roomId: string, portraitRef: string): void { this.store.setPlayerAvatar(roomId, portraitRef); this.changed(roomId) }

  interveneRole(roomId: string, roleId: string, selfModel: string, config = {}): void {
    this.idle(roomId, 'Private role intervention requires an idle room.')
    this.store.updateRolePrivateState(roomId, roleId, selfModel, config)
    this.changed(roomId)
  }

  storeNpcMemories(roomId: string, roleId: string, entries: Array<{ id?: string; text?: string; occurredAt?: string }>): void {
    this.idle(roomId, '管理 NPC 记忆需要在空闲时进行。')
    const occurredAt = this.room(roomId).sceneTime ?? '过去'
    this.store.insertNpcMemories(roomId, roleId, entries.map(entry => ({ id: entry.id ?? this.ids.create('manual'), text: String(entry.text ?? ''), occurredAt: entry.occurredAt ?? occurredAt, source: 'manual' as const })))
    this.changed(roomId)
  }

  retractNpcMemory(roomId: string, memoryId: string): void { this.store.retractNpcMemory(roomId, memoryId); this.changed(roomId) }
  updateNpcMemory(roomId: string, memoryId: string, entry: { text?: string; occurredAt?: string }): void { this.idle(roomId, '管理 NPC 记忆需要在空闲时进行。'); this.store.updateNpcMemory(roomId, memoryId, entry); this.changed(roomId) }
  reorderNpcMemories(roomId: string, roleId: string, memoryIds: string[]): void { this.idle(roomId, '调整记忆顺序需要在空闲时进行。'); this.store.reorderNpcMemories(roomId, roleId, memoryIds); this.changed(roomId) }
  supersedeNpcMemory(roomId: string, memoryId: string, entry: { text: string; occurredAt: string }): void { this.idle(roomId, '管理 NPC 记忆需要在空闲时进行。'); this.store.supersedeNpcMemory(roomId, memoryId, { ...entry, id: this.ids.create('manual') }); this.changed(roomId) }
  saveLore(roomId: string, lore: LoreEntry[]): void { this.store.saveLore(roomId, lore); this.changed(roomId) }

  createRole(roomId: string, role: Parameters<StageCraftRepository['createRole']>[1]): void { this.idle(roomId, '新建角色需要在空闲时进行。'); this.store.createRole(roomId, role); this.changed(roomId) }
  deleteRole(roomId: string, roleId: string): void { this.idle(roomId, '删除角色需要在空闲时进行。'); this.store.deleteRole(roomId, roleId); this.changed(roomId) }
  setRolePresence(roomId: string, roleId: string, presence: Role['presence']): void { this.store.setRolePresence(roomId, roleId, presence); this.changed(roomId) }
  setRoleThinking(roomId: string, roleId: string, thinkingStrength: ThinkingStrength): void { this.idle(roomId, '调整角色思维链需要在空闲时进行。'); this.store.setRoleThinking(roomId, roleId, thinkingStrength); this.changed(roomId) }
  reorderRoles(roomId: string, roleIds: string[]): void { this.idle(roomId, '调整顺序需要在空闲时进行。'); this.store.reorderRoles(roomId, roleIds); this.changed(roomId) }
  setRoleAvatar(roomId: string, roleId: string, portraitRef: string): void { this.store.setRoleAvatar(roomId, roleId, portraitRef); this.changed(roomId) }
  setRoleCurrentState(roomId: string, roleId: string, currentState: string): void { this.store.setRoleCurrentState(roomId, roleId, currentState); this.changed(roomId) }
  setDirectorSetting(roomId: string, text: string): void { this.store.addConsultation(roomId, null, 'player', text); this.changed(roomId) }
  updateScene(roomId: string, updates: { time?: string; location?: string }): void { this.idle(roomId, '修改场景需要在空闲时进行。'); this.store.updateScene(roomId, updates); this.changed(roomId) }
}
