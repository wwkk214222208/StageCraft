import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseWorldBookTxt, loadStoryPackageWithTxt, saveStoryPackage } from '../src/story-packages.ts'

test('parseWorldBookTxt handles entries, role tags, and blank lines', () => {
  const entries = parseWorldBookTxt(`=== 创世神话 ===
世界正式名为赫普塔隆。

> 角色: aria, 芙萝拉
正文第二段。

=== 神凡限制 ===
七女神与凡间的纽带系于信仰场。
`)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], { name: '创世神话', roles: ['aria', '芙萝拉'], content: '世界正式名为赫普塔隆。\n\n正文第二段。' })
  assert.deepEqual(entries[1], { name: '神凡限制', content: '七女神与凡间的纽带系于信仰场。' })
})

test('role tag line with 中文冒号 also parses; missing role means always-on', () => {
  const entries = parseWorldBookTxt('=== 条目 ===\n> 角色：aria\n内容。\n')
  assert.deepEqual(entries, [{ name: '条目', roles: ['aria'], content: '内容。' }])
})

test('loadStoryPackageWithTxt merges txt world book, JSON lore wins on name conflict', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-wbtxt-'))
  writeFileSync(join(root, 'demo.json'), JSON.stringify({
    id: 'demo', title: 'Demo', opening: '开场。', playerCharacter: { name: '玩家', persona: '人设。', currentState: '状态。' },
    roles: [{ id: 'aria', name: 'Aria', portraitRef: '/a.svg', currentState: '在场。', presence: 'present', memoryTimeline: {}, selfModel: '克制。' }],
    lore: [{ name: '重复条目', content: 'JSON 版本。' }],
  }))
  writeFileSync(join(root, 'demo.txt'), '=== 重复条目 ===\ntxt 版本。\n=== txt 新增 ===\n> 角色: aria\n新增内容。\n')
  const story = loadStoryPackageWithTxt(root, 'demo')
  assert.equal(story.lore!.length, 2)
  assert.deepEqual(story.lore!.find(e => e.name === '重复条目'), { name: '重复条目', content: 'JSON 版本。' })
  assert.deepEqual(story.lore!.find(e => e.name === 'txt 新增'), { name: 'txt 新增', roles: ['aria'], content: '新增内容。' })
})

test('saveStoryPackage writes JSON back preserving lore', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-wbsave-'))
  writeFileSync(join(root, 'demo.json'), JSON.stringify({
    id: 'demo', title: 'Demo', opening: '开场。', playerCharacter: { name: '玩家', persona: '人设。', currentState: '状态。' },
    roles: [{ id: 'aria', name: 'Aria', portraitRef: '/a.svg', currentState: '在场。', presence: 'present', memoryTimeline: {}, selfModel: '克制。' }],
  }))
  const story = loadStoryPackageWithTxt(root, 'demo')
  story.lore = [{ name: '新条目', content: '内容。' }]
  story.roles[0].selfModel = '修改后的人设。'
  saveStoryPackage(root, story)
  const reloaded = JSON.parse(readFileSync(join(root, 'demo.json'), 'utf8'))
  assert.equal(reloaded.roles[0].selfModel, '修改后的人设。')
  assert.deepEqual(reloaded.lore, [{ name: '新条目', content: '内容。' }])
})
