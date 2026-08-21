import assert from 'node:assert/strict'
import test from 'node:test'
import { CreatorWorkbenchService } from '../src/creator-workbench-service.ts'
import type { StoryPackage } from '../src/story-packages.ts'

const role = { id: 'role', name: 'Role', portraitRef: '/assets/default.svg', currentState: 'Ready', presence: 'present' as const, selfModel: 'Model' }
function story(): StoryPackage { return { id: 'story', title: 'Original', opening: 'Opening', playerCharacter: { name: 'Player', persona: 'Persona', currentState: 'Ready' }, roles: [role] } }
function fixture() { let current = story(); const writes: StoryPackage[] = []; const service = new CreatorWorkbenchService({ read: () => structuredClone(current), write: (next, previous) => { assert.deepEqual(current, previous); current = structuredClone(next); writes.push(structuredClone(next)) } }, 'workbench:test'); return { service, get current() { return current }, writes } }

test('ST card import creates a non-persistent workbench preview with warnings and diffs', async () => {
  const f = fixture(); const preview = await f.service.preview({ kind: 'st-card-json', name: 'fixture.json', content: JSON.stringify({ spec: 'chara_card_v2', name: 'Imported', description: 'Public fixture', character_book: { entries: [{ name: 'Lore', content: 'Public lore', enabled: true }] } }) })
  assert.equal(f.current.roles.length, 1); assert.equal(preview.candidate.roles.length, 2); assert.ok(preview.diffs.some(diff => diff.path === '/roles')); assert.ok(preview.warnings.length > 0)
})

test('text extraction preview is bounded and field decisions apply or reject', async () => {
  const f = fixture(); const preview = await f.service.preview({ kind: 'text', content: '角色：Extracted\n设定：Public lore' }); const titleDiff = preview.diffs.find(diff => diff.path === '/roles')
  assert.ok(titleDiff); const rejected = f.service.apply({ previewId: preview.id, requestedAt: new Date().toISOString(), accept: [{ path: titleDiff!.path, decision: 'reject' }] }); assert.equal(rejected.applied, false); assert.equal(f.writes.length, 0)
  const second = await f.service.preview({ kind: 'text', content: '角色：Applied' }); const path = second.diffs.find(diff => diff.path === '/roles')!.path; const applied = f.service.apply({ previewId: second.id, requestedAt: new Date().toISOString(), accept: [{ path, decision: 'accept' }] }); assert.equal(applied.applied, true); assert.equal(f.current.roles[1].name, 'Applied')
})

test('revert restores the preview baseline and legacy repository writes remain usable', async () => {
  const f = fixture(); const preview = await f.service.preview({ kind: 'text', content: '角色：Temporary' }); const path = preview.diffs.find(diff => diff.path === '/roles')!.path; f.service.apply({ previewId: preview.id, requestedAt: new Date().toISOString(), accept: [{ path, decision: 'accept' }] }); assert.equal(f.current.roles[1].name, 'Temporary'); f.service.revert(preview.id); assert.equal(f.current.roles[0].name, 'Role'); assert.equal(f.writes.length, 2)
})
