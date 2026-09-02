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
async function createDefaultLlmSystemService(context, options = {}) {
  const drivers = /* @__PURE__ */ new Map();
  const profiles = /* @__PURE__ */ new Map();
  const usage = [];
  const secrets = /* @__PURE__ */ new Map();
  const active = /* @__PURE__ */ new Map();
  let stopped = false;
  const store = options.store ?? (context.state ? { read: () => context.state.read("llm-system"), write: (snapshot2) => context.state.write("llm-system", snapshot2) } : void 0);
  const snapshot = () => Object.freeze({ credentialProfiles: Object.freeze([...profiles.values()].map((profile) => ({ ...profile }))), usage: Object.freeze(usage.map((record) => ({ ...record }))), secrets: Object.freeze(context.secrets ? {} : Object.fromEntries(secrets)) });
  let writeChain = Promise.resolve();
  const persist = () => {
    if (!store) return;
    const state = snapshot();
    writeChain = writeChain.then(() => store.write(state)).catch(() => void 0);
  };
  if (store) {
    const restored = await store.read().catch(() => void 0);
    if (restored) {
      for (const profile of restored.credentialProfiles ?? []) profiles.set(profile.id, Object.freeze({ ...profile }));
      for (const record of restored.usage ?? []) usage.push(Object.freeze({ ...record }));
      if (!context.secrets) for (const [profileId, secret] of Object.entries(restored.secrets ?? {})) secrets.set(profileId, secret);
    }
  }
  const contextDrivers = context.drivers ?? [];
  for (const driver of contextDrivers) {
    if (driver.kind !== "provider-driver") throw new TypeError("only provider drivers may be supplied");
    if (drivers.has(driver.providerId)) throw new Error(`duplicate provider driver: ${driver.providerId}`);
    drivers.set(driver.providerId, driver);
  }
  let status = "ready";
  const route = async (input) => {
    if (stopped) throw new Error("llm-system is stopped");
    const providerId = input.providerId ?? drivers.keys().next().value;
    const driver = providerId ? drivers.get(providerId) : void 0;
    const model = input.model ?? driver?.models[0];
    if (!providerId || !model) throw new Error("llm-system has no provider driver/model");
    if (!driver) throw new Error(`no provider driver registered for ${providerId}`);
    if (!driver.models.includes(model)) throw new Error(`driver ${providerId} does not provide model ${model}`);
    const credentialProfileId = input.credentialProfileId ?? [...profiles.values()].find((profile) => profile.providerId === providerId)?.id;
    if (credentialProfileId) {
      const profile = profiles.get(credentialProfileId);
      if (!profile) throw new Error(`unknown credential profile: ${credentialProfileId}`);
      if (profile.providerId !== providerId) throw new Error(`credential profile ${credentialProfileId} belongs to ${profile.providerId}`);
    }
    return Object.freeze({ providerId, model, ...credentialProfileId ? { credentialProfileId } : {} });
  };
  const complete = (input) => {
    if (active.has(input.requestId)) throw new Error(`requestId already active: ${input.requestId}`);
    const iterator = (async function* () {
      const selected = await route({ providerId: input.providerId, model: input.model, credentialProfileId: input.credentialProfileId, metadata: input.metadata });
      const driver = drivers.get(selected.providerId);
      if (input.credential && input.credential.profileId !== selected.credentialProfileId) throw new Error("credential material does not match selected profile");
      const storedSecret = selected.credentialProfileId ? (context.secrets ? await context.secrets.get(selected.credentialProfileId) : void 0) ?? secrets.get(selected.credentialProfileId) : void 0;
      const credential = input.credential ?? (storedSecret !== void 0 ? { profileId: selected.credentialProfileId, secret: storedSecret } : void 0);
      const controller = new AbortController();
      active.set(input.requestId, { controller, driver });
      try {
        for await (const chunk of driver.request({ requestId: input.requestId, providerId: selected.providerId, model: selected.model, credentialProfileId: selected.credentialProfileId, credential, messages: input.messages, signal: controller.signal, metadata: input.metadata }, context)) {
          if (controller.signal.aborted) break;
          yield chunk;
          if (chunk.type === "usage" && chunk.usage) {
            usage.push(Object.freeze({ requestId: input.requestId, providerId: selected.providerId, model: selected.model, ...chunk.usage, timestamp: (/* @__PURE__ */ new Date()).toISOString() }));
            persist();
          }
        }
      } finally {
        active.delete(input.requestId);
      }
    })();
    return iterator;
  };
  return { get status() {
    return status;
  }, listDrivers: () => Object.freeze([...drivers.values()]), listModels: (providerId) => Object.freeze([...drivers.values()].filter((d) => !providerId || d.providerId === providerId).map((d) => Object.freeze({ providerId: d.providerId, models: Object.freeze([...d.models]) }))), listCredentialProfiles: () => Object.freeze([...profiles.values()]), getCredentialProfile: (profileId) => profiles.get(profileId), async discoverModels(profileId) {
    const profile = profiles.get(profileId);
    if (!profile) throw new Error(`unknown credential profile: ${profileId}`);
    return Object.freeze([...profile.models ?? drivers.get(profile.driverId ?? profile.providerId)?.models ?? []]);
  }, upsertCredentialProfile(profile) {
    if (!profile?.id || !profile.providerId) throw new Error("credential profile id and providerId are required");
    const existing = profiles.get(profile.id);
    profiles.set(profile.id, Object.freeze({ ...existing, ...profile }));
    persist();
  }, async deleteCredentialProfile(profileId) {
    profiles.delete(profileId);
    if (!context.secrets) secrets.delete(profileId);
    await context.secrets?.delete?.(profileId);
    persist();
  }, async setCredentialSecret(profileId, secret) {
    if (!profiles.has(profileId)) throw new Error(`unknown credential profile: ${profileId}`);
    if (secret === void 0) {
      if (!context.secrets) secrets.delete(profileId);
      await context.secrets?.delete?.(profileId);
    } else {
      if (!context.secrets) secrets.set(profileId, secret);
      await context.secrets?.set(profileId, secret);
    }
    persist();
  }, async hasCredentialSecret(profileId) {
    if (context.secrets?.has) return context.secrets.has(profileId);
    if (context.secrets) return await context.secrets.get(profileId) !== void 0;
    return secrets.has(profileId);
  }, getRouteDefaults: () => ({}), setRouteDefault() {
  }, route, complete, async cancel(requestId) {
    const current = active.get(requestId);
    if (!current) return;
    current.controller.abort();
    await current.driver.cancel?.(requestId, context);
  }, recordUsage(record) {
    usage.push(Object.freeze({ ...record }));
    persist();
  }, queryUsage(filter = {}) {
    return Object.freeze(usage.filter((r) => (!filter.providerId || r.providerId === filter.providerId) && (!filter.model || r.model === filter.model) && (!filter.requestId || r.requestId === filter.requestId) && (!filter.from || (r.timestamp ?? "") >= filter.from) && (!filter.to || (r.timestamp ?? "") <= filter.to)));
  }, aggregateUsage(filter = {}) {
    const rows = usage.filter((r) => (!filter.providerId || r.providerId === filter.providerId) && (!filter.model || r.model === filter.model) && (!filter.requestId || r.requestId === filter.requestId) && (!filter.from || (r.timestamp ?? "") >= filter.from) && (!filter.to || (r.timestamp ?? "") <= filter.to));
    return Object.freeze({ inputTokens: rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0), outputTokens: rows.reduce((n, r) => n + (r.outputTokens ?? 0), 0), requests: new Set(rows.map((r) => r.requestId)).size });
  }, async stop() {
    if (stopped) return;
    stopped = true;
    const errors = [];
    for (const requestId of [...active.keys()]) {
      try {
        await this.cancel(requestId);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await writeChain;
    } catch (error) {
      errors.push(error);
    }
    status = "stopped";
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "one or more LLM harness stop operations failed");
  } };
}

// examples/v2/llm/src/index.ts
var index_default = defineLlmSystem({
  id: "example.stagecraft.llm",
  version: "1.0.0",
  title: "Example LLM System",
  async start(context) {
    const service = await createDefaultLlmSystemService(context);
    await service.upsertCredentialProfile({ id: "demo-profile", providerId: "demo", label: "Demo (no secret)" });
    return service;
  }
});
export {
  index_default as default
};
