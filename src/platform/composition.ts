import type { ModelRequest, ModelResult } from '../core/protocol.ts'
import type { CoreStateCommit, CoreStateRepository, CoreStateRestore } from '../core/state-repository.ts'
import type { AssetRepository, SecretStore } from '../core/platform.ts'
import type { StoryPackage } from '../story-packages.ts'
import { ModelGatewayTransport } from './model-gateway-transport.ts'
import type { ModelTransport, ModelTransportCallbacks } from '../core/platform.ts'

/** Small async operation port implemented by WebView hosts (Android, desktop shells, tests). */
export interface NativeOperations {
  /** `callbacks` 仅对流式操作（如 model.request）有意义，用于上报思维链增量；其余操作忽略。 */
  invoke<T = unknown>(operation: string, input?: Record<string, unknown>, callbacks?: ModelTransportCallbacks): T | Promise<T>
  invokeSync?<T = unknown>(operation: string, input?: Record<string, unknown>): T
}

/** JSON codecs kept at the platform boundary so Core/domain code remains runtime-neutral. */
export interface CompositionSources {
  story: (id: string) => Promise<StoryPackage>
}

export interface PortableComposition {
  operations: NativeOperations
  assets: AssetRepository
  secrets: SecretStore
  state: CoreStateRepository
  model: ModelTransport
  sources: CompositionSources
}

export class NativeAssetRepository implements AssetRepository {
  private readonly operations: NativeOperations
  constructor(operations: NativeOperations) { this.operations = operations }
  read(path: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.operations.invoke<{ data?: string }>('asset.read', { path })).then(value => value?.data ? decodeBase64(value.data) : undefined)
  }
  async write(path: string, data: Uint8Array, contentType?: string): Promise<void> {
    await this.operations.invoke('asset.write', { path, contentType: contentType ?? '', data: encodeBase64(data) })
  }
  async remove(path: string): Promise<void> { await this.operations.invoke('asset.remove', { path }) }
}

export class NativeSecretStore implements SecretStore {
  private readonly operations: NativeOperations
  constructor(operations: NativeOperations) { this.operations = operations }
  async get(key: string): Promise<string | undefined> { return (await this.operations.invoke<{ value?: string }>('secret.get', { key }))?.value }
  async set(key: string, value: string): Promise<void> { await this.operations.invoke('secret.set', { key, value }) }
  async remove(key: string): Promise<void> { await this.operations.invoke('secret.remove', { key }) }
}

/** Core commits remain one atomic host operation, matching CoreStateRepository's contract. */
export class NativeCoreStateRepository implements CoreStateRepository {
  private readonly operations: NativeOperations
  constructor(operations: NativeOperations) { this.operations = operations }
  commit(snapshot: CoreStateCommit): void {
    // Core's repository port is synchronous by design. Hosts must acknowledge the write
    // synchronously or fail closed; Android implements this through a synchronous bridge.
    const result = (this.operations.invokeSync ?? this.operations.invoke)<unknown>('core-state.commit', snapshot as unknown as Record<string, unknown>)
    if (result && typeof (result as Promise<unknown>).then === 'function') throw new Error('core-state.commit must be synchronous at the host boundary.')
  }
  restore(roomId: string, eventLimit = 100): CoreStateRestore | undefined {
    const result = (this.operations.invokeSync ?? this.operations.invoke)<CoreStateRestore | undefined>('core-state.restore', { roomId, eventLimit })
    if (result && typeof (result as Promise<unknown>).then === 'function') throw new Error('core-state.restore must be synchronous at the host boundary.')
    return result
  }
}

/** Promise-based adapter for the existing Core LLM router port. */
export class NativeModelTransport implements ModelTransport {
  private readonly operations: NativeOperations
  constructor(operations: NativeOperations) { this.operations = operations }
  request(request: ModelRequest, callbacks?: ModelTransportCallbacks): Promise<ModelResult> { return Promise.resolve(this.operations.invoke<ModelResult>('model.request', request as unknown as Record<string, unknown>, callbacks)) }
  cancel(requestId: string): Promise<void> { return Promise.resolve(this.operations.invoke('model.cancel', { requestId })).then(() => undefined) }
}

/** Loaders used by portable composition roots; JSON parsing stays in TypeScript. */
export function jsonSources(operations: NativeOperations): CompositionSources {
  return {
    story: async id => parseJsonSource<StoryPackage>(await Promise.resolve(operations.invoke<string | { value?: string }>('story.read', { id }))),
  }
}

export function createPortableComposition(operations: NativeOperations): PortableComposition {
  return {
    operations,
    assets: new NativeAssetRepository(operations),
    secrets: new NativeSecretStore(operations),
    state: new NativeCoreStateRepository(operations),
    model: new NativeModelTransport(operations),
    sources: jsonSources(operations),
  }
}

/** A transport factory useful to desktop shells without changing their ModelGateway path. */
export function modelTransportFromGateway(gateway: import('../model-gateway.ts').ModelGateway): ModelTransport {
  return new ModelGatewayTransport(gateway)
}

function parseJsonSource<T>(value: string | { value?: string }): T {
  const text = typeof value === 'string' ? value : value?.value
  if (typeof text !== 'string') throw new Error('Native JSON source returned a non-text value.')
  return JSON.parse(text) as T
}

function encodeBase64(data: Uint8Array): string {
  let value = ''
  for (const byte of data) value += String.fromCharCode(byte)
  return btoa(value)
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const data = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index)
  return data
}
