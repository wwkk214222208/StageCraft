/**
 * The small Cordis composition root used by StageCraft.
 *
 * DSH supplies the scoped `@deepseek-ai/cordis` package at runtime.  The
 * package is a peer of the DSH bundle; the root application's dev dependency
 * is only an npm alias to the public Cordis 4.0.0-rc.7 build so this module can
 * be exercised locally without shipping a second Cordis instance.
 */
import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'

export type CordisContext = Context
export type CordisPlugin = Plugin
export type CordisFiber = Fiber

export interface CordisRuntime {
  readonly ctx: CordisContext
  install(plugin: CordisPlugin, config?: unknown): CordisFiber & PromiseLike<CordisFiber>
  dispose(): Promise<void>
}

/** Create the host Context. The caller owns the returned context and fibers. */
export function createCordisContext(): CordisContext {
  return new Context()
}

/** Install one Cordis plugin and return its lifecycle Fiber. */
export function installCordisPlugin(
  ctx: CordisContext,
  plugin: CordisPlugin,
  config?: unknown,
): CordisFiber & PromiseLike<CordisFiber> {
  return config === undefined ? ctx.plugin(plugin) : ctx.plugin(plugin, config)
}

/**
 * Create a lightweight runtime owner for standalone and test composition.
 * Cordis itself owns dependency waiting and Fiber cleanup; this owner only
 * remembers installed fibers so shutdown is deterministic and reverse-order.
 */
export function createCordisRuntime(): CordisRuntime {
  const ctx = createCordisContext()
  const fibers: CordisFiber[] = []
  let disposed = false

  return {
    ctx,
    install(plugin, config) {
      if (disposed) throw new Error('Cordis runtime is disposed.')
      const fiber = installCordisPlugin(ctx, plugin, config)
      fibers.push(fiber)
      return fiber
    },
    async dispose() {
      if (disposed) return
      disposed = true
      let firstError: unknown
      for (const fiber of [...fibers].reverse()) {
        try {
          await fiber.dispose()
        } catch (error) {
          firstError ??= error
        }
      }
      fibers.length = 0
      if (firstError) throw firstError
    },
  }
}
