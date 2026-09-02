/**
 * Per-component key/area storage for the v2 reference Host port (`host.storage`).
 *
 * Every cooperative caller (the selected Core or one ordinary plugin) is
 * assigned an isolated namespace. This is not a strong security boundary:
 * code sharing one WebView can manufacture caller fields, so users own the
 * risk of sharing this host with untrusted content. The
 * reference implementation is intentionally simple (one JSON file per area,
 * atomic replace). It is NOT a secret store: material persisted here is
 * plaintext on desktop, matching the v1 `providers.json` trust level. Desktop
 * intentionally does not advertise or implement `host.secrets`; Android
 * supplies that optional port with Keystore backing. The official LLM must
 * only use `host.storage` here for non-secret configuration.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface HostPortCaller {
  readonly pluginId: string
  readonly version?: string
}

export type ComponentStorageArea = 'llm-harness' | 'config'

const AREA = /^[a-z][a-z0-9-]*$/
/** Values above this size are refused; the HTTP body cap applies on top. */
export const MAX_STORAGE_VALUE_BYTES = 1024 * 1024

export interface ComponentStoragePort {
  read(caller: HostPortCaller, area: string): Promise<unknown | undefined>
  write(caller: HostPortCaller, area: string, value: unknown): Promise<void>
}

export function validateStorageArea(area: string): string {
  if (typeof area !== 'string' || !AREA.test(area)) throw new Error(`storage area must be a lowercase identifier: ${String(area)}`)
  return area
}

export function validateStorageCaller(caller: HostPortCaller | undefined): HostPortCaller {
  if (!caller || typeof caller.pluginId !== 'string' || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(caller.pluginId)) throw new Error('storage caller must carry a valid reverse-domain pluginId')
  return caller
}

/** In-memory reference implementation for tests and harnesses. */
export function createInMemoryComponentStorage(): ComponentStoragePort {
  const areas = new Map<string, unknown>()
  return {
    async read(caller, area) {
      validateStorageCaller(caller); validateStorageArea(area)
      const key = `${caller.pluginId}/${area}`
      return areas.has(key) ? structuredClone(areas.get(key)) : undefined
    },
    async write(caller, area, value) {
      validateStorageCaller(caller); validateStorageArea(area)
      areas.set(`${caller.pluginId}/${area}`, structuredClone(value))
    },
  }
}

export interface NodeFileComponentStorageOptions {
  onCorrupt?: (error: unknown) => void
}

export function createNodeFileComponentStorage(root: string, options: NodeFileComponentStorageOptions = {}): ComponentStoragePort {
  // Serialize writes per (caller, area): concurrent rename cycles must not clobber.
  const chains = new Map<string, Promise<unknown>>()
  const serialized = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    chains.set(key, next.catch(() => undefined))
    return next
  }
  const fileFor = (caller: HostPortCaller, area: string): string => {
    validateStorageCaller(caller); validateStorageArea(area)
    return join(root, caller.pluginId, `${area}.json`)
  }
  return {
    async read(caller, area) {
      const file = fileFor(caller, area)
      let raw: string
      try { raw = readFileSync(file, 'utf8') } catch { return undefined }
      if (Buffer.byteLength(raw, 'utf8') > MAX_STORAGE_VALUE_BYTES) {
        const error = new Error(`storage value exceeds ${MAX_STORAGE_VALUE_BYTES} bytes`)
        options.onCorrupt?.(error)
        return undefined
      }
      try { return JSON.parse(raw) } catch (error) { options.onCorrupt?.(error); return undefined }
    },
    async write(caller, area, value) {
      const file = fileFor(caller, area)
      const key = `${caller.pluginId}/${area}`
      await serialized(key, async () => {
        const encoded = JSON.stringify(value ?? null, null, 2)
        if (Buffer.byteLength(encoded, 'utf8') > MAX_STORAGE_VALUE_BYTES) throw new Error(`storage value exceeds ${MAX_STORAGE_VALUE_BYTES} bytes`)
        const temporary = `${file}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(temporary, encoded, 'utf8')
        renameSync(temporary, file)
      })
    },
  }
}

/** Capability names govern which host operations a component may call. */
/** Capabilities supplied by the reference desktop host. Secret storage is a
 * platform-specific optional port (Android Keystore currently); it is not
 * advertised by this plaintext desktop storage implementation. */
export const HOST_CAPABILITIES = ['host.log', 'host.storage'] as const

/** Operation namespace → capability. Unknown operations have no capability and are denied. */
export function capabilityForHostOperation(operation: string): string | undefined {
  if (operation === 'host.log') return 'host.log'
  if (operation.startsWith('host.storage.')) return 'host.storage'
  if (operation.startsWith('host.secrets.')) return 'host.secrets'
  return undefined
}
