/**
 * Provider 路由共享逻辑（桌面 / Android / 同步共用）。
 *
 * 路由语义与桌面 app-boot.ts 完全一致，不按用途字符串猜角色/导演：
 * - 角色请求（route.role 存在）→ route.providerId（角色覆盖）→ 角色默认供应商；
 * - 导演请求（无 route.role）→ route.providerId（显式导演覆盖）→ 导演默认供应商 → 角色默认兜底；
 * - 模型：route.model（显式覆盖）→ defaults 指定模型 → 供应商 selectedModel / models[0]。
 *
 * defaults 兼容两种格式：
 * - 桌面扁平格式：{ defaultRoleProviderId, defaultRoleModel, directorProviderId, directorModel }（ProviderConfigStore.defaults()）；
 * - Android 嵌套格式：{ role: { providerId, model }, director: { providerId, model } }（手机端本地 meta）。
 * 两种格式可在同步后混用，这里统一归一化。
 */

export interface ProviderRoutingDefaults {
  defaultRoleProviderId?: string
  defaultRoleModel?: string
  directorProviderId?: string
  directorModel?: string
  role?: { providerId?: string; model?: string }
  director?: { providerId?: string; model?: string }
}

export interface ProviderRoutingEntry {
  id: string
  baseUrl: string
  apiKey: string
  models?: string[]
  selectedModel?: string
  responseFormat?: 'json_object' | 'json_schema' | 'none'
  [key: string]: unknown
}

export interface ProviderRouteRequest {
  route?: { providerId?: string; model?: string; role?: string }
}

/** 把两种 defaults 格式归一化为桌面扁平格式。 */
export function normalizeProviderDefaults(defaults: unknown): ProviderRoutingDefaults {
  const source = defaults && typeof defaults === 'object' ? defaults as Record<string, unknown> : {}
  const nested = (key: string): { providerId?: string; model?: string } | undefined => {
    const value = source[key]
    return value && typeof value === 'object' ? value as { providerId?: string; model?: string } : undefined
  }
  const role = nested('role')
  const director = nested('director')
  const defaultRoleProviderId = typeof source.defaultRoleProviderId === 'string' && source.defaultRoleProviderId ? source.defaultRoleProviderId : role?.providerId
  const defaultRoleModel = typeof source.defaultRoleModel === 'string' && source.defaultRoleModel ? source.defaultRoleModel : role?.model
  const directorProviderId = typeof source.directorProviderId === 'string' && source.directorProviderId ? source.directorProviderId : director?.providerId
  const directorModel = typeof source.directorModel === 'string' && source.directorModel ? source.directorModel : director?.model
  return { defaultRoleProviderId, defaultRoleModel, directorProviderId, directorModel }
}

/** 请求显式路由优先（与桌面 resolveRouteProviderId 相同语义）。 */
export function resolveRouteProviderId(request: ProviderRouteRequest, roleProviderId?: string, defaultProviderId?: string): string | undefined {
  return request.route?.providerId ?? roleProviderId ?? defaultProviderId
}

export function resolveRouteModel(request: ProviderRouteRequest, roleModelOverride?: string, fallbackModel?: string): string | undefined {
  return request.route?.model ?? roleModelOverride ?? fallbackModel
}

export interface ResolvedProviderRoute {
  provider?: ProviderRoutingEntry
  /** 归一化后的默认键（'role' | 'director'），供调用方记录用途。 */
  kind: 'role' | 'director' | 'none'
}

/**
 * 解析一次模型请求应使用的供应商（共享桌面路由语义）。
 * @param providers 供应商表（含 apiKey 的私有表；Android 从 Keystore secret 读取）
 * @param defaults 角色/导演默认（扁平或嵌套格式）
 * @param request 模型请求（route.providerId / route.model / route.role）
 */
export function resolveProviderForRequest(providers: ProviderRoutingEntry[], defaults: unknown, request: ProviderRouteRequest | undefined): ResolvedProviderRoute {
  const normalized = normalizeProviderDefaults(defaults)
  const route = request?.route
  const isRoleRequest = typeof route?.role === 'string' && Boolean(route.role)
  // 角色请求：route.providerId → 角色默认；导演请求：route.providerId → 导演默认 → 角色默认兜底
  const providerId = resolveRouteProviderId(
    { route },
    isRoleRequest ? normalized.defaultRoleProviderId : normalized.directorProviderId,
    isRoleRequest ? undefined : normalized.defaultRoleProviderId,
  )
  const provider = providers.find(item => String(item.id ?? '') === providerId)
  if (!provider) return { kind: 'none' }
  const defaultModel = isRoleRequest ? normalized.defaultRoleModel : (normalized.directorModel ?? normalized.defaultRoleModel)
  const model = resolveRouteModel(
    { route },
    defaultModel,
    typeof provider.selectedModel === 'string' ? provider.selectedModel : (Array.isArray(provider.models) && provider.models.length ? String(provider.models[0]) : undefined),
  )
  if (typeof provider.baseUrl !== 'string' || typeof provider.apiKey !== 'string' || !provider.baseUrl.trim() || !provider.apiKey.trim() || !model?.trim()) return { kind: 'none' }
  return {
    provider: {
      ...provider,
      baseUrl: provider.baseUrl.trim(),
      apiKey: provider.apiKey.trim(),
      selectedModel: model.trim(),
    },
    kind: isRoleRequest ? 'role' : 'director',
  }
}
