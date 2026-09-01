/** Injectable desktop selection seam: v1 legacy and v2 Core are mutually exclusive. */
import { existsSync } from 'node:fs'

export interface DesktopEntryOptions<LegacyOptions, V2Options> {
  planPath: string
  legacyOptions: LegacyOptions
  v2Options: V2Options
  startLegacy(options: LegacyOptions): Promise<unknown>
  startV2(options: V2Options): Promise<unknown>
  hasPlan?(path: string): boolean
}

/** Select before invoking either composition root; no speculative Core construction occurs. */
export async function startDesktopEntry<LegacyOptions, V2Options>(options: DesktopEntryOptions<LegacyOptions, V2Options>): Promise<unknown> {
  const hasPlan = options.hasPlan ?? existsSync
  if (hasPlan(options.planPath)) return options.startV2(options.v2Options)
  return options.startLegacy(options.legacyOptions)
}
