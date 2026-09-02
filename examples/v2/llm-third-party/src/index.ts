import { defineLlmSystem, type CredentialProfileMetadata, type LlmRouteDefault, type LlmSystemService, type LlmSystemStartContext, type LlmUsageFilter, type LlmUsageRecord, type ProviderChunk, type ProviderDriver } from '../../../../src/sdk/index.ts'

/**
 * A deliberately independent author example. It owns profiles, routes,
 * secrets, cancellation and usage; it does not import the official service or
 * any Core/private module. Transport remains replaceable through public
 * ProviderDriver plugins supplied in the start context.
 */
export default defineLlmSystem({
  id: 'example.third-party.llm', version: '0.1.0', title: 'Third-party LLM System', capabilities: { required: ['host.storage'], optional: ['host.secrets'] },
  async start(context): Promise<LlmSystemService> {
    const profiles = new Map<string, CredentialProfileMetadata>()
    const secrets = new Map<string, string>()
    const usage: LlmUsageRecord[] = []
    const routes: { role?: LlmRouteDefault; director?: LlmRouteDefault; assistant?: LlmRouteDefault } = {}
    const active = new Map<string, { controller: AbortController; driver?: ProviderDriver }>()
    let stopped = false
    const stateKey = 'third-party-llm'
    const restored = await context.state?.read<{ profiles?: CredentialProfileMetadata[]; routes?: typeof routes; usage?: LlmUsageRecord[] }>(stateKey)
    for (const profile of restored?.profiles ?? []) profiles.set(profile.id, Object.freeze({ ...profile, profileId: profile.profileId ?? profile.id, driverId: profile.driverId ?? profile.providerId, models: Object.freeze([...(profile.models ?? [])]) }))
    Object.assign(routes, restored?.routes ?? {})
    usage.push(...(restored?.usage ?? []))
    const drivers = new Map((context.drivers ?? []).map(driver => [driver.driverId, driver]))
    const persist = async () => { await context.state?.write(stateKey, { profiles: [...profiles.values()], routes, usage: [...usage] }) }
    const profileFor = (id?: string) => id ? profiles.get(id) ?? [...profiles.values()].find(profile => profile.providerId === id) : undefined
    const route = async (input: { model?: string; providerId?: string; driverId?: string; profileId?: string; credentialProfileId?: string; role?: string; purpose?: string }) => {
      if (stopped) throw new Error('third-party llm system is stopped')
      const kind = input.role?.trim() ? 'role' : input.purpose === 'assistant' ? 'assistant' : input.purpose === 'director' ? 'director' : undefined
      const preset = kind ? routes[kind] : undefined
      const profile = profileFor(input.profileId ?? input.credentialProfileId ?? input.providerId) ?? profileFor(preset?.profileId) ?? [...profiles.values()][0]
      const driverId = input.driverId ?? preset?.driverId ?? profile?.driverId
      const driver = driverId ? drivers.get(driverId) : undefined
      if (!profile || !driver) throw new Error('no third-party provider profile or driver is configured')
      const model = input.model ?? preset?.model ?? profile.selectedModel ?? profile.models?.[0] ?? driver.models[0]
      if (!model || (profile.models?.length && !profile.models.includes(model) && !driver.models.includes(model))) throw new Error(`model is not available: ${model}`)
      return Object.freeze({ providerId: profile.providerId, driverId, profileId: profile.id, credentialProfileId: profile.id, model })
    }
    const service: LlmSystemService = {
      get status() { return stopped ? 'stopped' : 'ready' },
      listDrivers: () => Object.freeze([...drivers.values()]),
      listModels: providerId => Object.freeze([...drivers.values()].filter(driver => !providerId || driver.driverId === providerId || driver.providerId === providerId).map(driver => ({ providerId: driver.providerId, models: Object.freeze([...driver.models]) }))),
      listCredentialProfiles: () => Object.freeze([...profiles.values()]),
      getCredentialProfile: profileId => profiles.get(profileId),
      async discoverModels(profileId) { const profile = profiles.get(profileId); if (!profile) throw new Error(`unknown profile: ${profileId}`); const driver = drivers.get(profile.driverId ?? profile.providerId); return Object.freeze([...(driver?.models ?? profile.models ?? [])]) },
      async upsertCredentialProfile(profile) { if (!profile.id || !profile.providerId) throw new Error('profile id and providerId are required'); profiles.set(profile.id, Object.freeze({ ...profile, profileId: profile.profileId ?? profile.id, driverId: profile.driverId ?? profile.providerId, models: Object.freeze([...(profile.models ?? [])]) })); await persist() },
      async deleteCredentialProfile(profileId) { profiles.delete(profileId); secrets.delete(profileId); if (context.secrets?.delete) await context.secrets.delete(profileId); for (const kind of ['role', 'director', 'assistant'] as const) if (routes[kind]?.profileId === profileId) delete routes[kind]; await persist() },
      async setCredentialSecret(profileId, secret) { if (!profiles.has(profileId)) throw new Error(`unknown profile: ${profileId}`); if (secret === undefined) { secrets.delete(profileId); await context.secrets?.delete?.(profileId) } else { secrets.set(profileId, secret); if (context.secrets) await context.secrets.set(profileId, secret) } },
      async hasCredentialSecret(profileId) { return context.secrets?.has ? context.secrets.has(profileId) : context.secrets ? (await context.secrets.get(profileId)) !== undefined : secrets.has(profileId) },
      getRouteDefaults: () => Object.freeze({ ...routes }),
      async setRouteDefault(purpose, value) { if (value?.profileId && !profiles.has(value.profileId)) throw new Error(`unknown profile: ${value.profileId}`); routes[purpose] = value; await persist() },
      route,
      complete(input) {
        if (active.has(input.requestId)) throw new Error(`requestId already active: ${input.requestId}`)
        const controller = new AbortController(); const reservation = { controller, driver: undefined as ProviderDriver | undefined }; active.set(input.requestId, reservation)
        const stream = (async function* () {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const selected = await route(input); const driver = drivers.get(selected.driverId)!; reservation.driver = driver
            const secret = input.credential?.secret ?? (context.secrets ? await context.secrets.get(selected.profileId) : secrets.get(selected.profileId))
            timer = setTimeout(() => controller.abort(), Number((input.metadata as any)?.timeoutMs ?? 120_000))
            for await (const chunk of driver.request({ ...input, providerId: selected.providerId, credentialProfileId: selected.profileId, model: selected.model, credential: secret ? { profileId: selected.profileId, secret } : undefined, signal: controller.signal, metadata: input.metadata }, context)) {
              if (controller.signal.aborted) break
              if (chunk.type === 'usage') { const record: LlmUsageRecord = { requestId: input.requestId, providerId: selected.providerId, driverId: selected.driverId, profileId: selected.profileId, model: selected.model, inputTokens: chunk.usage?.inputTokens, outputTokens: chunk.usage?.outputTokens, cachedTokens: chunk.usage?.cachedTokens, durationMs: chunk.usage?.durationMs, cost: chunk.usage?.cost, currency: chunk.usage?.currency, timestamp: (context.now ?? (() => new Date()))().toISOString() }; usage.push(Object.freeze(record)); await persist() }
              yield chunk
            }
          } finally { if (timer) clearTimeout(timer); active.delete(input.requestId) }
        })()
        return stream
      },
      async cancel(requestId) { const current = active.get(requestId); if (!current) return; current.controller.abort(); await current.driver?.cancel?.(requestId, context) },
      async recordUsage(record) { usage.push(Object.freeze({ ...record })); await persist() },
      queryUsage: (filter: LlmUsageFilter = {}) => Object.freeze(usage.filter(record => (!filter.requestId || record.requestId === filter.requestId) && (!filter.providerId || record.providerId === filter.providerId) && (!filter.driverId || record.driverId === filter.driverId) && (!filter.profileId || record.profileId === filter.profileId) && (!filter.model || record.model === filter.model) && (!filter.from || (record.timestamp ?? '') >= filter.from) && (!filter.to || (record.timestamp ?? '') <= filter.to))),
      aggregateUsage: (filter?: LlmUsageFilter) => { const rows = service.queryUsage(filter) as readonly LlmUsageRecord[]; return { inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0), outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0), requests: new Set(rows.map(row => row.requestId)).size, cachedTokens: rows.reduce((sum, row) => sum + (row.cachedTokens ?? 0), 0), durationMs: rows.reduce((sum, row) => sum + (row.durationMs ?? 0), 0), cost: rows.reduce((sum, row) => sum + (row.cost ?? 0), 0), currency: rows.find(row => row.currency)?.currency } },
      async stop() { if (stopped) return; for (const id of [...active.keys()]) await service.cancel(id); stopped = true; await persist() },
    }
    return service
  },
})
