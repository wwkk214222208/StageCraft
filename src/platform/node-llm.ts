import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { LlmSystemStatePort } from '../sdk/authoring.ts'

/** Node state adapter for the official desktop LLM System. */
export class NodeLlmStateStore implements LlmSystemStatePort {
  private readonly filePath: string
  private mutation: Promise<void> = Promise.resolve()
  constructor(filePath: string) { this.filePath = resolve(filePath) }

  async read<T = unknown>(key: string): Promise<T | undefined> {
    const values = await this.load()
    return values[key] === undefined ? undefined : structuredClone(values[key]) as T
  }

  async write<T = unknown>(key: string, value: T): Promise<void> {
    await this.enqueue(async () => {
      const values = await this.load()
      values[key] = structuredClone(value)
      await this.save(values)
    })
  }

  async delete(key: string): Promise<void> {
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

  private async load(): Promise<Record<string, unknown>> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LLM state must contain an object.')
      return value as Record<string, unknown>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  private async save(values: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
  }
}
