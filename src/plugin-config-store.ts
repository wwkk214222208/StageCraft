/**
 * PluginConfigStore 实现（评审修订）：主进程配置持久化不依赖 Core——Core 从未启动或已
 * crashed 时仍可读写（阶段 1 验收锚点）。
 *
 * - InMemoryPluginConfigStore：测试与 harness。
 * - createNodeFilePluginConfigStore：桌面/Node 侧参考实现（单 JSON 文件，原子替换写）。
 * - Android 主进程的 Java 实现（PluginConfigStore.java，只持久化
 *   desiredEnabled/config 并展示隔离记录，不实现依赖拓扑规则）。
 *
 * 本模块不得 import Core runtime；规则实现只在 src/plugin-bootstrap.ts。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PluginConfigStore, PluginLaunchPlan, QuarantineRecord } from './plugin-contract.ts'

const STORE_FORMAT_VERSION = 1

interface PersistedState {
  formatVersion: number
  updatedAt: string
  config: Record<string, unknown>
  enabled: Record<string, boolean>
  quarantine: QuarantineRecord[]
  launchPlan: PluginLaunchPlan | null
}

function emptyState(): PersistedState {
  return { formatVersion: STORE_FORMAT_VERSION, updatedAt: new Date(0).toISOString(), config: {}, enabled: {}, quarantine: [], launchPlan: null }
}

export function createInMemoryPluginConfigStore(): PluginConfigStore {
  const state = emptyState()
  return {
    readConfig: () => structuredClone(state.config),
    writeConfig: (id, config) => { touch(); if (config === undefined) delete state.config[id]; else state.config[id] = structuredClone(config) },
    readEnabled: () => structuredClone(state.enabled),
    writeEnabled: (id, enabled) => { touch(); state.enabled[id] = enabled },
    readQuarantine: () => structuredClone(state.quarantine),
    writeQuarantine: records => { touch(); state.quarantine = structuredClone(records) },
    readLaunchPlan: () => (state.launchPlan ? structuredClone(state.launchPlan) : null),
    writeLaunchPlan: plan => { touch(); state.launchPlan = structuredClone(plan) },
  }

  function touch(): void { state.updatedAt = new Date().toISOString() }
}

export interface FilePluginConfigStoreOptions {
  /** 读写失败时的兜底：例如文件损坏时以空状态起步而不抛出（Core 不可用时管理器必须仍可用）。 */
  onCorrupt?: (error: unknown) => void
}

export function createNodeFilePluginConfigStore(filePath: string, options: FilePluginConfigStoreOptions = {}): PluginConfigStore {
  const load = (): PersistedState => {
    try {
      const raw = readFileSync(filePath, 'utf8') as string
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      if (!parsed || parsed.formatVersion !== STORE_FORMAT_VERSION) throw new Error(`unsupported store format: ${String(parsed?.formatVersion)}`)
      return {
        formatVersion: STORE_FORMAT_VERSION,
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
        config: parsed.config ?? {},
        enabled: parsed.enabled ?? {},
        quarantine: parsed.quarantine ?? [],
        launchPlan: parsed.launchPlan ?? null,
      }
    } catch (error) {
      options.onCorrupt?.(error)
      return emptyState()
    }
  }

  const persist = (state: PersistedState): void => {
    state.updatedAt = new Date().toISOString()
    // 原子替换：先写临时文件再 rename，避免中断产生半截 JSON。
    const temporary = `${filePath}.tmp`
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8')
    renameSync(temporary, filePath)
  }

  return {
    readConfig: () => structuredClone(load().config),
    writeConfig: (id, config) => { const state = load(); if (config === undefined) delete state.config[id]; else state.config[id] = structuredClone(config); persist(state) },
    readEnabled: () => structuredClone(load().enabled),
    writeEnabled: (id, enabled) => { const state = load(); state.enabled[id] = enabled; persist(state) },
    readQuarantine: () => structuredClone(load().quarantine),
    writeQuarantine: records => { const state = load(); state.quarantine = structuredClone(records); persist(state) },
    readLaunchPlan: () => load().launchPlan ? structuredClone(load().launchPlan!) : null,
    writeLaunchPlan: plan => { const state = load(); state.launchPlan = structuredClone(plan); persist(state) },
  }
}
