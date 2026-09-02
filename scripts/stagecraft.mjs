#!/usr/bin/env node
/** Minimal, portable authoring CLI prototype. Not the production installer. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const command = args[0] === 'plugin' ? args[1] : undefined
const project = resolve(args[2] && !args[2].startsWith('-') ? args[2] : process.cwd())
let checkImportNonce = 0

if (!command || !['dev', 'check', 'test', 'build', 'pack'].includes(command)) {
  console.error('usage: stagecraft plugin <dev|check|test|build|pack> [project]')
  process.exitCode = 2
} else {
  try {
    if (command === 'check') process.exitCode = (await check(project)) ? 0 : 1
    if (command === 'build') await buildPlugin(project)
    if (command === 'pack') await packPlugin(project)
    if (command === 'test') await testPlugin(project)
    if (command === 'dev') await devPlugin(project)
  } catch (error) {
    console.error(`[stagecraft] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

function readManifest(projectDir) {
  const file = join(projectDir, 'stagecraft.plugin.json')
  if (!existsSync(file)) throw new Error(`missing ${file}`)
  let value
  try { value = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { throw new Error(`invalid manifest JSON: ${error.message}`) }
  return { file, value }
}

function filesUnder(dir, extensions = ['.ts', '.js', '.mjs']) {
  if (!existsSync(dir)) return []
  const result = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) result.push(...filesUnder(path, extensions))
    else if (extensions.includes(extname(name))) result.push(path)
  }
  return result
}

async function check(projectDir, { quiet = false } = {}) {
  const errors = []
  let manifest
  try { manifest = readManifest(projectDir).value } catch (error) { errors.push(error.message); return report(errors, quiet) }
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(manifest.id ?? '')) errors.push('manifest.id must be reverse-domain lowercase')
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version ?? '')) errors.push('manifest.version must be semver')
  if (!manifest.title?.trim()) errors.push('manifest.title is required')
  if (!['tool', 'provider-driver', 'llm-system', 'solution', 'ui', 'core'].includes(manifest.category)) errors.push('manifest.category must be tool/provider-driver/llm-system/solution/ui/core')
  if (manifest.apiVersion !== '0.1') errors.push(`unsupported manifest.apiVersion: ${manifest.apiVersion ?? 'missing'}`)
  errors.push(...validateCapabilities(manifest.capabilities))
  let sourceEntry; let outputEntry; const entryPaths = {}
  try {
    sourceEntry = safeProjectPath(projectDir, manifest.source ?? 'src/index.ts', 'source')
    outputEntry = safeProjectPath(projectDir, manifest.output ?? 'dist/index.js', 'output')
    const entry = manifest.entry ?? {}
    for (const key of ['desktop', 'android']) entryPaths[key] = safeProjectPath(projectDir, entry[key], `entry.${key}`)
    assertSharedPortableEntry(manifest)
  } catch (error) { errors.push(error.message) }
  if (sourceEntry && (!existsSync(sourceEntry) || statSync(sourceEntry).isDirectory())) errors.push(`missing TypeScript entry: ${relative(projectDir, sourceEntry)}`)
  if (outputEntry && (!existsSync(outputEntry) || statSync(outputEntry).isDirectory())) errors.push(`missing build output: ${relative(projectDir, outputEntry)} (run stagecraft plugin build)`)
  for (const [key, path] of Object.entries(entryPaths)) if (!existsSync(path) || statSync(path).isDirectory()) errors.push(`missing ${key} entry: ${manifest.entry?.[key]}`)
  const scanFiles = [...filesUnder(join(projectDir, 'src')), ...filesUnder(join(projectDir, 'dist'), ['.js', '.mjs'])]
  const forbidden = /(?:node:[\w-]+|require\s*\(|module\.exports|exports\.[A-Za-z_$]|process\.|globalThis\.process|Deno\.|\.so\b|\b(?:Dex|Kotlin|Java)\b|Termux)/
  for (const file of scanFiles) {
    const text = readFileSync(file, 'utf8')
    if (forbidden.test(text)) errors.push(`browser/native forbidden reference in ${relative(projectDir, file)}`)
  }
  if (outputEntry && manifest.integrity?.[manifest.output ?? 'dist/index.js']) {
    const expected = manifest.integrity[manifest.output ?? 'dist/index.js']
    const actual = `sha256-${sha256(readFileSync(outputEntry))}`
    if (expected !== actual) errors.push(`integrity mismatch for ${relative(projectDir, outputEntry)}`)
  } else errors.push(`missing integrity for ${manifest.output ?? 'dist/index.js'} (run stagecraft plugin build)`)
  if (outputEntry && existsSync(outputEntry) && !statSync(outputEntry).isDirectory()) await verifyBuiltDefaultExport(outputEntry, manifest, errors)
  return report(errors, quiet)
}

async function verifyBuiltDefaultExport(outputEntry, manifest, errors) {
  try {
    // Query parameter is deliberate: check may be called repeatedly in one process
    // after an author edits/rebuilds the local artifact.
    const moduleUrl = `${pathToFileURL(outputEntry).href}?stagecraftCheck=${++checkImportNonce}`
    const loaded = await import(moduleUrl)
    const plugin = loaded.default
    if (!plugin || typeof plugin !== 'object' || !plugin.manifest || typeof plugin.manifest !== 'object') {
      errors.push(`built ESM default export must be an authoring plugin with manifest: ${outputEntry}`)
      return
    }
    for (const key of ['id', 'version', 'title', 'category', 'apiVersion']) {
      if (plugin.manifest[key] !== manifest[key]) errors.push(`built manifest mismatch for ${key}: package=${String(manifest[key])}, built=${String(plugin.manifest[key])}`)
    }
    if (JSON.stringify(projectCapabilities(plugin.manifest.capabilities)) !== JSON.stringify(projectCapabilities(manifest.capabilities))) errors.push('built manifest mismatch for capabilities')
  } catch (error) {
    errors.push(`cannot import built ESM default export ${outputEntry}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function report(errors, quiet) {
  if (!quiet) {
    if (errors.length) for (const error of errors) console.error(`✗ ${error}`)
    else console.log('✓ plugin check passed')
  }
  return errors.length === 0
}

async function buildPlugin(projectDir) {
  const { file, value } = readManifest(projectDir)
  const sourceEntry = safeProjectPath(projectDir, value.source ?? 'src/index.ts', 'source')
  const outputEntry = safeProjectPath(projectDir, value.output ?? 'dist/index.js', 'output')
  assertSharedPortableEntry(value)
  if (!existsSync(sourceEntry) || statSync(sourceEntry).isDirectory()) throw new Error(`missing TypeScript entry: ${relative(projectDir, sourceEntry)}`)
  mkdirSync(dirname(outputEntry), { recursive: true })
  await build({ entryPoints: [sourceEntry], outfile: outputEntry, bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', sourcemap: false, logLevel: 'silent' })
  const entry = value.entry ?? { desktop: value.output ?? 'dist/index.js', android: value.output ?? 'dist/index.js' }
  const updated = { ...value, entry, integrity: { ...(value.integrity ?? {}), [value.output ?? 'dist/index.js']: `sha256-${sha256(readFileSync(outputEntry))}` } }
  writeFileSync(file, JSON.stringify(updated, null, 2) + '\n', 'utf8')
  console.log(`✓ built ${relative(projectDir, outputEntry)}`)
  if (!await check(projectDir, { quiet: true })) throw new Error('build completed, but portable check failed')
}

async function testPlugin(projectDir) {
  const tests = filesUnder(join(projectDir, 'test'), ['.js', '.mjs', '.ts'])
  if (!tests.length) throw new Error('no plugin tests found; add test/*.test.ts before claiming authorability')
  const { spawn } = await import('node:child_process')
  const code = await new Promise(resolveCode => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--test', ...tests], { cwd: projectDir, stdio: 'inherit' })
    child.on('exit', codeValue => resolveCode(codeValue ?? 1))
  })
  if (code !== 0) throw new Error(`plugin tests failed (${code})`)
}

async function devPlugin(projectDir) {
  // A deterministic one-shot dev check is safer for a prototype than a process
  // that silently hot-reloads code. Production dev server/watch semantics remain TBD.
  await buildPlugin(projectDir)
  console.log('✓ dev validation complete (watch/hot reload is intentionally not implemented)')
}

async function packPlugin(projectDir) {
  if (!await check(projectDir)) throw new Error('pack requires a passing plugin check')
  const { value } = readManifest(projectDir)
  assertSharedPortableEntry(value)
  const output = safeProjectPath(projectDir, `${value.id.replaceAll('.', '-')}-${value.version}.stagecraft-plugin.zip`, 'pack output')
  const runtimePath = value.entry.desktop
  const runtimeBytes = readFileSync(safeProjectPath(projectDir, runtimePath, `pack entry ${runtimePath}`))
  // M2 authoring metadata is retained for authoring tools, while manifest.json
  // is an explicit provisional M3 component projection.
  const componentManifest = {
    schemaVersion: '0.1', id: value.id, version: value.version, title: value.title,
    componentType: value.category === 'core' ? 'core' : 'plugin',
    ...(value.category === 'core' ? {} : { pluginCategory: value.category }),
    entrypoints: { runtime: runtimePath },
    ...(projectCapabilities(value.capabilities) ? { capabilities: projectCapabilities(value.capabilities) } : {}),
    ...(value.category === 'core' ? { hostApi: { version: '0.1' } } : {}),
    integrity: { runtime: `sha256-${sha256(runtimeBytes)}` },
  }
  const files = [...new Set(['manifest.json', 'stagecraft.plugin.json', value.entry.desktop, value.entry.android])]
    .sort()
    .map(path => ({ name: path.replaceAll('\\', '/'), data: path === 'manifest.json' ? Buffer.from(JSON.stringify(componentManifest) + '\n') : readFileSync(safeProjectPath(projectDir, path, `pack entry ${path}`)) }))
  writeFileSync(output, zip(files))
  console.log(`✓ packed ${relative(projectDir, output)}`)
}

function safeProjectPath(projectDir, value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} path is required`)
  if (isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error(`${label} path must stay inside the plugin root: ${value}`)
  const candidate = resolve(projectDir, value)
  const within = relative(projectDir, candidate)
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error(`${label} path must stay inside the plugin root: ${value}`)
  return candidate
}

function assertSharedPortableEntry(manifest) {
  const output = manifest.output ?? 'dist/index.js'
  const desktop = manifest.entry?.desktop
  const android = manifest.entry?.android
  if (desktop !== output || android !== output) throw new Error(`v0.1 supports one shared portable entry only: entry.desktop, entry.android and output must all equal ${output}`)
}

function sha256(data) { return createHash('sha256').update(data).digest('hex') }

function validateCapabilities(value) {
  if (value === undefined) return []
  if (Array.isArray(value)) return value.every(item => typeof item === 'string' && item.trim()) ? [] : ['manifest.capabilities legacy array must contain non-empty strings']
  if (!value || typeof value !== 'object') return ['manifest.capabilities must be { required?, optional? } or a legacy string array']
  const errors = []
  for (const key of Object.keys(value)) if (key !== 'required' && key !== 'optional') errors.push(`manifest.capabilities.${key} is not supported`)
  for (const key of ['required', 'optional']) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string' || !item.trim()))) errors.push(`manifest.capabilities.${key} must contain non-empty strings`)
  return errors
}

function projectCapabilities(value) {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return { required: [...value] }
  if (!value || typeof value !== 'object') return undefined
  return {
    ...(value.required === undefined ? {} : { required: [...value.required] }),
    ...(value.optional === undefined ? {} : { optional: [...value.optional] }),
  }
}

// Minimal store-only ZIP writer (no native or third-party dependency); entries are deterministic.
function zip(entries) {
  const chunks = []; const central = []; let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'); const data = Buffer.from(entry.data); const crc = crc32(data)
    const local = Buffer.alloc(30 + name.length); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28); name.copy(local, 30)
    chunks.push(local, data)
    const header = Buffer.alloc(46 + name.length); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0, 8); header.writeUInt16LE(0, 10); header.writeUInt16LE(0, 12); header.writeUInt16LE(0, 14); header.writeUInt32LE(crc, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt16LE(0, 30); header.writeUInt16LE(0, 32); header.writeUInt16LE(0, 34); header.writeUInt16LE(0, 36); header.writeUInt32LE(0, 38); header.writeUInt32LE(offset, 42); name.copy(header, 46); central.push(header); offset += local.length + data.length
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, end])
}

function crc32(data) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) } return (crc ^ 0xffffffff) >>> 0 }
