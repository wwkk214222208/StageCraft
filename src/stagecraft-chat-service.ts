import { randomUUID } from 'node:crypto'
import type { RoomSnapshot, WorldChangeRequest } from './types.ts'
import type { CoreRuntimePort } from './core/protocol.ts'
import { domainEvent } from './core/domain-events.ts'
import type { StageCraftChatPort } from './core/solutions.ts'
import type { WorkerSet } from './workers.ts'

export interface StageCraftChatThinkingEvent {
  actor: 'role' | 'director'
  roleId?: string
  turnId: string
  text: string
  done: boolean
}

export interface StageCraftChatNotifications {
  get(roomId: string): RoomSnapshot
  notify(roomId: string): void
  thinking(roomId: string, event: StageCraftChatThinkingEvent): void
}

/** Store-backed群聊领域服务。它不依赖 RoomRuntime；RoomRuntime 只作为兼容 facade。 */
export class StageCraftChatService implements StageCraftChatPort {
  private readonly store: import('./store.ts').Store
  private workers: WorkerSet
  private core?: CoreRuntimePort
  private unsubscribeCore?: () => void
  private readonly notifications: StageCraftChatNotifications
  private readonly activeTurns = new Set<string>()
  private readonly activeDirectorChats = new Set<string>()
  private readonly turnIds = new Map<string, string>()
  private readonly cancelledTurns = new Set<string>()
  private readonly cancelledRequests = new Set<string>()
  private readonly digestingRooms = new Set<string>()
  private readonly coreRequestContexts = new Map<string, { roomId: string; actor: 'role' | 'director'; roleId?: string; turnId: string }>()
  private disposed = false

  constructor(store: import('./store.ts').Store, workers: WorkerSet, core: CoreRuntimePort | undefined, notifications: StageCraftChatNotifications) {
    this.store = store
    this.workers = workers
    this.notifications = notifications
    if (core) this.setCoreRuntime(core)
  }

  setWorkers(workers: WorkerSet): void {
    if (this.disposed) throw new Error('StageCraft chat service is disposed.')
    if (this.activeTurns.size > 0) throw new Error('回合进行中不能切换模型。')
    this.workers = workers
  }

  setCoreRuntime(core: CoreRuntimePort): void {
    if (this.disposed) return
    this.unsubscribeCore?.()
    this.core = core
    this.unsubscribeCore = core.subscribe(event => {
      if (event.type === 'model.started') {
        const correlation = event.request.metadata?.correlation
        if (correlation && typeof correlation === 'object') {
          const value = correlation as Record<string, unknown>
          if (typeof value.roomId === 'string' && typeof value.turnId === 'string' && (value.actor === 'role' || value.actor === 'director')) {
            this.coreRequestContexts.set(event.request.requestId, { roomId: value.roomId, turnId: value.turnId, actor: value.actor, ...(typeof value.roleId === 'string' ? { roleId: value.roleId } : {}) })
          }
        }
        return
      }
      if (event.type === 'model.thinking.delta') {
        const context = this.coreRequestContexts.get(event.requestId)
        if (context) this.notifications.thinking(context.roomId, { ...context, text: event.text, done: false })
        return
      }
      if (event.type === 'model.completed') this.coreRequestContexts.delete(event.result.requestId)
      if (event.type === 'error' && event.requestId) this.coreRequestContexts.delete(event.requestId)
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeCore?.()
    this.unsubscribeCore = undefined
    this.coreRequestContexts.clear()
    for (const turnId of this.turnIds.values()) {
      this.cancelledTurns.add(turnId)
      this.cancelledRequests.add(turnId)
    }
    this.workers.cancel?.()
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('StageCraft chat service is disposed.')
  }

  async speak(roomId: string, roleId: string, feedback = ''): Promise<void> {
    this.ensureActive()
    if (this.activeTurns.has(roomId)) throw new Error('A turn is already being processed for this room.')
    const room = this.notifications.get(roomId)
    if (room.mode !== 'chat') throw new Error('当前不是群聊模式。')
    if (room.phase !== 'awaiting-player-input') throw new Error(`Room is busy: ${room.phase}`)
    const role = room.roles.find(item => item.id === roleId)
    if (!role) throw new Error('角色不存在。')
    if (role.presence !== 'present') throw new Error('该角色当前不在场，不能发言。')
    this.activeTurns.add(roomId)
    const turnId = randomUUID()
    this.turnIds.set(roomId, turnId)
    this.cancelledTurns.delete(turnId)
    this.store.createTurn(roomId, turnId, room.playerContribution ?? '', [{ roleId, participation: 'required', status: 'pending' }], 'role-speaking')
    this.core?.emitDomainEvent(domainEvent('role.speech.requested', { roomId, roleId, turnId }))
    this.notifications.notify(roomId)
    try {
      const latest = this.notifications.get(roomId)
      const speaking = latest.roles.find(item => item.id === roleId)!
      const contribution = latest.playerContribution ?? ''
      const contributionText = contribution.trim() ? contribution : '玩家没有说话，只是注视着你。'
      const speechInstruction = feedback.trim() ? `${contributionText}\n\n玩家对上一版台词的批复意见：${feedback.trim()}\n请根据批复重新生成更合适的台词。` : contributionText
      if (!this.workers.speak) throw new Error('当前模型服务不支持群聊发言协议。')
      const result = await this.workers.speak(speaking, speechInstruction, latest.roles, { time: latest.sceneTime, location: latest.sceneLocation, roomId, turnId }, text => {
        this.notifications.thinking(roomId, { actor: 'role', roleId, turnId, text, done: false })
      }, latest.lore, latest.scenes.at(-1)?.text)
      this.notifications.thinking(roomId, { actor: 'role', roleId, turnId, text: '', done: true })
      if (this.cancelledTurns.has(turnId)) return
      const text = result.text?.trim()
      if (!text) throw new Error('角色没有产出发言内容。')
      const speech = { roleId, text, ...(result.thinking ? { thinking: result.thinking } : {}), ...(result.usage ? { usage: result.usage } : {}), ...(result.worldChange ? { worldChange: result.worldChange } : {}), turnId }
      this.store.saveSpeech(roomId, speech)
      this.core?.emitDomainEvent(domainEvent('role.speech.generated', { roomId, speech }))
      if (result.worldChange) this.core?.emitDomainEvent(domainEvent('world-change.proposed', { roomId, change: result.worldChange, source: 'speech' }))
      this.notifications.notify(roomId)
      if (this.notifications.get(roomId).autoPublish) await this.approveSpeech(roomId, text)
    } catch (error) {
      this.notifications.thinking(roomId, { actor: 'role', roleId, turnId, text: '', done: true })
      if (this.cancelledTurns.has(turnId)) return
      this.store.saveDecision(turnId, { roleId, participation: 'required', status: 'unavailable', error: String(error) })
      this.store.failRoom(roomId, `角色发言失败：${String(error)}`)
      this.notifications.notify(roomId)
    } finally {
      this.activeTurns.delete(roomId)
      this.turnIds.delete(roomId)
    }
  }

  async rejectSpeech(roomId: string): Promise<void> {
    this.ensureActive()
    const room = this.notifications.get(roomId)
    if (room.mode !== 'chat') throw new Error('当前不是群聊模式。')
    const speech = this.store.rejectSpeech(roomId)
    this.core?.emitDomainEvent(domainEvent('speech.rejected', { roomId, roleId: speech.roleId, turnId: speech.turnId }))
    if (speech.worldChange) this.core?.emitDomainEvent(domainEvent('world-change.rejected', { roomId, change: speech.worldChange }))
    this.notifications.notify(roomId)
  }

  async retrySpeak(roomId: string): Promise<void> {
    this.ensureActive()
    const room = this.notifications.get(roomId)
    if (room.mode !== 'chat') throw new Error('当前不是群聊模式。')
    const failed = room.decisions.find(decision => decision.status === 'unavailable')
    if (!failed) throw new Error('没有可重试的发言。')
    this.store.cancelTurn(roomId)
    await this.speak(roomId, failed.roleId)
  }

  async approveSpeech(roomId: string, text: string, worldChangeOverride?: WorldChangeRequest | null): Promise<void> {
    this.ensureActive()
    const room = this.notifications.get(roomId)
    if (room.mode !== 'chat') throw new Error('当前不是群聊模式。')
    if (!['awaiting-approval', 'world-change-approval'].includes(room.phase) || !room.speech) throw new Error('当前没有待审批的台词。')
    const speech = room.speech
    const playerText = room.playerContribution ?? ''
    const worldChange = worldChangeOverride ?? speech.worldChange ?? null
    const worldChangeId = this.store.approveSpeech(roomId, text, undefined, worldChangeOverride)
    this.core?.emitDomainEvent(domainEvent('speech.approved', { roomId, text, worldChange }))
    if (worldChange) this.core?.emitDomainEvent(domainEvent('world-change.approved', { roomId, change: worldChange }))
    this.core?.emitDomainEvent(domainEvent('scene.published', { roomId, speaker: speech.roleId, text: text.trim() }))
    this.notifications.notify(roomId)
    await this.digestAfterSpeech(roomId, [playerText, text.trim()].filter(Boolean).join('\n'), 'role_reaction', worldChangeId)
  }

  async directorChat(roomId: string, text: string): Promise<void> {
    this.ensureActive()
    if (this.activeTurns.has(roomId)) throw new Error('A turn is already being processed for this room.')
    const room = this.notifications.get(roomId)
    if (room.mode !== 'chat') throw new Error('当前不是群聊模式。')
    if (room.phase !== 'awaiting-player-input') throw new Error(`Room is busy: ${room.phase}`)
    if (!this.workers.directorChat) throw new Error('当前模型服务不支持导演对话。')
    const playerText = String(text ?? '').trim()
    if (!playerText) throw new Error('请输入你想对导演说的话。')
    this.core?.emitDomainEvent(domainEvent('director.suggestion.submitted', { roomId, text: playerText }))
    this.activeTurns.add(roomId)
    this.activeDirectorChats.add(roomId)
    try {
      const context: import('./workers.ts').DirectorChatContext = {
        sceneTime: room.sceneTime, sceneLocation: room.sceneLocation, playerName: room.playerCharacter.name,
        playerContribution: room.playerContribution ?? '', recentScene: room.scenes.at(-1)?.text, roles: room.roles, lore: room.lore, history: room.consultations,
        roomId, turnId: `director-${roomId}`,
      }
      const result = await this.workers.directorChat(playerText, context, thinkingText => {
        this.notifications.thinking(roomId, { actor: 'director', turnId: `director-${Date.now()}`, text: thinkingText, done: false })
      })
      this.notifications.thinking(roomId, { actor: 'director', turnId: 'director', text: '', done: true })
      if (this.cancelledRequests.has(roomId)) return
      const reply = result.reply?.trim()
      if (!reply) throw new Error('导演没有产出回复。')
      this.store.addConsultation(roomId, null, 'player', playerText)
      this.store.addConsultation(roomId, null, 'director', reply, result.usage, result.thinking)
      if (!result.worldChange) this.core?.emitDomainEvent(domainEvent('director.reply.generated', { roomId, text: reply }))
      if (result.worldChange) {
        this.core?.emitDomainEvent(domainEvent('world-change.proposed', { roomId, change: result.worldChange, source: 'director' }))
        if (this.notifications.get(roomId).autoPublish) {
          this.store.saveWorldChange(roomId, result.worldChange, result.narration)
          const worldChangeId = this.store.approveWorldChange(roomId)
          if (result.narration?.trim()) {
            this.store.addNarrationScene(roomId, result.narration, result.usage, worldChangeId)
            this.notifications.notify(roomId)
            await this.digestAfterSpeech(roomId, result.narration, 'world_change', worldChangeId)
          } else this.notifications.notify(roomId)
        } else {
          this.store.saveWorldChange(roomId, result.worldChange, result.narration)
          this.notifications.notify(roomId)
        }
      } else this.notifications.notify(roomId)
    } finally {
      this.activeTurns.delete(roomId)
      this.activeDirectorChats.delete(roomId)
      this.cancelledRequests.delete(roomId)
    }
  }

  async approveWorldChange(roomId: string, override?: WorldChangeRequest | null): Promise<void> {
    this.ensureActive()
    const room = this.notifications.get(roomId)
    if (room.mode !== 'chat') throw new Error('当前不是群聊模式。')
    if (room.phase !== 'world-change-approval' || room.speech) throw new Error('当前没有待确认的世界变更申请。')
    const narration = room.pendingNarration
    const change = override ?? room.pendingWorldChange ?? {}
    const worldChangeId = this.store.approveWorldChange(roomId, override)
    this.core?.emitDomainEvent(domainEvent('world-change.approved', { roomId, change }))
    if (narration?.trim()) {
      this.store.addNarrationScene(roomId, narration, undefined, worldChangeId)
      this.notifications.notify(roomId)
      await this.digestAfterSpeech(roomId, narration, 'world_change', worldChangeId)
    } else this.notifications.notify(roomId)
  }

  async rejectWorldChange(roomId: string): Promise<void> {
    this.ensureActive()
    const room = this.notifications.get(roomId)
    if (room.mode !== 'chat') throw new Error('当前不是群聊模式。')
    if (room.phase !== 'world-change-approval' || room.speech) throw new Error('当前没有待确认的世界变更申请。')
    this.store.rejectWorldChange(roomId)
    this.core?.emitDomainEvent(domainEvent('world-change.rejected', { roomId, change: room.pendingWorldChange }))
    this.notifications.notify(roomId)
  }

  cancel(roomId: string): void {
    if (this.disposed) return
    for (const [requestId, context] of this.coreRequestContexts) if (context.roomId === roomId) this.coreRequestContexts.delete(requestId)
    const room = this.notifications.get(roomId)
    const directorChatActive = this.activeDirectorChats.has(roomId)
    const cancellablePhase = ['collecting-decisions', 'drafting', 'consulting-director', 'role-speaking', 'world-change-approval'].includes(room.phase)
    if (!directorChatActive && !cancellablePhase) return
    this.cancelledRequests.add(roomId)
    this.workers.cancel?.()
    const turnId = this.turnIds.get(roomId)
    if (turnId) this.cancelledRequests.add(turnId)
    if (turnId) this.cancelledTurns.add(turnId)
    if (!directorChatActive) {
      this.store.cancelTurn(roomId)
      if (room.speech) this.core?.emitDomainEvent(domainEvent('speech.rejected', { roomId, roleId: room.speech.roleId, turnId: room.speech.turnId }))
    }
    this.notifications.notify(roomId)
  }

  private async digestAfterSpeech(roomId: string, sceneText: string, source: 'role_reaction' | 'world_change' = 'role_reaction', worldChangeId?: string): Promise<void> {
    if (!this.workers.digest || this.digestingRooms.has(roomId)) return
    this.digestingRooms.add(roomId)
    try {
      const snapshot = this.notifications.get(roomId)
      const present = snapshot.roles.filter(role => role.presence === 'present')
      const scene = snapshot.scenes.at(-1)
      if (!scene) return
      await Promise.all(present.map(async role => {
        try {
          const digest = await this.workers.digest!(role, { id: scene.id, turnId: scene.turnId, text: sceneText, sceneTime: scene.sceneTime, sceneLocation: scene.sceneLocation, source, worldChangeId })
          const entries = normalizeDigestEntries(digest.entries)
          if (entries.length) this.store.insertNpcMemories(roomId, role.id, entries.map((entry, index) => ({ id: `digest-${scene.id}-${role.id}-${index}`, sceneId: scene.id, turnId: scene.turnId, ...(worldChangeId ? { worldChangeId } : {}), occurredAt: entry.occurredAt ?? scene.sceneTime ?? '过去', occurredLocation: scene.sceneLocation, source, ...entry })))
        } catch (error) { console.error(`[memory digest failed] ${role.id}: ${error}`) }
      }))
      this.notifications.notify(roomId)
    } finally { this.digestingRooms.delete(roomId) }
  }
}

function normalizeDigestEntries(value: unknown): Array<import('./types.ts').MemoryDigestEntry> {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const entry = item as Record<string, unknown>
    const text = typeof entry.text === 'string' ? entry.text.trim() : ''
    if (!text) return []
    return [{ text, ...(typeof entry.occurredAt === 'string' && entry.occurredAt.trim() ? { occurredAt: entry.occurredAt.trim() } : {}) }]
  })
}
