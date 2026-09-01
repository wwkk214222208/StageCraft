import type { ComponentLaunchPlan, ComponentManifest, ComponentSelection } from './component-contract.ts'
import { COMPONENT_SCHEMA_VERSION } from './component-contract.ts'
import { componentManifestHash, stableHash, stableStringify, validateComponentManifest } from './component-validation.ts'

export interface BuildComponentLaunchPlanInput {
  core: ComponentManifest
  plugins?: readonly ComponentManifest[]
  hostApiVersion: string
  stateSchemaVersion: string
}

export function selectComponent(manifest: ComponentManifest): ComponentSelection {
  return { id: manifest.id, version: manifest.version, manifestHash: componentManifestHash(manifest) }
}

export function buildComponentLaunchPlan(input: BuildComponentLaunchPlanInput): ComponentLaunchPlan {
  const errors = validateComponentLaunchInputs(input)
  if (errors.length) throw new Error(`invalid component launch plan: ${errors.join('; ')}`)
  const plugins = [...(input.plugins ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map(selectComponent)
  const core = selectComponent(input.core)
  const identity = { planVersion: COMPONENT_SCHEMA_VERSION, hostApiVersion: input.hostApiVersion, core, plugins, stateSchemaVersion: input.stateSchemaVersion }
  return Object.freeze({ ...identity, plugins: Object.freeze(plugins), planHash: stableHash(stableStringify(identity)) })
}

export function validateComponentLaunchPlan(plan: ComponentLaunchPlan, available: readonly ComponentManifest[]): string[] {
  const errors: string[] = []
  if (!plan || typeof plan !== 'object') return ['launch plan must be an object']
  if (plan.planVersion !== COMPONENT_SCHEMA_VERSION) errors.push(`planVersion must be ${COMPONENT_SCHEMA_VERSION}`)
  if (typeof plan.hostApiVersion !== 'string' || !plan.hostApiVersion) errors.push('hostApiVersion is required')
  if (!plan.core || !plan.core.id || !plan.core.version || !plan.core.manifestHash) errors.push('core slot must be an independent non-empty selection')
  if (!Array.isArray(plan.plugins)) errors.push('plugins must be an array')
  const all = new Map(available.map(manifest => [`${manifest.id}@${manifest.version}`, manifest]))
  if (plan.core) {
    const coreManifest = all.get(`${plan.core.id}@${plan.core.version}`)
    if (!coreManifest) errors.push(`core selection not found: ${plan.core.id}@${plan.core.version}`)
    else {
      if (coreManifest.componentType !== 'core') errors.push('core slot must select a core manifest')
      if (!coreManifest.hostApi || coreManifest.hostApi.version !== plan.hostApiVersion) errors.push('core hostApi.version must match plan hostApiVersion')
      if (componentManifestHash(coreManifest) !== plan.core.manifestHash) errors.push('core manifestHash mismatch')
    }
  }
  const seen = new Set<string>(plan.core ? [plan.core.id] : [])
  for (const selection of plan.plugins ?? []) {
    const key = `${selection.id}@${selection.version}`
    if (seen.has(selection.id)) errors.push(`duplicate component id in launch plan: ${selection.id}`)
    seen.add(selection.id)
    if (plan.core && selection.id === plan.core.id) errors.push('core selection must not appear in plugins')
    const manifest = all.get(key)
    if (!manifest) errors.push(`plugin selection not found: ${key}`)
    else {
      if (manifest.componentType === 'core') errors.push(`core manifest in plugins: ${key}`)
      if (manifest.hostApi && manifest.hostApi.version !== plan.hostApiVersion) errors.push(`plugin hostApi.version must match plan hostApiVersion: ${key}`)
      const coreManifest = plan.core ? all.get(`${plan.core.id}@${plan.core.version}`) : undefined
      if (manifest.coreApi && !coreManifest?.coreApi) errors.push(`plugin coreApi.version requires the selected Core to declare a provided coreApi: ${key}`)
      else if (manifest.coreApi && coreManifest?.coreApi && manifest.coreApi.version !== coreManifest.coreApi.version) errors.push(`plugin coreApi.version must match Core provided version: ${key}`)
      if (componentManifestHash(manifest) !== selection.manifestHash) errors.push(`plugin manifestHash mismatch: ${key}`)
    }
  }
  const identity = { planVersion: plan.planVersion, hostApiVersion: plan.hostApiVersion, core: plan.core, plugins: plan.plugins, stateSchemaVersion: plan.stateSchemaVersion }
  if (typeof plan.planHash !== 'string' || stableHash(stableStringify(identity)) !== plan.planHash) errors.push('planHash mismatch')
  return errors
}

function validateComponentLaunchInputs(input: BuildComponentLaunchPlanInput): string[] {
  const errors = [...validateComponentManifest(input.core)]
  if (input.core.componentType !== 'core') errors.push('core slot requires componentType=core')
  if (!input.hostApiVersion) errors.push('hostApiVersion is required')
  if (!input.stateSchemaVersion) errors.push('stateSchemaVersion is required')
  if (!input.core.hostApi) errors.push('core must declare hostApi')
  else if (input.core.hostApi.version !== input.hostApiVersion) errors.push(`core hostApi.version ${input.core.hostApi.version} must match plan hostApiVersion ${input.hostApiVersion}`)
  const seen = new Set<string>([input.core.id])
  for (const plugin of input.plugins ?? []) {
    errors.push(...validateComponentManifest(plugin).map(error => `${plugin.id}: ${error}`))
    if (plugin.componentType === 'core') errors.push(`plugins cannot contain core: ${plugin.id}`)
    if (seen.has(plugin.id)) errors.push(`duplicate component id in launch plan: ${plugin.id}`)
    seen.add(plugin.id)
    if (plugin.hostApi && plugin.hostApi.version !== input.hostApiVersion) errors.push(`${plugin.id}: hostApi.version ${plugin.hostApi.version} must match plan hostApiVersion ${input.hostApiVersion}`)
    if (plugin.coreApi && !input.core.coreApi) errors.push(`${plugin.id}: coreApi.version requires the selected Core to declare a provided coreApi`)
    else if (plugin.coreApi && input.core.coreApi && plugin.coreApi.version !== input.core.coreApi.version) errors.push(`${plugin.id}: coreApi.version ${plugin.coreApi.version} must match Core provided coreApi.version ${input.core.coreApi.version}`)
  }
  return errors
}
