import type { ComponentCapabilities } from './component-contract.ts'

export interface CapabilityNegotiation {
  ok: boolean
  granted: readonly string[]
  missingRequired: readonly string[]
  deniedOptional: readonly string[]
}

export function negotiateCapabilities(request: ComponentCapabilities | undefined, available: readonly string[]): CapabilityNegotiation {
  const availableSet = new Set(available)
  const required = [...new Set(request?.required ?? [])].sort()
  const optional = [...new Set(request?.optional ?? [])].sort()
  const granted = [...new Set([...required, ...optional].filter(capability => availableSet.has(capability)))].sort()
  const missingRequired = required.filter(capability => !availableSet.has(capability))
  const deniedOptional = optional.filter(capability => !availableSet.has(capability))
  return Object.freeze({ ok: missingRequired.length === 0, granted: Object.freeze(granted), missingRequired: Object.freeze(missingRequired), deniedOptional: Object.freeze(deniedOptional) })
}
