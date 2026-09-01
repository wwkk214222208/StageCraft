import { COMPONENT_HOST_API_VERSION } from './component-contract.ts'
import type { ComponentLaunchPlan, ComponentManifest, ComponentSelection } from './component-contract.ts'
import type { HostPortCaller } from './component-storage.ts'

export const HOST_CORE_ABI_VERSION = COMPONENT_HOST_API_VERSION

export type { HostPortCaller }

export interface HostPort {
  /**
   * `caller` identifies the calling component so the Host can enforce
   * per-capability authorization. Capability-gated operations are denied
   * (fail closed) when the caller is missing or not granted the capability.
   */
  call(operation: string, input: unknown, caller?: HostPortCaller): Promise<unknown>
}

export interface CoreBootRequest {
  hostApiVersion: string
  selectedCore: ComponentSelection
  readonly pluginSelections: readonly ComponentSelection[]
  planHash: string
}

/** Read-only generic handoff; the Host does not interpret plugin domains. */
export interface LoadedCoreComponent {
  readonly manifest: ComponentManifest
  readonly defaultExport: unknown
  readonly module?: Readonly<Record<string, unknown>>
}

export interface CoreReadySignal {
  type: 'ready'
  hostApiVersion: string
  selectedCore: ComponentSelection
  planHash: string
}

export interface CoreFailedSignal {
  type: 'failed'
  code: string
  message: string
}

export interface CoreShutdownSignal { type: 'shutdown' }
export type CoreLifecycleSignal = CoreReadySignal | CoreFailedSignal | CoreShutdownSignal

export interface CoreBootContext {
  readonly request: CoreBootRequest
  readonly components: readonly LoadedCoreComponent[]
  readonly host: HostPort
  ready(signal?: Omit<CoreReadySignal, 'type'>): void
  failed(code: string, message: string): void
}

export interface HostCoreEntry {
  boot(context: CoreBootContext): void | Promise<void>
  /** Host-to-Core generic operation surface; domain semantics stay inside Core. */
  invoke?(operation: string, input: unknown): unknown | Promise<unknown>
  /**
   * Optional transfer-level streaming surface. Chunks are forwarded to the
   * client as they are produced; aborting iteration releases the producer.
   */
  stream?(operation: string, input: unknown): AsyncIterable<unknown>
  shutdown?(): void | Promise<void>
}

export type HostCoreState = 'pending' | 'ready' | 'failed' | 'shutdown'

export function validateCoreReady(request: CoreBootRequest, signal: CoreReadySignal): string[] {
  const errors: string[] = []
  if (signal.type !== 'ready') errors.push('signal must be ready')
  if (signal.hostApiVersion !== request.hostApiVersion) errors.push(`host API mismatch: expected ${request.hostApiVersion}, got ${signal.hostApiVersion}`)
  if (signal.planHash !== request.planHash) errors.push('planHash mismatch')
  if (signal.selectedCore.id !== request.selectedCore.id || signal.selectedCore.version !== request.selectedCore.version || signal.selectedCore.manifestHash !== request.selectedCore.manifestHash) errors.push('selected core identity mismatch')
  return errors
}

/** Reference handshake: normal operations are unavailable until a validated ready signal. */
export class HostCoreSession {
  readonly request: CoreBootRequest
  state: HostCoreState = 'pending'
  failure?: CoreFailedSignal
  #backingHost: HostPort
  #entry?: HostCoreEntry

  constructor(plan: ComponentLaunchPlan, host: HostPort, components: readonly LoadedCoreComponent[] = []) {
    this.request = Object.freeze({ hostApiVersion: plan.hostApiVersion, selectedCore: Object.freeze({ ...plan.core }), pluginSelections: Object.freeze(plan.plugins.map(selection => Object.freeze({ ...selection }))), planHash: plan.planHash })
    this.#backingHost = host
    this.#components = Object.freeze(components.map(component => Object.freeze({ ...component })))
  }

  #components: readonly LoadedCoreComponent[]

  accept(signal: CoreLifecycleSignal): void {
    if (this.state === 'shutdown') throw new Error('Core session is shut down; no further signals are accepted')
    if (this.state === 'failed') throw new Error('Core session has failed; restart is required')
    if (this.state === 'ready' && signal.type === 'ready') throw new Error('Core session is already ready')
    if (signal.type === 'ready') {
      const errors = validateCoreReady(this.request, signal)
      if (errors.length) { this.state = 'failed'; this.failure = { type: 'failed', code: 'core_handshake_invalid', message: errors.join('; ') }; throw new Error(this.failure.message) }
      this.state = 'ready'; return
    }
    if (signal.type === 'failed') { this.state = 'failed'; this.failure = signal; return }
    this.state = 'shutdown'
  }

  /** Reference orchestration: the entry receives only the gated port and must signal ready. */
  async boot(entry: HostCoreEntry): Promise<void> {
    if (this.state !== 'pending') throw new Error(`Core boot is only valid from pending (state=${this.state})`)
    this.#entry = entry
    const context: CoreBootContext = {
      request: this.request,
      components: this.#components,
      // The boot-context port is available while the Core boots (diagnostics,
      // persisted-state loads) and after ready; it is denied once failed/shutdown.
      host: { call: (operation, input, caller) => this.#dispatchHost(operation, input, caller) },
      ready: signal => this.accept({ type: 'ready', hostApiVersion: signal?.hostApiVersion ?? this.request.hostApiVersion, selectedCore: signal?.selectedCore ?? this.request.selectedCore, planHash: signal?.planHash ?? this.request.planHash }),
      failed: (code, message) => this.accept({ type: 'failed', code, message }),
    }
    try { await entry.boot(context) } catch (error) {
      if (this.state === 'pending') { this.state = 'failed'; this.failure = { type: 'failed', code: 'core_boot_error', message: error instanceof Error ? error.message : String(error) } }
      throw error
    }
    if (this.state === 'pending') {
      this.state = 'failed'; this.failure = { type: 'failed', code: 'core_not_ready', message: 'Core boot returned without ready or failed signal' }
      throw new Error(this.failure.message)
    }
    if (this.state === 'failed') throw new Error(this.failure?.message ?? 'Core boot failed')
  }

  async callHost(operation: string, input: unknown, caller?: HostPortCaller): Promise<unknown> {
    if (this.state !== 'ready') throw new Error(`Host port unavailable before Core ready (state=${this.state})`)
    return this.#backingHost.call(operation, input, caller)
  }

  async #dispatchHost(operation: string, input: unknown, caller?: HostPortCaller): Promise<unknown> {
    if (this.state === 'failed' || this.state === 'shutdown') throw new Error(`Host port unavailable (state=${this.state})`)
    return this.#backingHost.call(operation, input, caller)
  }

  async invoke(operation: string, input: unknown): Promise<unknown> {
    if (this.state !== 'ready') throw new Error(`Core invoke unavailable before Core ready (state=${this.state})`)
    if (!this.#entry?.invoke) throw new Error('Core does not expose Host-to-Core invoke')
    return this.#entry.invoke(operation, input)
  }

  /** Transfer-level streaming: chunks are forwarded as produced; breaking the
   * iteration releases the Core-side producer. */
  async *stream(operation: string, input: unknown): AsyncGenerator<unknown> {
    if (this.state !== 'ready') throw new Error(`Core stream unavailable before Core ready (state=${this.state})`)
    if (!this.#entry?.stream) throw new Error('Core does not expose Host-to-Core stream')
    yield* this.#entry.stream(operation, input)
  }

  shutdown(): void {
    if (this.state === 'failed') throw new Error('Core session has failed; failed is terminal')
    if (this.state === 'shutdown') throw new Error('Core session is already shut down')
    this.state = 'shutdown'
    this.#entry = undefined
  }
}
