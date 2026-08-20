import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CREATOR_CONTRACT_VERSION,
  CREATOR_EXTRACTION_VERSION,
  applyFieldAcceptance,
  assertJsonSafe,
  diffStoryPackages,
  validateCreatorPreview,
} from '../src/creator-contracts.ts'
import type { CreatorExtractionPreview } from '../src/creator-contracts.ts'
import type { StoryPackage } from '../src/story-packages.ts'

function story(overrides: Partial<StoryPackage> = {}): StoryPackage {
  return {
    id: 'synthetic-story',
    title: 'Synthetic Story',
    opening: 'A public opening.',
    playerCharacter: { name: 'Player', persona: 'Public persona.', currentState: 'At the door.' },
    roles: [{ id: 'guide', name: 'Guide', portraitRef: '/assets/default.svg', currentState: 'Waiting.', presence: 'present', memoryTimeline: {}, selfModel: 'Public role model.' }],
    ...overrides,
  }
}

function preview(candidate = story(), expiresAt = '2099-01-01T00:00:00.000Z'): CreatorExtractionPreview {
  return {
    contractVersion: CREATOR_CONTRACT_VERSION,
    extractionVersion: CREATOR_EXTRACTION_VERSION,
    id: 'preview-synthetic',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt,
    source: { kind: 'st-card-json', name: 'synthetic-card.json', contentType: 'application/json', byteLength: 42, summary: 'Synthetic public test card (metadata only).' },
    candidate,
    diffs: diffStoryPackages(undefined, candidate),
    warnings: [],
    diagnostics: [],
    valid: true,
  }
}

test('creator contracts reject non-JSON values', () => {
  assert.throws(() => assertJsonSafe(new Map()), /JSON-safe/)
  assert.throws(() => assertJsonSafe({ value: Number.NaN }), /JSON-safe/)
})

test('preview validation delegates candidate authority to StoryPackage validation', () => {
  assert.doesNotThrow(() => validateCreatorPreview(preview()))
  assert.throws(() => validateCreatorPreview(preview(story({ roles: [] }))), /Invalid story package/)
})

test('preview validation enforces version and expiry without persisting content', () => {
  assert.throws(() => validateCreatorPreview({ ...preview(), contractVersion: '0.0.1' }), /Unsupported creator preview version/)
  assert.throws(() => validateCreatorPreview(preview(story(), '2020-01-01T00:00:00.000Z')), /expired/)
  assert.equal(preview().source.summary.includes('public'), true)
})

test('field diffs are explicit and acceptance returns paths', () => {
  const candidate = story({ title: 'Changed title' })
  const diffs = diffStoryPackages(story(), candidate)
  assert.deepEqual(diffs.map(diff => diff.path), ['/title'])
  assert.equal(diffs[0]?.decision, 'unchanged')
  const result = applyFieldAcceptance(preview(candidate), { previewId: 'preview-synthetic', requestedAt: '2026-01-01T00:00:00.000Z', accept: [{ path: '/title', decision: 'accept' }] })
  assert.equal(result.applied, true)
  assert.deepEqual(result.accepted, ['/title'])
  assert.deepEqual(result.rejected, [])
})

test('rejecting a changed field prevents apply and reports a diagnostic', () => {
  const candidate = story({ title: 'Changed title' })
  const result = applyFieldAcceptance(preview(candidate), { previewId: 'preview-synthetic', requestedAt: '2026-01-01T00:00:00.000Z', accept: [{ path: '/title', decision: 'reject' }] })
  assert.equal(result.applied, false)
  assert.deepEqual(result.rejected, ['/title'])
  assert.equal(result.diagnostics[0]?.code, 'validation-failed')
})
