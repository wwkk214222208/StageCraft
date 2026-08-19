import type { CoreEventListener, CoreRuntimePort } from './protocol.ts'
import type { CoreLlmRouterPlugin, CorePluginContainer, CoreRuntimeBindingPort, CoreRuntimePlugin, CoreSolutionPlugin, Disposable, HumanCoreInteractionPlugin } from './plugins.ts'

type Plugin = CoreRuntimePlugin | HumanCoreInteractionPlugin | CoreLlmRouterPlugin | CoreSolutionPlugin
type InstalledPlugin = { id: string; plugin: Plugin; installed: Disposable; kind: 'core' | 'human' | 'llm' | 'solution'; active: boolean }

/** 安装阶段的补偿释放不能改变原始错误，也不能制造同步 throw/unhandled rejection。 */
function quietDispose(disposable: Disposable | undefined): void {
  if (!disposable) return
  try {
    void Promise.resolve(disposable.dispose()).catch(() => {})
  } catch {
    // dispose 的同步错误同样只作为安装失败的补偿错误吞并。
  }
}

/** 无框架插件装配容器：检查 ID，且按安装逆序释放所有资源。 */
export class DefaultCorePluginContainer implements CorePluginContainer {
  readonly core: CoreRuntimePort
  readonly corePlugins: CoreRuntimePlugin[] = []
  readonly human: HumanCoreInteractionPlugin[] = []
  readonly llm: CoreLlmRouterPlugin[] = []
  readonly solutions: CoreSolutionPlugin[] = []
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
    let registrationAttempted = false
    try {
      return this.registerInstalled(plugin, 'llm', installed, () => {
        registrationAttempted = true
        this.llm.push(plugin)
      })
    } catch (error) {
      if (!registrationAttempted) quietDispose(installed)
      throw error
    }
  }

  addSolution(plugin: CoreSolutionPlugin): Disposable {
    this.ensureCanInstall(plugin)
    const binding = this.bindingCore.createSolutionBinding()
    let installed: Disposable | undefined
    let registrations: Disposable | undefined
    let registrationAttempted = false
    try {
      installed = plugin.install(binding.host)
      registrations = binding.commit()
      const combined: Disposable = {
        dispose: async () => {
          let firstError: unknown
          try { await installed?.dispose() } catch (error) { firstError = error }
          try { await registrations.dispose() } catch (error) { firstError ??= error }
          if (firstError) throw firstError
        },
      }
      return this.registerInstalled(plugin, 'solution', combined, () => {
        registrationAttempted = true
        this.solutions.push(plugin)
      })
    } catch (error) {
      // commit 后 binding 已 settled，rollback 不会撤销已注册的 definition/provider；
      // 此时必须释放 commit 返回的 registration，避免 registerInstalled 失败时泄漏。
      if (!registrationAttempted) {
        if (registrations) quietDispose(registrations)
        else {
          try { binding.rollback() } catch { /* 补偿释放不得覆盖安装错误。 */ }
        }
        quietDispose(installed)
      }
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
      quietDispose(installed)
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
    const list = entry.kind === 'core' ? this.corePlugins : entry.kind === 'human' ? this.human : entry.kind === 'llm' ? this.llm : this.solutions
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
