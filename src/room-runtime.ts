import { randomUUID } from 'node:crypto'
import type { RoomSnapshot, SubmitTurnInput } from './types.ts'
import { Store } from './store.ts'
import { fakeWorkers } from './workers.ts'
import type { WorkerSet } from './workers.ts'
import type { CoreRuntimePort } from './core/protocol.ts'
import { StageCraftChatService } from './stagecraft-chat-service.ts'
import { StageCraftDirectorService } from './stagecraft-director-service.ts'

type Listener = (snapshot: RoomSnapshot) => void
export type ThinkingListener = (event: ThinkingEvent) => void

/** 模型思维链增量事件：生成过程中实时推送，done=true 表示该参与者本轮思考结束 */
export interface ThinkingEvent {
  actor: 'role' | 'director'
  roleId?: string
  turnId: string
  text: string
  done: boolean
}

export class RoomRuntime {
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly thinkingListeners = new Map<string, Set<ThinkingListener>>()
  private readonly store: Store
  private core?: CoreRuntimePort
  private readonly chatService: StageCraftChatService
  private readonly directorService: StageCraftDirectorService

  constructor(store: Store, workers: WorkerSet = fakeWorkers, core?: CoreRuntimePort) {
    this.store = store
    this.core = core
    this.chatService = new StageCraftChatService(store, workers, core, {
      get: roomId => this.get(roomId),
      notify: roomId => this.emit(roomId),
      thinking: (roomId, event) => this.emitThinking(roomId, event),
    })
    this.directorService = new StageCraftDirectorService(store, workers, core, {
      get: roomId => this.get(roomId),
      notify: roomId => this.emit(roomId),
      thinking: (roomId, event) => this.emitThinking(roomId, event),
    })
  }

  setCoreRuntime(core: CoreRuntimePort): void {
    this.core = core
    this.chatService.setCoreRuntime(core)
    this.directorService.setCoreRuntime(core)
  }

  getChatService(): StageCraftChatService { return this.chatService }
  getDirectorService(): StageCraftDirectorService { return this.directorService }

  /** 释放 Core 事件订阅及群聊生成资源；Store 由应用组合根负责关闭。 */
  dispose(): void { this.chatService.dispose(); this.directorService.dispose() }

  setWorkers(workers: WorkerSet): void {
    this.assertWorkersSwitchAllowed()
    this.chatService.setWorkers(workers)
    this.directorService.setWorkers(workers)
  }

  /** 供组合根在拆除旧路由前预检，保证 provider 切换不会留下半安装状态。 */
  assertWorkersSwitchAllowed(): void {
    if (this.chatService.isActive() || this.directorService.isActive()) throw new Error('回合进行中不能切换模型。')
  }

  subscribe(roomId: string, listener: Listener): () => void {
    const set = this.listeners.get(roomId) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(roomId, set)
    return () => set.delete(listener)
  }

  /** 订阅房间内模型思维链增量（角色决策 / Director 草稿的 reasoning 流） */
  subscribeThinking(roomId: string, listener: ThinkingListener): () => void {
    const set = this.thinkingListeners.get(roomId) ?? new Set<ThinkingListener>()
    set.add(listener)
    this.thinkingListeners.set(roomId, set)
    return () => set.delete(listener)
  }

  private emitThinking(roomId: string, event: ThinkingEvent): void {
    for (const listener of this.thinkingListeners.get(roomId) ?? []) listener(event)
  }

  get(roomId: string): RoomSnapshot {
    const room = this.store.getRoom(roomId)
    if (!room) throw new Error('Room not found.')
    return room
  }

  async submitTurn(roomId: string, input: SubmitTurnInput): Promise<void> {
    if (this.directorService.isActive(roomId)) throw new Error('A turn is already being processed for this room.')
    const room = this.get(roomId)
    if (room.phase !== 'awaiting-player-input') throw new Error(`Room is busy: ${room.phase}`)
    if (room.mode === 'chat') {
      return this.chatService.submitContribution(roomId, input.text)
    }
    return this.directorService.submitTurn(roomId, input)
  }

  /** 群聊模式：点选角色发言——该角色一次决策产出台词，进入待审批 */
  async speak(roomId: string, roleId: string, feedback = ''): Promise<void> {
    return this.chatService.speak(roomId, roleId, feedback)
  }

  /** 群聊模式：拒绝待审批台词及其附带世界变更，不发布正文。 */
  async rejectSpeech(roomId: string): Promise<void> {
    return this.chatService.rejectSpeech(roomId)
  }

  /** 群聊模式：发言失败后重试——复位到可发言的空闲态，再重新让同一角色发言 */
  async retrySpeak(roomId: string): Promise<void> {
    return this.chatService.retrySpeak(roomId)
  }

  /** 群聊模式：玩家批准（可先编辑）台词 → 发布 → 在场角色并行消化记忆 */
  async approveSpeech(roomId: string, text: string, worldChangeOverride?: import('./types.ts').WorldChangeRequest | null): Promise<void> {
    return this.chatService.approveSpeech(roomId, text, worldChangeOverride)
  }

  /**
   * 群聊模式：玩家用自然语言向导演建议世界变更（推进时间/换场景/人物进出场/新人物）。
   * 导演一次调用产出回复 + 可选世界变更申请 + 叙述：
   * - 上帝模式（autoPublish=false）：申请进入待确认，玩家批准后落地并写叙述；
   * - 沉浸模式（autoPublish=true）：申请直接落地并写叙述。
   */
  async directorChat(roomId: string, text: string): Promise<void> {
    return this.chatService.directorChat(roomId, text)
  }

  /** 群聊模式：玩家批准导演对话产出的世界变更申请（无台词）→ 落地并写叙述 */
  async approveWorldChange(roomId: string, override?: import('./types.ts').WorldChangeRequest | null): Promise<void> {
    return this.chatService.approveWorldChange(roomId, override)
  }

  /** 群聊模式：玩家拒绝导演对话产出的世界变更申请 → 清空申请 */
  async rejectWorldChange(roomId: string): Promise<void> {
    return this.chatService.rejectWorldChange(roomId)
  }

  cancelTurn(roomId: string): void {
    if (this.get(roomId).mode === 'chat') {
      this.chatService.cancel(roomId)
      return
    }
    this.directorService.cancel(roomId)
  }

  /** 角色反馈确认完毕，进入导演起草（拟定草稿） */
  async proceedToDraft(roomId: string): Promise<void> {
    return this.directorService.proceedToDraft(roomId)
  }

  async rejectDraft(roomId: string): Promise<void> {
    return this.directorService.rejectDraft(roomId)
  }

  async retryDirector(roomId: string): Promise<void> {
    return this.directorService.retryDirector(roomId)
  }

  async reconsiderReaction(roomId: string, roleId: string, feedback: string): Promise<void> {
    return this.directorService.reconsiderReaction(roomId, roleId, feedback)
  }

  exportArchive(roomId: string): Record<string, unknown> { return this.store.exportRoom(roomId) }

  importArchive(roomId: string, archive: { room?: RoomSnapshot }): void {
    if (this.get(roomId).phase !== 'awaiting-player-input') throw new Error('读档需要空闲房间。')
    this.store.importRoom(roomId, archive)
    this.emit(roomId)
  }

  restart(roomId: string, story: import('./story-packages.ts').StoryPackage, options: { mode?: import('./types.ts').RoomMode; autoPublish?: boolean } = {}): void {
    this.chatService.cancel(roomId)
    this.directorService.cancel(roomId)
    this.store.restartRoom(roomId, story, options)
    this.emit(roomId)
  }

  /** 更新房间游玩配置：模式（导演/群聊）与沉浸开关（autoPublish） */
  setRoomConfig(roomId: string, config: { mode?: import('./types.ts').RoomMode; autoPublish?: boolean }): void {
    this.store.setRoomConfig(roomId, config)
    this.emit(roomId)
  }

  updatePlayerCharacter(roomId: string, player: { name: string; persona: string; currentState: string }): void {
    this.store.updatePlayerCharacter(roomId, player)
    this.emit(roomId)
  }

  setPlayerAvatar(roomId: string, portraitRef: string): void {
    this.store.setPlayerAvatar(roomId, portraitRef)
    this.emit(roomId)
  }

  interveneRole(roomId: string, roleId: string, selfModel: string, memoryTimeline: Record<string, string[]> | undefined, config: { providerId?: string; modelOverride?: string; impressions?: Record<string, string>; goals?: string[]; thinkingStrength?: import('./types.ts').ThinkingStrength } = {}): void {
    const room = this.get(roomId)
    if (room.phase !== 'awaiting-player-input') throw new Error('Private role intervention requires an idle room.')
    this.store.updateRolePrivateState(roomId, roleId, selfModel, memoryTimeline, config)
    this.emit(roomId)
  }

  storeNpcMemories(roomId: string, roleId: string, entries: Array<{ id?: string; text?: string; occurredAt?: string }>): void {
    if (this.get(roomId).phase !== 'awaiting-player-input') throw new Error('管理 NPC 记忆需要在空闲时进行。')
    this.store.insertNpcMemories(roomId, roleId, entries.map((entry, index) => ({ id: entry.id ?? `manual-${Date.now()}-${index}`, text: String(entry.text ?? ''), occurredAt: entry.occurredAt ?? this.get(roomId).sceneTime ?? '过去', source: 'manual' })))
    this.emit(roomId)
  }

  retractNpcMemory(roomId: string, memoryId: string): void { this.store.retractNpcMemory(roomId, memoryId); this.emit(roomId) }

  updateNpcMemory(roomId: string, memoryId: string, entry: Parameters<Store['updateNpcMemory']>[2]): void { if (this.get(roomId).phase !== 'awaiting-player-input') throw new Error('管理 NPC 记忆需要在空闲时进行。'); this.store.updateNpcMemory(roomId, memoryId, entry); this.emit(roomId) }

  reorderNpcMemories(roomId: string, roleId: string, memoryIds: string[]): void { if (this.get(roomId).phase !== 'awaiting-player-input') throw new Error('调整记忆顺序需要在空闲时进行。'); this.store.reorderNpcMemories(roomId, roleId, memoryIds); this.emit(roomId) }
  supersedeNpcMemory(roomId: string, memoryId: string, entry: Omit<Parameters<Store['supersedeNpcMemory']>[2], 'id'>): void { if (this.get(roomId).phase !== 'awaiting-player-input') throw new Error('管理 NPC 记忆需要在空闲时进行。'); this.store.supersedeNpcMemory(roomId, memoryId, { ...entry, id: `manual-${randomUUID()}` }); this.emit(roomId) }

  saveLore(roomId: string, lore: import('./types.ts').LoreEntry[]): void {
    this.store.saveLore(roomId, lore)
    this.emit(roomId)
  }

  createRole(roomId: string, role: { id: string; name: string; portraitRef: string; currentState: string; presence: 'present' | 'absent' | 'unavailable'; selfModel: string; memoryTimeline?: Record<string, string[]>; initialMemories?: import('./types.ts').InitialMemory[]; goals?: string[] }): void {
    if (this.get(roomId).phase !== 'awaiting-player-input') throw new Error('新建角色需要在空闲时进行。')
    this.store.createRole(roomId, role)
    this.emit(roomId)
  }

  deleteRole(roomId: string, roleId: string): void {
    if (this.get(roomId).phase !== 'awaiting-player-input') throw new Error('删除角色需要在空闲时进行。')
    this.store.deleteRole(roomId, roleId)
    this.emit(roomId)
  }

  setRolePresence(roomId: string, roleId: string, presence: 'present' | 'absent' | 'unavailable'): void {
    this.store.setRolePresence(roomId, roleId, presence)
    this.emit(roomId)
  }

  setRoleThinking(roomId: string, roleId: string, thinkingStrength: import('./types.ts').ThinkingStrength): void {
    if (this.get(roomId).phase !== 'awaiting-player-input') throw new Error('调整角色思维链需要在空闲时进行。')
    this.store.setRoleThinking(roomId, roleId, thinkingStrength)
    this.emit(roomId)
  }

  reorderRoles(roomId: string, roleIds: string[]): void {
    if (this.get(roomId).phase !== 'awaiting-player-input') throw new Error('调整顺序需要在空闲时进行。')
    this.store.reorderRoles(roomId, roleIds)
    this.emit(roomId)
  }

  setRoleAvatar(roomId: string, roleId: string, portraitRef: string): void {
    this.store.setRoleAvatar(roomId, roleId, portraitRef)
    this.emit(roomId)
  }

  /** 玩家直接修改角色当前状态（点击角色状态失焦确认） */
  setRoleCurrentState(roomId: string, roleId: string, currentState: string): void {
    this.store.setRoleCurrentState(roomId, roleId, currentState)
    this.emit(roomId)
  }

  /** 无草稿时玩家引入设定（作为 player 发言存入导演交流，供起草参考） */
  setDirectorSetting(roomId: string, text: string): void {
    this.store.addConsultation(roomId, null, 'player', text)
    this.emit(roomId)
  }

  updateScene(roomId: string, updates: { time?: string; location?: string }): void {
    if (this.get(roomId).phase !== 'awaiting-player-input') throw new Error('修改场景需要在空闲时进行。')
    this.store.updateScene(roomId, updates)
    this.emit(roomId)
  }

  async consult(roomId: string, draftId: string, playerText: string, context = ''): Promise<void> {
    return this.directorService.consult(roomId, draftId, playerText, context)
  }

  finishConsultation(roomId: string): void {
    this.directorService.finishConsultation(roomId)
  }

  async redraft(roomId: string, draftId: string): Promise<void> {
    return this.directorService.redraft(roomId, draftId)
  }

  approve(roomId: string, draftId: string, text: string, stateUpdates: Record<string, string>, sceneUpdates?: { time?: string; location?: string }): void {
    this.directorService.approve(roomId, draftId, text, stateUpdates, sceneUpdates)
  }

  private emit(roomId: string): void {
    const snapshot = this.store.getRoom(roomId)
    if (!snapshot) return
    for (const listener of this.listeners.get(roomId) ?? []) listener(snapshot)
    // 将旧快照投影到 Core State 并发布事件（兼容层：不改变业务流程，只添加事件流）
    if (this.core && 'projectRoom' in this.core) {
      (this.core as { projectRoom(room: RoomSnapshot, causedBy?: string): void }).projectRoom(snapshot, `room-runtime:${roomId}`)
    }
  }
}
