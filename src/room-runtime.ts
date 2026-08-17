import { randomUUID } from 'node:crypto'
import type { Decision, Draft, RoomSnapshot, SubmitTurnInput } from './types.ts'
import { Store } from './store.ts'
import { fakeWorkers } from './workers.ts'
import type { WorkerSet } from './workers.ts'

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
  private readonly activeTurns = new Set<string>()
  private readonly turnIds = new Map<string, string>()
  private readonly cancelledTurns = new Set<string>()
  private readonly cancelledRequests = new Set<string>()
  private readonly digestingRooms = new Set<string>()
  private readonly store: Store
  private workers: WorkerSet

  constructor(store: Store, workers: WorkerSet = fakeWorkers) {
    this.store = store
    this.workers = workers
  }

  setWorkers(workers: WorkerSet): void {
    if (this.activeTurns.size > 0) throw new Error('回合进行中不能切换模型。')
    this.workers = workers
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
    if (this.activeTurns.has(roomId)) throw new Error('A turn is already being processed for this room.')
    const room = this.get(roomId)
    if (room.phase !== 'awaiting-player-input') throw new Error(`Room is busy: ${room.phase}`)
    if (room.mode === 'chat') {
      // 群聊模式：提交的贡献存入上下文，同时作为一条玩家气泡插入对话流（类似酒馆，玩家发言直接上屏）
      if (!input.text.trim()) { this.emit(roomId); return }
      this.store.setContribution(roomId, input.text)
      this.store.addPlayerScene(roomId, input.text)
      this.emit(roomId)
      return
    }
    this.activeTurns.add(roomId)
    try {
      await this.processTurn(roomId, input)
    } finally {
      this.activeTurns.delete(roomId)
      this.turnIds.delete(roomId)
    }
  }

  /** 群聊模式：点选角色发言——该角色一次决策产出台词，进入待审批 */
  async speak(roomId: string, roleId: string): Promise<void> {
    if (this.activeTurns.has(roomId)) throw new Error('A turn is already being processed for this room.')
    const room = this.get(roomId)
    if (room.mode !== 'chat') throw new Error('当前不是群聊模式。')
    if (room.phase !== 'awaiting-player-input') throw new Error(`Room is busy: ${room.phase}`)
    const role = room.roles.find(item => item.id === roleId)
    if (!role) throw new Error('角色不存在。')
    if (role.presence !== 'present') throw new Error('该角色当前不在场，不能发言。')
    this.activeTurns.add(roomId)
    const turnId = randomUUID()
    this.turnIds.set(roomId, turnId)
    this.cancelledTurns.delete(turnId)
    // 单个 required 决策 = 被点选角色的发言
    this.store.createTurn(roomId, turnId, room.playerContribution ?? '', [{ roleId, participation: 'required', status: 'pending' }], 'role-speaking')
    this.emit(roomId)
    try {
      const latest = this.get(roomId)
      const speaking = latest.roles.find(item => item.id === roleId)!
      const contribution = latest.playerContribution ?? ''
      const contributionText = contribution.trim() ? contribution : '玩家没有说话，只是注视着你。'
      if (!this.workers.speak) throw new Error('当前模型服务不支持群聊发言协议。')
      const result = await this.workers.speak(speaking, contributionText, latest.roles, { time: latest.sceneTime, location: latest.sceneLocation }, (text) => {
        this.emitThinking(roomId, { actor: 'role', roleId, turnId, text, done: false })
      }, latest.lore, latest.scenes.at(-1)?.text)
      this.emitThinking(roomId, { actor: 'role', roleId, turnId, text: '', done: true })
      if (this.cancelledTurns.has(turnId)) return
      const text = result.text?.trim()
      if (!text) throw new Error('角色没有产出发言内容。')
      this.store.saveSpeech(roomId, { roleId, text, ...(result.thinking ? { thinking: result.thinking } : {}), ...(result.usage ? { usage: result.usage } : {}), turnId })
      this.emit(roomId)
      // 沉浸模式：跳过审批，自动发布并触发在场角色消化
      if (this.get(roomId).autoPublish) {
        await this.approveSpeech(roomId, text)
      }
    } catch (error) {
      this.emitThinking(roomId, { actor: 'role', roleId, turnId, text: '', done: true })
      if (this.cancelledTurns.has(turnId)) return
      // 标记该角色决策为「回应失败」，左侧栏据此显示「回应失败」并暴露重试入口
      this.store.saveDecision(turnId, { roleId, participation: 'required', status: 'unavailable', error: String(error) })
      this.store.failRoom(roomId, `角色发言失败：${String(error)}`)
      this.emit(roomId)
    } finally {
      this.activeTurns.delete(roomId)
      this.turnIds.delete(roomId)
    }
  }

  /** 群聊模式：发言失败后重试——复位到可发言的空闲态，再重新让同一角色发言 */
  async retrySpeak(roomId: string): Promise<void> {
    const room = this.get(roomId)
    if (room.mode !== 'chat') throw new Error('当前不是群聊模式。')
    const failed = room.decisions.find(decision => decision.status === 'unavailable')
    if (!failed) throw new Error('没有可重试的发言。')
    // 清除上一轮残留的错误与 speech，回到空闲态以便重新发言
    this.store.cancelTurn(roomId)
    await this.speak(roomId, failed.roleId)
  }

  /** 群聊模式：玩家批准（可先编辑）台词 → 发布 → 在场角色并行消化记忆 */
  async approveSpeech(roomId: string, text: string): Promise<void> {
    const room = this.get(roomId)
    if (room.mode !== 'chat') throw new Error('当前不是群聊模式。')
    if (room.phase !== 'awaiting-approval' || !room.speech) throw new Error('当前没有待审批的台词。')
    const speech = room.speech
    const playerText = room.playerContribution ?? ''
    this.store.approveSpeech(roomId, text)
    this.emit(roomId)
    // 记忆消化时把玩家发言一并并入，否则角色只记得自己的台词、记不住玩家说了什么
    await this.digestAfterSpeech(roomId, [playerText, text.trim()].filter(Boolean).join('\n'))
  }

  /** 群聊模式：台词发布后，所有在场角色各跑一次消化调用，把记忆并入时间线 */
  private async digestAfterSpeech(roomId: string, sceneText: string): Promise<void> {
    if (!this.workers.digest) return
    if (this.digestingRooms.has(roomId)) return
    this.digestingRooms.add(roomId)
    try {
      const snapshot = this.store.getRoom(roomId)
      if (!snapshot) return
      const present = snapshot.roles.filter(role => role.presence === 'present')
      // 记忆一律按「当前场景时间」归档，丢弃 LLM 自行理解的语义标签（如「情感」「重要约定」），
      // 保证时间线是以场景时间为序的事实记录，而非语义分组。
      const sceneTime = (snapshot.sceneTime ?? '').trim() || '未标注时间'
      await Promise.all(present.map(async role => {
        try {
          const digest = await this.workers.digest!(role, sceneText)
          const events = Object.values(digest.events ?? {}).flat().map(item => String(item ?? '').trim()).filter(Boolean)
          if (events.length) this.store.appendMemoryEvents(roomId, role.id, { [sceneTime]: events }, { fuzzy: false })
        } catch (error) {
          console.error(`[memory digest failed] ${role.id}: ${error}`)
        }
      }))
      this.emit(roomId)
    } finally {
      this.digestingRooms.delete(roomId)
    }
  }

  cancelTurn(roomId: string): void {
    this.cancelledRequests.add(roomId)
    this.workers.cancel?.()
    const turnId = this.turnIds.get(roomId)
    if (turnId) this.cancelledRequests.add(turnId)
    if (turnId) this.cancelledTurns.add(turnId)
    this.store.cancelTurn(roomId)
    this.emit(roomId)
  }

  private async processTurn(roomId: string, input: SubmitTurnInput): Promise<void> {
    const room = this.get(roomId)
    const required = new Set(input.requiredRoleIds ?? [])
    const presentIds = new Set(room.roles.filter(role => role.presence === 'present').map(role => role.id))
    const invalidRequired = [...required].filter(roleId => !presentIds.has(roleId))
    if (invalidRequired.length > 0) {
      throw new Error(`Required roles must be present: ${invalidRequired.join(', ')}`)
    }
    const decisions: Decision[] = room.roles.map(role => {
      if (role.presence !== 'present') return { roleId: role.id, participation: 'excluded', status: 'abstained' }
      return { roleId: role.id, participation: required.has(role.id) ? 'required' : 'optional', status: 'pending' }
    })
    const turnId = randomUUID()
    this.turnIds.set(roomId, turnId)
    this.cancelledTurns.delete(turnId)
    this.store.createTurn(roomId, turnId, input.text, decisions)
    this.emit(roomId)

    const runnable = this.get(roomId).roles.filter(role => decisions.find(d => d.roleId === role.id)?.participation !== 'excluded')
    const completed = await Promise.all(runnable.map(async role => {
      const decision = decisions.find(value => value.roleId === role.id)
      if (!decision) throw new Error('Decision roster mismatch.')
      try {
        const result = await this.workers.decide(role, decision.participation, input.text, room.roles, { time: room.sceneTime, location: room.sceneLocation }, (text) => {
          this.emitThinking(roomId, { actor: 'role', roleId: role.id, turnId, text, done: false })
        }, room.lore, room.scenes.at(-1)?.text)
        if (this.cancelledTurns.has(turnId)) return { ...decision, status: 'abstained' }
        this.emitThinking(roomId, { actor: 'role', roleId: role.id, turnId, text: '', done: true })
        const validated = validateDecision(result, decision)
        this.store.saveDecision(turnId, validated)
        if (validated.brief) this.store.saveReactionPreview(roomId, turnId, role.id, validated.brief)
        if (validated.impressions && Object.keys(validated.impressions).length > 0) this.store.applyRoleImpressions(roomId, role.id, validated.impressions)
        this.emit(roomId)
        return validated
      } catch (error) {
        this.emitThinking(roomId, { actor: 'role', roleId: role.id, turnId, text: '', done: true })
        const failed: Decision = { roleId: role.id, participation: decision.participation, status: 'unavailable', error: String(error) }
        console.error(`[role decision failed] ${role.id} (${decision.participation}): ${failed.error}`)
        this.store.saveDecision(turnId, failed)
        this.emit(roomId)
        return failed
      }
    }))

    if (this.cancelledTurns.has(turnId)) return
    const missingRequired = completed.filter(decision => decision.participation === 'required' && decision.status !== 'completed')
    if (missingRequired.length > 0) {
      this.store.failRoom(roomId, `Required role decisions unavailable: ${missingRequired.map(value => value.roleId).join(', ')}`)
      this.emit(roomId)
      return
    }

    // 角色决策完成：停下等用户确认/修改角色反馈，再由 proceedToDraft 触发导演起草（避免导演返工）。
    // 沉浸模式：跳过确认，决策完直接连续起草并自动发布（全程 AI 主导）。
    if (this.get(roomId).autoPublish) {
      await this.proceedToDraft(roomId)
      return
    }
    this.emit(roomId)
  }

  /** 角色反馈确认完毕，进入导演起草（拟定草稿） */
  async proceedToDraft(roomId: string): Promise<void> {
    const room = this.get(roomId)
    if (room.phase !== 'collecting-decisions') throw new Error('当前没有待确认的角色反馈。')
    const turnId = this.store.getLatestTurnId(roomId)
    if (!turnId) throw new Error('找不到当前回合。')
    const pending = room.decisions.filter(decision => decision.status === 'pending')
    if (pending.length > 0) throw new Error(`仍有角色决策未完成：${pending.map(decision => decision.roleId).join(', ')}`)
    this.store.transitionToDrafting(roomId)
    this.emit(roomId)
    try {
      const latest = this.get(roomId)
      const draft = await this.workers.draft(turnId, latest.playerContribution ?? '', room.decisions, latest.roles, this.store.listConsultationsForTurn(roomId, turnId), latest.playerCharacter, { time: latest.sceneTime, location: latest.sceneLocation }, (text) => {
        this.emitThinking(roomId, { actor: 'director', turnId, text, done: false })
      }, latest.lore, latest.scenes.at(-1)?.text)
      this.emitThinking(roomId, { actor: 'director', turnId, text: '', done: true })
      if (this.cancelledTurns.has(turnId)) return
      validateDraft(draft, turnId, latest.roles)
      this.store.saveDraft(roomId, draft)
      this.emit(roomId)
      // 沉浸模式：跳过审批，草稿直接发布（AI 主导）
      if (this.get(roomId).autoPublish) {
        this.approve(roomId, draft.id, draft.text, draft.stateUpdates, draft.sceneUpdates)
      }
    } catch (error) {
      this.emitThinking(roomId, { actor: 'director', turnId, text: '', done: true })
      if (this.cancelledTurns.has(turnId)) return
      this.store.failRoom(roomId, `Director failed: ${String(error)}`)
      this.emit(roomId)
    }
  }

  async retryDirector(roomId: string): Promise<void> {
    const room = this.get(roomId)
    if (room.phase !== 'drafting') throw new Error('当前没有可重试的导演请求。')
    const turnId = room.decisions.length > 0 ? this.store.getLatestTurnId(roomId) : undefined
    if (!turnId) throw new Error('找不到可重试的回合。')
    try {
      const draft = await this.workers.draft(turnId, room.playerContribution ?? '', room.decisions, room.roles, this.store.listConsultationsForTurn(roomId, turnId), room.playerCharacter, { time: room.sceneTime, location: room.sceneLocation }, (text) => {
        this.emitThinking(roomId, { actor: 'director', turnId, text, done: false })
      }, room.lore, room.scenes.at(-1)?.text)
      this.emitThinking(roomId, { actor: 'director', turnId, text: '', done: true })
      validateDraft(draft, turnId, room.roles)
      this.store.saveDraft(roomId, draft)
      this.emit(roomId)
    } catch (error) {
      this.emitThinking(roomId, { actor: 'director', turnId, text: '', done: true })
      if (this.cancelledTurns.has(turnId)) return
      this.store.failRoom(roomId, `Director failed: ${String(error)}`)
      this.emit(roomId)
    }
  }

  async reconsiderReaction(roomId: string, roleId: string, feedback: string): Promise<void> {
    const room = this.get(roomId)
    if (!['collecting-decisions', 'drafting', 'awaiting-approval', 'consulting-director'].includes(room.phase)) throw new Error('当前没有可重新考虑的角色反应。')
    const role = room.roles.find(item => item.id === roleId)
    const previous = room.decisions.find(item => item.roleId === roleId)
    const turnId = this.store.getLatestTurnId(roomId)
    if (!role || !previous || !turnId) throw new Error('找不到当前角色反应。')
    const result = await this.workers.decide(role, previous.participation, `${room.playerContribution ?? ''}\n\n玩家对你刚才的临时反应提出批复：${feedback}`, room.roles, { time: room.sceneTime, location: room.sceneLocation }, (text) => {
      this.emitThinking(roomId, { actor: 'role', roleId, turnId, text, done: false })
    }, room.lore, room.scenes.at(-1)?.text)
    this.emitThinking(roomId, { actor: 'role', roleId, turnId, text: '', done: true })
    const decision = validateDecision(result, previous)
    this.store.saveDecision(turnId, decision)
    if (decision.brief) this.store.saveReactionPreview(roomId, turnId, roleId, decision.brief)
    if (decision.impressions && Object.keys(decision.impressions).length > 0) this.store.applyRoleImpressions(roomId, roleId, decision.impressions)
    this.emit(roomId)
  }

  exportArchive(roomId: string): Record<string, unknown> { return this.store.exportRoom(roomId) }

  importArchive(roomId: string, archive: { room?: RoomSnapshot }): void {
    if (this.get(roomId).phase !== 'awaiting-player-input') throw new Error('读档需要空闲房间。')
    this.store.importRoom(roomId, archive)
    this.emit(roomId)
  }

  restart(roomId: string, story: import('./story-packages.ts').StoryPackage, options: { mode?: import('./types.ts').RoomMode; autoPublish?: boolean } = {}): void {
    const turnId = this.turnIds.get(roomId)
    if (turnId) this.cancelledTurns.add(turnId)
    this.activeTurns.delete(roomId)
    this.turnIds.delete(roomId)
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

  interveneRole(roomId: string, roleId: string, selfModel: string, memoryTimeline: Record<string, string[]>, config: { providerId?: string; modelOverride?: string; impressions?: Record<string, string>; goals?: string[] } = {}): void {
    const room = this.get(roomId)
    if (room.phase !== 'awaiting-player-input') throw new Error('Private role intervention requires an idle room.')
    this.store.updateRolePrivateState(roomId, roleId, selfModel, memoryTimeline, config)
    this.emit(roomId)
  }

  saveLore(roomId: string, lore: import('./types.ts').LoreEntry[]): void {
    this.store.saveLore(roomId, lore)
    this.emit(roomId)
  }

  createRole(roomId: string, role: { id: string; name: string; portraitRef: string; currentState: string; presence: 'present' | 'absent' | 'unavailable'; selfModel: string; memoryTimeline: Record<string, string[]>; goals?: string[] }): void {
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
    this.cancelledRequests.delete(roomId)
    const room = this.get(roomId)
    if (!room.draft || room.draft.id !== draftId) throw new Error('Draft is no longer available.')
    if (room.phase === 'awaiting-approval') this.store.startConsultation(roomId, draftId)
    else if (room.phase !== 'consulting-director') throw new Error(`Room is not available for consultation: ${room.phase}`)
    this.store.addConsultation(roomId, draftId, 'player', playerText)
    this.emit(roomId)
    if (!this.workers.consult) return
    try {
      const current = this.get(roomId)
      const answer = await this.workers.consult(current.draft!, this.store.listConsultationsForTurn(roomId, current.draft!.turnId), `${playerText}${context ? `\n\n${context}` : ''}`)
      this.store.addConsultation(roomId, draftId, 'director', answer.text, answer.usage)
      this.emit(roomId)
    } catch (error) {
      if (this.cancelledRequests.has(roomId)) return
      this.store.failRoom(roomId, `Director consultation failed: ${String(error)}`)
      this.emit(roomId)
    }
  }

  finishConsultation(roomId: string): void {
    this.store.finishConsultation(roomId)
    this.emit(roomId)
  }

  async redraft(roomId: string, draftId: string): Promise<void> {
    const room = this.get(roomId)
    if (!room.draft || room.draft.id !== draftId) throw new Error('Draft is no longer available.')
    if (!['awaiting-approval', 'consulting-director'].includes(room.phase)) throw new Error(`Room is not available for revision: ${room.phase}`)
    const turn = room.decisions
    this.store.transitionToDrafting(roomId)
    this.emit(roomId)
    try {
      const latest = this.get(roomId)
      const currentDraft = latest.draft!
      // 修订时场景上下文合并草稿已提案的 sceneUpdates，让导演知道拟议的新时间/地点
      const sceneContext = {
        time: currentDraft.sceneUpdates?.time ?? latest.sceneTime,
        location: currentDraft.sceneUpdates?.location ?? latest.sceneLocation,
      }
      const revised = await this.workers.draft(currentDraft.turnId, latest.playerContribution ?? '', turn, latest.roles, this.store.listConsultationsForTurn(roomId, currentDraft.turnId), latest.playerCharacter, sceneContext, (text) => {
        this.emitThinking(roomId, { actor: 'director', turnId: currentDraft.turnId, text, done: false })
      }, latest.lore, latest.scenes.at(-1)?.text, currentDraft.text)
      this.emitThinking(roomId, { actor: 'director', turnId: currentDraft.turnId, text: '', done: true })
      validateDraft(revised, currentDraft.turnId, latest.roles)
      this.store.saveDraft(roomId, revised)
      this.emit(roomId)
    } catch (error) {
      this.store.failRoom(roomId, `Director revision failed: ${String(error)}`)
      this.emit(roomId)
    }
  }

  approve(roomId: string, draftId: string, text: string, stateUpdates: Record<string, string>, sceneUpdates?: { time?: string; location?: string }): void {
    const room = this.get(roomId)
    if (room.phase !== 'awaiting-approval') throw new Error('No draft is awaiting approval.')
    this.store.publish(roomId, draftId, text, stateUpdates, sceneUpdates)
    this.emit(roomId)
  }

  private emit(roomId: string): void {
    const snapshot = this.store.getRoom(roomId)
    if (!snapshot) return
    for (const listener of this.listeners.get(roomId) ?? []) listener(snapshot)
  }
}

function validateDecision(result: Decision, expected: Decision): Decision {
  if (result.roleId !== expected.roleId) throw new Error(`Worker returned decision for unexpected role: ${result.roleId}`)
  if (result.participation !== expected.participation) throw new Error(`Worker returned unexpected participation for ${expected.roleId}`)
  if (!['completed', 'abstained', 'unavailable'].includes(result.status)) throw new Error(`Worker returned invalid status for ${expected.roleId}`)
  return result
}

function validateDraft(draft: { id: string; turnId: string; text: string; stateUpdates: Record<string, string>; settingProposals: unknown[]; intentHandling: unknown[]; openQuestions: unknown[]; roleProposals?: Array<{ id: string; name: string; currentState: string; presence: string; selfModel: string }> }, turnId: string, roles: Array<{ id: string }>): void {
  if (draft.turnId !== turnId) throw new Error('Director returned a draft for the wrong turn.')
  if (!draft.text.trim()) throw new Error('Director returned an empty draft.')
  if (!Array.isArray(draft.settingProposals) || !Array.isArray(draft.intentHandling) || !Array.isArray(draft.openQuestions)) throw new Error('Director returned invalid draft metadata.')
  const roleIds = new Set(roles.map(role => role.id))
  const unknownRoles = Object.keys(draft.stateUpdates).filter(roleId => roleId !== 'player' && !roleIds.has(roleId))
  if (unknownRoles.length > 0) throw new Error(`Director returned unknown role state updates: ${unknownRoles.join(', ')}`)
  for (const proposal of draft.roleProposals ?? []) {
    if (!proposal?.id || !proposal.name || !proposal.selfModel || !proposal.currentState) throw new Error('Director returned an invalid role proposal.')
    if (roleIds.has(proposal.id)) throw new Error(`Role proposal conflicts with existing role: ${proposal.id}`)
    if (!['present', 'absent', 'unavailable'].includes(proposal.presence)) throw new Error(`Role proposal has invalid presence: ${proposal.id}`)
  }
}
