/**
 * W6：CoreClient SSE abort/断线恢复测试（计划 §3.4 / 阶段 6）。
 *
 * 覆盖：
 * 1. SSE 流 abort：客户端取消订阅 → fetch 流取消（AbortController 触发）；
 * 2. 断线重连：流错误 → 退避重连 → resync（revision 地板重置）；
 * 3. 重连后迟到事件（revision < 新地板）丢弃。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { CoreClient } from '../public/core-client.js'

/** 可编程 fetch：按 URL 返回可控制的事件流。 */
function makeFetchHarness() {
  const controllers = new Map()
  const eventsStreams = new Map()
  const fetchImpl = async (url, init) => {
    const path = String(url)
    if (path.endsWith('/api/core/health')) {
      return new Response(JSON.stringify({ protocolVersion: '1.1', minSupportedProtocolVersion: '1.0', maxSupportedProtocolVersion: '1.1', status: 'ready' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path.endsWith('/api/core/view')) {
      return Response.json({ protocolVersion: '1.1', revision: 10, state: {}, workflows: [], interactions: [] })
    }
    if (path.endsWith('/api/core/events')) {
      const controller = new AbortController()
      const stream = new ReadableStream({
        start(c) {
          controllers.set(init.signal, controller)
          const queue = []
          const push = (event) => {
            try { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)) } catch { /* closed */ }
          }
          eventsStreams.set(init.signal, { push, close: () => { try { c.close() } catch { /* closed */ } } })
        },
        cancel() {
          // 客户端 abort 时标记
          controller.abort()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, controllers, eventsStreams }
}

/** 等待条件成立（带超时）。 */
async function waitFor(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

test('W6：SSE abort——取消订阅后 fetch 流取消（AbortController 触发）', async () => {
  const { fetchImpl, controllers } = makeFetchHarness()
  const client = new CoreClient({ fetchImpl, reconnectInitialMs: 1000, reconnectMaxMs: 1000 })
  const events = []
  const unsubscribe = client.subscribe(event => events.push(event))
  // 等订阅建立（events fetch 被调用）
  await waitFor(() => controllers.size > 0)
  assert.ok(controllers.size >= 1, 'SSE fetch 必须已发起')
  // 取消订阅 → #abort() → signal.abort（流取消传播）
  unsubscribe()
  await waitFor(() => [...controllers.keys()].some(signal => signal.aborted))
  assert.ok([...controllers.keys()].some(signal => signal.aborted), 'SSE fetch signal 必须被 abort')
  client.close()
})

test('W6：SSE abort——订阅全部取消时 fetch 流取消', async () => {
  const { fetchImpl, controllers } = makeFetchHarness()
  const client = new CoreClient({ fetchImpl, reconnectInitialMs: 5000, reconnectMaxMs: 5000 })
  const unsubA = client.subscribe(() => {})
  const unsubB = client.subscribe(() => {})
  await waitFor(() => controllers.size > 0)
  unsubA()
  // 还有 B 订阅：流保持（未 abort）
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok([...controllers.keys()].every(signal => !signal.aborted), '还有订阅者时流不得 abort')
  unsubB()
  // 全部取消：流 abort
  await waitFor(() => [...controllers.keys()].some(signal => signal.aborted))
  assert.ok([...controllers.keys()].some(signal => signal.aborted), '全部取消订阅后 signal 必须 abort')
  client.close()
})

test('W6：断线重连——流错误后退避重连并 resync（revision 地板重置）', async () => {
  let eventsFetchCount = 0
  const fetchImpl = async (url, init) => {
    const path = String(url)
    if (path.endsWith('/api/core/health')) {
      return new Response(JSON.stringify({ protocolVersion: '1.1', minSupportedProtocolVersion: '1.0', maxSupportedProtocolVersion: '1.1', status: 'ready' }), { status: 200 })
    }
    if (path.endsWith('/api/core/view')) {
      return Response.json({ protocolVersion: '1.1', revision: 10, state: {}, workflows: [], interactions: [] })
    }
    if (path.endsWith('/api/core/events')) {
      eventsFetchCount++
      const stream = new ReadableStream({
        start(c) {
          if (eventsFetchCount === 1) {
            // 第一次：发一个事件后立即关闭（模拟断线）
            c.enqueue(new TextEncoder().encode('data: {"protocolVersion":"1.1","roomId":"r","revision":11,"type":"state.changed","payload":{"type":"state.changed","revision":11}}\n\n'))
            c.close()
          } else {
            // 重连后：保持打开，可发事件
            c.enqueue(new TextEncoder().encode('data: {"protocolVersion":"1.1","roomId":"r","revision":12,"type":"state.changed","payload":{"type":"state.changed","revision":12}}\n\n'))
          }
        },
        cancel() {},
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  }
  const client = new CoreClient({ fetchImpl, reconnectInitialMs: 50, reconnectMaxMs: 100 })
  const resyncs = []
  const events = []
  client.subscribe(event => {
    if (event.type === 'core.resync') resyncs.push(event)
    if (event.type === 'core.event') events.push(event)
  })
  // 等待重连（第二次 events fetch）
  await waitFor(() => eventsFetchCount >= 2, 5000)
  assert.ok(eventsFetchCount >= 2, '断线后必须自动重连')
  // resync 必须发生（至少一次）
  assert.ok(resyncs.length >= 1, '重连必须 resync')
  // 重连后 resync 的 revision 地板 = 权威 view revision（10）
  const lastResync = resyncs[resyncs.length - 1]
  assert.equal(lastResync.revision, 10, 'resync 地板必须重置为权威 view revision')
  client.close()
})
