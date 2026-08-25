import type { RoomSnapshot, SubmitTurnInput } from './types.ts'
import { Store } from './store.ts'
import { fakeWorkers } from './workers.ts'
import type { WorkerSet } from './workers.ts'
import type { CoreRuntimePort } from './core/protocol.ts'
import { StageCraftChatService } from './stagecraft-chat-service.ts'
import { StageCraftDirectorService } from './stagecraft-director-service.ts'
import { StageCraftManagementService } from './stagecraft-management-service.ts'

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
  private readonly managementService: StageCraftManagementService

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
    this.managementService = new StageCraftManagementService(store, {
      get: roomId => this.get(roomId),
      notify: roomId => this.emit(roomId),
    }, {
      beforeRestart: roomId => {
        const phase = this.get(roomId).phase
        if (['collecting-decisions', 'drafting', 'consulting-director', 'role-speaking', 'world-change-approval'].includes(phase)) {
          this.chatService.cancel(roomId)
          this.directorService.cancel(roomId)
        }
      },
    })
  }

  setCoreRuntime(core: CoreRuntimePort): void {
    this.core = core
    this.chatService.setCoreRuntime(core)
    this.directorService.setCoreRuntime(core)
  }

  getChatService(): StageCraftChatService { return this.chatService }
  getDirectorService(): StageCraftDirectorService { return this.directorService }
  getManagementService(): StageCraftManagementService { return this.managementService }

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

  /** 群聊发言模式「所有人依次发言」：所有在场角色按顺序逐个发言、逐个审批。 */
  async speakAll(roomId: string): Promise<void> {
    return this.chatService.speakAll(roomId)
  }

  /** 群聊发言模式「导演决定发言角色」：世界导演选角后逐个发言、逐个审批。 */
  async directorDecide(roomId: string): Promise<void> {
    return this.chatService.directorDecide(roomId)
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
    this.managementService.importArchive(roomId, archive)
  }

  restart(roomId: string, story: import('./story-packages.ts').StoryPackage, options: { mode?: import('./types.ts').RoomMode; autoPublish?: boolean } = {}): void {
    this.managementService.restart(roomId, story, options)
  }

  /** 更新房间游玩配置：模式（导演/群聊）与沉浸开关（autoPublish） */
  setRoomConfig(roomId: string, config: { mode?: import('./types.ts').RoomMode; autoPublish?: boolean }): void {
    this.managementService.setRoomConfig(roomId, config)
  }

  updatePlayerCharacter(roomId: string, player: { name: string; persona: string; currentState: string }): void {
    this.managementService.updatePlayerCharacter(roomId, player)
  }

  setPlayerAvatar(roomId: string, portraitRef: string): void {
    this.managementService.setPlayerAvatar(roomId, portraitRef)
  }

  interveneRole(roomId: string, roleId: string, selfModel: string, config: { providerId?: string; modelOverride?: string; impressions?: Record<string, string>; goals?: string[]; thinkingStrength?: import('./types.ts').ThinkingStrength } = {}): void {
    this.managementService.interveneRole(roomId, roleId, selfModel, config)
  }

  storeNpcMemories(roomId: string, roleId: string, entries: Array<{ id?: string; text?: string; occurredAt?: string }>): void {
    this.managementService.storeNpcMemories(roomId, roleId, entries)
  }

  retractNpcMemory(roomId: string, memoryId: string): void { this.managementService.retractNpcMemory(roomId, memoryId) }

  updateNpcMemory(roomId: string, memoryId: string, entry: Parameters<Store['updateNpcMemory']>[2]): void { this.managementService.updateNpcMemory(roomId, memoryId, entry) }

  reorderNpcMemories(roomId: string, roleId: string, memoryIds: string[]): void { this.managementService.reorderNpcMemories(roomId, roleId, memoryIds) }
  supersedeNpcMemory(roomId: string, memoryId: string, entry: Omit<Parameters<Store['supersedeNpcMemory']>[2], 'id'>): void { this.managementService.supersedeNpcMemory(roomId, memoryId, entry) }

  saveLore(roomId: string, lore: import('./types.ts').LoreEntry[]): void {
    this.managementService.saveLore(roomId, lore)
  }

  createRole(roomId: string, role: { id: string; name: string; portraitRef: string; currentState: string; presence: 'present' | 'absent' | 'unavailable'; selfModel: string; memories?: import('./types.ts').InitialMemory[]; goals?: string[] }): void {
    this.managementService.createRole(roomId, role)
  }

  deleteRole(roomId: string, roleId: string): void {
    this.managementService.deleteRole(roomId, roleId)
  }

  setRolePresence(roomId: string, roleId: string, presence: 'present' | 'absent' | 'unavailable'): void {
    this.managementService.setRolePresence(roomId, roleId, presence)
  }

  setRoleThinking(roomId: string, roleId: string, thinkingStrength: import('./types.ts').ThinkingStrength): void {
    this.managementService.setRoleThinking(roomId, roleId, thinkingStrength)
  }

  reorderRoles(roomId: string, roleIds: string[]): void {
    this.managementService.reorderRoles(roomId, roleIds)
  }

  setRoleAvatar(roomId: string, roleId: string, portraitRef: string): void {
    this.managementService.setRoleAvatar(roomId, roleId, portraitRef)
  }

  /** 玩家直接修改角色当前状态（点击角色状态失焦确认） */
  setRoleCurrentState(roomId: string, roleId: string, currentState: string): void {
    this.managementService.setRoleCurrentState(roomId, roleId, currentState)
  }

  /** 无草稿时玩家引入设定（作为 player 发言存入导演交流，供起草参考） */
  setDirectorSetting(roomId: string, text: string): void {
    this.managementService.setDirectorSetting(roomId, text)
  }

  updateScene(roomId: string, updates: { time?: string; location?: string }): void {
    this.managementService.updateScene(roomId, updates)
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
