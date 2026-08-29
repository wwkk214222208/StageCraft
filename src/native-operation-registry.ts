/**
 * NativeOperationRegistry —— JavaScript bridge 操作面的进程归属唯一事实来源（计划 v0.4 §1.4 / Q9 裁决）。
 *
 * HTTP 路由归属（src/api-route-registry.ts）不能替代 JS interface 的能力隔离：
 *  - core-native  ：只允许注册到 Core 进程 Core WebView 的暴露面（CoreNative/WebMessagePort）。
 *  - main-host    ：只允许注册到主进程主 WebView 的暴露面（迁移期别名 StageCraftHost/StageCraftNative）。
 *  - forbidden    ：两侧均不得注册（如曾提议后废弃的操作）。
 *
 * 两套暴露集合的不相交性由 test/native-operation-registry.test.ts 自动断言；
 * 扫描来源：AndroidCompositionOperations.java（invokeSync 分派键）与 src/portable/android-local-core.ts（SYNC_OPERATIONS）。
 */

export type NativeOperationOwner = 'core-native' | 'main-host' | 'forbidden'

export interface NativeOperation {
  /** invokeSync/invokeAsync 的 operation 名，或直接 JS interface 方法名。 */
  name: string
  owner: NativeOperationOwner
  /** surface 说明该操作经哪个通道进入：generic bridge dispatch 或直接 interface 方法。 */
  surface: 'generic-dispatch' | 'interface-method'
  note?: string
}

export const NATIVE_OPERATIONS: readonly NativeOperation[] = [
  // ── Core 平台端口（§5.3：Core 进程独占；Core WebView 暴露面） ──────────────
  { name: 'asset.read', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'asset.write', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'asset.remove', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'secret.get', owner: 'core-native', surface: 'generic-dispatch', note: '只对 Core runtime 开放；插件 API 只得受控模型请求能力（§5.5）。' },
  { name: 'secret.set', owner: 'core-native', surface: 'generic-dispatch', note: 'Q10：provider key 写入只发生在 Core 进程。' },
  { name: 'secret.remove', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'core-state.commit', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'core-state.restore', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'stagecraft.room.get', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'stagecraft.repository', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'stories.list', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'story.read', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'story.create', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'story.delete', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'story.save', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'story.saveAs', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'preset.list', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'preset.save', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'preset.delete', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'preset.active-scope.set', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'archive.list', owner: 'core-native', surface: 'generic-dispatch', note: '存档文件存储随 W5 迁入 Core 进程（与 ApiRouteRegistry archive owner 一致）。' },
  { name: 'archive.load', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'archive.save', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'archive.delete', owner: 'core-native', surface: 'generic-dispatch' },
  { name: 'model.request', owner: 'core-native', surface: 'generic-dispatch', note: '流式回调经进程内桥逐事件投递；凭据不回传页面（§5.5）。' },
  { name: 'model.cancel', owner: 'core-native', surface: 'generic-dispatch' },

  // ── 主进程宿主端口（主 WebView 暴露面；迁移期别名 StageCraftNative） ────────
  { name: 'localCoreAllowed', owner: 'main-host', surface: 'interface-method' },
  { name: 'ready', owner: 'main-host', surface: 'interface-method' },
  { name: 'pair', owner: 'main-host', surface: 'interface-method', note: '远程配对；凭据不进入页面（Q10）。' },
  { name: 'reconnect', owner: 'main-host', surface: 'interface-method' },
  { name: 'disconnect', owner: 'main-host', surface: 'interface-method' },
  { name: 'refresh', owner: 'main-host', surface: 'interface-method' },
  { name: 'dispatch', owner: 'main-host', surface: 'interface-method', note: '远程模式命令传输通道（RemoteCoreConnection）；本地模式命令走同源 gateway，不经此口。' },
  { name: 'loadMedia', owner: 'main-host', surface: 'interface-method' },
  { name: 'chooseStoryArchive', owner: 'main-host', surface: 'interface-method', note: 'SAF 文件选择属宿主边界（§1.4）；选中的内容交给 core owner API 处理。' },
  { name: 'chooseCharacterCard', owner: 'main-host', surface: 'interface-method' },
  { name: 'exportDocument', owner: 'main-host', surface: 'interface-method' },
  { name: 'syncStatus', owner: 'main-host', surface: 'interface-method' },
  { name: 'syncPair', owner: 'main-host', surface: 'interface-method' },
  { name: 'syncRemoteFetch', owner: 'main-host', surface: 'interface-method' },
  { name: 'updateDownloadAndInstall', owner: 'main-host', surface: 'interface-method' },
  { name: 'clearSession', owner: 'main-host', surface: 'interface-method' },
]

export function nativeOperationsByOwner(owner: NativeOperationOwner): string[] {
  return NATIVE_OPERATIONS.filter(operation => operation.owner === owner).map(operation => operation.name)
}

/** 主/Core 两套 WebView 暴露集合必须无交集（Q9：不相交断言）。 */
export function assertDisjointExposure(): void {
  const mainHost = new Set(nativeOperationsByOwner('main-host'))
  const coreNative = nativeOperationsByOwner('core-native')
  const overlap = coreNative.filter(name => mainHost.has(name))
  if (overlap.length) throw new Error(`NativeOperationRegistry 暴露面交集：${overlap.join(', ')}`)
  for (const operation of NATIVE_OPERATIONS) {
    if (operation.owner === 'forbidden' && operation.surface !== 'generic-dispatch') {
      throw new Error(`forbidden 操作 ${operation.name} 不得出现在任何 interface surface`)
    }
  }
}
