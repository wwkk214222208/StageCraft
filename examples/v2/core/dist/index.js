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

// examples/v2/core/src/index.ts
var index_default = defineCore({ id: "example.stagecraft.core", version: "1.0.0", title: "Example replaceable Core", start(context) {
  const values = (context.components ?? []).map((component) => component.defaultExport);
  const solution = values.find((value) => value?.kind === "solution");
  const tool = values.find((value) => value?.kind === "tool");
  const llm = context.llmSystems?.[0]?.service;
  if (!solution || !llm || !tool) throw new Error("demo components missing");
  context.registerCommand("demo/run", async (input) => {
    const assembled = await solution.assemblePrompt({ user: String(input?.user ?? "") }, context);
    const messages = [{ role: "system", content: solution.systemPrompt }, { role: "user", content: assembled }];
    const chunks = [];
    for await (const chunk of llm.complete({ requestId: "demo-request", messages })) chunks.push(chunk);
    return { messages, chunks, tool: await tool.execute(input?.tool ?? "ok", context) };
  });
  context.registerCommand("demo/ping", () => ({ ok: true, core: context.pluginId }));
  context.ready();
} });
export {
  index_default as default
};
