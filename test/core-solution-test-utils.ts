import { DefaultCorePluginContainer } from '../src/core/container.ts'
import { StageCraftSolutionPlugin } from '../src/core/solutions.ts'
import type { CoreRuntimeSkeleton } from '../src/core/runtime.ts'

/** 需要 StageCraft workflow 的测试显式安装方案，避免 Core 构造器偷偷带入玩法。 */
export function installStageCraftSolution(core: CoreRuntimeSkeleton): DefaultCorePluginContainer {
  const container = new DefaultCorePluginContainer(core)
  container.addSolution(new StageCraftSolutionPlugin())
  return container
}
