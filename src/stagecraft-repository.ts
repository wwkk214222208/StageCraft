import type { Store } from './store.ts'

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
