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
import type { CoreLlmRouterPlugin, Disposable } from '../core/plugins.ts'
import type { CoreStateRepository } from '../core/state-repository.ts'
import type { ModelTransport } from '../core/platform.ts'

/** Native repository adapter: Android owns bytes/transactions; domain behavior remains here. */
export function createAndroidRepository(operations: NativeOperations): StageCraftRepository {
  const call = (method: string, args: unknown[]): unknown => {
    const result = operations.invokeSync?.('stagecraft.repository', { method, args })
    if (result === undefined) throw new Error('Android repository calls must be synchronous.')
    return result
  }
  return new Proxy({}, { get: (_target, property: string) => (...args: unknown[]) => call(property, args) }) as StageCraftRepository
}

class NativeCoreLlmRouter implements CoreLlmRouterPlugin {
  readonly id = 'stagecraft.llm.android-native'
  private host?: import('../core/plugins.ts').CoreLlmRouterHost
  private readonly transport: ModelTransport
  constructor(transport: ModelTransport) { this.transport = transport }
  install(host: import('../core/plugins.ts').CoreLlmRouterHost): Disposable {
    this.host = host
    return { dispose: () => { this.host = undefined } }
  }
  async request(request: import('../core/protocol.ts').ModelRequest): Promise<void> {
    if (!this.host) throw new Error('Android model router is disposed.')
    const result = await this.transport.request(request)
    await this.host.submitModelResult(result)
  }
  async cancel(requestId: string): Promise<void> { await this.transport.cancel?.(requestId) }
}

export type AndroidComposition = {
  readonly core: CoreRuntimeSkeleton
  readonly roomId: string
  readonly start: () => void
  readonly stop: () => void
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
}

/** Boots the real shared StageCraft solution in the WebView, never a Java domain replica. */
export function createAndroidComposition(operations: NativeOperations, options: { roomId?: string; workers?: WorkerSet; onMessage?: (message: unknown) => void } = {}): AndroidComposition {
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
  const bindings: Disposable[] = [container.addSolution(new StageCraftSolutionPlugin({ chat, director, management, defaultRoomId: roomId })), container.addLlm(new NativeCoreLlmRouter(composition.model))]
  const state: CoreStateRepository = composition.state
  bindings.push(core.attachStateRepository(state))
  const emit = (message: unknown): void => options.onMessage?.(message)
  let running = false
  return {
    core, roomId,
    start() { if (running) return; running = true; room = readRoom(); core.restoreState(roomId); core.projectRoom(room, 'android:start'); emit({ type: 'connection.state', state: 'connected' }); emit({ type: 'core.resync', reason: 'initial', revision: core.getView().revision, view: core.getView() }) },
    stop() { if (!running) return; running = false; chat.cancel(roomId); director.cancel(roomId); emit({ type: 'connection.state', state: 'disconnected' }) },
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
    dispose() { if (!running) return; chat.dispose(); director.dispose(); void container.dispose(); running = false },
  }
}
