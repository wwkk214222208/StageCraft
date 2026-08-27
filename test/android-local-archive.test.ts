import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const entryPath = join(process.cwd(), 'android', 'app', 'src', 'main', 'assets', 'web', 'local-runtime-web-entry.js')

function runtime() {
  const archives = new Map()
  const room = { id: 'android-local-room', storyId: 'eldoria', title: 'Eldoria', mode: 'director' }
  const native = {
    invokeSync(operation, inputJson) {
      const input = JSON.parse(inputJson)
      if (operation === 'archive.save') { archives.set(input.name, { ...input.archive, name: input.name }); return JSON.stringify({ ok: true, name: input.name }) }
      if (operation === 'archive.list') return JSON.stringify({ files: [...archives.keys()] })
      if (operation === 'archive.load') return JSON.stringify(archives.get(input.name) ?? { error: { message: '存档不存在。' } })
      if (operation === 'archive.delete') { if (!archives.delete(input.name)) return JSON.stringify({ ok: false, error: { message: '存档不存在或已删除。' } }); return JSON.stringify({ ok: true, name: input.name }) }
      if (operation === 'stagecraft.repository') return JSON.stringify({ ok: true })
      if (operation === 'secret.get') return JSON.stringify({ found: false })
      if (operation === 'secret.set' || operation === 'secret.remove') return JSON.stringify({ ok: true })
      return JSON.stringify({ ok: false, error: { message: `unsupported ${operation}` } })
    },
    invokeAsync() {},
  }
  const core = { roomId: room.id, start() {}, getRoom: () => room, getView: () => ({ revision: 0 }), stories: () => [], getProvider: () => ({ configured: false }), dispatchCommand: async () => {}, refresh() {} }
  const context = { console, URL, Response, ReadableStream, TextEncoder, Event, MessageEvent, queueMicrotask, setTimeout, clearTimeout, window: null }
  context.window = context
  context.location = new URL('http://127.0.0.1/web/offline.html')
  context.fetch = async () => new Response('not found', { status: 404 })
  context.EventSource = class {}
  context.StageCraftNative = native
  context.StageCraftOfflineCore = core
  vm.runInNewContext(readFileSync(entryPath, 'utf8'), context, { filename: entryPath })
  return context
}

test('local runtime web entry persists and lists archives', async () => {
  const context = runtime()
  const saved = await context.fetch('/api/archive/save', { method: 'POST', body: JSON.stringify({ name: '测试存档' }) })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).name, '测试存档')
  const listed = await context.fetch('/api/archive/list')
  assert.deepEqual(await listed.json(), { files: ['测试存档'] })
  const loaded = await context.fetch('/api/archive/load', { method: 'POST', body: JSON.stringify({ name: '测试存档' }) })
  assert.equal(loaded.status, 200)
  const deleted = await context.fetch('/api/archive/delete', { method: 'POST', body: JSON.stringify({ name: '测试存档' }) })
  assert.equal(deleted.status, 200)
  assert.deepEqual(await (await context.fetch('/api/archive/list')).json(), { files: [] })
  const missing = await context.fetch('/api/archive/delete', { method: 'POST', body: JSON.stringify({ name: '测试存档' }) })
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).error, '存档不存在或已删除。')
})
