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
function defineSolution(definition) {
  if (typeof definition.assemblePrompt !== "function") throw new TypeError("solution assemblePrompt must be a function");
  const value = { kind: "solution", manifest: manifest(definition, "solution"), systemPrompt: definition.systemPrompt, assemblePrompt: definition.assemblePrompt, handleCommand: definition.handleCommand };
  return Object.freeze(value);
}

// examples/v2/solution/src/index.ts
var index_default = defineSolution({ id: "example.stagecraft.solution", version: "1.0.0", title: "Example Solution", systemPrompt: "You are the StageCraft demo narrator.", assemblePrompt({ user }) {
  return `User says: ${user}`;
} });
export {
  index_default as default
};
