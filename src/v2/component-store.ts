import type { ComponentManifest, ComponentOrigin, ComponentRecord } from './component-contract.ts'
import { validateComponentManifest } from './component-validation.ts'

export interface ComponentStore {
  install(record: ComponentRecord): void
  get(id: string, version: string): ComponentRecord | undefined
  list(): readonly ComponentRecord[]
  remove(id: string, version: string): void
}

/** Reference store only: no filesystem/Android IO, intended for contract tests and adapters. */
export class MemoryComponentStore implements ComponentStore {
  private readonly records = new Map<string, ComponentRecord>()

  constructor(records: readonly ComponentRecord[] = []) { for (const record of records) this.install(record) }

  install(record: ComponentRecord): void {
    const manifestErrors = validateComponentManifest(record.manifest)
    if (manifestErrors.length) throw new Error(`invalid component manifest: ${manifestErrors.join('; ')}`)
    if (record.origin !== 'bundled' && record.origin !== 'local') throw new Error(`invalid component origin: ${String(record.origin)}`)
    const key = keyOf(record.manifest)
    if (this.records.has(key)) throw new Error(`component already installed: ${key}`)
    this.records.set(key, freezeRecord(record))
  }

  get(id: string, version: string): ComponentRecord | undefined { return this.records.get(`${id}@${version}`) }

  list(): readonly ComponentRecord[] {
    return Object.freeze([...this.records.values()].sort((a, b) => keyOf(a.manifest).localeCompare(keyOf(b.manifest))))
  }

  remove(id: string, version: string): void {
    const key = `${id}@${version}`; const record = this.records.get(key)
    if (!record) return
    if (record.origin === 'bundled') throw new Error(`bundled component cannot be removed: ${key}`)
    this.records.delete(key)
  }
}

function keyOf(manifest: ComponentManifest): string { return `${manifest.id}@${manifest.version}` }

function freezeRecord(record: ComponentRecord): ComponentRecord {
  const manifest = deepFreezeClone(record.manifest) as ComponentManifest
  const metadata = record.metadata === undefined ? undefined : deepFreezeClone(record.metadata) as Readonly<Record<string, unknown>>
  return Object.freeze({ ...record, manifest, metadata })
}

/** Clone first, then freeze recursively, so callers cannot mutate installed records through aliases. */
function deepFreezeClone(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeClone))
  const clone: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) clone[key] = deepFreezeClone(item)
  return Object.freeze(clone)
}

export function componentRecord(id: string, version: string, manifest: ComponentManifest, origin: ComponentOrigin, metadata?: Readonly<Record<string, unknown>>): ComponentRecord {
  if (manifest.id !== id || manifest.version !== version) throw new Error('record identity must match manifest identity')
  return { manifest, origin, metadata }
}
