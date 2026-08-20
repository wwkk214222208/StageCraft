import type { Store } from './store.ts'

/** Runtime method names shared by every StageCraft repository adapter. */
export const STAGECRAFT_REPOSITORY_METHODS = [
  'addConsultation', 'addNarrationScene', 'addPlayerScene', 'applyRoleImpressions',
  'approveSpeech', 'approveWorldChange', 'cancelTurn', 'createRole', 'createTurn',
  'deleteRole', 'failRoom', 'finishConsultation', 'getLatestTurnId', 'importRoom',
  'insertNpcMemories', 'listConsultationsForTurn', 'publish', 'rejectDraft',
  'rejectSpeech', 'rejectWorldChange', 'reorderNpcMemories', 'reorderRoles',
  'restartRoom', 'retractNpcMemory', 'saveDecision', 'saveDraft', 'saveLore',
  'saveReactionPreview', 'saveSpeech', 'saveWorldChange', 'setContribution',
  'setPlayerAvatar', 'setRoleAvatar', 'setRoleCurrentState', 'setRolePresence',
  'setRoleThinking', 'setRoomConfig', 'startConsultation', 'supersedeNpcMemory',
  'transitionToDrafting', 'updateNpcMemory', 'updatePlayerCharacter',
  'updateRolePrivateState', 'updateScene',
] as const

export type StageCraftRepositoryMethod = typeof STAGECRAFT_REPOSITORY_METHODS[number]

/** Domain repository used by StageCraft services; Node SQLite is one adapter. */
export type StageCraftRepository = Pick<Store,
  | 'addConsultation' | 'addNarrationScene' | 'addPlayerScene' | 'applyRoleImpressions'
  | 'approveSpeech' | 'approveWorldChange' | 'cancelTurn' | 'createRole' | 'createTurn'
  | 'deleteRole' | 'failRoom' | 'finishConsultation' | 'getLatestTurnId' | 'importRoom'
  | 'insertNpcMemories' | 'listConsultationsForTurn' | 'publish' | 'rejectDraft'
  | 'rejectSpeech' | 'rejectWorldChange' | 'reorderNpcMemories' | 'reorderRoles'
  | 'restartRoom' | 'retractNpcMemory' | 'saveDecision' | 'saveDraft' | 'saveLore'
  | 'saveReactionPreview' | 'saveSpeech' | 'saveWorldChange' | 'setContribution'
  | 'setPlayerAvatar' | 'setRoleAvatar' | 'setRoleCurrentState' | 'setRolePresence'
  | 'setRoleThinking' | 'setRoomConfig' | 'startConsultation' | 'supersedeNpcMemory'
  | 'transitionToDrafting' | 'updateNpcMemory' | 'updatePlayerCharacter'
  | 'updateRolePrivateState' | 'updateScene'
>
