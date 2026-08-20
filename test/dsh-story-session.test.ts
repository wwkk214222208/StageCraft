import assert from 'node:assert/strict'
import test from 'node:test'
import { DshStorySessionService } from '../src/dsh-story-session.ts'
import type { StoryPackage } from '../src/story-packages.ts'

const story = (title = 'Original'): StoryPackage => ({ id: 'story', title, opening: 'Opening', playerCharacter: { name: 'Player', persona: 'Persona', currentState: 'Ready' }, roles: [{ id: 'role', name: 'Role', portraitRef: '/assets/default.svg', currentState: 'Waiting', presence: 'present', memoryTimeline: {}, selfModel: 'Model' }] })
function fixture() {
  const calls: any[] = []; let current = story()
  const nativeSession = { id: 'native-1', prompt: async (content: unknown) => { calls.push(['prompt', content]) } }
  const native = { create: () => nativeSession, binding: (id: string) => id === 'native-1' ? { session: nativeSession } : undefined }
  const apiProxy = { sessions: { models: async (request: unknown) => { calls.push(['models', request]); return { providers: [{ id: 'provider-a', models: ['model-a'] }] } }, selectModel: async (selection: unknown) => { calls.push(['select-model', selection]); return { selected: selection } } } }
  const service = new DshStorySessionService(() => structuredClone(current), native, apiProxy)
  return { service, calls, get current() { return current } }
}

test('native sessions isolate owners and carry current story context', async () => {
  const f = fixture(); const session = f.service.open('owner-a', 'story')
  assert.throws(() => f.service.get('owner-b', session.id), /不属于/)
  await f.service.prompt('owner-a', session.id, '请修改开场')
  assert.equal(f.calls[0][0], 'prompt'); assert.match(f.calls[0][1][0].text, /当前剧本 ID：story/)
  assert.equal(f.current.title, 'Original')
})

test('native model directory and selection stay on the DSH session', async () => {
  const f = fixture(); const session = f.service.open('owner-a', 'story')
  assert.deepEqual(await f.service.models('owner-a', session.id), { providers: [{ id: 'provider-a', models: ['model-a'] }] })
  await f.service.selectModel('owner-a', session.id, { provider: 'provider-a', model: 'model-a' })
  assert.deepEqual(f.calls[0], ['select-model', { provider: 'provider-a', model: 'model-a' }])
})

test('close rejects further access', () => {
  const f = fixture(); const session = f.service.open('owner-a', 'story'); f.service.close('owner-a', session.id)
  assert.throws(() => f.service.get('owner-a', session.id), /未知/)
})
