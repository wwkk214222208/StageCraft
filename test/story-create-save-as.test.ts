import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStoryPackage, listStoryPackages, loadStoryPackage, saveStoryAsPackage, saveStoryPackage } from '../src/story-packages.ts'

const kit = (root) => {
  mkdirSync(join(root, 'custom'), { recursive: true })
  return root
}

test('createStoryPackage writes a valid template into custom/ marked as player story', () => {
  const root = kit(mkdtempSync(join(tmpdir(), 'ct-story-create-')))
  const story = createStoryPackage(root, { title: '星海彼岸', sceneTime: '夜晚', sceneLocation: '废弃飞船' })
  assert.ok(story.id.startsWith('story-'), '自动生成 id')
  assert.ok(existsSync(join(root, 'custom', `${story.id}.json`)), '写在 custom/')
  assert.equal(story.title, '星海彼岸')
  assert.equal(story.roles.length, 1, '模板必须包含至少一个角色')
  const loaded = loadStoryPackage(root, story.id)
  assert.equal(loaded.title, '星海彼岸')
  const listed = listStoryPackages(root).find(item => item.id === story.id)
  assert.ok(listed?.custom, '玩家剧本标记 custom')
})

test('saveStoryAsPackage copies content to a new custom id with a new title', () => {
  const root = kit(mkdtempSync(join(tmpdir(), 'ct-story-saveas-')))
  const source = createStoryPackage(root, { title: '原标题', id: 'orig' })
  source.roles.push({ id: 'extra', name: '追加角色', portraitRef: '/a.svg', currentState: '在场', presence: 'present', selfModel: 'm' })
  const saved = saveStoryAsPackage(root, source, 'copy-1', '新标题')
  assert.equal(saved.id, 'copy-1')
  assert.equal(saved.title, '新标题')
  assert.equal(saved.roles.length, 2, '内容完整保留')
  assert.ok(existsSync(join(root, 'custom', 'copy-1.json')), '另存为写入 custom/')
  assert.equal(listStoryPackages(root).find(item => item.id === 'copy-1')?.custom, true)
  // 原剧本不受影响
  assert.equal(loadStoryPackage(root, 'orig').roles.length, 1)
})

test('saveStoryPackage writes back to custom/ for player stories, keeping default precedence intact', () => {
  const root = kit(mkdtempSync(join(tmpdir(), 'ct-story-saveback-')))
  const bundle = mkdtempSync(join(tmpdir(), 'ct-story-bundle-'))
  writeFileSync(join(bundle, 'eldoria.json'), JSON.stringify({ id: 'eldoria', title: 'Bundle 默认', opening: '开场。', playerCharacter: { name: '玩家', persona: 'p', currentState: 'c' }, roles: [{ id: 'r', name: '角色', portraitRef: '/a.svg', currentState: 's', presence: 'present', selfModel: 'm' }], lore: [] }))
  const story = createStoryPackage(root, { title: '玩家版', id: 'eldoria' })
  saveStoryPackage(root, story)
  // 默认剧本：bundle 优先；玩家同 id 剧本无法覆盖默认（属于 custom 目录时读取也优先 custom）
  assert.equal(loadStoryPackage(root, 'eldoria', [bundle]).title, '玩家版', 'custom 玩家剧本优先于 bundle 默认')
})