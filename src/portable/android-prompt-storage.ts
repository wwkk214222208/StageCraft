import { gameplayDefaults, type GameplayScenario, type PromptPreset, type PromptPresetScope, type PromptPresetState, type PromptStorage, type PromptToggleState } from '../prompts.ts'
import { BUNDLED_GAMEPLAY } from './bundled-gameplay.ts'

/** Android 本地提示词 IO 所需的原生同步操作。 */
export interface AndroidPromptOperations {
  invokeSync<T = unknown>(operation: string, input?: Record<string, unknown>): T
}

/**
 * Android 本地提示词 IO 实现（PromptStorage 端口）：
 * - 玩法场景：构建期内联的 gameplay JSON（与桌面同一份文件，userEditable 标记一致）；
 * - 预设状态：SQLite（preset.list / preset.save / preset.active-scope.set 原生桥）；
 * - 私设开关：桌面专属且依赖文件系统，本地运行时暂为空态。
 * 归一化/渲染等运行时行为由 prompts.ts 共享逻辑承担，这里只负责原始读写。
 */
export function createAndroidPromptStorage(operations: AndroidPromptOperations): PromptStorage {
  const loadGameplayScenario = (scope: PromptPresetScope): GameplayScenario => {
    const fallback = gameplayDefaults[scope]
    const data = BUNDLED_GAMEPLAY[scope]
    if (!data) return { mode: fallback.mode, scope, name: fallback.name, components: [] }
    return {
      mode: data.mode ?? fallback.mode,
      scope,
      name: data.name ?? fallback.name,
      components: Array.isArray(data.components) ? data.components.map(component => ({ ...component, template: typeof component.template === 'string' ? component.template : undefined })) : fallback.components,
      ...(data.forceThinkingOff === true ? { forceThinkingOff: true } : {}),
      ...(data.userEditable === true ? { userEditable: true } : {}),
    }
  }
  const loadPresetState = (): PromptPresetState => {
    const raw = operations.invokeSync<{ presets?: PromptPreset[]; activeByScope?: Partial<Record<PromptPresetScope, string>> }>('preset.list', {})
    return { presets: Array.isArray(raw?.presets) ? raw.presets : [], activeByScope: raw?.activeByScope ?? {} }
  }
  const savePresetState = (state: PromptPresetState): void => {
    if (!state || typeof state !== 'object') return
    for (const preset of Array.isArray(state.presets) ? state.presets : []) {
      if (preset && typeof preset === 'object' && String((preset as { id?: unknown }).id ?? '').trim()) operations.invokeSync('preset.save', { preset })
    }
    operations.invokeSync('preset.active-scope.set', { activeByScope: state.activeByScope ?? {} })
  }
  const loadPrivateToggles = (): PromptToggleState => ({})
  const savePrivateToggle = (): PromptToggleState => ({})
  return { loadGameplayScenario, loadPresetState, savePresetState, loadPrivateToggles, savePrivateToggle }
}