/**
 * dsh-rp —— StageCraft 的 Cordis/dsh 适配壳（L2 蹭热度原型）。
 *
 * 把现有自包含应用（Store + RoomRuntime + ModelGateway + node:http 服务器，
 * 见 ../../src/app-boot.ts 的 startTavern()）包成一个 Cordis 插件：
 * dsh 用户可把它作为一个 profile bundle 装入 dsh，用 dsh 自己的插件/配置
 * 体系启动酒馆；核心类零改动。
 *
 * 设计取舍：
 * - inject = []：不依赖 dsh 任何服务（llm/session/web/…），自包含运行——
 *   热度照蹭、零耦合；将来要深集成 dsh 服务时再逐项加 inject。
 * - 只做装配与生命周期：apply 启动应用，返回 disposer 让 Cordis 在卸载时
 *   回收 HTTP 服务器与数据库（可逆约定）。
 * - 导出形态与官方 dsh 插件一致（命名导出 name/inject/apply，可再加
 *   Config = schemastery schema）。
 * - 原型限制：main 直接指向 TS 源码（Node 24 默认支持 type stripping，
 *   本仓库也用 --experimental-strip-types 运行）；发布到 npm 前应编译
 *   lib/（与每个 dsh-* 包一致）。root 按仓库布局解析，可用 RP_ROOT 覆盖。
 */
import { fileURLToPath } from 'node:url'
import { startTavern, type TavernApp } from '../../src/app-boot.ts'

/** Cordis 插件名（profile 行 id）。 */
export const name = 'rp'

/** 所需服务：无——自包含，不依赖 dsh 任何服务。 */
export const inject: string[] = []

/**
 * 启动酒馆应用。
 * @param ctx - 挂载作用域的 Context（仅用到 ctx.effect 注册可逆副作用）。
 */
export function apply(ctx: any): void {
  const root = process.env.RP_ROOT ?? fileURLToPath(new URL('../..', import.meta.url))
  // 默认 8799：避开独立酒馆（8787）与 dsh web GUI（8898）；可用 RP_PORT 覆盖。
  const port = Number(process.env.RP_PORT ?? 8799)
  ctx.effect(() => {
    const app: TavernApp = startTavern({ root, port })
    return () => {
      void app.close()
    }
  })
}
