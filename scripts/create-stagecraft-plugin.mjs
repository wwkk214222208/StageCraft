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
const manifest = { id, version: '0.1.0', title, category: template, apiVersion: '0.1', entry: { desktop: 'dist/index.js', android: 'dist/index.js' }, source: 'src/index.ts', output: 'dist/index.js' }
writeFileSync(join(target, 'stagecraft.plugin.json'), JSON.stringify(manifest, null, 2) + '\n')
// Vendor the tiny dependency-free authoring layer so a generated project works
// outside this repository as well; the runtime is bundled into dist/index.js.
writeFileSync(join(target, 'src', 'stagecraft-sdk.ts'), readFileSync(new URL('../src/sdk/authoring.ts', import.meta.url), 'utf8'))
writeFileSync(join(target, 'src', 'index.ts'), templateSource(template, id, title))
writeFileSync(join(target, 'test', 'plugin.test.ts'), templateTest(template, id))
writeFileSync(join(target, 'README.md'), `# ${title}\n\nRun stagecraft plugin build ., then stagecraft plugin check . and stagecraft plugin pack .\n`)
console.log(`created ${target} (${template} template)`)

function templateSource(kind, id, title) {
  const apiName = kind === 'provider-driver' ? 'defineProviderDriver' : kind === 'ui' ? 'defineUiPlugin' : kind === 'tool' ? 'defineToolPlugin' : kind === 'llm-system' ? 'defineLlmSystem, defineProviderDriver' : `define${kind[0].toUpperCase() + kind.slice(1)}`
  const header = `import { ${apiName} } from './stagecraft-sdk.ts'\n\n`
  const titleLiteral = JSON.stringify(title)
  if (kind === 'tool') return `${header}const plugin = defineToolPlugin({ id: '${id}', version: '0.1.0', title: ${titleLiteral}, execute: async input => ({ ok: true, input }) })\nexport default plugin\n`
  if (kind === 'provider-driver') return `${header}const plugin = defineProviderDriver({ id: '${id}', version: '0.1.0', title: ${titleLiteral}, providerId: 'example', models: ['example-model'], async *request() { yield { type: 'done' } } })\nexport default plugin\n`
  if (kind === 'llm-system') return `${header}const plugin = defineLlmSystem({ id: '${id}', version: '0.1.0', title: ${titleLiteral}, start(context) { context.registerDriver(defineProviderDriver({ id: '${id}.driver', version: '0.1.0', title: 'Example driver', providerId: 'example', models: ['example-model'], async *request() { yield { type: 'text', text: 'hello' }; yield { type: 'done' } } })) }, route: () => ({ providerId: 'example', model: 'example-model' }) })\nexport default plugin\n`
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
  if (kind === 'llm-system') return `${header}test('llm system registers a driver and routes', async () => { const { createAuthoringLlmSystemHarness } = await import('../src/stagecraft-sdk.ts'); const harness = await createAuthoringLlmSystemHarness(plugin); assert.deepEqual(harness.listModels(), [{ providerId: 'example', models: ['example-model'] }]); assert.deepEqual(await harness.route({}), { providerId: 'example', model: 'example-model' }) })\n`
  if (kind === 'solution') return `${header}test('solution assembles a prompt', async () => assert.equal(await plugin.assemblePrompt({ user: 'hello' }, { apiVersion: '0.1', pluginId: '${id}', config: {}, log() {} }), 'hello'))\n`
  if (kind === 'ui') return `${header}test('ui renders a portable view', async () => { const result = await plugin.render({ surface: { id: 'main', render: view => ({ surfaceId: 'main', view }) } }, { apiVersion: '0.1', pluginId: '${id}', config: {}, log() {} }); assert.deepEqual(result.view, { type: 'text', text: 'Hello StageCraft' }) })\n`
  return `import { createAuthoringCoreHarness } from '../src/stagecraft-sdk.ts'\n${header}test('core is ready and handles a command', async () => { const harness = await createAuthoringCoreHarness(plugin); assert.equal(harness.status, 'ready'); assert.deepEqual(await harness.dispatch('echo', 'hello'), { ok: true, input: 'hello' }) })\n`
}
