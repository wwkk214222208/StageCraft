import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'))
const createCli = join(root, 'scripts', 'create-stagecraft-plugin.mjs')
const stagecraftCli = join(root, 'scripts', 'stagecraft.mjs')

function run(script: string, args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('CLI covers all six templates and deterministic packing', () => {
  const base = mkdtempSync(join(root, '.tmp-sdk-cli-'))
  try {
    for (const kind of ['tool', 'provider-driver', 'llm-system', 'solution', 'ui', 'core']) {
      const project = join(base, kind)
      assert.equal(run(createCli, [project, kind], root).status, 0)
      assert.equal(run(stagecraftCli, ['plugin', 'build', project], root).status, 0)
      assert.equal(run(stagecraftCli, ['plugin', 'test', project], root).status, 0)
      assert.equal(run(stagecraftCli, ['plugin', 'check', project], root).status, 0)
      assert.equal(run(stagecraftCli, ['plugin', 'pack', project], root).status, 0)
      const archive = readdirSync(project).find(name => name.endsWith('.stagecraft-plugin.zip'))
      assert.ok(archive)
      const first = readFileSync(join(project, archive!))
      assert.equal(run(stagecraftCli, ['plugin', 'pack', project], root).status, 0)
      assert.deepEqual(readFileSync(join(project, archive!)), first, `${kind} pack should be deterministic`)
      const manifest = JSON.parse(readFileSync(join(project, 'stagecraft.plugin.json'), 'utf8'))
      const expectedManifestKeys = ['apiVersion', 'category', 'entry', 'id', 'integrity', 'output', 'source', 'title', 'version', ...(kind === 'llm-system' ? ['capabilities'] : [])]
      assert.deepEqual(Object.keys(manifest).sort(), expectedManifestKeys.sort())
    }
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('CLI check rejects root escape, CommonJS, divergent entries and missing tests', () => {
  const base = mkdtempSync(join(root, '.tmp-sdk-cli-invalid-'))
  try {
    const project = join(base, 'plugin')
    assert.equal(run(createCli, [project, 'tool'], root).status, 0)
    assert.equal(run(stagecraftCli, ['plugin', 'build', project], root).status, 0)
    const manifestPath = join(project, 'stagecraft.plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.capabilities = { required: 'host.storage' }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    let result = run(stagecraftCli, ['plugin', 'check', project], root)
    assert.notEqual(result.status, 0); assert.match(result.output, /manifest\.capabilities\.required/)
    delete manifest.capabilities; writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    manifest.id = 'stagecraft.character-status'; manifest.title = 'Character Status UI'; manifest.category = 'ui'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    result = run(stagecraftCli, ['plugin', 'check', project], root)
    assert.notEqual(result.status, 0); assert.match(result.output, /built manifest mismatch for (id|title|category)/)
    manifest.id = 'example.tool'; manifest.title = 'Example tool'; manifest.category = 'tool'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    manifest.source = '../escape.ts'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    result = run(stagecraftCli, ['plugin', 'check', project], root)
    assert.notEqual(result.status, 0); assert.match(result.output, /inside the plugin root/)
    manifest.source = resolve(project, 'absolute.ts'); writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    result = run(stagecraftCli, ['plugin', 'check', project], root)
    assert.notEqual(result.status, 0); assert.match(result.output, /inside the plugin root/)
    manifest.source = 'src'; writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    result = run(stagecraftCli, ['plugin', 'check', project], root)
    assert.notEqual(result.status, 0); assert.match(result.output, /missing TypeScript entry/)
    manifest.source = 'src/index.ts'; manifest.entry.android = 'dist/android.js'; writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    result = run(stagecraftCli, ['plugin', 'check', project], root)
    assert.notEqual(result.status, 0); assert.match(result.output, /one shared portable entry/)
    manifest.entry.android = 'dist/index.js'; writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    writeFileSync(join(project, 'src', 'bad-cjs.ts'), 'module.exports = {}\n')
    result = run(stagecraftCli, ['plugin', 'check', project], root)
    assert.notEqual(result.status, 0); assert.match(result.output, /forbidden reference/)
    rmSync(join(project, 'src', 'bad-cjs.ts'))
    rmSync(join(project, 'test'), { recursive: true, force: true })
    result = run(stagecraftCli, ['plugin', 'test', project], root)
    assert.notEqual(result.status, 0); assert.match(result.output, /no plugin tests found/)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('LLM package capabilities are projected into the packed v2 manifest', () => {
  const base = mkdtempSync(join(root, '.tmp-sdk-llm-capabilities-'))
  try {
    const project = join(base, 'llm')
    assert.equal(run(createCli, [project, 'llm-system'], root).status, 0)
    assert.equal(run(stagecraftCli, ['plugin', 'build', project], root).status, 0)
    const packageManifest = JSON.parse(readFileSync(join(project, 'stagecraft.plugin.json'), 'utf8'))
    assert.deepEqual(packageManifest.capabilities, { required: ['host.storage'], optional: ['host.secrets'] })
    assert.equal(run(stagecraftCli, ['plugin', 'pack', project], root).status, 0)
    const archive = readFileSync(join(project, 'example-llm-system-0.1.0.stagecraft-plugin.zip'))
    const marker = Buffer.from('manifest.json')
    const nameOffset = archive.indexOf(marker)
    assert.ok(nameOffset > 0)
    const localOffset = nameOffset - 30
    const nameLength = archive.readUInt16LE(localOffset + 26)
    const dataLength = archive.readUInt32LE(localOffset + 22)
    const packedManifest = JSON.parse(archive.subarray(localOffset + 30 + nameLength, localOffset + 30 + nameLength + dataLength).toString('utf8'))
    assert.deepEqual(packedManifest.capabilities, { required: ['host.storage'], optional: ['host.secrets'] })
  } finally { rmSync(base, { recursive: true, force: true }) }
})
