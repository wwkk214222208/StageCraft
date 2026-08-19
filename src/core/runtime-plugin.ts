import type { CoreRuntimePort } from './protocol.ts'
import type { CoreRuntimePlugin, Disposable } from './plugins.ts'

/** 将现有 CoreRuntimeSkeleton 作为可装配核心插件暴露给宿主。 */
export class CoreRuntimePluginAdapter implements CoreRuntimePlugin {
  readonly id = 'stagecraft.core'
  readonly runtime: CoreRuntimePort

  constructor(runtime: CoreRuntimePort) {
    this.runtime = runtime
  }

  install(): Disposable {
    return { dispose: () => {} }
  }
}
