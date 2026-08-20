import { CoreRuntimeSkeleton } from '../core/runtime.ts'
import { CORE_PROTOCOL_VERSION, type CoreEvent, type HumanCommand } from '../core/protocol.ts'

export const ANDROID_CORE_BUNDLE_VERSION = '1.0.0'
export const ANDROID_CORE_BRIDGE_VERSION = '1'

type EventSink = (message: string) => void

function json(value: unknown): string { return JSON.stringify(value) }

/** Browser/WebView composition root for the shared, platform-neutral Core. */
export function installAndroidCore(global: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  const core = new CoreRuntimeSkeleton()
  let sink: EventSink | undefined
  let unsubscribe: (() => void) | undefined
  let started = false

  const emit = (message: unknown): void => { if (sink) sink(json(message)) }
  const sendView = (reason: 'initial' | 'manual' | 'command'): void => {
    const view = core.getView()
    emit({ type: 'core.resync', reason, revision: view.revision, view })
  }
  const start = (nextSink: EventSink): void => {
    sink = nextSink
    if (started) { sendView('manual'); return }
    started = true
    unsubscribe = core.subscribe((event: CoreEvent) => emit({ type: 'core.event', event }))
    emit({ type: 'connection.state', state: 'connected' })
    sendView('initial')
  }
  const stop = (): void => { if (sink) emit({ type: 'connection.state', state: 'disconnected' }); sink = undefined }
  const dispatch = (commandJson: string): void => {
    if (!sink) return
    try {
      const command = JSON.parse(commandJson) as HumanCommand
      void core.dispatch(command).then(() => sendView('command')).catch(error => emit({ type: 'connection.error', message: error instanceof Error ? error.message : String(error) }))
    } catch (error) { emit({ type: 'connection.error', message: error instanceof Error ? error.message : String(error) }) }
  }
  global.StageCraftEmbeddedCore = Object.freeze({
    bundleVersion: ANDROID_CORE_BUNDLE_VERSION,
    bridgeVersion: ANDROID_CORE_BRIDGE_VERSION,
    protocolVersion: CORE_PROTOCOL_VERSION,
    start,
    stop,
    reconnect: () => { if (sink) sendView('manual') },
    refresh: () => { if (sink) sendView('manual') },
    dispatch,
    cancel: (requestId?: string) => { void core.cancel(requestId).catch(error => emit({ type: 'connection.error', message: error instanceof Error ? error.message : String(error) })) },
    dispose: () => { unsubscribe?.(); unsubscribe = undefined; stop() },
  })
}

installAndroidCore()
