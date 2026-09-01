/** StageCraft v2 component contract draft. Pure types/data: no Node, DOM or loader dependency. */

export const COMPONENT_SCHEMA_VERSION = '0.1' as const
export const COMPONENT_HOST_API_VERSION = '0.1' as const

export type ComponentType = 'core' | 'plugin'
export type PluginCategory = 'llm-system' | 'provider-driver' | 'solution' | 'tool' | 'effect' | 'ui' | 'composite'

export interface ComponentEntrypoints {
  /** Browser-compatible ESM entry required by every executable component. */
  runtime: string
  /** Optional ESM UI surface entry. */
  ui?: string
}

export interface ComponentApiRequirement { version: string }

export interface ComponentDependency {
  id: string
  version: string
  optional?: boolean
}

export interface ComponentCapabilities {
  required?: readonly string[]
  optional?: readonly string[]
}

export interface ComponentIntegrity {
  /** Integrity strings are opaque in M3; this contract does not claim signature verification. */
  runtime: string
  ui?: string
}

export interface ComponentManifest {
  schemaVersion: typeof COMPONENT_SCHEMA_VERSION
  id: string
  version: string
  title: string
  componentType: ComponentType
  /** Required only for componentType=plugin; forbidden for core. */
  pluginCategory?: PluginCategory
  entrypoints: ComponentEntrypoints
  hostApi?: ComponentApiRequirement
  coreApi?: ComponentApiRequirement
  dependencies?: readonly ComponentDependency[]
  capabilities?: ComponentCapabilities
  integrity: ComponentIntegrity
}

export interface ComponentSelection {
  id: string
  version: string
  manifestHash: string
}

export interface ComponentLaunchPlan {
  planVersion: typeof COMPONENT_SCHEMA_VERSION
  hostApiVersion: string
  /** The one exclusive Core slot. Ordinary plugins must never appear here. */
  core: ComponentSelection
  /** Ordinary plugins only; a core manifest here is invalid. */
  plugins: readonly ComponentSelection[]
  stateSchemaVersion: string
  planHash: string
}

export type ComponentOrigin = 'bundled' | 'local'

export interface ComponentRecord {
  manifest: ComponentManifest
  origin: ComponentOrigin
  installedAt?: string
  metadata?: Readonly<Record<string, unknown>>
}
