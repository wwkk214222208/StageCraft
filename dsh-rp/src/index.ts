/**
 * dsh-rp —— StageCraft 的 Cordis/DSH bundle 入口。
 *
 * 把现有自包含应用（Store + RoomRuntime + ModelGateway + node:http 服务器，
 * 见 app-boot.ts 的 startTavern()）包成一个 Cordis 插件。打包产物会将这份
 * 业务实现编译进 dist/index.js，安装时不依赖仓库布局或 TypeScript 源码。
 *
 * 设计取舍：
 * - inject = []：不依赖 dsh 任何服务（llm/session/web/…），自包含运行——
 *   热度照蹭、零耦合；将来要深集成 dsh 服务时再逐项加 inject。
 * - 只做装配与生命周期：apply 启动应用，返回 disposer 让 Cordis 在卸载时
 *   回收 HTTP 服务器与数据库（可逆约定）。
 * - 导出形态与官方 dsh 插件一致（命名导出 name/inject/apply，可再加
 *   Config = schemastery schema）。
 * - root 默认指向打包产物的 dist/，可用 DSH Config 或 RP_ROOT 覆盖。
 */
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { cpSync, existsSync, watch, type FSWatcher } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { startTavern, type TavernApp } from '../../src/app-boot.ts'
import { WorkerManager, type WorkerManagerSnapshot } from '../../src/debug/worker-manager.ts'
import type { DebugRpcMethod, DebugRpcParams, DebugRpcResults, DebugStream, DebugStreamEnvelope, HostRpcRequest } from '../../src/debug/sandbox-protocol.ts'

/** Cordis 插件名（profile 行 id）。 */
export const name = 'rp'

/** 所需服务：无——自包含，不依赖 dsh 任何服务。 */
export const inject: string[] = []

export type RuntimeMode = 'development' | 'embedded' | 'sandboxed'

export interface StageCraftDebugService {
  readonly mode: RuntimeMode
  status(): WorkerManagerSnapshot | { status: 'embedded' }
  start(): Promise<WorkerManagerSnapshot>
  stop(reason?: string): Promise<WorkerManagerSnapshot>
  kill(reason?: string): Promise<WorkerManagerSnapshot>
  restart(reason?: string): Promise<WorkerManagerSnapshot>
  recover(reason?: string): Promise<WorkerManagerSnapshot>
  request<M extends DebugRpcMethod>(method: M, params: DebugRpcParams[M], timeoutMs?: number, signal?: AbortSignal): Promise<DebugRpcResults[M]>
  subscribe(streams: readonly DebugStream[], listener: (envelope: DebugStreamEnvelope) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    stagecraftDebug: StageCraftDebugService
  }
}

export interface Config {
  /** Runtime isolation; embedded is the development-compatible default. */
  runtimeMode?: RuntimeMode
  /** HTTP port; omitted uses RP_PORT or the DSH-safe default 8799. */
  port?: number
  /** Bind address; omitted uses HOST or 127.0.0.1. */
  host?: string
  /** Bundle data/resource root; omitted uses RP_ROOT or this package's root. */
  root?: string
  /** 用户数据根（AppData 等）；省略时默认 <AppData>/stagecraft。 */
  userDataRoot?: string
  /** Enable development-only bearer-authenticated LAN access (TLS is external). */
  remoteEnabled?: boolean
  /** Local character-tavern repository root used by development mode watcher. */
  syncRepository?: string
  /** Development watcher debounce in milliseconds. */
  watchDebounceMs?: number
  /** Rebuild from syncRepository before plugin startup. */
  syncOnStart?: boolean
  /** Rebuild from syncRepository before /stagecraft-reload and reload commands. */
  syncOnReload?: boolean
  /** One-time pairing code lifetime in milliseconds. */
  remotePairingTtlMs?: number
  /** Bearer session lifetime in milliseconds. */
  remoteSessionTtlMs?: number
}

export const Config = z.object({
  runtimeMode: z.union([z.const('development'), z.const('embedded'), z.const('sandboxed')]),
  port: z.natural().max(65535),
  host: z.string(),
  root: z.string(),
  userDataRoot: z.string(),
  remoteEnabled: z.boolean(),
  syncRepository: z.string(),
  watchDebounceMs: z.natural(),
  syncOnStart: z.boolean(),
  syncOnReload: z.boolean(),
  remotePairingTtlMs: z.natural(),
  remoteSessionTtlMs: z.natural(),
})

/**
 * 启动酒馆应用。
 * @param ctx - 挂载作用域的 Context（仅用到 ctx.effect 注册可逆副作用）。
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const packageRoot = dirname(fileURLToPath(import.meta.url))
  const syncRepository = config.syncRepository || process.env.STAGECRAFT_SYNC_REPOSITORY || ''
  const watchDebounceMs = config.watchDebounceMs ?? 700
  const syncOnStart = config.syncOnStart ?? Boolean(syncRepository)
  const syncOnReload = config.syncOnReload ?? Boolean(syncRepository)
  const sync = (): void => {
    if (!syncRepository) return
    const repositoryRoot = resolve(syncRepository)
    const buildScript = join(repositoryRoot, 'dsh-rp', 'scripts', 'build.mjs')
    if (!existsSync(buildScript)) throw new Error(`StageCraft sync repository is missing dsh-rp/scripts/build.mjs: ${repositoryRoot}`)
    console.log(`[dsh-rp] syncing local repository: ${repositoryRoot}`)
    execFileSync(process.execPath, [buildScript], { cwd: join(repositoryRoot, 'dsh-rp'), stdio: 'inherit', env: { ...process.env, SOURCE_REPOSITORY_URL: process.env.SOURCE_REPOSITORY_URL ?? 'local-development' } })
    const builtRoot = join(repositoryRoot, 'dsh-rp', 'dist')
    const installRoot = packageRoot.endsWith('/dist') || packageRoot.endsWith('\\dist') ? packageRoot : join(packageRoot, '..', 'dist')
    if (resolve(builtRoot) !== resolve(installRoot)) cpSync(builtRoot, installRoot, { recursive: true, force: true })
  }
  if (syncOnStart) sync()
  const sourceRoot = fileURLToPath(new URL('../..', import.meta.url))
  const defaultRoot = packageRoot.endsWith('/dist') || packageRoot.endsWith('\\dist') ? packageRoot : sourceRoot
  const root = config.root || process.env.RP_ROOT || defaultRoot
  const runtimeMode = config.runtimeMode ?? 'embedded'
  const developmentMode = runtimeMode === 'development'
  const port = config.port ?? Number(process.env.RP_PORT ?? 8799)
  const host = config.host || process.env.HOST || '127.0.0.1'
  // 用户数据根：插件模式固定放在 AppData（卸载重装不丢存档/进度/供应商配置）。
  // Windows %APPDATA%\stagecraft；macOS/Linux ~/.config/stagecraft（XDG）。
  const userDataRoot = config.userDataRoot || process.env.STAGECRAFT_USER_DATA || (() => {
    const base = process.env.APPDATA || (process.platform === 'darwin' ? join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'))
    return join(base, 'stagecraft')
  })()
  if (developmentMode && !syncRepository) throw new Error('development runtimeMode requires syncRepository.')
  const hostRpc = async (request: HostRpcRequest): Promise<unknown> => { const apiProxy = (ctx as any).get?.('apiProxy', false); const sessions = apiProxy?.sessions; const workspace = apiProxy?.workspace; const target = request.method.startsWith('sessions.') ? sessions : workspace; const method = request.method.replace(/^[^.]+\./, ''); if (!target?.[method]) throw new Error(`DSH 宿主未提供 ${request.method}。`); return target[method](request.params) }
  const manager = runtimeMode === 'sandboxed' ? new WorkerManager({
    command: process.execPath,
    args: [workerEntryPath(packageRoot)],
    cwd: packageRoot,
    env: { STAGECRAFT_ROOT: root, STAGECRAFT_USER_DATA: userDataRoot, RP_PORT: String(port), HOST: host },
    onLog: line => console.error(`[stagecraft.worker] ${line}`),
    onHostRequest: hostRpc,
  }) : undefined
  const debug: StageCraftDebugService = manager
    ? {
        mode: runtimeMode,
        status: () => manager.getStatus(),
        start: () => manager.start(),
        stop: reason => manager.stop(reason),
        kill: reason => manager.kill(reason),
        restart: reason => manager.restart(reason),
        recover: reason => manager.recover(reason),
        request: (method, params, timeoutMs, signal) => manager.request(method, params, timeoutMs, signal),
        subscribe: (streams, listener) => manager.subscribe(streams, listener),
      }
    : {
        mode: runtimeMode,
        status: () => ({ status: 'embedded' as const }),
        start: async () => { throw new Error('StageCraft sandbox is disabled in embedded runtime mode.') },
        stop: async () => { throw new Error('StageCraft sandbox is disabled in embedded runtime mode.') },
        kill: async () => { throw new Error('StageCraft sandbox is disabled in embedded runtime mode.') },
        restart: async () => { throw new Error('StageCraft sandbox is disabled in embedded runtime mode.') },
        recover: async () => { throw new Error('StageCraft sandbox is disabled in embedded runtime mode.') },
        request: async () => { throw new Error('StageCraft sandbox is disabled in embedded runtime mode.') },
        subscribe: () => () => {},
      }
  await ctx.effect(async () => {
    ctx.provide('stagecraftDebug', debug)
    // Cordis accepts async disposers. Keeping the promise here is essential:
    // TavernApp.close() must finish SQLite/LLM state writes before the bundle
    // installation root is removed by a package/reload operation.
    const cleanups: Array<() => void | Promise<void>> = []
    let embeddedApp: TavernApp | undefined
    let embeddedGeneration = 0
    let restarting = Promise.resolve()
    const startEmbedded = async (): Promise<void> => { embeddedApp = await startTavern({ root, userDataRoot, port, host, ctx, remoteAccess: { enabled: config.remoteEnabled === true, pairingTtlMs: config.remotePairingTtlMs, sessionTtlMs: config.remoteSessionTtlMs } }) }
    const restartEmbedded = async (reason: string): Promise<{ status: 'embedded'; reason: string }> => {
      restarting = restarting.then(async () => { await embeddedApp?.close(); await startEmbedded() })
      await restarting
      embeddedGeneration += 1
      return { status: 'embedded', mode: 'embedded' as const, generation: embeddedGeneration, reason }
    }
    if (manager) await manager.start()
    else { await startEmbedded(); cleanups.push(async () => { await embeddedApp?.close() }) }
    if (developmentMode) {
      const repositoryRoot = resolve(syncRepository)
      const watchedPaths = [join(repositoryRoot, 'src'), join(repositoryRoot, 'public'), join(repositoryRoot, 'dsh-rp', 'src'), join(repositoryRoot, 'dsh-rp', 'scripts')].filter(path => existsSync(path))
      const watchers: FSWatcher[] = []
      let timer: NodeJS.Timeout | undefined
      const scheduleSync = (): void => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => { void (async () => { try { sync(); await restartEmbedded('development-file-change'); console.log('[dsh-rp] development change synced and restarted') } catch (error) { console.error(`[dsh-rp] development sync failed: ${error instanceof Error ? error.message : String(error)}`) } })() }, watchDebounceMs)
      }
      for (const path of watchedPaths) watchers.push(watch(path, { recursive: true }, scheduleSync))
      console.log(`[dsh-rp] development watcher enabled for ${watchedPaths.join(', ')}`)
      cleanups.push(() => { if (timer) clearTimeout(timer); for (const watcher of watchers) watcher.close() })
    }
    // 独立控制端点：POST /api/stagecraft/reload —— 重建 worker（或 embedded 下重启应用）。
    // 挂在 DSH 主进程 webServer 上（sandboxed 时 8899），供构建脚本 / dsh 命令触发。
    // 可选注入：profile 未声明 inject 时 ctx.get('webServer', false) 返回 undefined，不注册路由。
    const webServer = (ctx as unknown as { get?: (name: string, loose?: boolean) => unknown }).get?.('webServer', false) as { register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void> }) => () => void } | undefined
    if (webServer?.register) {
      const disposer = webServer.register({
        kind: 'exact',
        path: '/api/stagecraft/reload',
        handler: async (req, res) => {
          try {
            let reason = 'http-reload'
            if (req.method === 'POST') {
              const chunks: Buffer[] = []
              for await (const chunk of req) chunks.push(chunk as Buffer)
              const body = Buffer.concat(chunks).toString('utf8').trim()
              if (body) { try { reason = JSON.parse(body).reason ?? reason } catch { /* keep default */ } }
            }
            if (syncOnReload) sync()
            const snapshot = developmentMode ? await restartEmbedded(reason) : await debug.restart(reason)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, ...snapshot }))
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          }
        },
      })
      cleanups.push(disposer)
    }
    // DSH slash 命令：/stagecraft-reload —— 在会话里直接触发 worker 热重载。
    // 可选注入：commands 服务未挂载时跳过（headless 等 profile 无 UI 命令面）。
    const commands = (ctx as unknown as { get?: (name: string, loose?: boolean) => unknown }).get?.('commands', false) as { register: (definition: { name: string; description: string; handler: (invocation: { rawInput: string; signal: AbortSignal }) => Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }> }) => () => void } | undefined
    if (commands?.register) {
      const disposer = commands.register({
        name: 'stagecraft-reload',
        description: '重载 StageCraft（不重启 DSH）；sandboxed 重启 worker，embedded 重建内嵌应用并加载最新构建',
        handler: async invocation => {
          try {
            const reason = invocation.rawInput.trim() || 'slash-command'
            if (syncOnReload) sync()
            const snapshot = developmentMode ? await restartEmbedded(reason) : await debug.restart(reason)
            return { kind: 'success', text: snapshot.status === 'embedded' ? `StageCraft 已重载：第 ${snapshot.generation} 次内嵌重建（embedded）` : `StageCraft 已重载：generation ${snapshot.generation}，pid ${snapshot.pid ?? '?'}（${snapshot.status}）` }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      })
      cleanups.push(disposer)
    }
    // DSH slash 命令：/stagecraft —— 在系统默认浏览器打开 StageCraft 页面。
    const openPage = async (): Promise<void> => {
      const url = `http://${host}:${port}/`
      if (process.platform === 'win32') {
        const { execFile } = await import('node:child_process')
        await new Promise<void>((resolve, reject) => {
          execFile('cmd', ['/c', 'start', '', url], error => error ? reject(error) : resolve())
        })
      } else if (process.platform === 'darwin') {
        const { execFile } = await import('node:child_process')
        await new Promise<void>((resolve, reject) => {
          execFile('open', [url], error => error ? reject(error) : resolve())
        })
      } else {
        const { execFile } = await import('node:child_process')
        await new Promise<void>((resolve, reject) => {
          execFile('xdg-open', [url], error => error ? reject(error) : resolve())
        })
      }
    }
    if (commands?.register) {
      const disposer = commands.register({
        name: 'stagecraft',
        description: `在系统默认浏览器打开 StageCraft（http://${host}:${port}/）`,
        handler: async () => {
          try {
            await openPage()
            return { kind: 'success', text: `已在默认浏览器打开 StageCraft：http://${host}:${port}/` }
          } catch (error) {
            return { kind: 'error', text: `打开页面失败：${error instanceof Error ? error.message : String(error)}（直接访问 http://${host}:${port}/）` }
          }
        },
      })
      cleanups.push(disposer)
    }
    return async () => {
      const errors: unknown[] = []
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup() } catch (error) { errors.push(error) }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'one or more dsh-rp cleanup operations failed')
    }
  })
}

function workerEntryPath(packageRoot: string): string {
  return `${packageRoot}/worker.js`
}
