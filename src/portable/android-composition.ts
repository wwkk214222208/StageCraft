import { CoreRuntimeSkeleton } from '../core/runtime.ts'
import { DefaultCorePluginContainer } from '../core/container.ts'
import { StageCraftSolutionPlugin } from '../core/solutions.ts'
import { StageCraftChatService } from '../stagecraft-chat-service.ts'
import { StageCraftDirectorService } from '../stagecraft-director-service.ts'
import { StageCraftManagementService } from '../stagecraft-management-service.ts'
import { fakeWorkers, type WorkerSet } from '../workers.ts'
import type { ConsultationMessage, LoreEntry, PlayerCharacter, RoomSnapshot, TokenUsage } from '../types.ts'
import { type Decision, type Draft } from '../types.ts'
import { createPortableComposition, type NativeOperations } from '../platform/composition.ts'
import type { StageCraftRepository } from '../stagecraft-repository.ts'
import type { Disposable } from '../core/plugins.ts'
import type { CoreStateRepository } from '../core/state-repository.ts'
import { LlmSystemRouterAdapter } from '../core/llm-system-router-adapter.ts'
import { createOfficialLlmSystemService } from '../llm/official.ts'
import { AndroidLlmStatePort, createAndroidOpenAiDriver } from './android-llm.ts'

/** Native repository adapter: Android owns bytes/transactions; domain behavior remains here. */
export function createAndroidRepository(operations: NativeOperations): StageCraftRepository {
  const call = (method: string, args: unknown[]): unknown => {
    const result = operations.invokeSync?.('stagecraft.repository', { method, args })
    if (result === undefined) throw new Error('Android repository calls must be synchronous.')
    return result
  }
  return new Proxy({}, { get: (_target, property: string) => (...args: unknown[]) => call(property, args) }) as StageCraftRepository
}

export type AndroidComposition = {
  readonly core: CoreRuntimeSkeleton
  readonly roomId: string
  readonly start: () => Promise<void>
  readonly stop: () => void
  readonly disableLlm: () => Promise<void>
  readonly refresh: () => void
  readonly dispatch: (command: import('../core/protocol.ts').HumanCommand) => Promise<void>
  readonly cancel: (requestId?: string) => Promise<void>
  readonly dispose: () => void
  /** Rich-API 外壳所需的内部服务/房间访问（与 PC 端 RoomRuntime 同一组共享服务）。 */
  readonly getRoom: () => RoomSnapshot
  readonly chat: StageCraftChatService
  readonly director: StageCraftDirectorService
  readonly management: StageCraftManagementService
  readonly setWorkers: (workers: WorkerSet) => void
  readonly llmSystem: import('../sdk/authoring.ts').LlmSystemService
}

/** Boots the real shared StageCraft solution in the WebView, never a Java domain replica. */
export function createAndroidComposition(operations: NativeOperations, options: { roomId?: string; workers?: WorkerSet; onMessage?: (message: unknown) => void; llmEnabled?: boolean; providerStore?: { exportPrivate(): { providers: readonly Record<string, any>[]; defaults: Record<string, unknown> } } } = {}): AndroidComposition {
  const composition = createPortableComposition(operations)
  const roomId = options.roomId ?? 'android-local-room'
  const core = new CoreRuntimeSkeleton()
  const container = new DefaultCorePluginContainer(core)
  const repository = createAndroidRepository(operations)
  let room: RoomSnapshot | undefined
  const readRoom = (): RoomSnapshot => {
    const value = operations.invokeSync?.<RoomSnapshot>('stagecraft.room.get', { roomId })
    if (!value) throw new Error('Android local room is unavailable.')
    return value
  }
  const notify = (id: string): void => options.onMessage?.({ type: 'room.changed', roomId: id, view: core.getView() })
  const currentRoom = (): RoomSnapshot => { room = readRoom(); return room }
  const chat = new StageCraftChatService(repository, options.workers ?? fakeWorkers, core, { get: currentRoom, notify, thinking: (id, event) => options.onMessage?.({ type: 'thinking', roomId: id, event }) })
  const director = new StageCraftDirectorService(repository, options.workers ?? fakeWorkers, core, { get: currentRoom, notify, thinking: (id, event) => options.onMessage?.({ type: 'thinking', roomId: id, event }) })
  const management = new StageCraftManagementService(repository, { get: currentRoom, notify })
  const driver = createAndroidOpenAiDriver(operations)
  const legacyProviderStore = options.providerStore ? { exportPrivate: () => {
    const snapshot = options.providerStore!.exportPrivate()
    return { providers: snapshot.providers.map(profile => ({ ...profile, providerId: driver.driverId, driverId: driver.driverId })), defaults: snapshot.defaults }
  } } : undefined
  const servicePromise = createOfficialLlmSystemService({ apiVersion: '0.1', pluginId: 'stagecraft.llm.android', config: {}, log() {}, drivers: [driver], state: new AndroidLlmStatePort(operations), secrets: { get: key => composition.secrets.get(key), set: (key, value) => composition.secrets.set(key, value), delete: key => composition.secrets.remove(key), has: async key => (await composition.secrets.get(key)) !== undefined } }, { providerStore: legacyProviderStore })
  // Android keeps its synchronous composition factory for compatibility; the
  // facade is populated from the one service promise while start() awaits it.
  const lazyService = createLazyLlmService(servicePromise)
  const llmBinding = options.llmEnabled === false ? undefined : container.addLlm(new LlmSystemRouterAdapter(lazyService, { stopOnDispose: false }))
  const bindings: Disposable[] = [container.addSolution(new StageCraftSolutionPlugin({ chat, director, management, defaultRoomId: roomId })), ...(llmBinding ? [llmBinding] : [])]
  const state: CoreStateRepository = composition.state
  bindings.push(core.attachStateRepository(state))
  const emit = (message: unknown): void => options.onMessage?.(message)
  let running = false
  let llmDisabled = false
  return {
    core, roomId, llmSystem: lazyService,
    async start() { if (running) return; running = true; room = readRoom(); core.restoreState(roomId); core.projectRoom(room, 'android:start'); emit({ type: 'connection.state', state: 'connected' }); emit({ type: 'core.resync', reason: 'initial', revision: core.getView().revision, view: core.getView() }); try { await servicePromise } catch (error) { running = false; throw error } },
    async disableLlm() { if (llmDisabled) return; llmDisabled = true; try { await llmBinding?.dispose() } catch {} chat.setWorkers(fakeWorkers); director.setWorkers(fakeWorkers); try { await servicePromise.then(value => value.stop()) } catch {} },
    stop() { if (!running) return; running = false; chat.cancel(roomId); director.cancel(roomId); void servicePromise.then(value => value.stop()).catch(() => {}); emit({ type: 'connection.state', state: 'disconnected' }) },
    refresh() {
      if (!running) return
      room = readRoom()
      core.projectRoom(room, 'android:refresh')
      emit({ type: 'core.resync', reason: 'manual', revision: core.getView().revision, view: core.getView() })
    },
    async dispatch(command) { if (!running) return; await core.dispatch(command); emit({ type: 'core.resync', reason: 'command', revision: core.getView().revision, view: core.getView() }) },
    async cancel(requestId) { await core.cancel(requestId) },
    getRoom: () => readRoom(),
    chat, director, management,
    setWorkers(next) {
      chat.setWorkers(next)
      director.setWorkers(next)
    },
    dispose() { if (!running) return; chat.dispose(); director.dispose(); void container.dispose(); void servicePromise.then(value => value.stop()).catch(() => {}); running = false },
  }
}

function createLazyLlmService(promise: Promise<import('../sdk/authoring.ts').LlmSystemService>): import('../sdk/authoring.ts').LlmSystemService {
  let resolved: import('../sdk/authoring.ts').LlmSystemService | undefined
  void promise.then(value => { resolved = value }).catch(() => undefined)
  const awaitService = async () => promise
  return {
    get status() { return resolved?.status ?? 'ready' }, listDrivers: () => resolved?.listDrivers() ?? [], listModels: providerId => resolved?.listModels(providerId) ?? [], listCredentialProfiles: () => resolved?.listCredentialProfiles() ?? [], getCredentialProfile: profileId => resolved?.getCredentialProfile(profileId),
    discoverModels: profileId => awaitService().then(value => value.discoverModels(profileId)), upsertCredentialProfile: profile => awaitService().then(value => value.upsertCredentialProfile(profile)), deleteCredentialProfile: profileId => awaitService().then(value => value.deleteCredentialProfile(profileId)), setCredentialSecret: (profileId, secret) => awaitService().then(value => value.setCredentialSecret(profileId, secret)), hasCredentialSecret: profileId => awaitService().then(value => value.hasCredentialSecret(profileId)), getRouteDefaults: () => resolved?.getRouteDefaults() ?? {}, setRouteDefault: (purpose, value) => awaitService().then(service => service.setRouteDefault(purpose, value)), route: input => awaitService().then(value => value.route(input)), complete: input => (async function* () { yield* (await awaitService()).complete(input) })(), cancel: requestId => awaitService().then(value => value.cancel(requestId)), recordUsage: record => awaitService().then(value => value.recordUsage(record)), queryUsage: filter => awaitService().then(value => value.queryUsage(filter)), aggregateUsage: filter => awaitService().then(value => value.aggregateUsage(filter)), stop: () => awaitService().then(value => value.stop()),
  }
}
