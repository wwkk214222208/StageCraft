import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { CreatorPreviewApplyAdapter, creatorPreviewModuleRegistration } from '../src/creator-preview-apply.ts'
import { CREATOR_CONTRACT_VERSION, CREATOR_EXTRACTION_VERSION, diffStoryPackages, type CreatorExtractionPreview } from '../src/creator-contracts.ts'
import type { StoryPackage } from '../src/story-packages.ts'

function story(overrides: Partial<StoryPackage> = {}): StoryPackage {
  return { id: 'story', title: 'Original', opening: 'Opening', playerCharacter: { name: 'Player', persona: 'Persona', currentState: 'Ready' }, roles: [{ id: 'role', name: 'Role', portraitRef: '/assets/default.svg', currentState: 'Waiting', presence: 'present', selfModel: 'Model' }], ...overrides }
}
function preview(candidate: StoryPackage, id = 'preview-1'): CreatorExtractionPreview {
  return { contractVersion: CREATOR_CONTRACT_VERSION, extractionVersion: CREATOR_EXTRACTION_VERSION, id, createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', source: { kind: 'text', summary: 'metadata-only test source' }, candidate, diffs: diffStoryPackages(story(), candidate), warnings: [], diagnostics: [], valid: true }
}
function fixture(initial = story()) {
  let current = structuredClone(initial)
  const writes: StoryPackage[] = []
  const core = new CoreRuntimeSkeleton()
  creatorPreviewModuleRegistration(core)
  const repository = { read: () => structuredClone(current), write: (next: StoryPackage, previous: StoryPackage) => { assert.deepEqual(current, previous); current = structuredClone(next); writes.push(structuredClone(next)) } }
  const adapter = new CreatorPreviewApplyAdapter(core, { owner: 'room-1', repository })
  return { core, adapter, repository, get story() { return current }, writes }
}

test('model candidates stay non-persistent until explicit preview approval', () => {
  const f = fixture()
  const candidate = story({ title: 'Model title' })
  f.adapter.preview(preview(candidate))
  assert.equal(f.story.title, 'Original')
  const requested = f.adapter.request({ previewId: 'preview-1', requestedAt: '2026-01-01T00:00:00.000Z', accept: [{ path: '/title', decision: 'accept' }] })
  assert.equal(requested.status, 'pending')
  assert.equal(f.story.title, 'Original')
  f.adapter.approve('preview-1')
  assert.equal(f.story.title, 'Model title')
  assert.equal(f.writes.length, 1)
})

test('preview IDs are explicit, one-shot, and foreign or expired previews are rejected', () => {
  const f = fixture()
  assert.throws(() => f.adapter.request({ previewId: 'missing', requestedAt: '2026-01-01T00:00:00.000Z', accept: [] }), /Unknown or foreign/)
  f.adapter.preview(preview(story({ title: 'Changed' })))
  f.adapter.request({ previewId: 'preview-1', requestedAt: '2026-01-01T00:00:00.000Z', accept: [] })
  assert.throws(() => f.adapter.request({ previewId: 'preview-1', requestedAt: '2026-01-01T00:00:00.000Z', accept: [] }), /already been used/)
  const expired = fixture()
  assert.throws(() => expired.adapter.preview({ ...preview(story({ title: 'Expired' }), 'expired'), expiresAt: '2020-01-01T00:00:00.000Z' }), /expired/)
})

test('conflicts and invalid accepted paths do not mutate the package', () => {
  const f = fixture()
  f.adapter.preview(preview(story({ title: 'Changed' })))
  assert.throws(() => f.adapter.request({ previewId: 'preview-1', requestedAt: '2026-01-01T00:00:00.000Z', accept: [{ path: '/opening', decision: 'accept' }] }), /not in preview/)
  f.adapter.request({ previewId: 'preview-1', requestedAt: '2026-01-01T00:00:00.000Z', accept: [{ path: '/title', decision: 'accept' }] })
  const concurrent = story({ title: 'Concurrent change' })
  f.repository.write(concurrent, f.story)
  assert.throws(() => f.adapter.approve('preview-1'), /conflict/)
  assert.equal(f.story.title, 'Original')
})

test('reject and no-op paths do not apply, while Role/Lore/stat data remain namespaced', () => {
  const f = fixture()
  const candidate = story({ title: 'Changed', roles: [{ id: 'role', name: 'Role', portraitRef: '/assets/default.svg', currentState: 'Changed', presence: 'present', selfModel: 'Model' }], lore: [{ name: 'Lore', content: 'Content' }], sceneTime: 'night' })
  f.adapter.preview(preview(candidate))
  const result = f.adapter.request({ previewId: 'preview-1', requestedAt: '2026-01-01T00:00:00.000Z', accept: [{ path: '/title', decision: 'reject' }] })
  assert.equal(result.status, 'rejected')
  assert.equal(f.story.title, 'Original')
  const state = f.core.getView().state as any
  assert.equal(state.modules?.['creator.preview']?.proposals?.[0], undefined)
  assert.equal(state.modules?.roles, undefined)
  assert.equal(state.modules?.lore, undefined)
  assert.equal(state.modules?.stats, undefined)
})

test('repository failure leaves Core state unchanged and reports rollback capability', () => {
  const f = fixture()
  const candidate = story({ title: 'Rejected by repository' })
  f.adapter.preview(preview(candidate))
  f.adapter.request({ previewId: 'preview-1', requestedAt: '2026-01-01T00:00:00.000Z', accept: [{ path: '/title', decision: 'accept' }] })
  const original = f.core.getView()
  const originalWrite = f.repository.write
  f.repository.write = () => { throw new Error('repository commit failed') }
  assert.throws(() => f.adapter.approve('preview-1'), /repository commit failed/)
  assert.deepEqual(f.core.getView().state, original.state)
  f.repository.write = originalWrite
})
