import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startTavern } from '../src/app-boot.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

test('startTavern 启动自包含 HTTP 服务并响应 API 与静态资源', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rp-test-'))
  const app = startTavern({ root, dataDir, port: 0, host: '127.0.0.1' })
  try {
    // 端口 0 = 系统分配，listen 完成前 address() 为 null，轮询等待
    const address = await new Promise<{ port: number }>((resolve, reject) => {
      const deadline = Date.now() + 5_000
      const tick = (): void => {
        const addr = app.server.address()
        if (addr && typeof addr === 'object') resolve(addr as { port: number })
        else if (Date.now() > deadline) reject(new Error('服务器未完成监听'))
        else setTimeout(tick, 10)
      }
      tick()
    })
    const base = `http://127.0.0.1:${address.port}`

    // REST：房间快照
    const roomRes = await fetch(`${base}/api/room`)
    assert.equal(roomRes.status, 200)
    const room = await roomRes.json() as { id: string; phase: string }
    assert.equal(typeof room.id, 'string')
    assert.ok(room.phase)

    // Core View：旧房间快照的统一状态投影
    const coreViewRes = await fetch(`${base}/api/core/view`)
    assert.equal(coreViewRes.status, 200)
    const coreView = await coreViewRes.json() as { protocolVersion: string; revision: number; state: { room?: { id?: string }; workflow?: { phase?: string } } }
    assert.equal(coreView.protocolVersion, '1.0')
    assert.equal(coreView.state.room?.id, room.id)
    assert.equal(coreView.state.workflow?.phase, room.phase)

    // REST：剧本列表与使用量
    const storiesRes = await fetch(`${base}/api/stories`)
    assert.equal(storiesRes.status, 200)
    const stories = await storiesRes.json() as unknown[]
    assert.ok(Array.isArray(stories))

    // 静态首页
    const indexRes = await fetch(`${base}/`)
    assert.equal(indexRes.status, 200)
    const html = await indexRes.text()
    assert.ok(html.toLowerCase().includes('<!doctype html>'))

    // SSE：订阅房间事件，读第一块（初始快照）后立即断开
    const abort = new AbortController()
    const sse = await fetch(`${base}/api/events`, { signal: abort.signal })
    assert.equal(sse.status, 200)
    const reader = sse.body!.getReader()
    const first = await reader.read()
    const chunk = new TextDecoder().decode(first.value)
    assert.ok(chunk.includes('event: room'))
    abort.abort()
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
