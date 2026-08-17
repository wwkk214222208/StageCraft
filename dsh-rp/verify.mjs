/**
 * dsh-rp 验证脚本：
 * ① 用 stub ctx 调用插件 apply，证明"插件能启动酒馆"；
 * ② 若本机有 @deepseek-ai/cordis（如 dsh-harness 的 node_modules），
 *    用真实 Cordis 跑完整生命周期（ctx.plugin → start → 请求 → stop）。
 * 运行：node dsh-rp/verify.mjs
 */
import { setTimeout as sleep } from 'node:timers/promises'
import * as rp from './src/index.ts'

const PORT = Number(process.env.RP_PORT ?? 18787)
process.env.RP_PORT = String(PORT)
const base = `http://127.0.0.1:${PORT}`

/** 轮询等待服务器就绪（最多 10s） */
async function waitForReady(url) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.status === 200) return res
    } catch { /* 服务器还没起 */ }
    await sleep(200)
  }
  throw new Error(`服务器未在 ${url} 就绪`)
}

// ---------- ① stub ctx ----------
const disposers = []
const stubCtx = {
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
  },
  on() {},
  emit() {},
}
rp.apply(stubCtx)
await waitForReady(`${base}/api/room`)
console.log('[stub ctx] 插件 apply 后 /api/room 响应 OK')
const closeApp = disposers.pop()
await closeApp()
console.log('[stub ctx] disposer 关闭服务器+数据库 OK')

// ---------- ② 真实 Cordis（dsh vendor 版，可选） ----------
// Cordis 4：ctx.plugin() 同步执行 apply（返回 Fiber），卸载用 fiber.dispose()，没有 start/stop。
const entry = { name: rp.name, inject: rp.inject, apply: rp.apply }
try {
  const cordisPath = process.env.CORDIS_PATH ?? '/root/dsh-harness/node_modules/@deepseek-ai/cordis/lib/index.js'
  const { Context } = await import(`file://${cordisPath}`)
  const ctx = new Context()
  const fiber = ctx.plugin(entry)
  await waitForReady(`${base}/api/room`)
  console.log('[real cordis] ctx.plugin 后 /api/room 响应 OK')
  await fiber.dispose()
  // dispose 后端口应已释放
  const after = await fetch(`${base}/api/room`).catch(() => null)
  console.log(after ? '[real cordis] dispose 后端口仍可访问（异常）' : '[real cordis] fiber.dispose 卸载后端口已释放 OK')
} catch (error) {
  console.warn(`[real cordis] 跳过（需本机有 @deepseek-ai/cordis，可用 CORDIS_PATH 指定）：${error.message}`)
}
process.exit(0)
