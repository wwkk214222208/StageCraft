import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { StageCraftSolutionPlugin } from '../src/core/solutions.ts'
import { LegacyRuntimeSolutionPlugin } from '../src/core/command-adapter.ts'
import type { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import type { RoomRuntime } from '../src/room-runtime.ts'
import type { Disposable } from '../src/core/plugins.ts'

/** 需要 StageCraft workflow 的测试显式安装方案，避免 Core 构造器偷偷带入玩法。 */
export function installStageCraftSolution(core: CoreRuntimeSkeleton): DefaultCorePluginContainer {
  const container = new DefaultCorePluginContainer(core)
  container.addSolution(new StageCraftSolutionPlugin())
  return container
}

/** 旧 facade 仅作为测试/外部兼容插件显式安装。 */
export function installLegacyRuntimeSolution(container: DefaultCorePluginContainer, runtime: RoomRuntime, defaultRoomId: string): Disposable {
  return container.addSolution(new LegacyRuntimeSolutionPlugin({ runtime, defaultRoomId }))
}
