import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { CoreRuntimePort } from './protocol.ts'
import type { CoreLlmRouterPlugin, CoreRuntimePlugin, CoreSolutionPlugin, Disposable, HumanCoreInteractionPlugin } from './plugins.ts'
import type { CoreStateRepository } from './state-repository.ts'
import type { DefaultCorePluginContainer } from './container.ts'
import { CoreRuntimePluginAdapter } from './runtime-plugin.ts'

/**
 * Stable, deliberately narrow service exposed to future Cordis bridge plugins.
 * The Store remains an implementation detail; built-ins are installed through
 * the private typed ports below.
 */
export interface StageCraftService {
  readonly core: CoreRuntimePort
  readonly roomId: string
  readonly install: {
    core(plugin: CoreRuntimePlugin): Disposable
    human(plugin: HumanCoreInteractionPlugin): Disposable
    llm(plugin: CoreLlmRouterPlugin): Disposable
    solution(plugin: CoreSolutionPlugin): Disposable
    repository(repository: CoreStateRepository): Disposable
  }
}

/** Build the service around the private compatibility container. */
export function createStageCraftService(core: CoreRuntimePort, roomId: string, container: DefaultCorePluginContainer, attachRepository: (repository: CoreStateRepository) => Disposable): StageCraftService {
  return {
    core,
    roomId,
    install: {
      core: plugin => container.addCore(plugin),
      human: plugin => container.addHuman(plugin),
      llm: plugin => container.addLlm(plugin),
      solution: plugin => container.addSolution(plugin),
      repository: attachRepository,
    },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    stagecraft: StageCraftService
  }
}

export function stageCraftServicePlugin(service: StageCraftService): Plugin {
  return {
    name: 'stagecraft.service',
    apply(ctx) {
      // Cordis's provide() is itself fiber-scoped and removes the service on
      // unload; built-in adapters below use explicit effects for their handles.
      ctx.provide('stagecraft', service)
    },
  }
}

function installWithEffect<T>(ctx: Context, install: () => Disposable): void {
  ctx.effect(() => {
    const disposable = install()
    return () => disposable.dispose()
  })
}

export function coreRuntimeCordisPlugin(): Plugin {
  return {
    name: 'stagecraft.core',
    inject: ['stagecraft'],
    apply(ctx) {
      installWithEffect(ctx, () => ctx.stagecraft.install.core(new CoreRuntimePluginAdapter(ctx.stagecraft.core)))
    },
  }
}

export function stateRepositoryCordisPlugin(repository: CoreStateRepository): Plugin {
  return {
    name: 'stagecraft.state-repository',
    inject: ['stagecraft'],
    apply(ctx) {
      installWithEffect(ctx, () => ctx.stagecraft.install.repository(repository))
    },
  }
}

export function humanCordisPlugin(plugin: HumanCoreInteractionPlugin): Plugin {
  return {
    name: plugin.id,
    inject: ['stagecraft'],
    apply(ctx) {
      installWithEffect(ctx, () => ctx.stagecraft.install.human(plugin))
    },
  }
}

export function solutionCordisPlugin(plugin: CoreSolutionPlugin): Plugin {
  return {
    name: plugin.id,
    inject: ['stagecraft'],
    apply(ctx) {
      installWithEffect(ctx, () => ctx.stagecraft.install.solution(plugin))
    },
  }
}

export function llmCordisPlugin(plugin: CoreLlmRouterPlugin): Plugin {
  return {
    name: plugin.id,
    inject: ['stagecraft'],
    apply(ctx) {
      installWithEffect(ctx, () => ctx.stagecraft.install.llm(plugin))
    },
  }
}
