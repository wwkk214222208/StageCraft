import assert from 'node:assert/strict'
import test from 'node:test'
import { DshStorySessionService } from '../src/dsh-story-session.ts'
import type { StoryPackage } from '../src/story-packages.ts'

const story = (title = 'Original'): StoryPackage => ({ id: 'story', title, opening: 'Opening', playerCharacter: { name: 'Player', persona: 'Persona', currentState: 'Ready' }, roles: [{ id: 'role', name: 'Role', portraitRef: '/assets/default.svg', currentState: 'Waiting', presence: 'present', memoryTimeline: {}, selfModel: 'Model' }] })
function fixture() {
  const calls: any[] = []; let current = story()
  const nativeSession = { id: 'native-1', prompt: async (content: unknown) => { calls.push(['prompt', content]) } }
  const native = { create: () => nativeSession, binding: (id: string) => id === 'native-1' ? { session: nativeSession } : undefined }
  const apiProxy = { sessions: { create: async (request: unknown) => { calls.push(['create', request]); return { rpcId: 'create', result: { ok: true, value: { sessionId: 'native-1' } } } }, history: async (request: unknown) => { calls.push(['history', request]); return { rpcId: 'history', result: { ok: true, value: { events: [{ event: { type: 'user/message', data: { content: [{ type: 'text', text: '你正在协助编辑剧本文件。当前剧本 ID：story\n用户请求：帮我改一下场景时间' }] } } }, { event: { type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>\nA skill is a reusable set of task-specific instructions…' }] } } }, { event: { type: 'assistant/message', data: { content: [{ type: 'reasoning', text: '思维链内容不应显示' }, { type: 'text', text: '好的，已改好。' }, { type: 'tool-call', text: '{"name":"edit"}' }] } } }] } } } }, models: async (request: unknown) => { calls.push(['models', request]); return { rpcId: 'models', result: { ok: true, value: { providers: [{ id: 'provider-a', models: ['model-a'] }] } } } }, selectModel: async (selection: unknown) => { calls.push(['select-model', selection]); return { rpcId: 'select', result: { ok: true, value: { selected: selection } } } } } }
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

test('history shows only chat body, not injected system context', async () => {
  const f = fixture(); const session = await f.service.open('owner-a', 'story')
  const messages = await f.service.history('owner-a', session.id)
  assert.deepEqual(messages.map(message => ({ role: message.role, text: message.text })), [
    { role: 'user', text: '帮我改一下场景时间' },
    { role: 'system', text: '好的，已改好。' },
  ])
})

test('list restores only creator-owned sessions', async () => {
  const f = fixture(); const session = await f.service.open('owner-a', 'story')
  const createCall = f.calls.find(call => call[0] === 'create')
  assert.ok(createCall[1].payload.sessionId.startsWith('creator-'))
  const creatorId = createCall[1].payload.sessionId
  const apiProxy = { sessions: { list: async () => ({ rpcId: 'list', result: { ok: true, value: { items: [{ sessionId: creatorId, updatedAt: Date.now() }, { sessionId: 'engine-internal-session', updatedAt: Date.now() }] } } }) } }
  const service = new DshStorySessionService(() => structuredClone(f.current), undefined, () => apiProxy)
  const sessions = await service.list('owner-a', 'story')
  assert.deepEqual(sessions.map(item => item.id), [creatorId])
})

test('open resolves workspace before creating session', async () => {
  const calls: any[] = []
  const apiProxy = { workspace: { create: async (request: unknown) => { calls.push(['workspace', request]); return { rpcId: 'ws', result: { ok: true, value: { workspace: { workspaceId: 'ws-1', path: 'C:\\tavern', title: 'tavern', sessionIds: [], createdAt: '', updatedAt: '' } } } } } }, sessions: { create: async (request: unknown) => { calls.push(['create', request]); return { rpcId: 'create', result: { ok: true, value: { sessionId: 'creator-abc' } } } } } }
  const service = new DshStorySessionService(() => structuredClone(story()), undefined, () => apiProxy, 'C:\\tavern')
  const session = await service.open('owner-a', 'story')
  const workspaceCall = calls.find(call => call[0] === 'workspace')
  assert.deepEqual(workspaceCall[1].payload, { path: 'C:\\tavern' })
  const createCall = calls.find(call => call[0] === 'create')
  assert.equal(createCall[1].payload.workspaceId, 'ws-1')
  assert.equal(session.id, 'creator-abc')
})

test('archive removes session and hides archived from list', async () => {
  const calls: any[] = []
  const apiProxy = { workspace: { create: async (request: unknown) => { calls.push(['workspace', request]); return { rpcId: 'ws', result: { ok: true, value: { workspace: { workspaceId: 'ws-1', path: 'C:\\tavern\\stories', title: 'stories', sessionIds: [], createdAt: '', updatedAt: '' } } } } }, archiveSession: async (request: unknown) => { calls.push(['archive', request]); return { rpcId: 'archive', result: { ok: true, value: { archivedSessionIds: ['creator-abc'] } } } }, list: async () => ({ rpcId: 'wslist', result: { ok: true, value: { items: [], archivedSessionIds: ['creator-abc'] } } }) }, sessions: { create: async (request: unknown) => { calls.push(['create', request]); return { rpcId: 'create', result: { ok: true, value: { sessionId: 'creator-abc' } } } }, list: async () => ({ rpcId: 'list', result: { ok: true, value: { items: [{ sessionId: 'creator-abc', updatedAt: Date.now() }] } } }) } }
  const service = new DshStorySessionService(() => structuredClone(story()), undefined, () => apiProxy, 'C:\\tavern\\stories')
  await service.open('owner-a', 'story')
  await service.archive('owner-a', 'creator-abc')
  assert.throws(() => service.get('owner-a', 'creator-abc'), /未知/)
  assert.deepEqual((await service.list('owner-a', 'story')).map(item => item.id), [])
})

test('close rejects further access', async () => {
  const f = fixture(); const session = await f.service.open('owner-a', 'story'); f.service.close('owner-a', session.id)
  assert.throws(() => f.service.get('owner-a', session.id), /未知/)
})
