import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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
}

export class ProviderConfigStore {
  private readonly filePath: string
  private configs: ProviderConfig[]
  private defaultRoleProviderId: string | undefined
  private defaultRoleModel: string | undefined
  private directorProviderId: string | undefined
  private directorModel: string | undefined

  constructor(filePath: string) {
    this.filePath = filePath
    const file = this.read()
    this.configs = file.providers
    this.defaultRoleProviderId = file.defaultRoleProviderId ?? this.configs[0]?.id
    this.defaultRoleModel = file.defaultRoleModel
    this.directorProviderId = file.directorProviderId ?? this.configs[0]?.id
    this.directorModel = file.directorModel
  }

  list(): PublicProviderConfig[] {
    return this.configs.map(config => ({ id: config.id, name: config.name, baseUrl: config.baseUrl, models: config.models, selectedModel: config.selectedModel, hasApiKey: Boolean(config.apiKey), responseFormat: config.responseFormat }))
  }

  defaults(): Omit<ProviderConfigFile, 'providers'> {
    return { defaultRoleProviderId: this.defaultRoleProviderId, defaultRoleModel: this.defaultRoleModel, directorProviderId: this.directorProviderId, directorModel: this.directorModel }
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
