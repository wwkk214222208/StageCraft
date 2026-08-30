/**
 * PluginContract —— 插件清单、状态、依赖与能力类型（PLUGIN-MANAGER-DESIGN §3.2/3.3 + 计划 v0.4 §2.4/§6.3/§7.4）。
 *
 * 本模块必须保持零依赖（不 import node:* / DOM）：Core 进程 WebView、桌面与测试共用同一套类型与语义。
 * 深度校验唯一实现在 src/plugin-bootstrap.ts；主进程 Java 只持久化 desiredEnabled 与展示，不得复制规则。
 */

/** 装配类别（计划 §2.4：core/repository/human/llm/solution 五类 + composite 聚合）。 */
export type PluginKind = 'core' | 'repository' | 'human' | 'llm' | 'solution' | 'composite'

export interface PluginProvides {
  stateModules?: string[]
  stateSchemas?: string[]
  proposalTypes?: string[]
  recordCollections?: string[]
  effectHandlers?: string[]
  promptContributors?: string[]
  uiManifests?: string[]
}

export interface PluginRequires {
  /** 依赖的其他插件 id；版本范围 v1 不做 semver 区间，只要求 id 存在。 */
  plugins?: string[]
  /** 声明兼容的 Core API 版本（如 '1.1'）。 */
  coreApi?: string
}

export interface PluginManifest {
  id: string
  version: string
  kind: PluginKind
  title: string
  author?: string
  description?: string
  /** 静态声明本插件会占用的 ID，加载前冲突预检（provides 冲突 → quarantined）。 */
  provides?: PluginProvides
  requires?: PluginRequires
  /** 权限声明（§5 安全）：用户在管理器可见，不做沙盒强制。 */
  capabilities?: string[]
  /** 本插件写入的状态模块所属 schema 版本；存档导入时参与兼容判定（§7.4）。 */
  stateSchemaVersion?: string
}

/** D1 无热加载：状态机只剩启用标记 + 装载结果（disabled 仅表示 desiredEnabled=false）。 */
export type PluginState = 'enabled' | 'disabled' | 'quarantined'

/** 装载期隔离记录（计划 §6.3）：Core bootstrap 产出，经控制面摘要 + 数据面完整记录上报主进程。 */
export interface QuarantineRecord {
  pluginId: string
  manifestVersion: string
  manifestHash: string
  reason: string
  stage: 'manifest' | 'dependency' | 'install' | 'state-restore'
  at: string
}

export interface PluginLoadReport {
  /** effective：desiredEnabled 且未被隔离、装载成功的插件（按依赖拓扑序）。 */
  enabled: string[]
  disabled: string[]
  quarantined: QuarantineRecord[]
  /** 任一必需装载失败时为 true：Core 可进入 degraded/failed，但主进程管理器必须仍可用（§6.3）。 */
  degraded: boolean
}

/** 不可变启动计划（计划 §2.4）：运行期不热替换；变更必须停止旧 Core → 新 plan → 新 Core。 */
export interface PluginLaunchPlan {
  protocolVersion: string
  pluginSetHash: string
  plugins: ReadonlyArray<{
    readonly id: string
    readonly version: string
    readonly manifestHash: string
    readonly enabled: boolean
    readonly config?: unknown
  }>
  stateSchemaVersion: string
}

/** 存档插件依赖快照（§7.4）：导出时写入；导入时逐条判定。 */
export interface PluginDependencySnapshot {
  id: string
  version: string
  manifestHash: string
  stateSchemaVersion?: string
  /** 可选插件缺失允许只读/降级；缺省视为必需（禁止产生新剧情）。 */
  required?: boolean
}

export type ArchiveDependencyVerdict =
  | { verdict: 'ok' }
  | { verdict: 'degraded'; missing: string[]; reason: string }
  | { verdict: 'blocked'; missing: string[]; incompatible: string[]; reason: string }

/** 配置存储独立于 Core；Core 从未启动成功时也必须可读写（由主进程实现）。 */
export interface PluginConfigStore {
  readConfig(): Record<string, unknown>
  writeConfig(id: string, config: unknown): void
  readEnabled(): Record<string, boolean>
  writeEnabled(id: string, enabled: boolean): void
  readQuarantine(): QuarantineRecord[]
  writeQuarantine(records: QuarantineRecord[]): void
  readLaunchPlan(): PluginLaunchPlan | null
  writeLaunchPlan(plan: PluginLaunchPlan): void
}
