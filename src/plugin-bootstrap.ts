/**
 * PluginBootstrap —— 清单校验、依赖拓扑、provides 冲突预检、逐插件失败隔离与 LaunchPlan 生成（W3；计划 §6.3/§2.4/§7.4）。
 *
 * 深度校验唯一实现（Q4 裁决）：Core 进程 bootstrap 与桌面复用本模块；主进程 Java 不得复制规则。
 * 校验顺序（单插件粒度，失败 → quarantined 并继续装载其余插件）：
 *   manifest 校验失败 → stage 'manifest'
 *   依赖缺失 / 环 / provides 冲突 / coreApi 不匹配 → stage 'dependency'
 *   install() 抛错 → stage 'install'
 * 本模块零运行时依赖，可在 Core WebView 与 Node 侧执行。
 */

import type {
  PluginDependencySnapshot,
  PluginKind,
  PluginLaunchPlan,
  PluginLoadReport,
  PluginManifest,
  PluginProvides,
  PluginRequires,
  QuarantineRecord,
  ArchiveDependencyVerdict,
} from './plugin-contract.ts'
import { CORE_PROTOCOL_VERSION } from './core/protocol.ts'

const PLUGIN_KINDS: readonly PluginKind[] = ['core', 'repository', 'human', 'llm', 'solution', 'composite']
const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
const PROVIDE_KEYS: readonly (keyof PluginProvides)[] = [
  'stateModules', 'stateSchemas', 'proposalTypes', 'recordCollections', 'effectHandlers', 'promptContributors', 'uiManifests',
]

/** 确定性 FNV-1a 32bit 哈希（十六进制）：仅用于构建期一致性核对，不做安全用途。 */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** manifest 规范化 JSON（键序确定）→ hash。同一清单在任何宿主必须得到同一 hash。 */
export function manifestHash(manifest: PluginManifest): string {
  return stableHash(stableStringify(manifest))
}

/** 确定性 JSON 序列化：对象键排序，数组保序。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/** manifest 校验：返回错误列表（空 = 通过）。 */
export function validateManifest(manifest: PluginManifest): string[] {
  const errors: string[] = []
  if (!manifest || typeof manifest !== 'object') return ['manifest 必须是对象']
  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) errors.push(`id 非法（需反向域名小写，如 "stagecraft.chat"）: ${String(manifest.id)}`)
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) errors.push(`version 非法（需 semver）: ${String(manifest.version)}`)
  if (!PLUGIN_KINDS.includes(manifest.kind)) errors.push(`kind 非法（${PLUGIN_KINDS.join('/')}）: ${String(manifest.kind)}`)
  if (typeof manifest.title !== 'string' || !manifest.title.trim()) errors.push('title 缺失')
  if (manifest.requires && !Array.isArray(manifest.requires.plugins) && typeof manifest.requires.coreApi !== 'string') errors.push('requires 形状非法')
  if (manifest.provides) {
    for (const key of PROVIDE_KEYS) {
      const list = manifest.provides[key]
      if (list !== undefined && (!Array.isArray(list) || list.some(entry => typeof entry !== 'string'))) errors.push(`provides.${key} 必须是字符串数组`)
    }
  }
  return errors
}

export interface ProvidesConflict {
  id: string
  ownerA: string
  ownerB: string
}

/** provides 冲突预检：同一 provide id 被多个插件声明 → 冲突（load 前拒绝）。 */
export function checkProvidesConflicts(manifests: readonly PluginManifest[]): ProvidesConflict[] {
  const owner = new Map<string, string>()
  const conflicts: ProvidesConflict[] = []
  for (const manifest of manifests) {
    for (const key of PROVIDE_KEYS) {
      for (const provided of manifest.provides?.[key] ?? []) {
        const qualified = `${key}:${provided}`
        const previous = owner.get(qualified)
        if (previous && previous !== manifest.id) conflicts.push({ id: qualified, ownerA: previous, ownerB: manifest.id })
        else owner.set(qualified, manifest.id)
      }
    }
  }
  return conflicts
}

/** 依赖拓扑排序：返回装载顺序；环抛错（stage 'dependency'）。 */
export function resolveLoadOrder(manifests: readonly PluginManifest[]): PluginManifest[] {
  const byId = new Map(manifests.map(manifest => [manifest.id, manifest]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const ordered: PluginManifest[] = []
  const visit = (manifest: PluginManifest): void => {
    if (visited.has(manifest.id)) return
    if (visiting.has(manifest.id)) throw new Error(`插件依赖成环：${[...visiting, manifest.id].join(' -> ')}`)
    visiting.add(manifest.id)
    for (const dependencyId of manifest.requires?.plugins ?? []) {
      const dependency = byId.get(dependencyId)
      if (dependency) visit(dependency)
    }
    visiting.delete(manifest.id)
    visited.add(manifest.id)
    ordered.push(manifest)
  }
  for (const manifest of manifests) visit(manifest)
  return ordered
}

export interface BootstrapInput {
  manifests: readonly PluginManifest[]
  /** desiredEnabled：主进程 PluginConfigStore 的启用意图（缺省视为启用）。 */
  desiredEnabled?: Record<string, boolean>
  /** 宿主提供的装载器：把 manifest 装进容器，返回 Disposable。按单插件粒度 try/catch。 */
  install: (manifest: PluginManifest) => { dispose: () => void } | void
  /** Core API 版本要求（requires.coreApi 不匹配 → stage 'dependency'）。 */
  coreApiVersion?: string
  now?: () => string
}

export interface BootstrapResult {
  report: PluginLoadReport
  disposables: Array<{ dispose: () => void }>
}

/**
 * 逐插件装载（§6.3）：任一失败只隔离该插件并继续；失败插件是必要插件时由调用方
 * 依据 report.degraded 决定 Core 进入 degraded/failed——主进程管理器始终可用。
 *
 * 评审修订（CP-W1 后短周期）：
 *  - provides 冲突只在"启用意图"集合内计算——被禁用的插件不参与，避免误伤正常插件；
 *  - 安装前逐条校验依赖满足：缺失 / 被禁用 / 被隔离 / 装载失败的依赖都会阻断依赖者（stage 'dependency'）；
 *  - 装载顺序仍按依赖拓扑，成环时全部隔离。
 */
export function bootstrapPlugins(input: BootstrapInput): BootstrapResult {
  const now = input.now ?? (() => new Date().toISOString())
  const quarantined: QuarantineRecord[] = []
  const enabled: string[] = []
  const disabled: string[] = []
  const disposables: Array<{ dispose: () => void }> = []
  const desiredOff = (id: string): boolean => input.desiredEnabled?.[id] === false

  // 重复 id：同一插件身份在候选集出现多次属于包装错误——保留首次出现，后续出现按 'manifest' 隔离。
  const firstOccurrence = new Map<string, PluginManifest>()
  for (const manifest of input.manifests) {
    if (!firstOccurrence.has(manifest.id)) firstOccurrence.set(manifest.id, manifest)
  }
  const isFirstOccurrence = (manifest: PluginManifest): boolean => firstOccurrence.get(manifest.id) === manifest

  const active = input.manifests.filter(manifest => !desiredOff(manifest.id) && isFirstOccurrence(manifest))
  for (const manifest of input.manifests) {
    if (desiredOff(manifest.id)) {
      if (isFirstOccurrence(manifest)) disabled.push(manifest.id)
      continue
    }
    if (!isFirstOccurrence(manifest)) {
      quarantined.push(record(manifest, `插件 id 重复：${manifest.id} 在候选集中出现多次`, 'manifest', now()))
    }
  }
  const conflicts = new Set(checkProvidesConflicts(active).flatMap(conflict => [`${conflict.ownerA}:${conflict.id}`, `${conflict.ownerB}:${conflict.id}`]))
  const byId = new Map(active.map(manifest => [manifest.id, manifest]))

  let ordered: PluginManifest[]
  try {
    ordered = resolveLoadOrder(active)
  } catch (error) {
    // 环：无法确定顺序，全部隔离（stage 'dependency'），不装载任何插件。
    for (const manifest of active) {
      quarantined.push(record(manifest, error instanceof Error ? error.message : String(error), 'dependency', now()))
    }
    return { report: { enabled, disabled, quarantined, degraded: true }, disposables }
  }

  const installed = new Set<string>()
  for (const manifest of ordered) {
    const manifestErrors = validateManifest(manifest)
    if (manifestErrors.length) {
      quarantined.push(record(manifest, manifestErrors.join('；'), 'manifest', now()))
      continue
    }
    if (manifest.requires?.coreApi && input.coreApiVersion && manifest.requires.coreApi !== input.coreApiVersion) {
      quarantined.push(record(manifest, `coreApi 不匹配：需要 ${manifest.requires.coreApi}，宿主为 ${input.coreApiVersion}`, 'dependency', now()))
      continue
    }
    const conflicted = [...conflicts].some(entry => entry.startsWith(`${manifest.id}:`))
    if (conflicted) {
      quarantined.push(record(manifest, 'provides 与其他插件冲突', 'dependency', now()))
      continue
    }
    const unmet = unmetDependency(manifest, { byId, installed, quarantinedIds: new Set(quarantined.map(item => item.pluginId)), disabledSet: new Set(disabled) })
    if (unmet) {
      quarantined.push(record(manifest, unmet, 'dependency', now()))
      continue
    }
    try {
      const disposable = input.install(manifest)
      if (disposable) disposables.push(disposable)
      installed.add(manifest.id)
      enabled.push(manifest.id)
    } catch (error) {
      quarantined.push(record(manifest, error instanceof Error ? error.message : String(error), 'install', now()))
    }
  }
  return { report: { enabled, disabled, quarantined, degraded: quarantined.length > 0 }, disposables }

  /** 依赖满足检查：返回第一个未满足原因（null = 满足）。 */
  function unmetDependency(
    manifest: PluginManifest,
    context: { byId: Map<string, PluginManifest>; installed: Set<string>; quarantinedIds: Set<string>; disabledSet: Set<string> },
  ): string | null {
    for (const dependencyId of manifest.requires?.plugins ?? []) {
      if (context.disabledSet.has(dependencyId)) return `依赖被禁用：${dependencyId}`
      if (!context.byId.has(dependencyId)) return `依赖缺失：${dependencyId} 不在候选集内`
      if (context.quarantinedIds.has(dependencyId)) return `依赖未装载成功（被隔离或 install 失败）：${dependencyId}`
      if (!context.installed.has(dependencyId)) return `依赖未装载成功：${dependencyId}`
    }
    return null
  }

  function record(manifest: PluginManifest, reason: string, stage: QuarantineRecord['stage'], at: string): QuarantineRecord {
    return { pluginId: manifest.id, manifestVersion: manifest.version, manifestHash: manifestHash(manifest), reason, stage, at }
  }
}

export interface LaunchPlanInput {
  manifests: readonly PluginManifest[]
  desiredEnabled?: Record<string, boolean>
  config?: Record<string, unknown>
  /** 装载结果：被隔离/禁用的插件不得进入 plan 的 enabled 集（effective = desired - quarantined）。 */
  quarantinedIds?: readonly string[]
  stateSchemaVersion: string
}

/** 生成不可变 PluginLaunchPlan（§2.4）：pluginSetHash 由排序后的 (id,version,manifestHash,enabled) 决定。 */
export function buildPluginLaunchPlan(input: LaunchPlanInput): PluginLaunchPlan {
  const seen = new Set<string>()
  for (const manifest of input.manifests) {
    if (seen.has(manifest.id)) throw new Error(`buildPluginLaunchPlan：候选集存在重复插件 id ${manifest.id}（包装错误，须先经 bootstrapPlugins 隔离）。`)
    seen.add(manifest.id)
  }
  const quarantined = new Set(input.quarantinedIds ?? [])
  const plugins = [...input.manifests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(manifest => {
      // config 未配置时省略键：保证 JSON 持久化（PluginConfigStore）与内存形状一致。
      const plugin: { id: string; version: string; manifestHash: string; enabled: boolean; config?: unknown } = {
        id: manifest.id,
        version: manifest.version,
        manifestHash: manifestHash(manifest),
        enabled: input.desiredEnabled?.[manifest.id] !== false && !quarantined.has(manifest.id),
      }
      if (input.config?.[manifest.id] !== undefined) plugin.config = input.config[manifest.id]
      return plugin
    })
  const pluginSetHash = stableHash(stableStringify(plugins.map(plugin => [plugin.id, plugin.version, plugin.manifestHash, plugin.enabled])))
  return Object.freeze({
    protocolVersion: CORE_PROTOCOL_VERSION,
    pluginSetHash,
    plugins: Object.freeze(plugins.map(plugin => Object.freeze(plugin))),
    stateSchemaVersion: input.stateSchemaVersion,
  })
}

/** 插件集哈希（health 摘要用）：与 launch plan 同源。 */
export function computePluginSetHash(plan: PluginLaunchPlan): string {
  return plan.pluginSetHash
}

/**
 * 存档依赖判定（§7.4）：全部必需插件存在且版本兼容 → ok；
 * 仅可选缺失 → degraded（只读/明确降级）；必需缺失或版本/schema 不兼容 → blocked（禁止新剧情）。
 *
 * 评审修订：版本必须比较——主版本不同不兼容；当前版本低于存档版本（降级装载）不兼容；
 * 存档声明了 stateSchemaVersion 而当前 manifest 未声明 → 无法证明兼容，按不兼容处理。
 */
export function validateArchiveDependencies(
  snapshot: readonly PluginDependencySnapshot[],
  available: readonly PluginManifest[],
): ArchiveDependencyVerdict {
  const byId = new Map(available.map(manifest => [manifest.id, manifest]))
  const missing: string[] = []
  const optionalMissing: string[] = []
  const incompatible: string[] = []
  for (const entry of snapshot) {
    const manifest = byId.get(entry.id)
    if (!manifest) {
      (entry.required === false ? optionalMissing : missing).push(entry.id)
      continue
    }
    if (!isVersionCompatible(entry.version, manifest.version)) {
      incompatible.push(`${entry.id}: 存档 ${entry.version} 与当前 ${manifest.version} 不兼容（主版本不同或为降级装载）`)
      continue
    }
    if (entry.stateSchemaVersion && !manifest.stateSchemaVersion) {
      incompatible.push(`${entry.id}: 存档声明 stateSchema ${entry.stateSchemaVersion}，当前插件未声明 schema（无法证明兼容）`)
      continue
    }
    if (entry.stateSchemaVersion && manifest.stateSchemaVersion && entry.stateSchemaVersion !== manifest.stateSchemaVersion) {
      incompatible.push(`${entry.id}: 存档 schema ${entry.stateSchemaVersion} ≠ 当前 ${manifest.stateSchemaVersion}`)
    }
  }
  if (missing.length || incompatible.length) {
    return {
      verdict: 'blocked',
      missing,
      incompatible,
      reason: `缺必需插件 [${missing.join(', ')}]；版本/schema 不兼容 [${incompatible.join('；')}]。禁止产生新剧情，进入恢复/只读模式。`,
    }
  }
  if (optionalMissing.length) {
    return { verdict: 'degraded', missing: optionalMissing, reason: `可选插件缺失 [${optionalMissing.join(', ')}]，允许只读或明确降级。` }
  }
  return { verdict: 'ok' }
}

/** 语义化版本兼容：完整 semver（允许 -prerelease/+build 后缀）、主版本相同且当前 >= 存档（组件级比较）。任何不完整或不可解析的版本都视为不兼容。 */
export function isVersionCompatible(archiveVersion: string, currentVersion: string): boolean {
  const archive = parseSemver(archiveVersion)
  const current = parseSemver(currentVersion)
  if (!archive || !current) return false
  if (archive.major !== current.major) return false
  if (current.minor !== archive.minor) return current.minor > archive.minor
  return current.patch >= archive.patch
}

/** 完整匹配（锚定首尾）：'1.2.3garbage' 这类前缀形式必须拒绝，不得截断解析。 */
function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.exec(version)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}
