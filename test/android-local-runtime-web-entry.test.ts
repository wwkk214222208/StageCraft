import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const entryPath = join(process.cwd(), 'android', 'app', 'src', 'main', 'assets', 'web', 'local-runtime-web-entry.js')

function createRuntime() {
  const stories = new Map()
  const room = { id: 'android-local-room', storyId: 'eldoria', mode: 'director', roles: [], scenes: [] }
  const native = {
    invokeSync(operation, inputJson) {
      const input = JSON.parse(inputJson)
      if (operation === 'story.create') {
        const story = { id: 'story-created', title: input.title, opening: 'opening', playerCharacter: { name: '玩家', persona: '', currentState: '' }, roles: [] }
        stories.set(story.id, story)
        return JSON.stringify({ ok: true, id: story.id, title: story.title })
      }
      if (operation === 'story.save') {
        stories.set(input.story.id, input.story)
        return JSON.stringify({ ok: true, id: input.story.id })
      }
      if (operation === 'stories.list') return JSON.stringify({ stories: [...stories.values()].map(story => ({ id: story.id, title: story.title, custom: true, mode: 'director' })) })
      if (operation === 'secret.get') return JSON.stringify({ found: false })
      if (operation === 'secret.set' || operation === 'secret.remove') return JSON.stringify({ ok: true })
      return JSON.stringify({ ok: false, error: { message: `unsupported ${operation}` } })
    },
    invokeAsync() {},
  }
  const core = {
    roomId: room.id,
    start() {},
    getRoom: () => room,
    getView: () => ({ revision: 0 }),
    stories: () => [...stories.values()].map(story => ({ id: story.id, title: story.title, custom: true, mode: 'director' })),
    story: async id => stories.get(id),
    getProvider: () => ({ configured: false }),
    dispatchCommand: async () => {},
  }
  const context = {
    console,
    URL,
    Response,
    ReadableStream,
    TextEncoder,
    Event,
    MessageEvent,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    window: null,
  }
  context.window = context
  context.location = new URL('http://127.0.0.1/web/offline.html')
  context.fetch = async () => new Response('not found', { status: 404 })
  context.EventSource = class {}
  context.StageCraftNative = native
  context.StageCraftOfflineCore = core
  vm.runInNewContext(readFileSync(entryPath, 'utf8'), context, { filename: entryPath })
  return { context, stories }
}

test('local runtime web entry creates and saves private stories', async () => {
  const { context, stories } = createRuntime()
  const createdResponse = await context.fetch('/api/stories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '本地新剧本' }) })
  assert.equal(createdResponse.status, 200)
  const created = await createdResponse.json()
  assert.deepEqual(created, { ok: true, id: 'story-created', title: '本地新剧本' })
  assert.equal(stories.get('story-created').title, '本地新剧本')

  const story = { ...stories.get('story-created'), title: '已保存标题' }
  const savedResponse = await context.fetch('/api/story/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ story }) })
  assert.equal(savedResponse.status, 200)
  assert.equal((await savedResponse.json()).ok, true)
  assert.equal(stories.get('story-created').title, '已保存标题')

  const listResponse = await context.fetch('/api/stories')
  assert.equal(listResponse.status, 200)
  assert.equal((await listResponse.json())[0].id, 'story-created')
})

test('local runtime web entry exposes native story failures as HTTP errors', async () => {
  const { context } = createRuntime()
  context.StageCraftNative.invokeSync = () => JSON.stringify({ ok: false, error: { message: 'database write failed' } })
  const response = await context.fetch('/api/stories', { method: 'POST', body: JSON.stringify({ title: '失败剧本' }) })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'database write failed')
})
