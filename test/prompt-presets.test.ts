import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { applyPromptPreset, getPromptPresetState, loadGameplayScenario, setPromptPresetForScope, updatePromptPreset } from '../src/prompts.ts'

function fixture() { return join(mkdtempSync(join(tmpdir(), 'stagecraft-preset-')), 'prompts.json') }

test('gameplay scenarios expose thinking override metadata', () => {
  const scenario = loadGameplayScenario('director.draft')
  assert.equal(scenario.forceThinkingOff, undefined)
  const file = fixture()
  updatePromptPreset({ id: 'fast', name: 'Fast', modes: ['director'], scenarios: { 'director.draft': { forceThinkingOff: true, nodes: [], regexRules: [] } }, nodes: [], regexRules: [] }, file)
  assert.equal(getPromptPresetState(file).presets.find(item => item.id === 'fast')?.scenarios?.['director.draft']?.forceThinkingOff, true)
})

test('gameplay scenarios define structured fixed prompt sources', () => {
  const scenario = loadGameplayScenario('director.draft')
  assert.equal(scenario.components.length, 14)
  assert.equal(scenario.components[0].name, '导演身份、创作职责、执行约束与工具输出')
})

test('scope selection and ordered messages are independent', () => {
  const file = fixture()
  updatePromptPreset({ id: 'a', name: 'A', nodes: [
    { id: 'private-before', name: 'before', type: 'user', content: 'BEFORE', enabled: true, editable: true },
    { id: 'director.draft.identity', name: 'core system', type: 'system', content: '', enabled: false, editable: false, runtimeBinding: 'director.draft.identity' },
    { id: 'private-middle', name: 'middle', type: 'user', content: 'MIDDLE', enabled: true, editable: true },
    { id: 'director.draft.output', name: 'core request', type: 'user', content: '', enabled: false, editable: false, runtimeBinding: 'director.draft.output' },
  ], regexRules: [] }, file)
  updatePromptPreset({ id: 'b', name: 'B', modes: ['chat'], scenarios: { 'chat.role-speech': { nodes: [{ id: 'chat.role.persona', name: 'persona', type: 'system', content: '', enabled: true, editable: false, runtimeBinding: 'chat.role.persona' }, { id: 'chat.role.player-action', name: 'action', type: 'system', content: '', enabled: true, editable: false, runtimeBinding: 'chat.role.player-action' }, { id: 'tail', name: 'tail', type: 'user', content: 'TAIL', enabled: true, editable: true }], regexRules: [] } }, nodes: [], regexRules: [] }, file)
  setPromptPresetForScope('director.draft', 'a', file)
  setPromptPresetForScope('chat.role-speech', 'b', file)
  assert.deepEqual(applyPromptPreset('SYS', 'USR', 'director.draft', file).messages.map(item => `${item.role}:${item.content}`), ['user:BEFORE', 'system:SYS', 'user:MIDDLE', 'user:USR'])
  assert.deepEqual(applyPromptPreset('SYS', 'USR', 'chat.role-speech', file).messages.map(item => item.content), ['SYS', 'USR', 'TAIL'])
  const stored = JSON.parse(readFileSync(join(file.slice(0, file.lastIndexOf('\\')), 'custom', 'presets.json'), 'utf8'))
  assert.equal(stored.presets.find((item: any) => item.id === 'a').scenarios['director.draft'].order.includes('director.draft.identity'), true)
  assert.equal(getPromptPresetState(file).activeByScope['director.draft'], 'a')
})

test('legacy system placeholder migrates to visible runtime components', () => {
  const file = fixture()
  updatePromptPreset({ id: 'legacy', name: 'Legacy', modes: ['director'], nodes: [
    { id: 'private-before', name: 'before', type: 'user', content: 'BEFORE', enabled: true, editable: true },
    { id: 'stagecraft-system', name: '旧系统提示词', type: 'system', content: '', enabled: true, editable: false },
    { id: 'private-after', name: 'after', type: 'user', content: 'AFTER', enabled: true, editable: true },
  ], regexRules: [] }, file)
  const scenario = getPromptPresetState(file).presets.find(item => item.id === 'legacy')?.scenarios?.['director.draft']
  assert.deepEqual(scenario?.nodes.filter(node => node.runtimeBinding).map(node => node.id), ['director.draft.identity', 'director.draft.always-lore', 'director.draft.role-personas', 'director.draft.player-persona', 'director.draft.player-state', 'director.draft.scene', 'director.draft.recent-scene', 'director.draft.role-states', 'director.draft.player-action', 'director.draft.focus-roles', 'director.draft.role-briefs', 'director.draft.consultations', 'director.draft.previous-draft', 'director.draft.output'])
  assert.equal(scenario?.nodes.find(node => node.id === 'director.draft.identity')?.name, '导演身份、创作职责、执行约束与工具输出')
  assert.deepEqual(scenario?.nodes.filter(node => node.type === 'user' && node.removable !== false).map(node => node.content), ['BEFORE', 'AFTER'])
})

test('player presets persist system ids but not gameplay names or content', () => {
  const file = fixture()
  updatePromptPreset({ id: 'named', name: 'Named', modes: ['chat'], scenarios: { 'chat.role-speech': { nodes: [
    { id: 'chat.role.player-action', name: '玩家不能覆盖此名称', content: '不能保存', type: 'system', enabled: true, editable: false, runtimeBinding: 'chat.role.player-action' },
    { id: 'private-one', name: '私有要求', content: '保留我', type: 'user', enabled: true, editable: true },
    { id: 'chat.role.persona', name: '也不能覆盖', content: '不能保存', type: 'system', enabled: true, editable: false, runtimeBinding: 'chat.role.persona' },
  ], regexRules: [] } }, nodes: [], regexRules: [] }, file)
  const stored = JSON.parse(readFileSync(join(file.slice(0, file.lastIndexOf('\\')), 'custom', 'presets.json'), 'utf8'))
  const scenario = stored.presets.find((item: any) => item.id === 'named').scenarios['chat.role-speech']
  assert.deepEqual(scenario.order, ['chat.role.player-action', 'private-one', 'chat.role.persona'])
  assert.equal(scenario.privateNodes[0].content, '保留我')
  assert.equal(JSON.stringify(scenario).includes('玩家不能覆盖此名称'), false)
  const loaded = getPromptPresetState(file).presets.find(item => item.id === 'named')?.scenarios?.['chat.role-speech']
  assert.deepEqual(loaded?.nodes.map(node => node.id).slice(0, 3), ['chat.role.player-action', 'private-one', 'chat.role.persona'])
  assert.deepEqual(loaded?.nodes.map(node => node.id).slice(3), ['chat.role.always-lore', 'chat.role.private-lore', 'chat.role.goals', 'chat.role.execution', 'chat.role.scene', 'chat.role.memory', 'chat.role.public-state'])
  assert.equal(loaded?.nodes[0].name, '玩家行动')
})

test('runtime system prompt is split into immutable ordered components', () => {
  const file = fixture()
  updatePromptPreset({ id: 'split', name: 'Split', modes: ['director'], scenarios: { 'director.draft': { nodes: [
    { id: 'director.draft.identity', name: '职责', type: 'system', content: '', enabled: false, editable: false, runtimeBinding: 'director.draft.identity' },
    { id: 'private', name: '私有要求', type: 'user', content: 'PRIVATE', enabled: true, editable: true },
    { id: 'director.draft.output', name: '上下文', type: 'user', content: '', enabled: false, editable: false, runtimeBinding: 'director.draft.output' },
  ], regexRules: [] } }, nodes: [], regexRules: [] }, file)
  setPromptPresetForScope('director.draft', 'split', file)
  const result = applyPromptPreset('A', 'USER', 'director.draft', file)
  assert.deepEqual(result.messages.map(item => `${item.role}:${item.content}`), ['system:A', 'user:PRIVATE', 'user:USER'])
})

test('regex compatibility is disabled by default', () => {
  const file = fixture()
  updatePromptPreset({ id: 'plain', name: 'Plain', nodes: [{ id: 'director.draft.system', name: 'system', type: 'system', content: '', enabled: true, editable: false, runtimeBinding: 'director.draft.system' }, { id: 'director.draft.request', name: 'request', type: 'system', content: '', enabled: true, editable: false, runtimeBinding: 'director.draft.request' }], regexRules: [{ id: 'r1', name: 'replace', pattern: '/foo/g', replacement: 'bar', enabled: true }] }, file)
  setPromptPresetForScope('director.draft', 'plain', file)
  assert.deepEqual(applyPromptPreset('foo', 'foo', 'director.draft', file).messages.map(item => item.content), ['foo', 'foo'])
})

test('ST regex literal syntax is applied when compatibility is enabled', () => {
  const file = fixture()
  updatePromptPreset({ id: 'regex', name: 'Regex', nodes: [{ id: 'director.draft.system', name: 'system', type: 'system', content: '', enabled: true, editable: false, runtimeBinding: 'director.draft.system' }, { id: 'director.draft.request', name: 'request', type: 'system', content: '', enabled: true, editable: false, runtimeBinding: 'director.draft.request' }], regexRules: [{ id: 'r1', name: 'replace', pattern: '/foo/gi', replacement: 'bar', enabled: true }], compatibility: { source: 'sillytavern', regexEnabled: true } }, file)
  setPromptPresetForScope('director.draft', 'regex', file)
  assert.deepEqual(applyPromptPreset('FOO', 'foo', 'director.draft', file).messages.map(item => item.content), ['bar', 'bar'])
})
