import type { ComponentManifest, PluginCategory } from './component-contract.ts'
import { COMPONENT_SCHEMA_VERSION } from './component-contract.ts'

const ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
const API_VERSION = /^\d+\.\d+(?:\.\d+)?$/
const CATEGORIES: readonly PluginCategory[] = ['llm-system', 'provider-driver', 'solution', 'tool', 'effect', 'ui', 'composite']
const FORBIDDEN_ENTRY = /(?:^|[/:])(?:node:[^/]+|file:|data:)|(?:\.so|\.dll|\.dylib|\.dex|\.apk)(?:$|[?#])|(?:^|[\\/])(?:Termux|Java|Kotlin)(?:[\\/]|$)/i

/** Deterministic JSON representation shared by desktop and Android. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/** Deterministic non-cryptographic identity hash; integrity remains an opaque package field. */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0 }
  return hash.toString(16).padStart(8, '0')
}

export function componentManifestHash(manifest: ComponentManifest): string { return stableHash(stableStringify(manifest)) }

export function validateComponentManifest(manifest: ComponentManifest): string[] {
  const errors: string[] = []
  if (!manifest || typeof manifest !== 'object') return ['manifest must be an object']
  if (manifest.schemaVersion !== COMPONENT_SCHEMA_VERSION) errors.push(`schemaVersion must be ${COMPONENT_SCHEMA_VERSION}`)
  if (typeof manifest.id !== 'string' || !ID.test(manifest.id)) errors.push('id must be reverse-domain lowercase')
  if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) errors.push('version must be semver')
  if (typeof manifest.title !== 'string' || !manifest.title.trim()) errors.push('title is required')
  if (manifest.componentType !== 'core' && manifest.componentType !== 'plugin') errors.push('componentType must be core or plugin')
  if (manifest.componentType === 'core' && manifest.pluginCategory !== undefined) errors.push('core must not declare pluginCategory')
  if (manifest.componentType === 'plugin' && !CATEGORIES.includes(manifest.pluginCategory as PluginCategory)) errors.push('plugin must declare a valid pluginCategory')
  if (manifest.componentType === 'core' && !manifest.hostApi) errors.push('core must declare hostApi')
  validateEntrypoints(manifest, errors)
  validateApi(manifest.hostApi, 'hostApi', errors)
  validateApi(manifest.coreApi, 'coreApi', errors)
  validateDependencies(manifest.dependencies, errors)
  validateCapabilities(manifest.capabilities, errors)
  if (!manifest.integrity || typeof manifest.integrity !== 'object' || typeof manifest.integrity.runtime !== 'string' || !manifest.integrity.runtime.trim()) errors.push('integrity.runtime is required')
  if (manifest.entrypoints?.ui && (typeof manifest.integrity?.ui !== 'string' || !manifest.integrity.ui.trim())) errors.push('integrity.ui is required when entrypoints.ui is declared')
  if (!manifest.entrypoints?.ui && manifest.integrity?.ui !== undefined) errors.push('integrity.ui requires entrypoints.ui')
  return errors
}

function validateEntrypoints(manifest: ComponentManifest, errors: string[]): void {
  const entrypoints = manifest.entrypoints
  if (!entrypoints || typeof entrypoints !== 'object') { errors.push('entrypoints is required'); return }
  for (const key of ['runtime', 'ui'] as const) {
    const path = entrypoints[key]
    if (key === 'runtime' && (typeof path !== 'string' || !path.trim())) errors.push('entrypoints.runtime is required')
    if (path !== undefined) {
      if (typeof path !== 'string' || !isPortableRelativePath(path)) errors.push(`entrypoints.${key} must be a root-contained browser ESM path`)
      else if (!/\.(?:mjs|js)$/i.test(path)) errors.push(`entrypoints.${key} must point to .mjs or .js`)
    }
  }
}

export function isPortableRelativePath(path: string): boolean {
  if (!path || path.includes('\0') || FORBIDDEN_ENTRY.test(path)) return false
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\')) return false
  const parts = path.split(/[\\/]/)
  if (parts.some(part => part === '..' || part === '.')) return false
  return parts.length > 0 && parts.every(part => Boolean(part))
}

function validateApi(value: { version: string } | undefined, name: string, errors: string[]): void {
  if (value !== undefined && (!value || typeof value !== 'object' || typeof value.version !== 'string' || !API_VERSION.test(value.version))) errors.push(`${name}.version must be a numeric API version`)
}

function validateDependencies(dependencies: ComponentManifest['dependencies'], errors: string[]): void {
  if (dependencies === undefined) return
  if (!Array.isArray(dependencies)) { errors.push('dependencies must be an array'); return }
  const seen = new Set<string>()
  for (const dependency of dependencies) {
    if (!dependency || typeof dependency.id !== 'string' || !ID.test(dependency.id) || typeof dependency.version !== 'string' || !VERSION.test(dependency.version)) errors.push('dependency must contain a reverse-domain id and semver version')
    else if (seen.has(dependency.id)) errors.push(`duplicate dependency: ${dependency.id}`)
    else seen.add(dependency.id)
  }
}

function validateCapabilities(capabilities: ComponentManifest['capabilities'], errors: string[]): void {
  if (capabilities === undefined) return
  if (!capabilities || typeof capabilities !== 'object') { errors.push('capabilities must be an object'); return }
  const required = capabilities.required ?? []; const optional = capabilities.optional ?? []
  if (!Array.isArray(required) || required.some(item => typeof item !== 'string' || !item.trim())) errors.push('capabilities.required must be non-empty strings')
  if (!Array.isArray(optional) || optional.some(item => typeof item !== 'string' || !item.trim())) errors.push('capabilities.optional must be non-empty strings')
  if (Array.isArray(required) && Array.isArray(optional)) for (const item of required) if (optional.includes(item)) errors.push(`capability cannot be both required and optional: ${item}`)
}
