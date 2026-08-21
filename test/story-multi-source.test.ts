import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listStoryPackages, loadStoryPackage } from '../src/story-packages.ts'

const story = (id, title) => ({ id, title, opening: '开场。', sceneTime: '夜晚', playerCharacter: { name: '玩家', persona: 'p', currentState: 'c' }, roles: [{ id: 'r', name: '角色', portraitRef: '/a.svg', currentState: 's', presence: 'present', selfModel: 'm' }], lore: [] })

test('listStoryPackages merges main, custom, and extra bundle directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-story-list-'))
  const appdata = join(root, 'appdata')
  const bundle = join(root, 'bundle')
  mkdirSync(join(appdata, 'custom'), { recursive: true })
  mkdirSync(join(bundle, 'custom'), { recursive: true })
  writeFileSync(join(appdata, 'eldoria.json'), JSON.stringify(story('eldoria', 'AppData 版')))
  writeFileSync(join(appdata, 'custom', '七女神纪元.json'), JSON.stringify(story('七女神纪元', 'AppData custom')))
  writeFileSync(join(bundle, 'eldoria.json'), JSON.stringify(story('eldoria', 'Bundle 版')))
  writeFileSync(join(bundle, 'festival.json'), JSON.stringify(story('festival', 'Bundle 专属')))
  writeFileSync(join(bundle, 'custom', 'bundle-custom.json'), JSON.stringify(story('bundle-custom', 'Bundle custom')))

  const listed = listStoryPackages(appdata, [bundle])
  // AppData 优先（同 id），bundle 专属剧本出现，custom 标记正确
  assert.equal(listed.find(s => s.id === 'eldoria').title, 'AppData 版', 'AppData 优先于 bundle 同 id')
  assert.ok(listed.some(s => s.id === 'festival' && !s.custom), 'bundle 专属默认剧本出现')
  assert.ok(listed.some(s => s.id === '七女神纪元' && s.custom), 'AppData custom 标记 custom')
  assert.ok(listed.some(s => s.id === 'bundle-custom' && s.custom), 'bundle custom 标记 custom')
})

test('loadStoryPackage falls back to bundle when missing in appdata', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-story-load-'))
  const appdata = join(root, 'appdata')
  const bundle = join(root, 'bundle')
  mkdirSync(appdata, { recursive: true })
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(appdata, 'eldoria.json'), JSON.stringify(story('eldoria', 'AppData 版')))
  writeFileSync(join(bundle, 'festival.json'), JSON.stringify(story('festival', 'Bundle 专属')))
  assert.equal(loadStoryPackage(appdata, 'eldoria', [bundle]).title, 'AppData 版')
  assert.equal(loadStoryPackage(appdata, 'festival', [bundle]).title, 'Bundle 专属', 'AppData 缺失时从 bundle 加载')
})
