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
function defineProviderDriver(definition) {
  if (!definition.providerId?.trim()) throw new Error("providerId is required");
  if (!Array.isArray(definition.models) || definition.models.length === 0) throw new Error("provider driver must declare at least one model");
  if (typeof definition.request !== "function") throw new TypeError("provider request must be a function");
  const value = { kind: "provider-driver", manifest: manifest(definition, "provider-driver"), driverId: definition.driverId ?? definition.providerId, providerId: definition.providerId, models: Object.freeze([...definition.models]), request: definition.request, cancel: definition.cancel };
  return Object.freeze(value);
}

// examples/v2/driver/src/index.ts
var index_default = defineProviderDriver({ id: "example.stagecraft.driver", version: "1.0.0", title: "Example Provider Driver", providerId: "demo", models: ["demo-1"], async *request(request) {
  yield { type: "text", text: `echo:${request.messages.map((message) => message.content).join("|")}` };
  yield { type: "usage", usage: { inputTokens: 4, outputTokens: 6 } };
  yield { type: "done" };
} });
export {
  index_default as default
};
