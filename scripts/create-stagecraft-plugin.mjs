#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const allowed = new Set(['tool', 'provider-driver', 'llm-system', 'solution', 'ui', 'core'])
const flagTemplate = args.indexOf('--template')
const flagName = args.indexOf('--name')
const template = flagTemplate >= 0 ? args[flagTemplate + 1] : (allowed.has(args[1]) ? args[1] : (allowed.has(args[0]) ? args[0] : 'tool'))
const targetArg = flagName >= 0 ? args[flagName + 1] : (allowed.has(args[0]) ? (args[1] ?? 'my-stagecraft-plugin') : (args[0] ?? 'my-stagecraft-plugin'))
const target = resolve(targetArg)
const title = args.slice(2).filter(value => !value.startsWith('--') && value !== template && value !== targetArg).join(' ') || templateTitle(template)
if (!allowed.has(template)) { console.error(`template must be one of: ${[...allowed].join(', ')}`); process.exit(2) }
if (existsSync(target)) { console.error(`target already exists: ${target}`); process.exit(1) }

mkdirSync(join(target, 'src'), { recursive: true }); mkdirSync(join(target, 'test'), { recursive: true })
const id = `example.${template.replaceAll('-', '.')}`
const manifest = { id, version: '0.1.0', title, category: template, apiVersion: '0.1', ...(template === 'llm-system' ? { capabilities: { required: ['host.storage'], optional: ['host.secrets'] } } : {}), entry: { desktop: 'dist/index.js', android: 'dist/index.js' }, source: 'src/index.ts', output: 'dist/index.js' }
writeFileSync(join(target, 'stagecraft.plugin.json'), JSON.stringify(manifest, null, 2) + '\n')
// Vendor the tiny dependency-free authoring layer so a generated project works
// outside this repository as well; the runtime is bundled into dist/index.js.
writeFileSync(join(target, 'src', 'stagecraft-sdk.ts'), readFileSync(new URL('../src/sdk/authoring.ts', import.meta.url), 'utf8'))
writeFileSync(join(target, 'src', 'index.ts'), templateSource(template, id, title))
writeFileSync(join(target, 'test', 'plugin.test.ts'), templateTest(template, id))
const readme = template === 'llm-system'
  ? `# ${title}\n\nCreate this project with the scaffold command for the llm-system template. Then run:\n\nnode scripts/stagecraft.mjs plugin build .\nnode scripts/stagecraft.mjs plugin check .\nnode scripts/stagecraft.mjs plugin test .\nnode scripts/stagecraft.mjs plugin pack .\n\nThe generated LLM System requires host.storage and optionally uses host.secrets; it owns provider profiles, routes, secrets, cancellation and usage.\n`
  : `# ${title}\n\nCreate this project with the scaffold command for the ${template} template. Then run stagecraft plugin build ., stagecraft plugin check ., stagecraft plugin test . and stagecraft plugin pack .\n`
writeFileSync(join(target, 'README.md'), readme)
console.log(`created ${target} (${template} template)`)

function templateSource(kind, id, title) {
  const apiName = kind === 'provider-driver' ? 'defineProviderDriver' : kind === 'ui' ? 'defineUiPlugin' : kind === 'tool' ? 'defineToolPlugin' : kind === 'llm-system' ? 'createDefaultLlmSystemService, defineLlmSystem' : `define${kind[0].toUpperCase() + kind.slice(1)}`
  const header = `import { ${apiName} } from './stagecraft-sdk.ts'\n\n`
  const titleLiteral = JSON.stringify(title)
  if (kind === 'tool') return `${header}const plugin = defineToolPlugin({ id: '${id}', version: '0.1.0', title: ${titleLiteral}, execute: async input => ({ ok: true, input }) })\nexport default plugin\n`
  if (kind === 'provider-driver') return `${header}const plugin = defineProviderDriver({ id: '${id}', version: '0.1.0', title: ${titleLiteral}, providerId: 'example', models: ['example-model'], async *request() { yield { type: 'done' } } })\nexport default plugin\n`
  if (kind === 'llm-system') return `import { defineLlmSystem } from './stagecraft-sdk.ts'

// Independent starter: the LLM System owns profiles, routes, secrets,
// cancellation and usage; replace the selected ProviderDriver as needed.
const plugin = defineLlmSystem({ id: '${id}', version: '0.1.0', title: ${titleLiteral}, capabilities: { required: ['host.storage'], optional: ['host.secrets'] }, async start(context) {
  const profiles = new Map(); const secrets = new Map(); const usage = []; const routes = {}; const active = new Map(); let stopped = false
  const drivers = new Map((context.drivers ?? []).map(driver => [driver.driverId, driver]))
  const save = async () => context.state?.write('llm-system', { profiles: [...profiles.values()], routes, usage })
  const find = (id) => id ? profiles.get(id) ?? [...profiles.values()].find(profile => profile.providerId === id) : undefined
  const service = {
    get status() { return stopped ? 'stopped' : 'ready' }, listDrivers: () => [...drivers.values()],
    listModels: providerId => [...drivers.values()].filter(driver => !providerId || driver.driverId === providerId).map(driver => ({ providerId: driver.providerId, models: [...driver.models] })),
    listCredentialProfiles: () => [...profiles.values()], getCredentialProfile: id => profiles.get(id),
    discoverModels: async id => [...(drivers.get(profiles.get(id)?.driverId ?? '')?.models ?? [])],
    async upsertCredentialProfile(profile) { profiles.set(profile.id, Object.freeze({ ...profile, profileId: profile.profileId ?? profile.id, driverId: profile.driverId ?? profile.providerId })); await save() },
    async deleteCredentialProfile(id) { profiles.delete(id); secrets.delete(id); await context.secrets?.delete?.(id); await save() },
    async setCredentialSecret(id, secret) { if (secret === undefined) { secrets.delete(id); await context.secrets?.delete?.(id) } else { secrets.set(id, secret); if (context.secrets) await context.secrets.set(id, secret) } },
    hasCredentialSecret: async id => context.secrets ? (await context.secrets.get(id)) !== undefined : secrets.has(id),
    getRouteDefaults: () => ({ ...routes }), async setRouteDefault(purpose, value) { routes[purpose] = value; await save() },
    async route(input) { const preset = routes[input.role?.trim() ? 'role' : input.purpose]; const profile = find(input.profileId ?? input.credentialProfileId ?? input.providerId) ?? find(preset?.profileId) ?? [...profiles.values()][0]; const driverId = input.driverId ?? preset?.driverId ?? profile?.driverId; const model = input.model ?? preset?.model ?? profile?.selectedModel ?? profile?.models?.[0] ?? drivers.get(driverId)?.models?.[0]; if (!profile || !driverId || !model || !drivers.has(driverId)) throw new Error('configure a provider profile and driver first'); return { providerId: profile.providerId, driverId, profileId: profile.id, credentialProfileId: profile.id, model } },
    complete(input) { if (active.has(input.requestId)) throw new Error('requestId already active: ' + input.requestId); const controller = new AbortController(); const reservation = { controller, driver: undefined }; active.set(input.requestId, reservation); return (async function* () { let timer; try { const selected = await service.route(input); const driver = drivers.get(selected.driverId); reservation.driver = driver; const secret = input.credential?.secret ?? (context.secrets ? await context.secrets.get(selected.profileId) : secrets.get(selected.profileId)); timer = setTimeout(() => controller.abort(), Number(input.metadata?.timeoutMs ?? 120000)); for await (const chunk of driver.request({ ...input, model: selected.model, providerId: selected.providerId, credentialProfileId: selected.profileId, credential: secret ? { profileId: selected.profileId, secret } : undefined, signal: controller.signal }, context)) { if (controller.signal.aborted) break; if (chunk.type === 'usage') { usage.push({ requestId: input.requestId, providerId: selected.providerId, driverId: selected.driverId, profileId: selected.profileId, model: selected.model, ...chunk.usage, timestamp: new Date().toISOString() }); await save() } yield chunk } } finally { if (timer) clearTimeout(timer); active.delete(input.requestId) } })() },
    async cancel(id) { const current = active.get(id); if (!current) return; current.controller.abort(); await current.driver?.cancel?.(id, context) }, recordUsage: async record => { usage.push(record); await save() },
    queryUsage: filter => usage.filter(record => (!filter?.requestId || record.requestId === filter.requestId) && (!filter?.providerId || record.providerId === filter.providerId) && (!filter?.driverId || record.driverId === filter.driverId)), aggregateUsage: filter => { const rows = service.queryUsage(filter); return { inputTokens: rows.reduce((n, row) => n + (row.inputTokens ?? 0), 0), outputTokens: rows.reduce((n, row) => n + (row.outputTokens ?? 0), 0), requests: new Set(rows.map(row => row.requestId)).size } },
    async stop() { if (stopped) return; for (const id of [...active.keys()]) await service.cancel(id); stopped = true; await save() },
  }; const restored = await context.state?.read('llm-system'); for (const profile of restored?.profiles ?? []) profiles.set(profile.id, profile); Object.assign(routes, restored?.routes ?? {}); usage.push(...(restored?.usage ?? [])); return service
} })
export default plugin
`
  if (kind === 'solution') return `${header}const plugin = defineSolution({ id: '${id}', version: '0.1.0', title: ${titleLiteral}, systemPrompt: 'You are helpful.', assemblePrompt: ({ user }) => user })\nexport default plugin\n`
  if (kind === 'ui') return `${header}const plugin = defineUiPlugin({ id: '${id}', version: '0.1.0', title: ${titleLiteral}, render: ({ surface }) => surface.render({ type: 'text', text: 'Hello StageCraft' }) })\nexport default plugin\n`
  return `${header}const plugin = defineCore({ id: '${id}', version: '0.1.0', title: ${titleLiteral}, start(context) { context.registerCommand('echo', input => ({ ok: true, input })); context.ready() } })\nexport default plugin\n`
}

function templateTitle(kind) {
  if (kind === 'tool') return 'Example tool'
  if (kind === 'provider-driver') return 'Example provider driver'
  if (kind === 'llm-system') return 'Example LLM system'
  if (kind === 'solution') return 'Example solution'
  if (kind === 'ui') return 'Example UI'
  return 'Example core'
}

function templateTest(kind, id) {
  const header = `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport plugin from '../src/index.ts'\n`
  if (kind === 'tool') return `${header}test('tool executes', async () => assert.deepEqual(await plugin.execute('hello', { apiVersion: '0.1', pluginId: '${id}', config: {}, log() {} }), { ok: true, input: 'hello' }))\n`
  if (kind === 'provider-driver') return `${header}test('provider streams a completion', async () => { const chunks = []; for await (const chunk of plugin.request({ requestId: 'template-1', model: 'example-model', messages: [] }, { apiVersion: '0.1', pluginId: '${id}', config: {}, log() {} })) chunks.push(chunk.type); assert.deepEqual(chunks, ['done']) })\n`
  if (kind === 'llm-system') return `import { createAuthoringLlmSystemHarness, defineProviderDriver } from '../src/stagecraft-sdk.ts'\n${header}test('llm system stop cancels an active request through its driver', async () => { let cancelled = ''; const driver = defineProviderDriver({ id: 'template.driver', version: '0.1.0', title: 'Template driver', providerId: 'template', models: ['template-model'], async *request(request) { while (!request.signal?.aborted) await new Promise(resolve => setTimeout(resolve, 1)); yield { type: 'done' } }, cancel: id => { cancelled = id } }); const service = await createAuthoringLlmSystemHarness(plugin, {}, { drivers: [driver] }); await service.upsertCredentialProfile({ id: 'template-profile', providerId: 'template', driverId: 'template', models: ['template-model'] }); const task = (async () => { for await (const _chunk of service.complete({ requestId: 'template-active', providerId: 'template', model: 'template-model', messages: [] })) {} })(); await new Promise(resolve => setTimeout(resolve, 0)); await service.stop(); await task; assert.equal(cancelled, 'template-active'); assert.equal(service.status, 'stopped') })\n`
  if (kind === 'solution') return `${header}test('solution assembles a prompt', async () => assert.equal(await plugin.assemblePrompt({ user: 'hello' }, { apiVersion: '0.1', pluginId: '${id}', config: {}, log() {} }), 'hello'))\n`
  if (kind === 'ui') return `${header}test('ui renders a portable view', async () => { const result = await plugin.render({ surface: { id: 'main', render: view => ({ surfaceId: 'main', view }) } }, { apiVersion: '0.1', pluginId: '${id}', config: {}, log() {} }); assert.deepEqual(result.view, { type: 'text', text: 'Hello StageCraft' }) })\n`
  return `import { createAuthoringCoreHarness } from '../src/stagecraft-sdk.ts'\n${header}test('core is ready and handles a command', async () => { const harness = await createAuthoringCoreHarness(plugin); assert.equal(harness.status, 'ready'); assert.deepEqual(await harness.dispatch('echo', 'hello'), { ok: true, input: 'hello' }) })\n`
}
