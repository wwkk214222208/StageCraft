import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setPromptStorage, getPromptPresetState, updatePromptPreset, applyPromptPreset, loadGameplayScenario, userEditableScopes, type PromptPreset } from '../src/prompts.ts'
import { createAndroidPromptStorage } from '../src/portable/android-prompt-storage.ts'
import { BUNDLED_GAMEPLAY } from '../src/portable/bundled-gameplay.ts'

test('bundled gameplay covers all scopes with desktop-identical markers', () => {
  assert.equal(Object.keys(BUNDLED_GAMEPLAY).length, 8)
  assert.equal(BUNDLED_GAMEPLAY['director.draft']?.userEditable, true)
  assert.equal(BUNDLED_GAMEPLAY['director.role-decision']?.userEditable, true)
  assert.equal(BUNDLED_GAMEPLAY['chat.role-speech']?.userEditable, true)
  assert.equal(BUNDLED_GAMEPLAY['chat.world-director']?.userEditable, true)
  assert.equal(BUNDLED_GAMEPLAY['director.consult']?.userEditable, undefined)
  assert.equal(BUNDLED_GAMEPLAY['director.memory-digest']?.userEditable, undefined)
  assert.equal(BUNDLED_GAMEPLAY['chat.role-selection']?.userEditable, undefined)
  assert.equal(BUNDLED_GAMEPLAY['prompt-preset.transform']?.userEditable, undefined)
  assert.equal(BUNDLED_GAMEPLAY['chat.role-selection']?.forceThinkingOff, true)
})

test('android prompt storage drives the same runtime behavior over SQLite presets', () => {
  const records = new Map<string, PromptPreset>()
  const activeByScope: Record<string, string> = {}
  const operations = {
    invokeSync<T = unknown>(operation: string, input: Record<string, unknown> = {}): T {
      if (operation === 'preset.list') return { presets: [...records.values()], activeByScope } as T
      if (operation === 'preset.save') { const preset = input.preset as PromptPreset; records.set(String(preset?.id), preset); return { ok: true } as T }
      if (operation === 'preset.active-scope.set') { Object.assign(activeByScope, (input.activeByScope ?? {}) as Record<string, string>); return { ok: true } as T }
      throw new Error(`unexpected native operation: ${operation}`)
    },
  }
  setPromptStorage(createAndroidPromptStorage(operations))
  try {
    // 与桌面相同：仅 userEditable 标记的 4 个创作场景可编辑
    const editable = userEditableScopes().sort()
    assert.deepEqual(editable, ['chat.role-speech', 'chat.world-director', 'director.draft', 'director.role-decision'].sort())
    assert.equal(loadGameplayScenario('chat.role-selection').forceThinkingOff, true)
    // 内部 scope 透传，不进预设管线
    assert.deepEqual(applyPromptPreset('SYS', 'USR', 'director.consult').messages.map(message => message.content), ['SYS', 'USR'])
    // 预设写入/读回走 SQLite 原生桥；enabled 预设会同步 activeByScope（与桌面运行时一致），随后可读回
    updatePromptPreset({ id: 'a', name: 'A', enabled: true, modes: ['director'], nodes: [{ id: 'u', name: 'u', type: 'user', content: 'X', enabled: true, editable: true }], regexRules: [] })
    const state = getPromptPresetState()
    assert.ok(state.presets.some(preset => preset.id === 'a'))
    assert.equal(state.activeByScope['director.draft'], 'a')
    assert.equal(records.has('a'), true)
  } finally {
    setPromptStorage(undefined)
  }
})