import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Store } from '../src/store.ts'
import { createAndroidRepository } from '../src/portable/android-composition.ts'
import { STAGECRAFT_REPOSITORY_METHODS } from '../src/stagecraft-repository.ts'
import type { StoryPackage } from '../src/story-packages.ts'

const story: StoryPackage = {
  id: 'contract-story', title: 'Contract story', opening: 'The opening.', sceneTime: 'Dawn', sceneLocation: 'Hall',
  playerCharacter: { name: 'Player', persona: 'Observer', currentState: 'Ready' },
  roles: [
    { id: 'aria', name: 'Aria', portraitRef: '/aria.svg', currentState: 'Watching.', presence: 'present', memoryTimeline: { Past: ['The festival began.'] }, selfModel: 'Careful.', impressions: {}, goals: ['Find the truth.'] },
    { id: 'mira', name: 'Mira', portraitRef: '/mira.svg', currentState: 'Waiting.', presence: 'absent', memoryTimeline: { Past: ['She is waiting.'] }, selfModel: 'Curious.' },
  ],
  lore: [{ name: 'Rule', content: 'Be honest.' }],
}

function fresh() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'stagecraft-contract-')), 'room.sqlite'))
  const roomId = store.createRoomFromPackage(story, 'contract-room')
  return { store, roomId }
}

function room(store: Store, id = 'contract-room') { return store.getRoom(id)! }

// This is intentionally a public list: adding a Store method to the port requires adding it here.
test('StageCraftRepository enumerates every public method and rejects unknown methods', () => {
  assert.equal(new Set(STAGECRAFT_REPOSITORY_METHODS).size, STAGECRAFT_REPOSITORY_METHODS.length)
  const store = fresh().store
  for (const method of STAGECRAFT_REPOSITORY_METHODS) assert.equal(typeof (store as any)[method], 'function', method)
  const calls: Array<{ method: string; args: unknown[] }> = []
  const repository = createAndroidRepository({ invokeSync(operation, input) {
    assert.equal(operation, 'stagecraft.repository')
    calls.push({ method: String((input as any).method), args: (input as any).args })
    if ((input as any).method === 'unknownMethod') throw new Error('Unsupported Android repository operation: unknownMethod')
    return null
  } })
  assert.throws(() => (repository as any).unknownMethod('contract-room'), /Unsupported Android repository operation/)
  repository.setContribution('contract-room', 'hello')
  assert.deepEqual(calls.at(-1), { method: 'setContribution', args: ['contract-room', 'hello'] })
})

test('first run creates a complete full room snapshot', () => {
  const { store, roomId } = fresh()
  const snapshot = room(store, roomId)
  assert.deepEqual(Object.keys(snapshot).sort(), ['autoPublish', 'consultations', 'decisions', 'id', 'lore', 'mode', 'phase', 'playerCharacter', 'reactions', 'revision', 'roles', 'sceneLocation', 'sceneTime', 'scenes', 'storyId', 'title'].sort())
  assert.equal(snapshot.phase, 'awaiting-player-input')
  assert.equal(snapshot.mode, 'director')
  assert.equal(snapshot.autoPublish, false)
  assert.equal(snapshot.roles.length, 2)
  assert.equal(snapshot.scenes[0].text, story.opening)
  assert.deepEqual(snapshot.lore, story.lore)
})

test('role, config, scene, memory, turn, draft, speech, world-change, and consultation mutations are public and durable', () => {
  const { store, roomId } = fresh()
  const role = room(store).roles[0]
  store.setRoomConfig(roomId, { mode: 'chat', autoPublish: true })
  store.updatePlayerCharacter(roomId, { name: 'New Player', persona: 'Bold', currentState: 'Seated' })
  store.setPlayerAvatar(roomId, '/player.png')
  store.updateScene(roomId, { time: 'Noon', location: 'Garden' })
  store.setContribution(roomId, 'I enter.')
  store.setRolePresence(roomId, role.id, 'present')
  store.setRoleAvatar(roomId, role.id, '/new.png')
  store.setRoleCurrentState(roomId, role.id, 'Speaking.')
  store.setRoleThinking(roomId, role.id, 'deep')
  store.updateRolePrivateState(roomId, role.id, 'Updated self.', { Past: ['Updated memory.'] }, { impressions: { Mira: 'Trusted' }, goals: ['Escape'], thinkingStrength: 'brief' })
  store.applyRoleImpressions(roomId, role.id, { Mira: 'Ally' })
  store.insertNpcMemories(roomId, role.id, [{ id: 'memory-new', occurredAt: 'Noon', source: 'manual', text: 'A new fact.' }])
  store.updateNpcMemory(roomId, 'memory-new', { text: 'An edited fact.' })
  store.reorderNpcMemories(roomId, role.id, store.listNpcMemories(roomId, role.id).map(item => item.id).reverse())
  store.supersedeNpcMemory(roomId, 'memory-new', { id: 'memory-replacement', text: 'Replacement.', occurredAt: 'Later' })
  store.retractNpcMemory(roomId, 'memory-replacement')
  store.createRole(roomId, { id: 'noel', name: 'Noel', portraitRef: '/noel.svg', currentState: 'Arriving.', presence: 'present', selfModel: 'Quiet.' })
  store.reorderRoles(roomId, ['noel', 'mira', 'aria'])
  store.deleteRole(roomId, 'noel')
  store.createTurn(roomId, 'turn-1', 'I enter.', [{ roleId: 'aria', participation: 'required', status: 'pending' }])
  store.saveDecision('turn-1', { roleId: 'aria', participation: 'required', status: 'completed', brief: 'I respond.', privateReaction: 'Concerned.' })
  store.saveReactionPreview(roomId, 'turn-1', 'aria', 'Preview')
  store.transitionToDrafting(roomId)
  store.saveDraft(roomId, { id: 'draft-1', turnId: 'turn-1', text: 'Draft.', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], createdAt: new Date().toISOString() })
  store.startConsultation(roomId, 'draft-1')
  store.addConsultation(roomId, 'draft-1', 'player', 'Please clarify.')
  store.addConsultation(roomId, 'draft-1', 'director', 'Certainly.', { promptTokens: 1, completionTokens: 2 }, 'thinking')
  assert.equal(store.listConsultationsForTurn(roomId, 'turn-1').length, 2)
  store.finishConsultation(roomId)
  store.rejectDraft(roomId)
  store.saveSpeech(roomId, { roleId: 'aria', turnId: 'turn-2', text: 'Hello.' })
  store.approveSpeech(roomId, 'Hello approved.')
  const changeId = store.saveWorldChange(roomId, { sceneTime: 'Evening', sceneLocation: 'Tower', reason: 'The scene moves.' }, 'The tower rises.')
  assert.equal(store.listWorldChanges(roomId).find(change => change.id === changeId)?.status, 'proposed')
  store.approveWorldChange(roomId)
  assert.equal(room(store).sceneLocation, 'Tower')
  store.addNarrationScene(roomId, 'The tower appears.')
  store.saveLore(roomId, [{ name: 'New rule', content: 'Listen.' }])
  store.failRoom(roomId, 'recoverable')
  assert.equal(room(store).lastError, 'recoverable')
})

test('failed atomic mutations leave the prior snapshot unchanged and survive reconstruction', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'stagecraft-atomic-')), 'room.sqlite')
  const first = new Store(path); first.createRoomFromPackage(story, 'atomic-room')
  const before = first.getRoom('atomic-room')!
  assert.throws(() => first.importRoom('atomic-room', { room: { ...before, roles: [before.roles[0], before.roles[0]] } as any }))
  assert.deepEqual(first.getRoom('atomic-room'), before)
  first.close()
  const second = new Store(path)
  assert.deepEqual(second.getRoom('atomic-room'), before)
})
