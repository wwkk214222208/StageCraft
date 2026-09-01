/** Optional convenience profile. Host-Core ABI deliberately does not import this module. */
export const OFFICIAL_CORE_PLUGIN_API_PROFILE = 'stagecraft.core-plugin/0.1' as const

export interface OfficialCorePluginDescriptor {
  id: string
  version: string
  pluginCategory: 'llm-system' | 'provider-driver' | 'solution' | 'tool' | 'effect' | 'ui' | 'composite'
}

export interface OfficialCorePluginApi {
  readonly profile: typeof OFFICIAL_CORE_PLUGIN_API_PROFILE
  listPlugins(): readonly OfficialCorePluginDescriptor[]
  loadPlugin(descriptor: OfficialCorePluginDescriptor): void | Promise<void>
  unloadPlugin?(id: string): void | Promise<void>
}

export function isOfficialCorePluginApi(value: unknown): value is OfficialCorePluginApi {
  const candidate = value as OfficialCorePluginApi | undefined
  return Boolean(candidate && candidate.profile === OFFICIAL_CORE_PLUGIN_API_PROFILE && typeof candidate.listPlugins === 'function' && typeof candidate.loadPlugin === 'function')
}
