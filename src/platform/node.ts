import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AssetRepository, SecretStore } from '../core/platform.ts'

/** Filesystem adapter kept outside Core so browser/Android builds can omit node:fs. */
export class FileAssetRepository implements AssetRepository {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  async read(path: string): Promise<Uint8Array | undefined> {
    const target = this.resolvePath(path)
    try { return new Uint8Array(await readFile(target)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const target = this.resolvePath(path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data)
  }

  async remove(path: string): Promise<void> { await rm(this.resolvePath(path), { force: true }) }

  private resolvePath(path: string): string {
    if (!path || isAbsolute(path)) throw new Error('Asset path must be relative.')
    const target = resolve(join(this.root, path))
    const boundary = relative(this.root, target)
    if (boundary.startsWith('..') || isAbsolute(boundary)) throw new Error('Asset path escapes repository root.')
    return target
  }
}

/** Preferred explicit name for the Node filesystem asset adapter. */
export class NodeFileRepository extends FileAssetRepository {}

/**
 * Minimal Node secret adapter. It keeps the storage boundary replaceable;
 * deployments needing OS keychains can supply another SecretStore.
 */
export class NodeSecretStore implements SecretStore {
  private readonly filePath: string
  private mutation: Promise<void> = Promise.resolve()

  constructor(filePath: string) { this.filePath = resolve(filePath) }

  async get(key: string): Promise<string | undefined> { return (await this.load())[key] }
  async set(key: string, value: string): Promise<void> {
    await this.enqueue(async () => {
      const values = await this.load()
      values[key] = value
      await this.save(values)
    })
  }
  async remove(key: string): Promise<void> {
    await this.enqueue(async () => {
      const values = await this.load()
      delete values[key]
      await this.save(values)
    })
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const operation = this.mutation.then(task)
    this.mutation = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async load(): Promise<Record<string, string>> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Secret store must contain an object.')
      const entries = Object.entries(value as Record<string, unknown>)
      if (entries.some(([, item]) => typeof item !== 'string')) throw new Error('Secret store values must be strings.')
      return Object.fromEntries(entries) as Record<string, string>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  private async save(values: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
  }
}
