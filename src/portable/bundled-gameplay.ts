import type { GameplayScenario, PromptPresetScope } from '../prompts.ts'
import directorRoleDecision from '../../prompts/gameplay/director.role-decision.json' with { type: 'json' }
import directorDraft from '../../prompts/gameplay/director.draft.json' with { type: 'json' }
import directorConsult from '../../prompts/gameplay/director.consult.json' with { type: 'json' }
import directorMemoryDigest from '../../prompts/gameplay/director.memory-digest.json' with { type: 'json' }
import chatRoleSpeech from '../../prompts/gameplay/chat.role-speech.json' with { type: 'json' }
import chatWorldDirector from '../../prompts/gameplay/chat.world-director.json' with { type: 'json' }
import chatRoleSelection from '../../prompts/gameplay/chat.role-selection.json' with { type: 'json' }
import promptPresetTransform from '../../prompts/gameplay/prompt-preset.transform.json' with { type: 'json' }

/**
 * Android 本地运行时的玩法场景数据源：构建期由 esbuild 把 prompts/gameplay/*.json
 * 内联进 embedded-core bundle（与桌面同一份文件）。桌面不引用此模块。
 */
export const BUNDLED_GAMEPLAY: Partial<Record<PromptPresetScope, GameplayScenario>> = {
  'director.role-decision': directorRoleDecision as GameplayScenario,
  'director.draft': directorDraft as GameplayScenario,
  'director.consult': directorConsult as GameplayScenario,
  'director.memory-digest': directorMemoryDigest as GameplayScenario,
  'chat.role-speech': chatRoleSpeech as GameplayScenario,
  'chat.world-director': chatWorldDirector as GameplayScenario,
  'chat.role-selection': chatRoleSelection as GameplayScenario,
  'prompt-preset.transform': promptPresetTransform as GameplayScenario,
}