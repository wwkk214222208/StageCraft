import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyPromptPreset, listIdeologyFiles, loadIdeology, loadPrompts, renderPrompt, removeIdeologyFile, renameIdeologyFile, saveIdeologyFile, savePromptPresets, setActiveIdeologyFile } from '../src/prompts.ts'

test('loadPrompts reads the default prompts file', () => {
  const prompts = loadPrompts()
  assert.ok(prompts.role.system.includes('{prefix}'), 'role.system 应有 {prefix} 占位符')
  assert.ok(prompts.role.prefix.includes('{roleName}'), 'role.prefix 应有 {roleName} 占位符')
  assert.ok(prompts.director.request.includes('{focalRoles}'), 'director.request 应有 {focalRoles} 占位符')
  assert.ok(prompts.skills.director.includes('RP Director'))
  assert.ok(prompts.skills.consultation.includes('咨询助手'))
})

test('renderPrompt substitutes placeholders and keeps unknown ones', () => {
  const out = renderPrompt('你好 {name}，现在是 {time}。', { name: '世界' })
  assert.equal(out, '你好 世界，现在是 {time}。')
})

test('loadPrompts supports a custom file via PROMPTS_FILE', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-prompts-'))
  const custom = join(root, 'custom.json')
  writeFileSync(custom, JSON.stringify({ role: { prefix: '自定义前缀 {roleName}', system: '{prefix}\n记忆：{memoryTimeline}\n{roleIdeals}', user: 'u', retrySystem: 'rs', retryUser: 'ru' }, director: { request: '{directorIdeals}\n草稿', retrySystem: 'rs', retryUser: 'ru' }, consult: { user: 'cu' }, skills: { director: '{directorIdeals}\n思维链六步', consultation: 'sc' } }))
  const prompts = loadPrompts(custom)
  assert.equal(prompts.role.prefix, '自定义前缀 {roleName}')
  assert.equal(renderPrompt(prompts.role.system, { prefix: 'P', memoryTimeline: 'M' }), 'P\n记忆：M\n{roleIdeals}')
})

test('private ideology files remain manageable but are no longer injected', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-ideology-'))
  const custom = join(root, 'prompts.json')
  writeFileSync(custom, JSON.stringify({ role: { prefix: 'p', system: 'base\n{roleIdeals}', user: 'u', retrySystem: 'rs', retryUser: 'ru' }, director: { request: 'r', retrySystem: 'rs', retryUser: 'ru' }, consult: { user: 'cu' }, skills: { director: 'base\n{directorIdeals}', consultation: 'sc' } }))
  // 私有理念文件仍可独立保存和管理，但不再由 loadPrompts 自动注入。
  assert.equal(loadPrompts(custom).role.system, 'base\n{roleIdeals}')
  assert.equal(loadPrompts(custom).skills.director, 'base\n{directorIdeals}')
  saveIdeologyFile('ideology', { roleIdeals: '世界A', directorIdeals: '宪法A' }, custom)
  setActiveIdeologyFile('ideology', custom)
  assert.equal(loadPrompts(custom).role.system, 'base\n{roleIdeals}')
  assert.equal(loadPrompts(custom).skills.director, 'base\n{directorIdeals}')
  assert.deepEqual(listIdeologyFiles(custom).map(item => item.name), ['ideology.json'])
  saveIdeologyFile('预设B', { roleIdeals: '世界B', directorIdeals: '宪法B' }, custom)
  setActiveIdeologyFile('预设B', custom)
  assert.equal(loadPrompts(custom).role.system, 'base\n{roleIdeals}')
  assert.equal(loadIdeology(custom).roleIdeals, '世界B')
  assert.deepEqual(listIdeologyFiles(custom).map(item => item.name), ['预设B.json', 'ideology.json'])
})

test('active prompt preset preserves fixed runtime text and custom user nodes', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-preset-'))
  const custom = join(root, 'prompts.json')
  writeFileSync(custom, JSON.stringify({ role: { prefix: 'p', system: 'base', user: 'u', retrySystem: 'rs', retryUser: 'ru' }, director: { request: 'r', retrySystem: 'rs', retryUser: 'ru' }, consult: { user: 'cu' }, skills: { director: 'd', consultation: 'c' } }))
  savePromptPresets([{ id: 'p1', name: '测试', enabled: true, nodes: [
    { id: 's', name: '系统', type: 'system', content: 'S1', enabled: true, editable: false },
    { id: 'off', name: '关闭', type: 'user', content: 'NO', enabled: false, editable: true },
    { id: 'u', name: '用户', type: 'user', content: 'U1', enabled: true, editable: true },
  ], regexRules: [{ id: 'r', name: '替换', pattern: 'U1', replacement: 'U2', enabled: true }] }], custom)
  assert.deepEqual(applyPromptPreset('SYS', 'USR', custom), { system: 'SYS', user: 'USR\n\nU1', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USR' }, { role: 'user', content: 'U1' }] })
})

test('prompts file rename/delete with active sync and protection', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-ideology-crud-'))
  const custom = join(root, 'prompts.json')
  writeFileSync(custom, JSON.stringify({ role: { prefix: 'p', system: 'base\n{roleIdeals}', user: 'u', retrySystem: 'rs', retryUser: 'ru' }, director: { request: 'r', retrySystem: 'rs', retryUser: 'ru' }, consult: { user: 'cu' }, skills: { director: 'base\n{directorIdeals}', consultation: 'sc' } }))
  saveIdeologyFile('世界观A', { roleIdeals: 'A', directorIdeals: 'DA' }, custom)
  setActiveIdeologyFile('世界观A', custom)
  // 重命名激活文件：active.json 同步，但废弃自动注入
  assert.ok(renameIdeologyFile('世界观A', '世界观B', custom))
  assert.equal(loadIdeology(custom).roleIdeals, 'A')
  assert.equal(loadPrompts(custom).skills.director, 'base\n{directorIdeals}')
  assert.deepEqual(listIdeologyFiles(custom).map(item => item.name), ['世界观B.json'])
  // 删除普通文件
  saveIdeologyFile('临时C', { roleIdeals: 'C' }, custom)
  assert.ok(removeIdeologyFile('临时C', custom))
  assert.deepEqual(listIdeologyFiles(custom).map(item => item.name), ['世界观B.json'])
  // 受保护文件不可删 / 不可改名
  assert.ok(!removeIdeologyFile('ideology', custom))
  assert.ok(!removeIdeologyFile('active', custom))
  assert.ok(!renameIdeologyFile('ideology', '别的', custom))
  assert.ok(!renameIdeologyFile('active', '别的', custom))
})
