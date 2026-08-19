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

/** Cordis 插件名（profile 行 id）。 */
export const name = 'rp'

/** 所需服务：无——自包含，不依赖 dsh 任何服务。 */
export const inject: string[] = []

export interface Config {
  /** HTTP port; omitted uses RP_PORT or the DSH-safe default 8799. */
  port?: number
  /** Bind address; omitted uses HOST or 127.0.0.1. */
  host?: string
  /** Bundle data/resource root; omitted uses RP_ROOT or this package's root. */
  root?: string
}

export const Config = z.object({
  port: z.natural().max(65535),
  host: z.string(),
  root: z.string(),
})

/**
 * 启动酒馆应用。
 * @param ctx - 挂载作用域的 Context（仅用到 ctx.effect 注册可逆副作用）。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const packageRoot = dirname(fileURLToPath(import.meta.url))
  const sourceRoot = fileURLToPath(new URL('../..', import.meta.url))
  const defaultRoot = packageRoot.endsWith('/dist') || packageRoot.endsWith('\\dist') ? packageRoot : sourceRoot
  const root = config.root || process.env.RP_ROOT || defaultRoot
  // 默认 8799：避开独立酒馆（8787）与 dsh web GUI（8898）；可用 RP_PORT 覆盖。
  const port = config.port ?? Number(process.env.RP_PORT ?? 8799)
  const host = config.host || process.env.HOST || '127.0.0.1'
  ctx.effect(() => {
    const app: TavernApp = startTavern({ root, port, host })
    return () => app.close()
  })
}
