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
function defineLlmSystem(definition) {
  if (typeof definition.start !== "function") throw new TypeError("llm-system start must be a function");
  if (typeof definition.route !== "function") throw new TypeError("llm-system route must be a function");
  const value = { kind: "llm-system", manifest: manifest(definition, "llm-system"), start: definition.start, stop: definition.stop, route: definition.route };
  return Object.freeze(value);
}

// examples/v2/llm/src/index.ts
var index_default = defineLlmSystem({ id: "example.stagecraft.llm", version: "1.0.0", title: "Example LLM System", start(context) {
  context.upsertCredentialProfile({ id: "demo-profile", providerId: "demo", label: "Demo (no secret)" });
}, route(input) {
  return { providerId: input.providerId ?? "demo", model: input.model ?? "demo-1", credentialProfileId: input.credentialProfileId ?? "demo-profile" };
} });
export {
  index_default as default
};
