import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startTavern } from '../src/app-boot.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

test('startTavern 启动自包含 HTTP 服务并响应 API 与静态资源', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rp-test-'))
  const saveRoot = mkdtempSync(join(tmpdir(), 'rp-save-test-'))
  // 禁止测试继承 providers.example.json 或环境中的真实 API 配置。
  writeFileSync(join(dataDir, 'providers.json'), JSON.stringify({ providers: [] }), 'utf8')
  const app = await startTavern({ root, dataDir, saveRoot, port: 0, host: '127.0.0.1' })
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

    // Core Command：通过统一协议修改房间配置，旧 API 仍保持独立可用
    const commandRes = await fetch(`${base}/api/core/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'command-test', actor: 'player', type: 'role-management', payload: { operation: 'set-room-config', mode: 'chat', autoPublish: false } }),
    })
    assert.equal(commandRes.status, 200)
    const commandResult = await commandRes.json() as { ok: boolean; view: { state: { room?: { mode?: string } } } }
    assert.equal(commandResult.ok, true)
    assert.equal(commandResult.view.state.room?.mode, 'chat')
    const beforeUnhandled = await (await fetch(`${base}/api/room`)).json() as { revision: number }
    const unhandledRes = await fetch(`${base}/api/core/commands`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'unhandled-command', actor: 'operator', type: 'submit-text', payload: { action: 'not-installed' } }),
    })
    assert.equal(unhandledRes.status, 400)
    const unhandled = await unhandledRes.json() as { error?: string }
    assert.equal(unhandled.error, 'Core command has no handler: submit-text')
    const afterUnhandled = await (await fetch(`${base}/api/room`)).json() as { revision: number }
    assert.equal(afterUnhandled.revision, beforeUnhandled.revision)

    const archive = await (await fetch(`${base}/api/archive/export`)).json()
    const archiveImport = await fetch(`${base}/api/archive/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(archive) })
    assert.equal(archiveImport.status, 200)
    const importedRoom = await (await fetch(`${base}/api/room`)).json() as { revision: number }
    const importedCore = await (await fetch(`${base}/api/core/view`)).json() as { revision: number }
    assert.equal(importedCore.revision, importedRoom.revision)
    const saveRes = await fetch(`${base}/api/archive/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'management-roundtrip' }) })
    assert.equal(saveRes.status, 200)
    const loadRes = await fetch(`${base}/api/archive/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'management-roundtrip' }) })
    assert.equal(loadRes.status, 200)
    const loadedRoom = await (await fetch(`${base}/api/room`)).json() as { revision: number }
    const loadedCore = await (await fetch(`${base}/api/core/view`)).json() as { revision: number }
    assert.equal(loadedCore.revision, loadedRoom.revision)

    // 兼容 HTTP chat 路由仍构造带 chat scope 的 Core command，实际由新群聊服务执行。
    const chatRoom = await (await fetch(`${base}/api/room`)).json() as { roles: Array<{ id: string }> }
    const speakRes = await fetch(`${base}/api/chat/speak`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roleId: chatRoom.roles[0].id }) })
    assert.equal(speakRes.status, 200)
    const spokenRoom = await (await fetch(`${base}/api/room`)).json() as { phase: string; speech?: { text?: string } }
    assert.equal(spokenRoom.phase, 'awaiting-approval')
    assert.ok(spokenRoom.speech?.text)
    const retryRes = await fetch(`${base}/api/chat/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(retryRes.status, 400)
    const retryError = await retryRes.json() as { error?: string }
    assert.equal(retryError.error, '没有可重试的发言。')

    // REST：剧本列表与使用量
    const storiesRes = await fetch(`${base}/api/stories`)
    assert.equal(storiesRes.status, 200)
    const stories = await storiesRes.json() as unknown[]
    assert.ok(Array.isArray(stories))

    // 计费：价格表读取/保存、/api/usage 携带累计统计、清空累计
    const billingRes = await fetch(`${base}/api/billing`)
    assert.equal(billingRes.status, 200)
    const billing = await billingRes.json() as { prices: { version: number; rates: Array<{ provider: string; model: string; inputPerMillion: number }> }; stats: { totalCost: number; requests: number } }
    assert.equal(billing.prices.version, 1)
    assert.equal(billing.stats.totalCost, 0)
    const pricePut = await fetch(`${base}/api/billing/prices`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, rates: [{ provider: '测试源', model: '测试模型', currency: 'RMB', inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 0.25 }] }) })
    assert.equal(pricePut.status, 200)
    const saved = await pricePut.json() as { prices: { rates: Array<{ provider: string; model: string; inputPerMillion: number }> }; stats: { requests: number } }
    assert.equal(saved.prices.rates.length, 1)
    assert.equal(saved.prices.rates[0].provider, '测试源')
    assert.equal(saved.prices.rates[0].model, '测试模型')
    assert.equal(saved.prices.rates[0].inputPerMillion, 1)
    assert.equal(saved.stats.requests, 0)
    const usageRes = await fetch(`${base}/api/usage`)
    assert.equal(usageRes.status, 200)
    const usage = await usageRes.json() as { billing?: { totalCost: number; requests: number } }
    assert.ok(usage.billing)
    assert.equal(typeof usage.billing.requests, 'number')
    const resetRes = await fetch(`${base}/api/billing/reset`, { method: 'POST' })
    assert.equal(resetRes.status, 200)
    const reset = await resetRes.json() as { totalCost: number; requests: number }
    assert.equal(reset.requests, 0)
    assert.equal(reset.totalCost, 0)

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
    rmSync(saveRoot, { recursive: true, force: true })
  }
})
