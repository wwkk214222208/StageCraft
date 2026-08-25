import type { Decision, Draft, RoomSnapshot, SubmitTurnInput } from './types.ts'
import { fakeWorkers } from './workers.ts'
import type { WorkerSet } from './workers.ts'
import type { CoreRuntimePort } from './core/protocol.ts'
import { domainEvent } from './core/domain-events.ts'
import type { StageCraftDirectorPort } from './core/solutions.ts'
import type { StageCraftRepository } from './stagecraft-repository.ts'
import { systemIds, type IdFactory } from './core/platform.ts'

/** 最近已批准正文：跳过玩家发言气泡，取最后一条非玩家（已批准/开场/旁白）scene。 */
function recentApprovedText(scenes: Array<{ speaker?: string; text: string }>): string | undefined {
  for (let index = scenes.length - 1; index >= 0; index -= 1) {
    const scene = scenes[index]
    if (scene.speaker !== 'player') return scene.text
  }
  return undefined
}

export interface StageCraftDirectorNotifications {
  get(roomId: string): RoomSnapshot
  notify(roomId: string): void
  thinking(roomId: string, event: { actor: 'role' | 'director'; roleId?: string; turnId: string; text: string; done: boolean }): void
}

/** Store-backed 导演领域服务；RoomRuntime 仅保留兼容 facade。 */
export class StageCraftDirectorService implements StageCraftDirectorPort {
  private readonly store: StageCraftRepository
  private readonly ids: IdFactory
  private workers: WorkerSet
  private core?: CoreRuntimePort
  private unsubscribeCore?: () => void
  private readonly notifications: StageCraftDirectorNotifications
  private readonly activeTurns = new Set<string>()
  /** Any in-flight Director operation, including draft/retry/consult requests. */
  private readonly activeOperations = new Set<string>()
  private readonly turnIds = new Map<string, string>()
  private readonly cancelledTurns = new Set<string>()
  private readonly cancelledRequests = new Set<string>()
  private readonly coreRequestContexts = new Map<string, { roomId: string; actor: 'role' | 'director'; roleId?: string; turnId: string }>()
  private disposed = false

  constructor(store: StageCraftRepository, workers: WorkerSet = fakeWorkers, core: CoreRuntimePort | undefined, notifications: StageCraftDirectorNotifications, ports: { ids?: IdFactory } = {}) {
    this.store = store
    this.ids = ports.ids ?? systemIds
    this.workers = workers
    this.notifications = notifications
    if (core) this.setCoreRuntime(core)
  }

  setWorkers(workers: WorkerSet): void {
    if (this.disposed) throw new Error('StageCraft director service is disposed.')
    if (this.activeOperations.size > 0) throw new Error('回合进行中不能切换模型。')
    this.workers = workers
  }

  isActive(roomId?: string): boolean { return roomId ? this.activeOperations.has(roomId) : this.activeOperations.size > 0 }

  setCoreRuntime(core: CoreRuntimePort): void {
    if (this.disposed) return
    this.unsubscribeCore?.()
    this.coreRequestContexts.clear()
    this.core = core
    this.unsubscribeCore = core.subscribe(event => {
      if (event.type === 'model.started') {
        const correlation = event.request.metadata?.correlation
        if (correlation && typeof correlation === 'object') {
          const value = correlation as Record<string, unknown>
          if (typeof value.roomId === 'string' && typeof value.turnId === 'string' && (value.actor === 'role' || value.actor === 'director')) {
            if (value.mode === 'chat') return
            if (value.mode !== 'director' && !['role.decision', 'role.decision.retry', 'director.draft', 'director.draft.retry', 'director.consult'].includes(event.request.capability)) return
            try { if (this.notifications.get(value.roomId).mode !== 'director' && value.mode !== undefined) return } catch { return }
            if (this.cancelledRequests.has(value.roomId) || this.cancelledTurns.has(value.turnId)) return
            this.coreRequestContexts.set(event.request.requestId, {
              roomId: value.roomId,
              turnId: value.turnId,
              actor: value.actor,
              ...(typeof value.roleId === 'string' ? { roleId: value.roleId } : {}),
            })
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
    for (const turnId of this.turnIds.values()) this.cancelledTurns.add(turnId)
    void Promise.resolve(this.workers.cancel?.()).catch(() => undefined)
    this.activeOperations.clear()
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('StageCraft director service is disposed.')
  }

  async submitTurn(roomId: string, input: SubmitTurnInput): Promise<void> {
    this.ensureActive()
    if (this.activeOperations.has(roomId)) throw new Error('A Director operation is already active for this room.')
    const room = this.notifications.get(roomId)
    if (room.mode !== 'director') throw new Error('当前不是导演模式。')
    if (room.phase !== 'awaiting-player-input') throw new Error(`Room is busy: ${room.phase}`)
    this.activeTurns.add(roomId)
    this.activeOperations.add(roomId)
    this.cancelledRequests.delete(roomId)
    this.core?.emitDomainEvent(domainEvent('player.contribution.submitted', { roomId, text: input.text }))
    // 导演模式玩家发言始终记入正文（气泡样式，与群聊一致）；侧栏「隐藏玩家发言」只控制前端显示，不影响记录
    if (input.text.trim()) this.store.addPlayerScene(roomId, input.text)
    try {
      await this.processTurn(roomId, input)
    } finally {
      this.activeTurns.delete(roomId)
      this.activeOperations.delete(roomId)
      this.turnIds.delete(roomId)
    }
  }

  private async processTurn(roomId: string, input: SubmitTurnInput): Promise<void> {
    const room = this.notifications.get(roomId)
    const required = new Set(input.requiredRoleIds ?? [])
    const presentIds = new Set(room.roles.filter(role => role.presence === 'present').map(role => role.id))
    const invalidRequired = [...required].filter(roleId => !presentIds.has(roleId))
    if (invalidRequired.length > 0) throw new Error(`Required roles must be present: ${invalidRequired.join(', ')}`)
    const decisions: Decision[] = room.roles.map(role => role.presence !== 'present'
      ? { roleId: role.id, participation: 'excluded', status: 'abstained' }
      : { roleId: role.id, participation: required.has(role.id) ? 'required' : 'optional', status: 'pending' })
    const turnId = this.ids.create()
    this.turnIds.set(roomId, turnId)
    this.cancelledTurns.delete(turnId)
    this.store.createTurn(roomId, turnId, input.text, decisions)
    this.notifications.notify(roomId)
    const runnable = this.notifications.get(roomId).roles.filter(role => decisions.find(d => d.roleId === role.id)?.participation !== 'excluded')
    const completed = await Promise.all(runnable.map(async role => {
      const decision = decisions.find(value => value.roleId === role.id)
      if (!decision) throw new Error('Decision roster mismatch.')
      try {
        const result = await this.workers.decide(role, decision.participation, input.text, room.roles, { time: room.sceneTime, location: room.sceneLocation, roomId, turnId }, text => {
          this.notifications.thinking(roomId, { actor: 'role', roleId: role.id, turnId, text, done: false })
        }, room.lore, recentApprovedText(room.scenes))
        if (this.cancelledTurns.has(turnId)) return { ...decision, status: 'abstained' as const }
        this.notifications.thinking(roomId, { actor: 'role', roleId: role.id, turnId, text: '', done: true })
        const validated = validateDecision(result, decision)
        this.store.saveDecision(turnId, validated)
        if (validated.brief) this.store.saveReactionPreview(roomId, turnId, role.id, validated.brief)
        if (validated.impressions && Object.keys(validated.impressions).length > 0) this.store.applyRoleImpressions(roomId, role.id, validated.impressions)
        this.notifications.notify(roomId)
        return validated
      } catch (error) {
        this.notifications.thinking(roomId, { actor: 'role', roleId: role.id, turnId, text: '', done: true })
        if (this.cancelledTurns.has(turnId)) return { ...decision, status: 'abstained' as const }
        const failed: Decision = { roleId: role.id, participation: decision.participation, status: 'unavailable', error: String(error) }
        console.error(`[role decision failed] ${role.id} (${decision.participation}): ${failed.error}`)
        this.store.saveDecision(turnId, failed)
        this.notifications.notify(roomId)
        return failed
      }
    }))
    if (this.cancelledTurns.has(turnId)) return
    const missingRequired = completed.filter(decision => decision.participation === 'required' && decision.status !== 'completed')
    if (missingRequired.length > 0) {
      this.store.failRoom(roomId, `Required role decisions unavailable: ${missingRequired.map(value => value.roleId).join(', ')}`)
      this.notifications.notify(roomId)
      return
    }
    this.core?.emitDomainEvent(domainEvent('role.decision.completed', { roomId, turnId }))
    if (this.notifications.get(roomId).autoPublish) await this.proceedToDraft(roomId, true)
    else this.notifications.notify(roomId)
  }

  async proceedToDraft(roomId: string, internal = false): Promise<void> {
    this.ensureActive()
    if (!internal && this.activeOperations.has(roomId)) throw new Error('A Director operation is already active for this room.')
    const ownsOperation = !internal
    if (ownsOperation) this.activeOperations.add(roomId)
    try {
    const room = this.notifications.get(roomId)
    if (room.mode !== 'director') throw new Error('当前不是导演模式。')
    if (room.phase !== 'collecting-decisions') throw new Error('当前没有待确认的角色反馈。')
    const turnId = this.store.getLatestTurnId(roomId)
    if (!turnId) throw new Error('找不到当前回合。')
    const pending = room.decisions.filter(decision => decision.status === 'pending')
    if (pending.length > 0) throw new Error(`仍有角色决策未完成：${pending.map(decision => decision.roleId).join(', ')}`)
    this.store.transitionToDrafting(roomId)
    this.notifications.notify(roomId)
    try {
      const latest = this.notifications.get(roomId)
      const draft = await this.workers.draft(turnId, latest.playerContribution ?? '', latest.decisions, latest.roles, this.store.listConsultationsForTurn(roomId, turnId), latest.playerCharacter, { time: latest.sceneTime, location: latest.sceneLocation, roomId, turnId }, text => {
        this.notifications.thinking(roomId, { actor: 'director', turnId, text, done: false })
      }, latest.lore, recentApprovedText(latest.scenes))
      this.notifications.thinking(roomId, { actor: 'director', turnId, text: '', done: true })
      if (this.cancelledTurns.has(turnId)) return
      validateDraft(draft, turnId, latest.roles)
      this.store.saveDraft(roomId, draft)
      this.core?.emitDomainEvent(domainEvent('director.draft.generated', { roomId, draftId: draft.id, turnId }))
      this.notifications.notify(roomId)
      if (this.notifications.get(roomId).autoPublish) this.approve(roomId, draft.id, draft.text, draft.stateUpdates, draft.sceneUpdates, true)
    } catch (error) {
      this.notifications.thinking(roomId, { actor: 'director', turnId, text: '', done: true })
      if (this.cancelledTurns.has(turnId)) return
      this.store.failRoom(roomId, `Director failed: ${String(error)}`)
      this.notifications.notify(roomId)
    }
    } finally {
      if (ownsOperation) this.activeOperations.delete(roomId)
    }
  }

  async rejectDraft(roomId: string): Promise<void> {
    this.ensureActive()
    this.assertNoActiveOperation(roomId)
    const room = this.notifications.get(roomId)
    if (room.mode !== 'director' || room.phase !== 'awaiting-approval' || !room.draft) throw new Error('No draft is awaiting rejection.')
    const draftId = room.draft.id
    this.store.rejectDraft(roomId)
    this.core?.emitDomainEvent(domainEvent('draft.rejected', { roomId, draftId, reason: 'player-rejected' }))
    this.notifications.notify(roomId)
  }

  async retryDirector(roomId: string): Promise<void> {
    this.ensureActive()
    if (this.activeOperations.has(roomId)) throw new Error('A Director operation is already active for this room.')
    const ownsOperation = true
    this.activeOperations.add(roomId)
    try {
    const room = this.notifications.get(roomId)
    if (room.mode !== 'director' || room.phase !== 'drafting') throw new Error('当前没有可重试的导演请求。')
    const turnId = room.decisions.length > 0 ? this.store.getLatestTurnId(roomId) : undefined
    if (!turnId) throw new Error('找不到可重试的回合。')
    try {
      const draft = await this.workers.draft(turnId, room.playerContribution ?? '', room.decisions, room.roles, this.store.listConsultationsForTurn(roomId, turnId), room.playerCharacter, { time: room.sceneTime, location: room.sceneLocation, roomId, turnId }, text => this.notifications.thinking(roomId, { actor: 'director', turnId, text, done: false }), room.lore, recentApprovedText(room.scenes))
      this.notifications.thinking(roomId, { actor: 'director', turnId, text: '', done: true })
      if (this.cancelledTurns.has(turnId)) return
      validateDraft(draft, turnId, room.roles)
      this.store.saveDraft(roomId, draft)
      this.notifications.notify(roomId)
    } catch (error) {
      this.notifications.thinking(roomId, { actor: 'director', turnId, text: '', done: true })
      if (this.cancelledTurns.has(turnId)) return
      this.store.failRoom(roomId, `Director failed: ${String(error)}`)
      this.notifications.notify(roomId)
    }
    } finally {
      if (ownsOperation) this.activeOperations.delete(roomId)
    }
  }

  async reconsiderReaction(roomId: string, roleId: string, feedback: string): Promise<void> {
    this.ensureActive()
    if (this.activeOperations.has(roomId)) throw new Error('A Director operation is already active for this room.')
    const ownsOperation = true
    this.activeOperations.add(roomId)
    try {
    const room = this.notifications.get(roomId)
    if (room.mode !== 'director' || !['collecting-decisions', 'drafting', 'awaiting-approval', 'consulting-director'].includes(room.phase)) throw new Error('当前没有可重新考虑的角色反应。')
    const role = room.roles.find(item => item.id === roleId)
    const previous = room.decisions.find(item => item.roleId === roleId)
    const turnId = this.store.getLatestTurnId(roomId)
    if (!role || !previous || !turnId) throw new Error('找不到当前角色反应。')
    const reconsideration = feedback.trim() ? `${room.playerContribution ?? ''}\n\n玩家对你刚才的临时反应提出批复：${feedback.trim()}` : (room.playerContribution ?? '')
    const result = await this.workers.decide(role, previous.participation, reconsideration, room.roles, { time: room.sceneTime, location: room.sceneLocation, roomId, turnId }, text => this.notifications.thinking(roomId, { actor: 'role', roleId, turnId, text, done: false }), room.lore, recentApprovedText(room.scenes))
    this.notifications.thinking(roomId, { actor: 'role', roleId, turnId, text: '', done: true })
    if (this.cancelledTurns.has(turnId)) return
    const decision = validateDecision(result, previous)
    this.store.saveDecision(turnId, decision)
    if (decision.brief) this.store.saveReactionPreview(roomId, turnId, roleId, decision.brief)
    if (decision.impressions && Object.keys(decision.impressions).length > 0) this.store.applyRoleImpressions(roomId, roleId, decision.impressions)
    this.notifications.notify(roomId)
    } finally {
      if (ownsOperation) this.activeOperations.delete(roomId)
    }
  }

  async consult(roomId: string, draftId: string, playerText: string, context = ''): Promise<void> {
    this.ensureActive()
    if (this.activeOperations.has(roomId)) throw new Error('A Director operation is already active for this room.')
    const ownsOperation = true
    this.activeOperations.add(roomId)
    try {
    this.cancelledRequests.delete(roomId)
    const room = this.notifications.get(roomId)
    if (room.mode !== 'director' || !room.draft || room.draft.id !== draftId) throw new Error('Draft is no longer available.')
    if (room.phase === 'awaiting-approval') this.store.startConsultation(roomId, draftId)
    else if (room.phase !== 'consulting-director') throw new Error(`Room is not available for consultation: ${room.phase}`)
    this.store.addConsultation(roomId, draftId, 'player', playerText)
    this.notifications.notify(roomId)
    if (!this.workers.consult) return
    try {
      const current = this.notifications.get(roomId)
      const answer = await this.workers.consult(current.draft!, this.store.listConsultationsForTurn(roomId, current.draft!.turnId), `${playerText}${context ? `\n\n${context}` : ''}`, { roomId, turnId: current.draft!.turnId })
      if (this.cancelledRequests.has(roomId)) return
      this.store.addConsultation(roomId, draftId, 'director', answer.text, answer.usage)
      this.notifications.notify(roomId)
    } catch (error) {
      if (this.cancelledRequests.has(roomId)) return
      this.store.failRoom(roomId, `Director consultation failed: ${String(error)}`)
      this.notifications.notify(roomId)
    }
    } finally {
      if (ownsOperation) this.activeOperations.delete(roomId)
    }
  }

  finishConsultation(roomId: string): void {
    this.ensureActive()
    this.assertNoActiveOperation(roomId)
    this.store.finishConsultation(roomId)
    this.notifications.notify(roomId)
  }

  async redraft(roomId: string, draftId: string): Promise<void> {
    this.ensureActive()
    if (this.activeOperations.has(roomId)) throw new Error('A Director operation is already active for this room.')
    const ownsOperation = true
    this.activeOperations.add(roomId)
    try {
    const room = this.notifications.get(roomId)
    if (room.mode !== 'director' || !room.draft || room.draft.id !== draftId) throw new Error('Draft is no longer available.')
    if (!['awaiting-approval', 'consulting-director'].includes(room.phase)) throw new Error(`Room is not available for revision: ${room.phase}`)
    this.store.transitionToDrafting(roomId)
    this.notifications.notify(roomId)
    try {
      const latest = this.notifications.get(roomId)
      const currentDraft = latest.draft!
      const sceneContext = { time: currentDraft.sceneUpdates?.time ?? latest.sceneTime, location: currentDraft.sceneUpdates?.location ?? latest.sceneLocation, roomId, turnId: currentDraft.turnId }
      const revised = await this.workers.draft(currentDraft.turnId, latest.playerContribution ?? '', latest.decisions, latest.roles, this.store.listConsultationsForTurn(roomId, currentDraft.turnId), latest.playerCharacter, sceneContext, text => this.notifications.thinking(roomId, { actor: 'director', turnId: currentDraft.turnId, text, done: false }), latest.lore, recentApprovedText(latest.scenes), currentDraft.text)
      this.notifications.thinking(roomId, { actor: 'director', turnId: currentDraft.turnId, text: '', done: true })
      if (this.cancelledTurns.has(currentDraft.turnId)) return
      validateDraft(revised, currentDraft.turnId, latest.roles)
      this.store.saveDraft(roomId, revised)
      this.notifications.notify(roomId)
    } catch (error) {
      this.notifications.thinking(roomId, { actor: 'director', turnId: room.draft.turnId, text: '', done: true })
      if (this.cancelledTurns.has(room.draft.turnId)) return
      this.store.failRoom(roomId, `Director revision failed: ${String(error)}`)
      this.notifications.notify(roomId)
    }
    } finally {
      if (ownsOperation) this.activeOperations.delete(roomId)
    }
  }

  approve(roomId: string, draftId: string, text: string, stateUpdates: Record<string, string>, sceneUpdates?: { time?: string; location?: string }, internal = false): void {
    this.ensureActive()
    if (!internal) this.assertNoActiveOperation(roomId)
    const room = this.notifications.get(roomId)
    if (room.mode !== 'director' || room.phase !== 'awaiting-approval') throw new Error('No draft is awaiting approval.')
    this.store.publish(roomId, draftId, text, stateUpdates, sceneUpdates)
    this.core?.emitDomainEvent(domainEvent('draft.approved', { roomId, draftId, text }))
    this.core?.emitDomainEvent(domainEvent('scene.published', { roomId, text }))
    this.notifications.notify(roomId)
  }

  private assertNoActiveOperation(roomId: string): void {
    if (this.activeOperations.has(roomId)) throw new Error('A Director operation is already active for this room.')
  }

  cancel(roomId: string): void {
    if (this.disposed) return
    const pendingWorkflowRequests = this.core?.getView().workflows
      .filter(workflow => String(workflow.locals.roomId ?? '') === roomId)
      .flatMap(workflow => workflow.pendingModelRequestIds)
    const requestIds = [...new Set([
      ...[...this.coreRequestContexts].filter(([, context]) => context.roomId === roomId).map(([requestId]) => requestId),
      ...(pendingWorkflowRequests ?? []),
    ])]
    for (const requestId of requestIds) this.coreRequestContexts.delete(requestId)
    const room = this.notifications.get(roomId)
    const cancellablePhase = ['collecting-decisions', 'drafting', 'consulting-director', 'role-speaking', 'world-change-approval'].includes(room.phase)
    if (!cancellablePhase) return
    this.cancelledRequests.add(roomId)
    if (this.workers.supportsRequestCancellation) {
      for (const requestId of requestIds) void Promise.resolve(this.workers.cancel?.(requestId)).catch(() => undefined)
    } else if (this.workers.cancel) {
      // 旧 Worker 只有全量取消能力；Core 生产路径明确标记 supportsRequestCancellation，绝不走这里。
      void Promise.resolve(this.workers.cancel()).catch(() => undefined)
    }
    const turnId = this.turnIds.get(roomId) ?? room.draft?.turnId ?? this.store.getLatestTurnId(roomId)
    if (turnId) this.cancelledTurns.add(turnId)
    this.store.cancelTurn(roomId)
    this.notifications.notify(roomId)
  }
}

function validateDecision(result: Decision, expected: Decision): Decision {
  if (result.roleId !== expected.roleId) throw new Error(`Worker returned decision for unexpected role: ${result.roleId}`)
  if (result.participation !== expected.participation) throw new Error(`Worker returned unexpected participation for ${expected.roleId}`)
  if (!['completed', 'abstained', 'unavailable'].includes(result.status)) throw new Error(`Worker returned invalid status for ${expected.roleId}`)
  return result
}

function validateDraft(draft: Draft, turnId: string, roles: Array<{ id: string }>): void {
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
