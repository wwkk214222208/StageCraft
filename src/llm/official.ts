import { normalizeProviderDefaults, type ProviderRoutingDefaults } from '../provider-routing.ts'
import { defineLlmSystem, type CredentialMaterial, type CredentialProfileMetadata, type LlmCompletionRequest, type LlmRouteSelection, type LlmSystemService, type LlmSystemStartContext, type LlmUsageAggregate, type LlmUsageFilter, type LlmUsageRecord, type ProviderChunk, type ProviderDriver } from '../sdk/authoring.ts'
import { createModelStreamAccumulator, parseModelCompleteResponse } from '../model-gateway.ts'

export interface LlmProviderProfile extends CredentialProfileMetadata {
  readonly profileId?: string
  readonly driverId: string
  readonly name: string
  readonly baseUrl: string
  readonly models: readonly string[]
  readonly selectedModel?: string
  readonly responseFormat: 'json_object' | 'json_schema' | 'none'
  readonly toolCalling: boolean
}

export interface LlmRouteDefaults {
  readonly role?: { profileId?: string; driverId?: string; model?: string }
  readonly director?: { profileId?: string; driverId?: string; model?: string }
  readonly assistant?: { profileId?: string; driverId?: string; model?: string }
}

export interface OfficialLlmState {
  profiles: readonly LlmProviderProfile[]
  defaults: LlmRouteDefaults
  usage: readonly LlmUsageRecord[]
}

export interface OfficialLlmSystemOptions {
  readonly profiles?: readonly LlmProviderProfile[]
  readonly defaults?: LlmRouteDefaults | ProviderRoutingDefaults
  readonly stateKey?: string
  readonly billing?: (record: LlmUsageRecord) => Pick<LlmUsageRecord, 'cost' | 'currency'> | undefined
  /** Optional one-time import adapter for the existing production store. The
   * official service owns subsequent CRUD writes; the legacy store is never
   * mutated by this plugin. */
  readonly providerStore?: { exportPrivate(): { providers: readonly Record<string, any>[]; defaults: Record<string, unknown> } }
  readonly billingStore?: { calculate(provider: string, model: string, usage: { promptTokens: number; completionTokens: number; cachedTokens?: number }, at?: Date): { total: number; currency: string } | undefined }
}

export interface OpenAiCompatibleDriverOptions {
  readonly id: string
  readonly version: string
  readonly title: string
  readonly driverId: string
  readonly models: readonly string[]
  readonly fetchImpl?: typeof fetch
}

/** Narrow ProviderDriver adapter sharing ModelGateway's production OpenAI
 * compatible SSE/JSON parser. It is useful for the official service and in
 * offline tests with an injected fetch implementation. */
export function createOpenAiCompatibleDriver(options: OpenAiCompatibleDriverOptions): ProviderDriver {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    kind: 'provider-driver', manifest: Object.freeze({ id: options.id, version: options.version, title: options.title, category: 'provider-driver', apiVersion: '0.1' }),
    driverId: options.driverId, providerId: options.driverId, models: Object.freeze([...options.models]),
    async *request(request) {
      const route = (request.metadata as any)?.llmRoute ?? {}; const endpoint = `${String(route.baseUrl ?? '').replace(/\/$/, '')}/chat/completions`
      const body = { model: request.model, messages: request.messages, stream: true, ...(route.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {}), ...(route.responseFormat === 'json_schema' && route.jsonSchema ? { response_format: { type: 'json_schema', json_schema: route.jsonSchema } } : {}), ...(route.toolCalling && Array.isArray(route.tools) ? { tools: route.tools } : {}) }
      const response = await fetchImpl(endpoint, { method: 'POST', signal: request.signal, headers: { 'content-type': 'application/json', ...(request.credential?.secret ? { authorization: `Bearer ${request.credential.secret}` } : {}) }, body: JSON.stringify(body) })
      if (!response.ok) throw new Error(`Model HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
      if (response.body && response.headers.get('content-type')?.includes('text/event-stream')) {
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; const accumulator = createModelStreamAccumulator();
        const emit = (payload: string): ProviderChunk[] => { const parsed = accumulator.push(payload); const chunks: ProviderChunk[] = []; if (parsed.reasoning) chunks.push({ type: 'thinking', text: parsed.reasoning }); if (parsed.content) chunks.push({ type: 'text', text: parsed.content }); if (parsed.toolArguments) chunks.push({ type: 'text', text: parsed.toolArguments }); if (parsed.usage) chunks.push({ type: 'usage', usage: { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens, cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens } }); return chunks }
        while (true) { const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n'); let sep; while ((sep = buffer.indexOf('\n\n')) >= 0) { const event = buffer.slice(0, sep); buffer = buffer.slice(sep + 2); const data = event.split('\n').map(line => line.trim()).find(line => line.startsWith('data:')); if (!data) continue; const payload = data.slice(5).trim(); if (payload === '[DONE]') { yield { type: 'done' }; return } for (const chunk of emit(payload)) yield chunk } }
        if (buffer.trim()) for (const chunk of emit(buffer.trim())) yield chunk
        yield { type: 'done' }; return
      }
      const result = parseModelCompleteResponse(await response.json()); if (result.reasoning) yield { type: 'thinking', text: result.reasoning }; if (result.content) yield { type: 'text', text: result.content }; if (result.toolArguments) yield { type: 'text', text: result.toolArguments }; if (result.usage) yield { type: 'usage', usage: { inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens, cachedTokens: result.usage.prompt_tokens_details?.cached_tokens } }; yield { type: 'done' }
    },
  }
}

function copyProfile(profile: CredentialProfileMetadata): LlmProviderProfile {
  const profileId = profile.profileId ?? profile.id
  const driverId = profile.driverId ?? profile.providerId
  return Object.freeze({
    id: profileId, profileId, providerId: driverId, driverId,
    name: profile.name ?? profile.label ?? profileId,
    label: profile.label ?? profile.name,
    baseUrl: profile.baseUrl ?? '', models: Object.freeze([...(profile.models ?? [])]), selectedModel: profile.selectedModel,
    responseFormat: profile.responseFormat ?? 'json_object', toolCalling: profile.toolCalling !== false,
    ...(profile.createdAt ? { createdAt: profile.createdAt } : {}), ...(profile.updatedAt ? { updatedAt: profile.updatedAt } : {}),
  })
}

function defaults(value: OfficialLlmSystemOptions['defaults']): LlmRouteDefaults {
  const source = value && typeof value === 'object' ? value as Record<string, any> : {}
  const normalized = normalizeProviderDefaults(value)
  return {
    role: source.role ? { profileId: source.role.profileId ?? source.role.providerId, driverId: source.role.driverId, model: source.role.model } : (normalized.defaultRoleProviderId || normalized.defaultRoleModel ? { profileId: normalized.defaultRoleProviderId, model: normalized.defaultRoleModel } : undefined),
    director: source.director ? { profileId: source.director.profileId ?? source.director.providerId, driverId: source.director.driverId, model: source.director.model } : (normalized.directorProviderId || normalized.directorModel ? { profileId: normalized.directorProviderId, model: normalized.directorModel } : undefined),
    assistant: source.assistant ? { profileId: source.assistant.profileId ?? source.assistant.providerId, driverId: source.assistant.driverId, model: source.assistant.model } : undefined,
  }
}

function matches(record: LlmUsageRecord, filter: LlmUsageFilter = {}): boolean {
  return (!filter.providerId || record.providerId === filter.providerId) && (!filter.driverId || record.driverId === filter.driverId) && (!filter.profileId || record.profileId === filter.profileId) && (!filter.model || record.model === filter.model) && (!filter.requestId || record.requestId === filter.requestId) && (!filter.from || (record.timestamp ?? '') >= filter.from) && (!filter.to || (record.timestamp ?? '') <= filter.to)
}

/** Official reference LLM System. It owns provider profiles, routing, model
 * discovery, request cancellation and usage; the Host only supplies ports. */
export async function createOfficialLlmSystemService(context: LlmSystemStartContext, options: OfficialLlmSystemOptions = {}): Promise<LlmSystemService> {
  const drivers = new Map<string, ProviderDriver>((context.drivers ?? []).map(driver => [driver.driverId, driver]))
  const profiles = new Map<string, LlmProviderProfile>()
  const usage: LlmUsageRecord[] = []
  const memorySecrets = new Map<string, string>()
  let routeDefaults = defaults(options.defaults)
  const active = new Map<string, { controller: AbortController; driver?: ProviderDriver }>()
  let stopped = false
  const stateKey = options.stateKey ?? 'official-llm'
  const state = context.state
  if (options.providerStore) {
    const stored = options.providerStore.exportPrivate()
    for (const profile of stored.providers) {
      const legacyProviderId = profile.providerId ? String(profile.providerId) : profile.driverId ? String(profile.driverId) : String(profile.id)
      const copy = copyProfile({ id: String(profile.id), providerId: legacyProviderId, driverId: profile.driverId ? String(profile.driverId) : legacyProviderId, name: String(profile.name ?? profile.id), label: String(profile.name ?? profile.id), baseUrl: String(profile.baseUrl ?? ''), models: Array.isArray(profile.models) ? profile.models.map(String) : [], selectedModel: profile.selectedModel ? String(profile.selectedModel) : undefined, responseFormat: profile.responseFormat, toolCalling: profile.toolCalling })
      profiles.set(copy.id, copy)
      if (profile.apiKey) {
        if (context.secrets) await context.secrets.set(copy.id, String(profile.apiKey))
        else memorySecrets.set(copy.id, String(profile.apiKey))
      }
    }
    routeDefaults = defaults(stored.defaults)
  }
  if (state) {
    const restored = await state.read<OfficialLlmState>(stateKey).catch(() => undefined)
    for (const profile of restored?.profiles ?? []) profiles.set(profile.id, copyProfile(profile))
    routeDefaults = restored?.defaults ? defaults(restored.defaults) : routeDefaults
    for (const record of restored?.usage ?? []) usage.push(Object.freeze({ ...record }))
    if (!context.secrets) {
      const restoredSecrets = await state.read<Record<string, string>>(`${stateKey}:secrets`).catch(() => undefined)
      for (const [profileId, secret] of Object.entries(restoredSecrets ?? {})) memorySecrets.set(profileId, secret)
    }
  }
  for (const profile of options.profiles ?? []) profiles.set(profile.id, copyProfile(profile))
  const persist = async (): Promise<void> => {
    if (!state) return
    await state.write(stateKey, { profiles: [...profiles.values()].map(profile => ({ ...profile, models: [...profile.models] })), defaults: routeDefaults, usage: [...usage] })
  }
  if (!context.secrets && state && memorySecrets.size) await state.write(`${stateKey}:secrets`, Object.fromEntries(memorySecrets))
  const profileFor = (input: { profileId?: string; credentialProfileId?: string; providerId?: string }): LlmProviderProfile | undefined => {
    const id = input.profileId ?? input.credentialProfileId ?? input.providerId
    return id ? profiles.get(id) ?? [...profiles.values()].find(profile => profile.driverId === id) : undefined
  }
  const route = async (input: { model?: string; providerId?: string; driverId?: string; profileId?: string; credentialProfileId?: string; role?: string; purpose?: string }): Promise<LlmRouteSelection> => {
    if (stopped) throw new Error('llm-system is stopped')
    // A role is a role request only when the role field is explicitly present.
    const kind = input.role?.trim() ? 'role' : input.purpose === 'assistant' ? 'assistant' : input.purpose === 'director' ? 'director' : 'director'
    const preset = routeDefaults[kind]
    const profile = profileFor(input) ?? (preset?.profileId ? profiles.get(preset.profileId) : undefined) ?? [...profiles.values()][0]
    const driverId = input.driverId ?? profile?.driverId ?? preset?.driverId
    const driver = driverId ? drivers.get(driverId) : undefined
    if (!profile || !driver) throw new Error('no provider profile or driver is configured')
    const model = input.model ?? preset?.model ?? profile.selectedModel ?? profile.models[0] ?? driver.models[0]
    if (!model || !driver.models.includes(model) && profile.models.length > 0 && !profile.models.includes(model)) throw new Error(`model is not available: ${model}`)
    return Object.freeze({ providerId: driverId, profileId: profile.id, credentialProfileId: profile.id, driverId, model })
  }
  const service: LlmSystemService = {
    get status() { return stopped ? 'stopped' : 'ready' },
    listDrivers: () => Object.freeze([...drivers.values()]),
    listModels: profileId => Object.freeze(profileId ? [{ providerId: profiles.get(profileId)?.driverId ?? profileId, models: Object.freeze([...(profiles.get(profileId)?.models ?? drivers.get(profiles.get(profileId)?.driverId ?? '')?.models ?? [])]) }] : [...drivers.values()].map(driver => Object.freeze({ providerId: driver.driverId, models: Object.freeze([...new Set([...driver.models, ...[...profiles.values()].filter(profile => profile.driverId === driver.driverId).flatMap(profile => profile.models)])]) }))),
    listCredentialProfiles: () => Object.freeze([...profiles.values()].map(profile => ({ ...profile, models: Object.freeze([...profile.models]) }))),
    getCredentialProfile: profileId => profiles.get(profileId),
    async discoverModels(profileId) {
      const profile = profiles.get(profileId); if (!profile) throw new Error(`unknown credential profile: ${profileId}`)
      const fetchImpl = context.fetch ?? fetch
      if (!profile.baseUrl) { const driver = drivers.get(profile.driverId); return Object.freeze([...(driver?.models ?? profile.models)]) }
      const storedSecrets = !context.secrets ? await state?.read<Record<string, string>>(`${stateKey}:secrets`).catch(() => undefined) : undefined
      const secret = context.secrets ? await context.secrets.get(profileId) : storedSecrets?.[profileId] ?? memorySecrets.get(profileId)
      const response = await fetchImpl(`${profile.baseUrl.replace(/\/$/, '')}/models`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} })
      if (!response.ok) throw new Error(`model discovery failed HTTP ${response.status}`)
      const body = await response.json() as { data?: Array<{ id?: string }> }
      const models = (body.data ?? []).map(item => item.id).filter((id): id is string => Boolean(id))
      const updated = copyProfile({ ...profile, models, selectedModel: models[0] ?? profile.selectedModel })
      profiles.set(profileId, updated); await persist(); return Object.freeze([...models])
    },
    async upsertCredentialProfile(profile) { profiles.set(profile.id, copyProfile(profile)); await persist() },
    async deleteCredentialProfile(profileId) { profiles.delete(profileId); memorySecrets.delete(profileId); if (context.secrets) await context.secrets.delete?.(profileId); if (state) { const current = await state.read<Record<string, string>>(`${stateKey}:secrets`).catch(() => undefined) ?? {}; delete current[profileId]; await state.write(`${stateKey}:secrets`, current) }; if (routeDefaults.role?.profileId === profileId) routeDefaults = { ...routeDefaults, role: undefined }; if (routeDefaults.director?.profileId === profileId) routeDefaults = { ...routeDefaults, director: undefined }; if (routeDefaults.assistant?.profileId === profileId) routeDefaults = { ...routeDefaults, assistant: undefined }; await persist() },
    async setCredentialSecret(profileId, secret) { if (!profiles.has(profileId)) throw new Error(`unknown credential profile: ${profileId}`); if (secret === undefined) memorySecrets.delete(profileId); else memorySecrets.set(profileId, secret); if (context.secrets) { if (secret === undefined) await context.secrets.delete?.(profileId); else await context.secrets.set(profileId, secret) } else if (state) { const current = await state.read<Record<string, string>>(`${stateKey}:secrets`).catch(() => undefined) ?? {}; if (secret === undefined) delete current[profileId]; else current[profileId] = secret; await state.write(`${stateKey}:secrets`, current) } },
    async hasCredentialSecret(profileId) { if (context.secrets?.has) return context.secrets.has(profileId); if (context.secrets) return (await context.secrets.get(profileId)) !== undefined; if (memorySecrets.has(profileId)) return true; return Boolean((await state?.read<Record<string, string>>(`${stateKey}:secrets`).catch(() => undefined))?.[profileId]) },
    getRouteDefaults: () => Object.freeze({ ...routeDefaults }),
    async setRouteDefault(purpose, value) { if (value?.profileId && !profiles.has(value.profileId)) throw new Error(`unknown credential profile: ${value.profileId}`); routeDefaults = { ...routeDefaults, [purpose]: value ? Object.freeze({ ...value }) : undefined }; await persist() },
    route,
    complete(input: LlmCompletionRequest): AsyncIterable<ProviderChunk> {
      if (active.has(input.requestId)) throw new Error(`requestId already active: ${input.requestId}`)
      const reservation: { controller: AbortController; driver?: ProviderDriver } = { controller: new AbortController() }
      active.set(input.requestId, reservation)
      const iterator = (async function* () {
        try {
          const selected = await route(input); const driver = drivers.get(selected.driverId!)!; reservation.driver = driver; const controller = reservation.controller; const started = (context.now ?? (() => new Date()))().getTime()
          let inputTokens: number | undefined; let outputTokens: number | undefined; let cachedTokens: number | undefined
          const storedSecrets = !context.secrets ? await state?.read<Record<string, string>>(`${stateKey}:secrets`).catch(() => undefined) : undefined
          const secret = selected.credentialProfileId ? (context.secrets ? await context.secrets.get(selected.credentialProfileId) : storedSecrets?.[selected.credentialProfileId] ?? memorySecrets.get(selected.credentialProfileId)) : undefined
          const credential: CredentialMaterial | undefined = input.credential ?? (secret === undefined ? undefined : { profileId: selected.credentialProfileId!, secret })
          const selectedProfile = profiles.get(selected.profileId ?? selected.providerId)
          const requestMetadata = { ...(input.metadata ?? {}), llmRoute: { baseUrl: selectedProfile?.baseUrl, responseFormat: selectedProfile?.responseFormat, toolCalling: selectedProfile?.toolCalling, jsonSchema: (input.metadata as any)?.jsonSchema, tools: (input.metadata as any)?.tools } }
          for await (const chunk of driver.request({ ...input, providerId: selected.providerId, credentialProfileId: selected.credentialProfileId, model: selected.model, credential, signal: controller.signal, metadata: requestMetadata }, context)) {
            if (controller.signal.aborted) break
            if (chunk.type === 'usage') { inputTokens = chunk.usage?.inputTokens; outputTokens = chunk.usage?.outputTokens; cachedTokens = chunk.usage?.cachedTokens }
            if (chunk.type === 'usage') await service.recordUsage({ requestId: input.requestId, providerId: selected.providerId, driverId: selected.driverId, profileId: selected.profileId, model: selected.model, inputTokens, outputTokens, cachedTokens, durationMs: chunk.usage?.durationMs ?? ((context.now ?? (() => new Date()))().getTime() - started), cost: chunk.usage?.cost, currency: chunk.usage?.currency, timestamp: (context.now ?? (() => new Date()))().toISOString() })
            yield chunk
          }
        } finally { active.delete(input.requestId) }
      })(); return iterator
    },
    async cancel(requestId) { const current = active.get(requestId); if (!current) return; current.controller.abort(); await current.driver?.cancel?.(requestId, context) },
    async recordUsage(record) { const priced = options.billing?.(record) ?? (options.billingStore ? (() => { const cost = options.billingStore!.calculate(record.providerId, record.model, { promptTokens: record.inputTokens ?? 0, completionTokens: record.outputTokens ?? 0, cachedTokens: record.cachedTokens }, record.timestamp ? new Date(record.timestamp) : new Date()); return cost ? { cost: cost.total, currency: cost.currency } : undefined })() : undefined); usage.push(Object.freeze({ ...record, ...(priced ?? {}) })); await persist() },
    queryUsage: filter => Object.freeze(usage.filter(record => matches(record, filter))),
    aggregateUsage: filter => { const rows = usage.filter(record => matches(record, filter)); return Object.freeze({ inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0), outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0), requests: new Set(rows.map(row => row.requestId)).size, cachedTokens: rows.reduce((sum, row) => sum + (row.cachedTokens ?? 0), 0), durationMs: rows.reduce((sum, row) => sum + (row.durationMs ?? 0), 0), cost: rows.reduce((sum, row) => sum + (row.cost ?? 0), 0), currency: rows.find(row => row.currency)?.currency }) as LlmUsageAggregate & Record<string, unknown> },
    async stop() { if (stopped) return; stopped = true; const errors: unknown[] = []; for (const requestId of [...active.keys()]) { try { await service.cancel(requestId) } catch (error) { errors.push(error) } } try { await persist() } catch (error) { errors.push(error) } if (errors.length) throw new AggregateError(errors, 'one or more LLM System stop operations failed') },
  }
  return service
}

export function defineOfficialLlmSystem(options: OfficialLlmSystemOptions = {}) {
  return defineLlmSystem({ id: 'stagecraft.official.llm', version: '1.0.0', title: 'StageCraft Official LLM System', start: context => createOfficialLlmSystemService(context, options) })
}

export const createOfficialLlmSystemPlugin = defineOfficialLlmSystem
