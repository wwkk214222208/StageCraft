/**
 * dsh-rp 验证脚本：
 * ① 用 stub ctx 调用打包产物 apply，证明安装目录自包含；
 * ② 默认从宿主解析 @deepseek-ai/cordis；显式 CORDIS_PATH 时加载指定绝对路径，
 *    用真实 Cordis 跑完整生命周期（ctx.plugin → 请求 → fiber.dispose）。
 * 运行：node dsh-rp/verify.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = join(repositoryRoot, 'dsh-rp')
const distRoot = join(packageRoot, 'dist')

// Always verify the artifact that would be installed, including dist/worker.js.
execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: packageRoot, stdio: 'inherit' })
if (!existsSync(join(distRoot, 'worker.js'))) throw new Error('dsh-rp build did not produce dist/worker.js')
const rp = await import(pathToFileURL(join(distRoot, 'index.js')).href + `?verify=${Date.now()}`)

const PORT = Number(process.env.RP_PORT ?? 18787)
process.env.RP_PORT = String(PORT)
const base = `http://127.0.0.1:${PORT}`
const deadline = 5_000

async function bounded(promise, label, timeoutMs = deadline) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs) })
  try { return await Promise.race([promise, timeout]) } finally { clearTimeout(timer) }
}

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

// ---------- ③ real sandbox worker contract ----------
const sandboxCtx = new Context()
const sandboxFiber = sandboxCtx.plugin({ name: rp.name, inject: rp.inject, apply: rp.apply }, {
  runtimeMode: 'sandboxed',
  root: distRoot,
})
const streamFrames = []
try {
  await bounded(sandboxFiber, 'sandbox Cordis plugin startup')
  const debug = sandboxCtx.stagecraftDebug
  if (!debug || debug.mode !== 'sandboxed') throw new Error('sandboxed plugin did not provide ctx.stagecraftDebug')
  const unsubscribe = debug.subscribe(['worker.status', 'core.view'], envelope => streamFrames.push(envelope))
  const status = await bounded(debug.request('worker.status', {}), 'worker.status request')
  if (status.status !== 'running') throw new Error(`worker.status was ${status.status}`)
  const view = await bounded(debug.request('core.view.get', {}), 'core.view.get request')
  if (!view || typeof view.revision !== 'number') throw new Error('core.view.get returned no bounded core view')
  const subscribed = await bounded(debug.request('debug.subscribe', { streams: ['worker.status', 'core.view'] }), 'debug.subscribe request')
  if (!subscribed.subscribed) throw new Error('debug.subscribe was not acknowledged')
  await bounded(debug.request('debug.flush', {}), 'debug request')
  await bounded(debug.recover('stream contract'), 'debug worker recover')
  if (streamFrames.length === 0) throw new Error('sandbox worker emitted no debug/status stream frames')
  console.log('[sandbox cordis] handshake/status/core.view/debug stream OK')

  const stopped = await bounded(debug.stop('contract graceful stop'), 'worker stop')
  if (stopped.status !== 'stopped') throw new Error(`worker.stop did not stop worker: ${stopped.status}`)
  const restarted = await bounded(debug.restart('contract restart'), 'worker restart')
  if (restarted.status !== 'running' || restarted.generation < 2) throw new Error('worker restart did not create a new running generation')
  const afterRestart = await bounded(debug.request('worker.status', {}), 'post-restart worker.status')
  if (afterRestart.status !== 'running') throw new Error('worker unavailable after restart')
  unsubscribe()

  // A worker lifecycle must not invalidate the host Context or its plugin registry.
  const probe = sandboxCtx.plugin({ name: 'sandbox.context.probe', apply() {} })
  await bounded(probe, 'host Context probe plugin')
  await bounded(probe.dispose(), 'host Context probe disposal')
  console.log('[sandbox cordis] stop/restart preserved host Context usability')
} finally {
  await bounded(sandboxFiber.dispose(), 'sandbox Cordis plugin disposal').catch(error => console.error(`[sandbox cordis] cleanup: ${error.message}`))
}
