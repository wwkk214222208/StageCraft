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
  if (definition.capabilities !== void 0) value.capabilities = Object.freeze([...definition.capabilities]);
  return Object.freeze(value);
}
function defineCore(definition) {
  if (typeof definition.start !== "function") throw new TypeError("core start must be a function");
  const value = { kind: "core", manifest: manifest(definition, "core"), start: definition.start, stop: definition.stop };
  return Object.freeze(value);
}
async function createAuthoringLlmSystemHarness(plugin, config = {}, options = {}) {
  const drivers = /* @__PURE__ */ new Map();
  const profiles = /* @__PURE__ */ new Map();
  const usage = [];
  const active = /* @__PURE__ */ new Map();
  let stopped = false;
  const context = {
    apiVersion: STAGECRAFT_AUTHORING_API,
    pluginId: plugin.manifest.id,
    config,
    log() {
    },
    registerDriver(driver) {
      if (driver.kind !== "provider-driver") throw new TypeError("only provider drivers may be registered");
      if (drivers.has(driver.providerId)) throw new Error(`duplicate provider driver: ${driver.providerId}`);
      drivers.set(driver.providerId, driver);
    },
    listDrivers: () => Object.freeze([...drivers.values()]),
    listModels: (providerId) => Object.freeze([...drivers.values()].filter((d) => !providerId || d.providerId === providerId).map((d) => Object.freeze({ providerId: d.providerId, models: Object.freeze([...d.models]) }))),
    upsertCredentialProfile(profile) {
      if (!profile?.id || !profile.providerId) throw new Error("credential profile id and providerId are required");
      profiles.set(profile.id, Object.freeze({ ...profile }));
    },
    listCredentialProfiles: () => Object.freeze([...profiles.values()])
  };
  for (const driver of options.drivers ?? []) context.registerDriver(driver);
  await plugin.start(context);
  let status = "ready";
  const route = async (input) => {
    if (stopped) throw new Error("llm-system is stopped");
    const selected = await plugin.route(input, context);
    if (!selected?.providerId || !selected.model) throw new Error("llm-system route must select providerId and model");
    const driver = drivers.get(selected.providerId);
    if (!driver) throw new Error(`no provider driver registered for ${selected.providerId}`);
    if (!driver.models.includes(selected.model)) throw new Error(`driver ${selected.providerId} does not provide model ${selected.model}`);
    if (selected.credentialProfileId) {
      const profile = profiles.get(selected.credentialProfileId);
      if (!profile) throw new Error(`unknown credential profile: ${selected.credentialProfileId}`);
      if (profile.providerId !== selected.providerId) throw new Error(`credential profile ${selected.credentialProfileId} belongs to ${profile.providerId}`);
    }
    return Object.freeze({ ...selected });
  };
  const complete = (input) => {
    if (active.has(input.requestId)) throw new Error(`requestId already active: ${input.requestId}`);
    const iterator = (async function* () {
      const selected = await route({ providerId: input.providerId, model: input.model, credentialProfileId: input.credentialProfileId, metadata: input.metadata });
      const driver = drivers.get(selected.providerId);
      if (input.credential && input.credential.profileId !== selected.credentialProfileId) throw new Error("credential material does not match selected profile");
      const controller = new AbortController();
      active.set(input.requestId, { controller, driver });
      try {
        for await (const chunk of driver.request({ requestId: input.requestId, providerId: selected.providerId, model: selected.model, credentialProfileId: selected.credentialProfileId, credential: input.credential, messages: input.messages, signal: controller.signal, metadata: input.metadata }, context)) {
          if (controller.signal.aborted) break;
          yield chunk;
          if (chunk.type === "usage" && chunk.usage) usage.push(Object.freeze({ requestId: input.requestId, providerId: selected.providerId, model: selected.model, ...chunk.usage, timestamp: (/* @__PURE__ */ new Date()).toISOString() }));
        }
      } finally {
        active.delete(input.requestId);
      }
    })();
    return iterator;
  };
  return { get status() {
    return status;
  }, listDrivers: context.listDrivers, listModels: context.listModels, listCredentialProfiles: context.listCredentialProfiles, upsertCredentialProfile: context.upsertCredentialProfile, route, complete, async cancel(requestId) {
    const current = active.get(requestId);
    if (!current) return;
    current.controller.abort();
    await current.driver.cancel?.(requestId, context);
  }, recordUsage(record) {
    usage.push(Object.freeze({ ...record }));
  }, queryUsage(filter = {}) {
    return Object.freeze(usage.filter((r) => (!filter.providerId || r.providerId === filter.providerId) && (!filter.model || r.model === filter.model)));
  }, aggregateUsage(filter = {}) {
    const rows = usage.filter((r) => (!filter.providerId || r.providerId === filter.providerId) && (!filter.model || r.model === filter.model));
    return Object.freeze({ inputTokens: rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0), outputTokens: rows.reduce((n, r) => n + (r.outputTokens ?? 0), 0), requests: new Set(rows.map((r) => r.requestId)).size });
  }, async stop() {
    if (stopped) return;
    stopped = true;
    for (const requestId of [...active.keys()]) await this.cancel(requestId);
    await plugin.stop?.(context);
    status = "stopped";
  } };
}

// examples/v2/core/src/index.ts
var index_default = defineCore({ id: "example.stagecraft.core", version: "1.0.0", title: "Example replaceable Core", start(context) {
  const values = (context.components ?? []).map((component) => component.defaultExport);
  const solution = values.find((value) => value?.kind === "solution");
  const llmSystem = values.find((value) => value?.kind === "llm-system");
  const drivers = values.filter((value) => value?.kind === "provider-driver");
  const tool = values.find((value) => value?.kind === "tool");
  if (!solution || !llmSystem || !tool || drivers.length !== 1) throw new Error("demo components missing");
  const llm = createAuthoringLlmSystemHarness(llmSystem, {}, { drivers });
  context.registerCommand("demo/run", async (input) => {
    const assembled = await solution.assemblePrompt({ user: String(input?.user ?? "") }, context);
    const messages = [{ role: "system", content: solution.systemPrompt }, { role: "user", content: assembled }];
    const chunks = [];
    for await (const chunk of (await llm).complete({ requestId: "demo-request", messages })) chunks.push(chunk);
    return { messages, chunks, tool: await tool.execute(input?.tool ?? "ok", context) };
  });
  context.registerCommand("demo/ping", () => ({ ok: true, core: context.pluginId }));
  context.ready();
} });
export {
  index_default as default
};
