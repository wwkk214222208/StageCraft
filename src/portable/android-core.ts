import { createAndroidComposition } from './android-composition.ts'
import { CORE_PROTOCOL_VERSION, type HumanCommand } from '../core/protocol.ts'
import type { NativeOperations } from '../platform/composition.ts'

export const ANDROID_CORE_BUNDLE_VERSION = '1.1.0'
export const ANDROID_CORE_BRIDGE_VERSION = '1'
type EventSink = (message: string) => void
const json = (value: unknown): string => JSON.stringify(value)

/** WebView entry: installs the complete StageCraft solution around the shared Core runtime. */
export function installAndroidCore(global: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  const native = (global.StageCraftNative ?? {}) as Record<string, unknown>
  if (global.StageCraftNative === undefined || typeof native.invokeSync !== 'function') {
    throw new Error('Android embedded Core requires the native operations bridge.')
  }
  const invoke = (operation: string, input: Record<string, unknown> = {}): unknown => {
    const method = native.invokeSync as ((name: string, value: string) => string) | undefined
    if (typeof method !== 'function') throw new Error('Android native composition bridge is unavailable.')
    const result = method.call(native, operation, json(input))
    if (typeof result !== 'string' || result.length > 4 * 1024 * 1024) throw new Error('Android bridge response is invalid or too large.')
    const parsed = JSON.parse(result) as unknown
    if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error?: unknown }).error === 'string') throw new Error((parsed as { error: string }).error)
    return parsed
  }
  const operations: NativeOperations = {
    invoke: (operation, input = {}) => invoke(operation, input),
    invokeSync: (operation, input = {}) => invoke(operation, input),
  }
  let sink: EventSink | undefined
  let composition: ReturnType<typeof createAndroidComposition> | undefined
  const emit = (message: unknown): void => sink?.(json(message))
  const start = (nextSink: EventSink): void => {
    sink = nextSink
    composition ??= createAndroidComposition(operations, { onMessage: emit })
    composition.start()
  }
  const dispatch = (commandJson: string): void => {
    if (!composition) return
    try { void composition.dispatch(JSON.parse(commandJson) as HumanCommand).catch(error => emit({ type: 'connection.error', message: error instanceof Error ? error.message : String(error) })) }
    catch (error) { emit({ type: 'connection.error', message: error instanceof Error ? error.message : String(error) }) }
  }
  global.StageCraftEmbeddedCore = Object.freeze({
    bundleVersion: ANDROID_CORE_BUNDLE_VERSION, bridgeVersion: ANDROID_CORE_BRIDGE_VERSION, protocolVersion: CORE_PROTOCOL_VERSION,
    start, stop: () => { composition?.stop(); sink = undefined }, reconnect: () => composition?.start(), refresh: () => composition?.refresh(), dispatch,
    cancel: (requestId?: string) => { void composition?.cancel(requestId).catch(error => emit({ type: 'connection.error', message: String(error) })) },
    dispose: () => { composition?.dispose(); composition = undefined; sink = undefined },
  })
}

if (typeof globalThis !== 'undefined' && (globalThis as any).StageCraftNative) installAndroidCore()
