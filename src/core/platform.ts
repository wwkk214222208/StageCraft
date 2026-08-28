/**
 * Platform ports used by the portable Core.  Implementations live at the
 * application boundary; Core only depends on these small contracts.
 */
import type { ModelRequest, ModelResult } from './protocol.ts'

export interface Clock {
  now(): string
}

export interface IdFactory {
  create(prefix?: string): string
}

export interface Repository<T> {
  get(id: string): Promise<T | undefined> | T | undefined
  put(value: T): Promise<void> | void
  delete(id: string): Promise<void> | void
  list(): Promise<T[]> | T[]
}

export interface AssetRepository {
  read(path: string): Promise<Uint8Array | undefined>
  write(path: string, data: Uint8Array, contentType?: string): Promise<void>
  remove(path: string): Promise<void>
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export interface FilePicker {
  pick(options?: { accept?: readonly string[] }): Promise<{ name: string; type?: string; data: Uint8Array } | undefined>
}

export interface PlatformLifecycle {
  onPause(listener: () => void): () => void
  onResume(listener: () => void): () => void
}

export type ModelTransportRequest = ModelRequest
export type ModelTransportResult = ModelResult

/**
 * 流式增量的可选回调。传输层无需等到最终结果返回，即可把思维链逐段上报，
 * 供 Core LLM 路由插件发布 `model.thinking.delta` 事件。
 *
 * 安卓端此前缺这条通道：`ModelTransport` 只返回结果 Promise，路由插件拿不到
 * 增量，思维链只能随最终结果一次性出现（表现为"无法即时显示"）。桌面端走
 * ModelGateway 的 completeStreaming 回调，本来就具备该能力。
 */
export interface ModelTransportCallbacks {
  onThinking?: (text: string) => void
}

export interface ModelTransport {
  request(request: ModelTransportRequest, callbacks?: ModelTransportCallbacks): Promise<ModelTransportResult>
  cancel?(requestId: string): Promise<void> | void
}

export interface PortableRuntimePorts {
  clock?: Clock
  ids?: IdFactory
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
}

export const systemIds: IdFactory = {
  create: (prefix = '') => {
    const id = globalThis.crypto?.randomUUID?.()
    if (!id) throw new Error('No platform UUID implementation is available.')
    return prefix ? `${prefix}:${id}` : id
  },
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()
  async get(key: string): Promise<string | undefined> { return this.values.get(key) }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value) }
  async remove(key: string): Promise<void> { this.values.delete(key) }
}

export class MemoryAssetRepository implements AssetRepository {
  private readonly values = new Map<string, Uint8Array>()
  async read(path: string): Promise<Uint8Array | undefined> {
    const value = this.values.get(path)
    return value ? new Uint8Array(value) : undefined
  }
  async write(path: string, data: Uint8Array): Promise<void> { this.values.set(path, new Uint8Array(data)) }
  async remove(path: string): Promise<void> { this.values.delete(path) }
}
