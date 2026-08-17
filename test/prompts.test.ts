import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadPrompts, renderPrompt } from '../src/prompts.ts'

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
  const root = mkdtempSync(join(tmpdir(), 'character-tavern-prompts-'))
  const custom = join(root, 'custom.json')
  writeFileSync(custom, JSON.stringify({ role: { prefix: '自定义前缀 {roleName}', system: '{prefix}\n记忆：{memoryTimeline}', user: 'u', retrySystem: 'rs', retryUser: 'ru' }, director: { request: 'r', retrySystem: 'rs', retryUser: 'ru' }, consult: { user: 'cu' }, skills: { director: 'sd', consultation: 'sc' } }))
  const prompts = loadPrompts(custom)
  assert.equal(prompts.role.prefix, '自定义前缀 {roleName}')
  assert.equal(renderPrompt(prompts.role.system, { prefix: 'P', memoryTimeline: 'M' }), 'P\n记忆：M')
})
