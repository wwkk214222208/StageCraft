import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 示例模板里的占位 API Key（视为未配置） */
const PLACEHOLDER_API_KEY = /在这里填写|你的_API_Key|你的_Key/i

export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string[]
  selectedModel?: string
  responseFormat: 'json_object' | 'json_schema' | 'none'
  toolCalling?: boolean
}

export interface PublicProviderConfig {
  id: string
  name: string
  baseUrl: string
  models: string[]
  selectedModel?: string
  hasApiKey: boolean
  responseFormat: ProviderConfig['responseFormat']
}

interface ProviderConfigFile {
  providers: ProviderConfig[]
  defaultRoleProviderId?: string
  defaultRoleModel?: string
  directorProviderId?: string
  directorModel?: string
  assistantProviderId?: string
  assistantModel?: string
  roleThinkingStrength?: import('./types.ts').ThinkingStrength
  assistantThinkingStrength?: import('./types.ts').ThinkingStrength
  directorThinkingStrength?: import('./types.ts').ThinkingStrength
}

export class ProviderConfigStore {
  private readonly filePath: string
  private configs: ProviderConfig[]
  private defaultRoleProviderId: string | undefined
  private defaultRoleModel: string | undefined
  private directorProviderId: string | undefined
  private directorModel: string | undefined
  private assistantProviderId: string | undefined
  private assistantModel: string | undefined
  private roleThinkingStrength: import('./types.ts').ThinkingStrength | undefined
  private assistantThinkingStrength: import('./types.ts').ThinkingStrength | undefined
  private directorThinkingStrength: import('./types.ts').ThinkingStrength | undefined

  constructor(filePath: string) {
    this.filePath = filePath
    const file = this.read()
    this.configs = file.providers
    this.defaultRoleProviderId = file.defaultRoleProviderId ?? this.configs[0]?.id
    this.defaultRoleModel = file.defaultRoleModel
    this.directorProviderId = file.directorProviderId ?? this.configs[0]?.id
    this.directorModel = file.directorModel
    this.assistantProviderId = file.assistantProviderId ?? this.defaultRoleProviderId
    this.assistantModel = file.assistantModel
    this.roleThinkingStrength = file.roleThinkingStrength
    this.assistantThinkingStrength = file.assistantThinkingStrength
    this.directorThinkingStrength = file.directorThinkingStrength
  }

  list(): PublicProviderConfig[] {
    return this.configs.map(config => ({ id: config.id, name: config.name, baseUrl: config.baseUrl, models: config.models, selectedModel: config.selectedModel, hasApiKey: Boolean(config.apiKey) && !PLACEHOLDER_API_KEY.test(config.apiKey), responseFormat: config.responseFormat }))
  }

  /** Full private configuration for authenticated device synchronization. */
  exportPrivate(): { providers: ProviderConfig[]; defaults: Omit<ProviderConfigFile, 'providers'> } {
    return { providers: this.configs.map(config => ({ ...config, models: [...config.models] })), defaults: this.defaults() }
  }

  /** Replace provider configuration from a trusted, authenticated sync payload. */
  importPrivate(value: { providers?: unknown; defaults?: unknown }): void {
    if (!Array.isArray(value.providers)) throw new Error('同步数据缺少 providers。')
    const providers = value.providers.map((item: any) => {
      if (!item || typeof item !== 'object' || !String(item.id ?? '').trim() || !String(item.baseUrl ?? '').trim()) throw new Error('同步数据中的 Provider 无效。')
      return { id: String(item.id), name: String(item.name ?? item.id), baseUrl: String(item.baseUrl).replace(/\/$/, ''), apiKey: String(item.apiKey ?? ''), models: Array.isArray(item.models) ? item.models.map(String) : [], selectedModel: item.selectedModel ? String(item.selectedModel) : undefined, responseFormat: item.responseFormat === 'json_schema' ? 'json_schema' : item.responseFormat === 'none' ? 'none' : 'json_object', toolCalling: item.toolCalling !== false } as ProviderConfig
    })
    this.configs = providers
    const defaults = value.defaults && typeof value.defaults === 'object' ? value.defaults as any : {}
    this.defaultRoleProviderId = defaults.defaultRoleProviderId ? String(defaults.defaultRoleProviderId) : providers[0]?.id
    this.defaultRoleModel = defaults.defaultRoleModel ? String(defaults.defaultRoleModel) : undefined
    this.directorProviderId = defaults.directorProviderId ? String(defaults.directorProviderId) : providers[0]?.id
    this.directorModel = defaults.directorModel ? String(defaults.directorModel) : undefined
    this.assistantProviderId = defaults.assistantProviderId ? String(defaults.assistantProviderId) : this.defaultRoleProviderId
    this.assistantModel = defaults.assistantModel ? String(defaults.assistantModel) : undefined
    this.roleThinkingStrength = defaults.roleThinkingStrength
    this.assistantThinkingStrength = defaults.assistantThinkingStrength
    this.directorThinkingStrength = defaults.directorThinkingStrength
    this.persist()
  }

  defaults(): Omit<ProviderConfigFile, 'providers'> {
    return { defaultRoleProviderId: this.defaultRoleProviderId, defaultRoleModel: this.defaultRoleModel, directorProviderId: this.directorProviderId, directorModel: this.directorModel, assistantProviderId: this.assistantProviderId, assistantModel: this.assistantModel, ...(this.roleThinkingStrength ? { roleThinkingStrength: this.roleThinkingStrength } : {}), ...(this.assistantThinkingStrength ? { assistantThinkingStrength: this.assistantThinkingStrength } : {}), ...(this.directorThinkingStrength ? { directorThinkingStrength: this.directorThinkingStrength } : {}) }
  }

  /** 导演思维链强度（缺省 undefined = 跟随默认档位 standard） */
  directorThinking(): import('./types.ts').ThinkingStrength | undefined {
    return this.directorThinkingStrength
  }

  setRoleThinking(strength: import('./types.ts').ThinkingStrength): void {
    if (!['off', 'brief', 'standard', 'deep'].includes(strength)) throw new Error('无效的思维链强度。')
    this.roleThinkingStrength = strength
    this.persist()
  }

  roleThinking(): import('./types.ts').ThinkingStrength | undefined { return this.roleThinkingStrength }

  setAssistantThinking(strength: import('./types.ts').ThinkingStrength): void {
    if (!['off', 'brief', 'standard', 'deep'].includes(strength)) throw new Error('无效的思维链强度。')
    this.assistantThinkingStrength = strength
    this.persist()
  }

  assistantThinking(): import('./types.ts').ThinkingStrength | undefined { return this.assistantThinkingStrength }

  setDirectorThinking(strength: import('./types.ts').ThinkingStrength): void {
    if (!['off', 'brief', 'standard', 'deep'].includes(strength)) throw new Error('无效的思维链强度。')
    this.directorThinkingStrength = strength
    this.persist()
  }

  get(id: string): ProviderConfig | undefined {
    return this.configs.find(config => config.id === id)
  }

  getDefaultRole(): ProviderConfig | undefined {
    return this.get(this.defaultRoleProviderId ?? '') ?? this.configs[0]
  }

  getSelected(): ProviderConfig | undefined {
    return this.getDefaultRole()
  }

  getDirector(): ProviderConfig | undefined {
    return this.get(this.directorProviderId ?? '') ?? this.getDefaultRole()
  }

  setDefaultRole(id: string, model?: string): ProviderConfig {
    const config = this.get(id)
    if (!config) throw new Error('Provider 配置不存在。')
    this.defaultRoleProviderId = id
    this.defaultRoleModel = model
    this.persist()
    return config
  }

  setAssistant(id: string, model?: string): ProviderConfig {
    const config = this.get(id)
    if (!config) throw new Error('Provider 配置不存在。')
    this.assistantProviderId = id
    this.assistantModel = model
    this.persist()
    return config
  }

  getAssistant(): ProviderConfig | undefined {
    return this.get(this.assistantProviderId ?? '') ?? this.getDefaultRole()
  }

  assistantModelName(): string | undefined { return this.assistantModel }

  setDirector(id: string, model?: string): ProviderConfig {
    const config = this.get(id)
    if (!config) throw new Error('Provider 配置不存在。')
    this.directorProviderId = id
    this.directorModel = model
    this.persist()
    return config
  }

  save(config: ProviderConfig): void {
    const index = this.configs.findIndex(item => item.id === config.id)
    if (index >= 0) this.configs[index] = config
    else this.configs.push(config)
    if (!this.defaultRoleProviderId) this.defaultRoleProviderId = config.id
    if (!this.directorProviderId) this.directorProviderId = config.id
    this.persist()
  }

  /** 删除供应商；若它是默认角色/导演，则相应回退到第一个剩余配置（无则清空）。 */
  remove(id: string): boolean {
    const index = this.configs.findIndex(item => item.id === id)
    if (index < 0) return false
    this.configs.splice(index, 1)
    if (this.defaultRoleProviderId === id) this.defaultRoleProviderId = this.configs[0]?.id
    if (this.directorProviderId === id) this.directorProviderId = this.configs[0]?.id
    this.persist()
    return true
  }

  async discoverModels(id: string, fetchImpl: typeof fetch = fetch): Promise<PublicProviderConfig> {
    const config = this.get(id)
    if (!config) throw new Error('Provider 配置不存在。')
    const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${config.apiKey}` } })
    if (!response.ok) throw new Error(`模型列表请求失败 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const body = await response.json() as { data?: Array<{ id?: string }> }
    config.models = (body.data ?? []).map(item => item.id).filter((value): value is string => Boolean(value))
    config.selectedModel = config.models[0] ?? config.selectedModel
    this.persist()
    return this.list().find(item => item.id === id)!
  }

  private read(): ProviderConfigFile {
    if (!existsSync(this.filePath)) return { providers: [] }
    const value = JSON.parse(readFileSync(this.filePath, 'utf8')) as ProviderConfigFile | ProviderConfig[]
    return Array.isArray(value) ? { providers: value } : value
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify({ providers: this.configs, ...this.defaults() }, null, 2), 'utf8')
  }
}
