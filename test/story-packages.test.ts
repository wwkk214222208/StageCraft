import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Store } from '../src/store.ts'
import { listStoryPackages, loadStoryPackage } from '../src/story-packages.ts'

const stories = join(import.meta.dirname, '..', 'stories')
const fixtures = join(import.meta.dirname, 'fixtures')

test('test fixture story package loads with validated roles', () => {
  const story = loadStoryPackage(fixtures, 'royal-festival')
  assert.equal(story.title, '皇家祭典')
  assert.equal(story.roles.length, 3)
  const listed = listStoryPackages(stories)
  assert.ok(!listed.some(item => item.id === 'royal-festival'), '皇家祭典不应再出现在默认剧本列表')
  assert.ok(listed.length >= 1)
})

test('Eldoria default story package loads with Seraphina and expanded lore', () => {
  const story = loadStoryPackage(stories, 'eldoria')
  assert.equal(story.title, 'Eldoria：迷雾森林的守护者')
  assert.equal(story.roles.length, 3)
  assert.equal(story.roles.find(role => role.id === 'seraphina')?.name, '塞拉菲娜')
  assert.ok(story.lore.some(entry => entry.name === '埃尔多利亚·总览'), '应有埃尔多利亚总览世界书')
  assert.ok(existsSync(join(import.meta.dirname, '..', 'public', 'assets', 'seraphina.png')), '应包含塞拉菲娜默认立绘')
  const present = story.roles.filter(role => role.presence === 'present').map(role => role.id).sort()
  assert.deepEqual(present, ['rowan', 'seraphina'], '初始应在场：塞拉菲娜与罗温')
  assert.deepEqual(listStoryPackages(stories).find(item => item.id === 'eldoria'), { id: 'eldoria', title: 'Eldoria：迷雾森林的守护者' })
})

test('seed with Eldoria creates Eldoria as the default startup room', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-eldoria-seed-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.seed(loadStoryPackage(stories, 'eldoria'))
  const room = store.getRoom(roomId)!
  assert.equal(room.title, 'Eldoria：迷雾森林的守护者')
  assert.equal(room.storyId, 'eldoria')
  assert.equal(room.roles.length, 3)
})

test('七女神纪元 story package loads with all roles and lore', () => {
  const story = loadStoryPackage(stories, '七女神纪元')
  assert.equal(story.title, '七女神纪元')
  assert.equal(story.roles.length, 12)
  assert.equal(story.playerCharacter?.name, '怀夕')
  assert.ok(story.lore.length >= 14, `应有世界书条目，实际 ${story.lore.length}`)
  assert.ok(story.roles.every(role => role.selfModel && role.memoryTimeline), '所有角色应有 selfModel 与记忆时间线')
  assert.ok(story.lore.some(entry => entry.name === '归煦神谕·苏棠' && entry.roles?.length === 1 && entry.roles[0] === 'sutang'), '归煦神谕·苏棠只对苏棠可见')
  assert.ok(story.lore.some(entry => entry.name === '怀夕·道成肉身' && entry.roles?.includes('sutang') && entry.roles?.includes('lucifer')), '怀夕·道成肉身只对苏棠、露西菲尔可见')
  assert.ok(story.lore.some(entry => entry.name === '银月圣殿·禁忌知识' && entry.roles?.includes('nara')), '银月圣殿·禁忌知识只对娜拉可见')
  assert.ok(story.lore.some(entry => entry.name === '七神总览·通用常识' && !entry.roles), '通用常识条目应常开')
  const present = story.roles.filter(role => role.presence === 'present').map(role => role.id).sort()
  assert.deepEqual(present, ['lucifer', 'sutang'], '初始只有苏棠与露西菲尔在线')
  const listed = listStoryPackages(stories)
  const qiNv = listed.find(item => item.id === '七女神纪元')
  const eldoria = listed.find(item => item.id === 'eldoria')
  assert.deepEqual(qiNv, { id: '七女神纪元', title: '七女神纪元', custom: true }, '私人剧本位于 stories/custom/ 并标记 custom')
  assert.deepEqual(eldoria, { id: 'eldoria', title: 'Eldoria：迷雾森林的守护者' }, '默认剧本不带 custom 标记')
})

test('a package creates an independent initialized room whose opening is the first history scene', () => {
  const story = loadStoryPackage(fixtures, 'royal-festival')
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-story-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.createRoomFromPackage(story, 'custom-festival')
  const room = store.getRoom(roomId)!
  assert.equal(room.title, story.title)
  assert.equal(room.roles.length, 3)
  assert.equal(room.scenes.length, 1, '开局文本应成为第一条历史 scene')
  assert.equal(room.scenes[0].text, story.opening)
  assert.equal(room.scenes[0].turnId, 'opening')
  assert.equal(room.phase, 'awaiting-player-input')
})

test('structured initial memories seed canonical story records instead of legacy timeline entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-story-initial-memory-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.createRoomFromPackage({
    id: 'structured-memory-story', title: '结构化记忆剧本', opening: '', playerCharacter: { name: '玩家', persona: '', currentState: '' },
    roles: [{ id: 'keeper', name: '守秘人', portraitRef: '/assets/default.svg', currentState: '守在门前。', presence: 'present', selfModel: '谨慎。', memoryTimeline: { '旧时间': ['不应作为初始记录写入。'] }, initialMemories: [{ kind: 'promise', text: '答应保护银钥匙。', subjects: ['玩家'], occurredAt: '开场前', salience: 5, confidence: 1 }] }],
  }, 'structured-memory-room')
  const memory = store.getRoom(roomId)!.roles[0].memories![0]
  assert.equal(memory.text, '答应保护银钥匙。')
  assert.equal(memory.kind, 'promise')
  assert.equal(memory.source, 'story')
  assert.equal(memory.occurredAt, '开场前')
})

test('restarting a room seeds the opening as the first history scene', () => {
  const story = loadStoryPackage(stories, '七女神纪元')
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-story-restart-'))
  const store = new Store(join(root, 'app.sqlite'))
  const roomId = store.createRoomFromPackage(story, 'restart-test')
  store.restartRoom(roomId, story)
  const room = store.getRoom(roomId)!
  assert.equal(room.scenes.length, 1)
  assert.equal(room.scenes[0].text, story.opening)
  assert.equal(room.scenes[0].turnId, 'opening')
})
