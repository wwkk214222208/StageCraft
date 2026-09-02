/**
 * NativeOperationRegistry —— JavaScript bridge 操作面的进程归属唯一事实来源。
 *
 * HTTP 路由归属（src/api-route-registry.ts）不能替代 JS interface 的能力隔离。
 * 本模块同时表达"当前暴露面"与"目标暴露面"：
 *
 *  - owner（目标态）：core-native 只注册进 Core WebView 暴露面；main-host 只注册进主 WebView
 *    暴露面；forbidden 两侧均不得注册。两份目标 allowlist 必须不相交（测试以真实 Java 分派键证明）。
 *  - legacyExposure（当前态）：`legacy-main-core` 表示该操作今天仍可从主 WebView 经通用
 *    invokeSync/invokeAsync 入口执行——这是迁移期例外，如实登记；Java 分派层的
 *    legacyCoreBridgeEnabled 翻转后，通用入口拒绝主 WebView 对 core-native 的跨 owner 调用。
 *  - 新建的主/Core bridge 从第一天起必须执行各自 allowlist；legacy 例外集合封闭，不得新增 operation。
 *
 * 迁移决策（何时翻转 legacyCoreBridgeEnabled、移除哪些例外）属于项目治理，见 governance/。
 */

export type NativeOperationOwner = 'core-native' | 'main-host' | 'forbidden'
/** 当前态：main=仅主 WebView；core=仅 Core WebView；legacy-main-core=主 WebView 经 legacy 通用入口可达（迁移期例外）；none=当前不可达。 */
export type LegacyExposure = 'main' | 'core' | 'legacy-main-core' | 'none'

export interface NativeOperation {
  /** invokeSync/invokeAsync 的 operation 名，或直接 JS interface 方法名。 */
  name: string
  owner: NativeOperationOwner
  /** surface 说明该操作经哪个通道进入：generic bridge dispatch 或直接 interface 方法。 */
  surface: 'generic-dispatch' | 'interface-method'
  legacyExposure: LegacyExposure
  note?: string
}

const coreNativeOperations: NativeOperation[] = [
  { name: 'asset.read', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'asset.write', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'asset.remove', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'secret.get', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core', note: '只对 Core runtime 开放；插件 API 只得受控模型请求能力（§5.5）。' },
  { name: 'secret.set', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core', note: 'provider key 写入只发生在 Core 进程。' },
  { name: 'secret.remove', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'core-state.commit', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'core-state.restore', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'stagecraft.room.get', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'stagecraft.repository', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'stories.list', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'story.read', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'story.create', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'story.delete', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'story.save', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'story.saveAs', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'preset.list', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'preset.save', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'preset.delete', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'preset.active-scope.set', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'prompt.gameplay.list', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core', note: '读取打包 assets/web/gameplay 场景（与桌面 prompts/gameplay 同源）。' },
  { name: 'archive.list', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core', note: '存档文件存储迁入 Core 进程（与 ApiRouteRegistry archive owner 一致）。' },
  { name: 'archive.load', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'archive.save', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'archive.delete', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  { name: 'model.request', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core', note: '流式回调经进程内桥逐事件投递；凭据不回传页面（§5.5）。' },
  { name: 'model.cancel', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'legacy-main-core' },
  // v2 host.storage（逐能力授权）：仅 Core WebView 可达，不是 legacy 迁移期例外。
  { name: 'storage.read', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'core', note: 'v2 每组件命名空间 KV（host.storage 能力）；caller 必须携带组件身份并已声明 host.storage 能力。' },
  { name: 'storage.write', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'core', note: '同 storage.read；原子替换写。' },
  { name: 'v2-secret.get', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'core', note: 'v2 host.secrets；Keystore-backed, namespaced by caller component.' },
  { name: 'v2-secret.set', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'core', note: 'v2 host.secrets；secret never enters ordinary component storage.' },
  { name: 'v2-secret.delete', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'core' },
  { name: 'v2-secret.has', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'core' },
]

const mainHostOperations: NativeOperation[] = [
  { name: 'localCoreAllowed', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main' },
  { name: 'ready', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main' },
  { name: 'pair', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: '远程配对；凭据不进入页面。' },
  { name: 'adbPair', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: 'ADB reverse 免码直连（/api/remote/device-token）；凭据不进入页面。' },
  { name: 'reconnect', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main' },
  { name: 'disconnect', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main' },
  { name: 'refresh', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main' },
  { name: 'dispatch', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: '远程模式命令传输通道（RemoteCoreConnection）；本地模式命令走同源 gateway，不经此口。' },
  { name: 'loadMedia', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main' },
  { name: 'chooseStoryArchive', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: 'SAF 文件选择属宿主边界（§1.4）；选中的内容交给 core owner API 处理。' },
  // v2 组件管理面（M5/M6，此前 synchronized 方法漏测漏登记，2026-09-02 收口）
  { name: 'getV2ComponentState', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: 'v2 Component Store 状态读取（installed/plan/recovery）。' },
  { name: 'installV2Component', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: 'v2 组件 zip 安装（SAF uri）。' },
  { name: 'selectV2Core', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: '选择外部 v2 Core，需 acknowledgeRisk。' },
  { name: 'setV2PluginEnabled', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: '启用/停用外部 v2 ordinary plugin，需 acknowledgeRisk + 有效外部 Core plan。' },
  { name: 'selectV2Rescue', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: '清空 v2 plan 回到内置 rescue Core。' },
  { name: 'setV2SafeMode', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: 'v2 安全模式开关（回落 last-good plan）。' },
  { name: 'clearV2Quarantine', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: '清除 v2 Core 隔离记录。' },
  { name: 'chooseV2Component', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: 'SAF 选择 v2 组件 zip（宿主边界）；安装经 installV2Component。' },
  { name: 'chooseCharacterCard', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main' },
  { name: 'exportDocument', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main' },
  { name: 'syncStatus', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main' },
  { name: 'syncPair', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main' },
  { name: 'syncAdbPair', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: 'ADB reverse 免码直连（/api/remote/device-token）后保存会话，供设置页「与电脑同步」使用。' },
  { name: 'syncRemoteFetch', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main' },
  { name: 'updateDownloadAndInstall', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main' },
  { name: 'clearSession', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main' },
  { name: 'getPluginState', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: '插件管理状态读取（desired/effective/quarantined/catalog）；Core 不可用时仍可用。' },
  { name: 'setPluginEnabled', owner: 'main-host', surface: 'interface-method', legacyExposure: 'main', note: '插件启用意图修改（改配置 → 重启 Core 生效）。' },
]

/**
 * legacy 通用入口本身：迁移期主 WebView 仍经它执行 core-native 操作（如实登记的迁移期例外）。
 * 目标态：主 WebView 只暴露 main-host；invokeSync/invokeAsync 的 core-native 通道在
 * legacyCoreBridgeEnabled 翻转后关闭。
 */
const legacyGenericEntry: NativeOperation[] = [
  { name: 'invokeSync', owner: 'main-host', surface: 'interface-method', legacyExposure: 'legacy-main-core', note: 'legacy 通用入口（迁移期例外）：主 WebView 经此调用 core-native 操作；legacyCoreBridgeEnabled 翻转后 Java 分派层拒绝主 WebView 的跨 owner 调用。' },
  { name: 'invokeAsync', owner: 'main-host', surface: 'interface-method', legacyExposure: 'legacy-main-core', note: '同 invokeSync：legacy 通用入口（迁移期例外），legacyCoreBridgeEnabled 翻转后拒绝跨 owner 调用。' },
]

export const NATIVE_OPERATIONS: readonly NativeOperation[] = [
  ...coreNativeOperations,
  ...mainHostOperations,
  ...legacyGenericEntry,
]

/** 目标态 allowlist：Core WebView 暴露面（新建 Core bridge 第一天起强制执行）。 */
export function coreNativeAllowlist(): string[] {
  return coreNativeOperations.map(operation => operation.name)
}

/** 目标态 allowlist：主 WebView 暴露面（新建主进程 bridge 第一天起强制执行）。 */
export function mainHostAllowlist(): string[] {
  return mainHostOperations.map(operation => operation.name)
}

/**
 * 迁移期封闭例外：今天可从主 WebView 经 legacy 通用入口执行的 core-native 操作集合。
 * 该集合只允许收缩（legacyCoreBridgeEnabled 翻转后清零），不得新增。
 */
export function legacyMainCoreException(): string[] {
  return NATIVE_OPERATIONS
    .filter(operation => operation.legacyExposure === 'legacy-main-core' && operation.owner === 'core-native')
    .map(operation => operation.name)
}

/** 目标态不相交 + legacy 迁移期例外封闭性校验（测试必须穷举真实 Java 分派键证明，而非只比 owner 字符串）。 */
export function assertDisjointExposure(): void {
  const mainHost = new Set(mainHostAllowlist())
  const overlap = coreNativeAllowlist().filter(name => mainHost.has(name))
  if (overlap.length) throw new Error(`目标暴露面交集：${overlap.join(', ')}`)
  for (const operation of NATIVE_OPERATIONS) {
    if (operation.owner === 'forbidden' && operation.legacyExposure !== 'none') {
      throw new Error(`forbidden 操作 ${operation.name} 不得保留任何 legacy 暴露面`)
    }
    if (operation.legacyExposure === 'legacy-main-core' && operation.surface !== 'interface-method' && operation.owner !== 'core-native') {
      throw new Error(`${operation.name} 的 legacy-main-core 例外只允许落在 core-native generic-dispatch 或通用入口上`)
    }
  }
  const genericEntries = legacyGenericEntry.map(operation => operation.name)
  for (const operation of NATIVE_OPERATIONS) {
    if (operation.legacyExposure === 'legacy-main-core' && !genericEntries.includes(operation.name) && operation.surface !== 'generic-dispatch') {
      throw new Error(`${operation.name} 不得绕过封闭的 legacy 通用入口`)
    }
  }
}
