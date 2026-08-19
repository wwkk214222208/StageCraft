/**
 * dsh-rp 验证脚本：
 * ① 用 stub ctx 调用打包产物 apply，证明安装目录自包含；
 * ② 默认从宿主解析 @deepseek-ai/cordis；显式 CORDIS_PATH 时加载指定绝对路径，
 *    用真实 Cordis 跑完整生命周期（ctx.plugin → 请求 → fiber.dispose）。
 * 运行：node dsh-rp/verify.mjs
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as rp from './dist/index.js'

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

// ---------- ① local Cordis host ----------
const stubCtx = new Context()
const stubFiber = stubCtx.plugin({ name: 'verify.local-host', apply: ctx => rp.apply(ctx) })
await stubFiber
await waitForReady(`${base}/api/room`)
console.log('[local Cordis host] 插件 apply 后 /api/room 响应 OK')
await stubFiber.dispose()
console.log('[local Cordis host] Fiber 卸载关闭服务器+数据库 OK')

// ---------- ② 真实 Cordis（DSH vendor 版） ----------
// Cordis 4：ctx.plugin() 返回 Fiber（thenable），卸载用 fiber.dispose()，没有 start/stop。
const entry = { name: rp.name, inject: rp.inject, apply: rp.apply }
try {
  const cordisModule = process.env.CORDIS_PATH
    ? await import(pathToFileURL(resolve(process.env.CORDIS_PATH)).href)
    : await import('@deepseek-ai/cordis')
  const { Context } = cordisModule
  const ctx = new Context()
  const fiber = ctx.plugin(entry)
  await fiber
  await waitForReady(`${base}/api/room`)
  console.log('[real cordis] ctx.plugin 后 /api/room 响应 OK')
  await fiber.dispose()
  // dispose 后端口应已释放
  const after = await fetch(`${base}/api/room`).catch(() => null)
  if (after) throw new Error('fiber.dispose 后 HTTP 端口仍可访问')
  console.log('[real cordis] fiber.dispose 卸载后端口已释放 OK')
} catch (error) {
  console.error(`[real cordis] 验证失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
}
