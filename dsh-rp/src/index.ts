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
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { startTavern, type TavernApp } from '../../src/app-boot.ts'
import { WorkerManager, type WorkerManagerSnapshot } from '../../src/debug/worker-manager.ts'
import type { DebugRpcMethod, DebugRpcParams, DebugRpcResults, DebugStream, DebugStreamEnvelope } from '../../src/debug/sandbox-protocol.ts'

/** Cordis 插件名（profile 行 id）。 */
export const name = 'rp'

/** 所需服务：无——自包含，不依赖 dsh 任何服务。 */
export const inject: string[] = []

export type RuntimeMode = 'embedded' | 'sandboxed'

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
  /** Enable development-only bearer-authenticated LAN access (TLS is external). */
  remoteEnabled?: boolean
  /** One-time pairing code lifetime in milliseconds. */
  remotePairingTtlMs?: number
  /** Bearer session lifetime in milliseconds. */
  remoteSessionTtlMs?: number
}

export const Config = z.object({
  runtimeMode: z.union([z.const('embedded'), z.const('sandboxed')]),
  port: z.natural().max(65535),
  host: z.string(),
  root: z.string(),
  remoteEnabled: z.boolean(),
  remotePairingTtlMs: z.natural(),
  remoteSessionTtlMs: z.natural(),
})

/**
 * 启动酒馆应用。
 * @param ctx - 挂载作用域的 Context（仅用到 ctx.effect 注册可逆副作用）。
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const packageRoot = dirname(fileURLToPath(import.meta.url))
  const sourceRoot = fileURLToPath(new URL('../..', import.meta.url))
  const defaultRoot = packageRoot.endsWith('/dist') || packageRoot.endsWith('\\dist') ? packageRoot : sourceRoot
  const root = config.root || process.env.RP_ROOT || defaultRoot
  const runtimeMode = config.runtimeMode ?? 'embedded'
  const port = config.port ?? Number(process.env.RP_PORT ?? 8799)
  const host = config.host || process.env.HOST || '127.0.0.1'
  const manager = runtimeMode === 'sandboxed' ? new WorkerManager({
    command: process.execPath,
    args: [workerEntryPath(packageRoot)],
    cwd: packageRoot,
    env: { STAGECRAFT_ROOT: root, RP_PORT: String(port), HOST: host },
    onLog: line => console.error(`[stagecraft.worker] ${line}`),
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
    const cleanups: Array<() => void> = []
    if (manager) await manager.start()
    else {
      // Embedded mode remains the self-contained development path.
      const app: TavernApp = await startTavern({ root, port, host, ctx, remoteAccess: { enabled: config.remoteEnabled === true, pairingTtlMs: config.remotePairingTtlMs, sessionTtlMs: config.remoteSessionTtlMs } })
      cleanups.push(() => void app.close())
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
            const snapshot = await debug.restart(reason)
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
    return () => { for (const cleanup of cleanups.reverse()) cleanup() }
  })
}

function workerEntryPath(packageRoot: string): string {
  return `${packageRoot}/worker.js`
}
