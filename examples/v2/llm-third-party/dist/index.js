// src/sdk/authoring.ts
var STAGECRAFT_AUTHORING_API = "0.1";
function manifest(definition, category) {
  if (!definition || typeof definition !== "object") throw new TypeError("plugin definition must be an object");
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(definition.id)) throw new Error(`invalid plugin id: ${definition.id}`);
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(definition.version)) throw new Error(`invalid plugin version: ${definition.version}`);
  if (!definition.title?.trim()) throw new Error("plugin title is required");
  const value = {
    id: definition.id,
    version: definition.version,
    title: definition.title,
    category,
    apiVersion: STAGECRAFT_AUTHORING_API
  };
  if (definition.description !== void 0) value.description = definition.description;
  if (definition.author !== void 0) value.author = definition.author;
  if (definition.entry !== void 0) value.entry = Object.freeze({ desktop: definition.entry.desktop, android: definition.entry.android });
  if (definition.capabilities !== void 0) value.capabilities = freezeCapabilities(definition.capabilities);
  return Object.freeze(value);
}
function freezeCapabilities(value) {
  if (Array.isArray(value)) return Object.freeze([...value]);
  if (!value || typeof value !== "object") throw new TypeError("plugin capabilities must be an array or { required?, optional? }");
  if (value.required !== void 0 && !Array.isArray(value.required)) throw new TypeError("plugin capabilities.required must be an array");
  if (value.optional !== void 0 && !Array.isArray(value.optional)) throw new TypeError("plugin capabilities.optional must be an array");
  const required = value.required === void 0 ? void 0 : Object.freeze([...value.required]);
  const optional = value.optional === void 0 ? void 0 : Object.freeze([...value.optional]);
  if (required?.some((capability) => typeof capability !== "string" || !capability.trim()) || optional?.some((capability) => typeof capability !== "string" || !capability.trim())) throw new TypeError("plugin capabilities must contain non-empty strings");
  return Object.freeze({ ...required === void 0 ? {} : { required }, ...optional === void 0 ? {} : { optional } });
}
function defineLlmSystem(definition) {
  if (typeof definition.start !== "function") throw new TypeError("llm-system start must be a function");
  if ("route" in definition || "stop" in definition) throw new TypeError("llm-system route/stop must be implemented by the service returned from start()");
  const value = { kind: "llm-system", manifest: manifest(definition, "llm-system"), start: definition.start };
  return Object.freeze(value);
}

// examples/v2/llm-third-party/src/index.ts
var index_default = defineLlmSystem({
  id: "example.third-party.llm",
  version: "0.1.0",
  title: "Third-party LLM System",
  capabilities: { required: ["host.storage"], optional: ["host.secrets"] },
  async start(context) {
    const profiles = /* @__PURE__ */ new Map();
    const secrets = /* @__PURE__ */ new Map();
    const usage = [];
    const routes = {};
    const active = /* @__PURE__ */ new Map();
    let stopped = false;
    const stateKey = "third-party-llm";
    const restored = await context.state?.read(stateKey);
    for (const profile of restored?.profiles ?? []) profiles.set(profile.id, Object.freeze({ ...profile, profileId: profile.profileId ?? profile.id, driverId: profile.driverId ?? profile.providerId, models: Object.freeze([...profile.models ?? []]) }));
    Object.assign(routes, restored?.routes ?? {});
    usage.push(...restored?.usage ?? []);
    const drivers = new Map((context.drivers ?? []).map((driver) => [driver.driverId, driver]));
    const persist = async () => {
      await context.state?.write(stateKey, { profiles: [...profiles.values()], routes, usage: [...usage] });
    };
    const profileFor = (id) => id ? profiles.get(id) ?? [...profiles.values()].find((profile) => profile.providerId === id) : void 0;
    const route = async (input) => {
      if (stopped) throw new Error("third-party llm system is stopped");
      const kind = input.role?.trim() ? "role" : input.purpose === "assistant" ? "assistant" : input.purpose === "director" ? "director" : void 0;
      const preset = kind ? routes[kind] : void 0;
      const profile = profileFor(input.profileId ?? input.credentialProfileId ?? input.providerId) ?? profileFor(preset?.profileId) ?? [...profiles.values()][0];
      const driverId = input.driverId ?? preset?.driverId ?? profile?.driverId;
      const driver = driverId ? drivers.get(driverId) : void 0;
      if (!profile || !driver) throw new Error("no third-party provider profile or driver is configured");
      const model = input.model ?? preset?.model ?? profile.selectedModel ?? profile.models?.[0] ?? driver.models[0];
      if (!model || profile.models?.length && !profile.models.includes(model) && !driver.models.includes(model)) throw new Error(`model is not available: ${model}`);
      return Object.freeze({ providerId: profile.providerId, driverId, profileId: profile.id, credentialProfileId: profile.id, model });
    };
    const service = {
      get status() {
        return stopped ? "stopped" : "ready";
      },
      listDrivers: () => Object.freeze([...drivers.values()]),
      listModels: (providerId) => Object.freeze([...drivers.values()].filter((driver) => !providerId || driver.driverId === providerId || driver.providerId === providerId).map((driver) => ({ providerId: driver.providerId, models: Object.freeze([...driver.models]) }))),
      listCredentialProfiles: () => Object.freeze([...profiles.values()]),
      getCredentialProfile: (profileId) => profiles.get(profileId),
      async discoverModels(profileId) {
        const profile = profiles.get(profileId);
        if (!profile) throw new Error(`unknown profile: ${profileId}`);
        const driver = drivers.get(profile.driverId ?? profile.providerId);
        return Object.freeze([...driver?.models ?? profile.models ?? []]);
      },
      async upsertCredentialProfile(profile) {
        if (!profile.id || !profile.providerId) throw new Error("profile id and providerId are required");
        profiles.set(profile.id, Object.freeze({ ...profile, profileId: profile.profileId ?? profile.id, driverId: profile.driverId ?? profile.providerId, models: Object.freeze([...profile.models ?? []]) }));
        await persist();
      },
      async deleteCredentialProfile(profileId) {
        profiles.delete(profileId);
        secrets.delete(profileId);
        if (context.secrets?.delete) await context.secrets.delete(profileId);
        for (const kind of ["role", "director", "assistant"]) if (routes[kind]?.profileId === profileId) delete routes[kind];
        await persist();
      },
      async setCredentialSecret(profileId, secret) {
        if (!profiles.has(profileId)) throw new Error(`unknown profile: ${profileId}`);
        if (secret === void 0) {
          secrets.delete(profileId);
          await context.secrets?.delete?.(profileId);
        } else {
          secrets.set(profileId, secret);
          if (context.secrets) await context.secrets.set(profileId, secret);
        }
      },
      async hasCredentialSecret(profileId) {
        return context.secrets?.has ? context.secrets.has(profileId) : context.secrets ? await context.secrets.get(profileId) !== void 0 : secrets.has(profileId);
      },
      getRouteDefaults: () => Object.freeze({ ...routes }),
      async setRouteDefault(purpose, value) {
        if (value?.profileId && !profiles.has(value.profileId)) throw new Error(`unknown profile: ${value.profileId}`);
        routes[purpose] = value;
        await persist();
      },
      route,
      complete(input) {
        if (active.has(input.requestId)) throw new Error(`requestId already active: ${input.requestId}`);
        const controller = new AbortController();
        const reservation = { controller, driver: void 0 };
        active.set(input.requestId, reservation);
        const stream = (async function* () {
          let timer;
          try {
            const selected = await route(input);
            const driver = drivers.get(selected.driverId);
            reservation.driver = driver;
            const secret = input.credential?.secret ?? (context.secrets ? await context.secrets.get(selected.profileId) : secrets.get(selected.profileId));
            timer = setTimeout(() => controller.abort(), Number(input.metadata?.timeoutMs ?? 12e4));
            for await (const chunk of driver.request({ ...input, providerId: selected.providerId, credentialProfileId: selected.profileId, model: selected.model, credential: secret ? { profileId: selected.profileId, secret } : void 0, signal: controller.signal, metadata: input.metadata }, context)) {
              if (controller.signal.aborted) break;
              if (chunk.type === "usage") {
                const record = { requestId: input.requestId, providerId: selected.providerId, driverId: selected.driverId, profileId: selected.profileId, model: selected.model, inputTokens: chunk.usage?.inputTokens, outputTokens: chunk.usage?.outputTokens, cachedTokens: chunk.usage?.cachedTokens, durationMs: chunk.usage?.durationMs, cost: chunk.usage?.cost, currency: chunk.usage?.currency, timestamp: (context.now ?? (() => /* @__PURE__ */ new Date()))().toISOString() };
                usage.push(Object.freeze(record));
                await persist();
              }
              yield chunk;
            }
          } finally {
            if (timer) clearTimeout(timer);
            active.delete(input.requestId);
          }
        })();
        return stream;
      },
      async cancel(requestId) {
        const current = active.get(requestId);
        if (!current) return;
        current.controller.abort();
        await current.driver?.cancel?.(requestId, context);
      },
      async recordUsage(record) {
        usage.push(Object.freeze({ ...record }));
        await persist();
      },
      queryUsage: (filter = {}) => Object.freeze(usage.filter((record) => (!filter.requestId || record.requestId === filter.requestId) && (!filter.providerId || record.providerId === filter.providerId) && (!filter.driverId || record.driverId === filter.driverId) && (!filter.profileId || record.profileId === filter.profileId) && (!filter.model || record.model === filter.model) && (!filter.from || (record.timestamp ?? "") >= filter.from) && (!filter.to || (record.timestamp ?? "") <= filter.to))),
      aggregateUsage: (filter) => {
        const rows = service.queryUsage(filter);
        return { inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0), outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0), requests: new Set(rows.map((row) => row.requestId)).size, cachedTokens: rows.reduce((sum, row) => sum + (row.cachedTokens ?? 0), 0), durationMs: rows.reduce((sum, row) => sum + (row.durationMs ?? 0), 0), cost: rows.reduce((sum, row) => sum + (row.cost ?? 0), 0), currency: rows.find((row) => row.currency)?.currency };
      },
      async stop() {
        if (stopped) return;
        for (const id of [...active.keys()]) await service.cancel(id);
        stopped = true;
        await persist();
      }
    };
    return service;
  }
});
export {
  index_default as default
};
