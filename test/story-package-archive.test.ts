import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStoredZip, collectStoryArchiveEntries, importStoryArchive } from '../src/story-package-archive.ts'

const story = { id: 'source', title: '单个剧本', opening: '开场', playerCharacter: { name: '玩家', persona: 'persona', currentState: 'state' }, roles: [{ id: 'guide', name: '向导', portraitRef: '/story-assets/source/roles/guide.png', currentState: 'state', presence: 'present', selfModel: 'guide' }] }

test('story archive round trips one story and rewrites asset refs', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-story-')); const assets = join(root, 'source.assets', 'roles'); mkdirSync(assets, { recursive: true }); writeFileSync(join(assets, 'guide.png'), Buffer.from([1, 2, 3]))
  const archive = createStoredZip(collectStoryArchiveEntries(story as any, join(root, 'source.assets')))
  const imported = importStoryArchive(archive, root, 'imported')
  assert.equal(imported.id, 'imported'); assert.equal(imported.roles[0].portraitRef, '/story-assets/imported/roles/guide.png'); assert.deepEqual([...readFileSync(join(root, 'custom', 'imported.assets', 'roles', 'guide.png'))], [1, 2, 3])
})

test('story archive rejects traversal and unsupported assets before writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-story-invalid-'))
  const base = collectStoryArchiveEntries(story as any, join(root, 'missing'))
  assert.throws(() => importStoryArchive(createStoredZip([...base, { name: '../escape.png', data: Buffer.from([1]) }]), root, 'bad'), /不安全/)
  assert.throws(() => importStoryArchive(createStoredZip([...base, { name: 'assets/script.js', data: Buffer.from([1]) }]), root, 'bad'), /不支持/)
})
