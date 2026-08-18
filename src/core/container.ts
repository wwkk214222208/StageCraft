import type { CoreEvent, CoreEventListener, CoreRuntimePort } from './protocol.ts'
import type { CoreLlmRouterPlugin, CorePluginContainer, Disposable, HumanCoreInteractionPlugin } from './plugins.ts'

/**
 * 无框架装配容器。
 *
 * 独立 HTTP 入口、Cordis 入口和测试入口都可以使用同一个容器；具体宿主只负责
 * 创建/释放 adapter，不把宿主依赖带进 core runtime。
 */
export class DefaultCorePluginContainer implements CorePluginContainer {
  readonly human: HumanCoreInteractionPlugin[] = []
  readonly llm: CoreLlmRouterPlugin[] = []

  constructor(readonly core: CoreRuntimePort) {}

  addHuman(plugin: HumanCoreInteractionPlugin): Disposable {
    this.human.push(plugin)
    const installed = plugin.install(this.core)
    const container = this
    return {
      async dispose() {
        await installed.dispose()
        const index = container.human.indexOf(plugin)
        if (index >= 0) container.human.splice(index, 1)
      },
    }
  }

  addLlm(plugin: CoreLlmRouterPlugin): Disposable {
    // LLM adapter 的 host 只暴露 ModelResult 回传口；CoreRuntimePort 已提供该能力。
    const host = {
      submitModelResult: (result: Parameters<CoreRuntimePort['submitModelResult']>[0]) => this.core.submitModelResult(result),
      publishModelEvent: (event: CoreEvent) => this.emit(event),
    }
    this.llm.push(plugin)
    const installed = plugin.install(host)
    const container = this
    return {
      async dispose() {
        await installed.dispose()
        const index = container.llm.indexOf(plugin)
        if (index >= 0) container.llm.splice(index, 1)
      },
    }
  }

  subscribe(listener: CoreEventListener): Disposable {
    const dispose = this.core.subscribe(listener)
    return { dispose }
  }

  private emit(event: CoreEvent): void {
    // CoreRuntimePort 没有公开 emit；路由插件的事件应通过 submitModelResult 回到核心。
    // 该方法保留为宿主扩展点，当前不向外伪造核心状态事件。
    void event
  }
}
