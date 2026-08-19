import type { CoreEventListener, CoreRuntimePort } from './protocol.ts'
import type { CoreLlmRouterPlugin, CorePluginContainer, CoreRuntimeBindingPort, CoreRuntimePlugin, Disposable, HumanCoreInteractionPlugin } from './plugins.ts'

type Plugin = CoreRuntimePlugin | HumanCoreInteractionPlugin | CoreLlmRouterPlugin
type InstalledPlugin = { id: string; plugin: Plugin; installed: Disposable; kind: 'core' | 'human' | 'llm'; active: boolean }

/** 无框架插件装配容器：检查 ID，且按安装逆序释放所有资源。 */
export class DefaultCorePluginContainer implements CorePluginContainer {
  readonly core: CoreRuntimePort
  readonly corePlugins: CoreRuntimePlugin[] = []
  readonly human: HumanCoreInteractionPlugin[] = []
  readonly llm: CoreLlmRouterPlugin[] = []
  private readonly installed: InstalledPlugin[] = []
  private readonly byId = new Map<string, InstalledPlugin>()
  private readonly subscriptions = new Set<() => void>()
  private disposed = false

  private readonly bindingCore: CoreRuntimeBindingPort

  constructor(core: CoreRuntimePort & CoreRuntimeBindingPort) {
    this.core = core
    this.bindingCore = core
  }

  addCore(plugin: CoreRuntimePlugin): Disposable {
    if (plugin.runtime !== this.core) throw new Error(`Core runtime plugin does not belong to this container: ${plugin.id}`)
    return this.install(plugin, 'core', () => this.corePlugins.push(plugin))
  }

  addHuman(plugin: HumanCoreInteractionPlugin): Disposable {
    return this.install(plugin, 'human', () => this.human.push(plugin))
  }

  addLlm(plugin: CoreLlmRouterPlugin): Disposable {
    // 由 Core 统一完成 install 与当前路由绑定，容器不再重复 install。
    this.ensureCanInstall(plugin)
    const installed = this.bindingCore.bindLlmRouter(plugin)
    try {
      return this.registerInstalled(plugin, 'llm', installed, () => this.llm.push(plugin))
    } catch (error) {
      void installed.dispose()
      throw error
    }
  }

  subscribe(listener: CoreEventListener): Disposable {
    this.ensureActive()
    const unsubscribe = this.core.subscribe(listener)
    this.subscriptions.add(unsubscribe)
    let active = true
    return {
      dispose: () => {
        if (!active) return
        active = false
        this.subscriptions.delete(unsubscribe)
        unsubscribe()
      },
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.subscriptions) unsubscribe()
    this.subscriptions.clear()
    let firstError: unknown
    for (const entry of [...this.installed].reverse()) {
      if (!entry.active) continue
      try {
        await this.remove(entry)
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) throw firstError
  }

  private install<T extends Plugin>(plugin: T, kind: InstalledPlugin['kind'], addToList: () => void, host?: unknown): Disposable {
    this.ensureCanInstall(plugin)
    const installed = kind === 'core'
      ? (plugin as CoreRuntimePlugin).install()
      : kind === 'human'
        ? (plugin as HumanCoreInteractionPlugin).install(this.core)
        : (plugin as CoreLlmRouterPlugin).install(host as Parameters<CoreLlmRouterPlugin['install']>[0])
    return this.registerInstalled(plugin, kind, installed, addToList)
  }

  private registerInstalled<T extends Plugin>(plugin: T, kind: InstalledPlugin['kind'], installed: Disposable, addToList: () => void): Disposable {
    this.ensureCanInstall(plugin)
    const entry: InstalledPlugin = { id: plugin.id, plugin, installed, kind, active: true }
    this.byId.set(entry.id, entry)
    this.installed.push(entry)
    try {
      addToList()
    } catch (error) {
      this.byId.delete(entry.id)
      this.installed.pop()
      entry.active = false
      void installed.dispose()
      throw error
    }
    return { dispose: () => this.remove(entry) }
  }

  private async remove(entry: InstalledPlugin): Promise<void> {
    if (!entry.active) return
    entry.active = false
    this.byId.delete(entry.id)
    const index = this.installed.indexOf(entry)
    if (index >= 0) this.installed.splice(index, 1)
    const list = entry.kind === 'core' ? this.corePlugins : entry.kind === 'human' ? this.human : this.llm
    const pluginIndex = list.indexOf(entry.plugin as never)
    if (pluginIndex >= 0) list.splice(pluginIndex, 1)
    await entry.installed.dispose()
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('Core plugin container is disposed.')
  }

  private ensureCanInstall(plugin: Plugin): void {
    this.ensureActive()
    if (!plugin.id.trim()) throw new Error('Plugin id is required.')
    if (this.byId.has(plugin.id)) throw new Error(`Plugin already registered: ${plugin.id}`)
  }
}
