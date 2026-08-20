import assert from 'node:assert/strict'
import test from 'node:test'
import { DshStorySessionService } from '../src/dsh-story-session.ts'
import type { StoryPackage } from '../src/story-packages.ts'

const story = (title = 'Original'): StoryPackage => ({ id: 'story', title, opening: 'Opening', playerCharacter: { name: 'Player', persona: 'Persona', currentState: 'Ready' }, roles: [{ id: 'role', name: 'Role', portraitRef: '/assets/default.svg', currentState: 'Waiting', presence: 'present', memoryTimeline: {}, selfModel: 'Model' }] })
function fixture() {
  const calls: any[] = []; let current = story()
  const nativeSession = { id: 'native-1', prompt: async (content: unknown) => { calls.push(['prompt', content]) } }
  const native = { create: () => nativeSession, binding: (id: string) => id === 'native-1' ? { session: nativeSession } : undefined }
  const apiProxy = { sessions: { create: async (request: unknown) => { calls.push(['create', request]); return { rpcId: 'create', result: { ok: true, value: { sessionId: 'native-1' } } } }, models: async (request: unknown) => { calls.push(['models', request]); return { rpcId: 'models', result: { ok: true, value: { providers: [{ id: 'provider-a', models: ['model-a'] }] } } } }, selectModel: async (selection: unknown) => { calls.push(['select-model', selection]); return { rpcId: 'select', result: { ok: true, value: { selected: selection } } } } } }
  let currentApiProxy: any
  const service = new DshStorySessionService(() => structuredClone(current), native, () => currentApiProxy)
  currentApiProxy = apiProxy
  return { service, calls, get current() { return current } }
}

test('native sessions isolate owners and carry current story context', async () => {
  const f = fixture(); const session = await f.service.open('owner-a', 'story')
  assert.throws(() => f.service.get('owner-b', session.id), /不属于/)
  await f.service.prompt('owner-a', session.id, '请修改开场')
  const promptCall = f.calls.find(call => call[0] === 'prompt')
  assert.ok(promptCall); assert.match(promptCall[1][0].text, /当前剧本 ID：story/)
  assert.equal(f.current.title, 'Original')
})

test('native model directory and selection stay on the DSH session', async () => {
  const f = fixture(); const session = await f.service.open('owner-a', 'story')
  assert.deepEqual(await f.service.models('owner-a', session.id), { providers: [{ id: 'provider-a', models: ['model-a'] }] })
  await f.service.selectModel('owner-a', session.id, { provider: 'provider-a', model: 'model-a' })
  const selectCall = f.calls.find(call => call[0] === 'select-model')
  assert.equal(selectCall[1].payload.sessionId, 'native-1')
  assert.deepEqual(selectCall[1].payload, { sessionId: 'native-1', provider: 'provider-a', model: 'model-a' })
})

test('close rejects further access', async () => {
  const f = fixture(); const session = await f.service.open('owner-a', 'story'); f.service.close('owner-a', session.id)
  assert.throws(() => f.service.get('owner-a', session.id), /未知/)
})
