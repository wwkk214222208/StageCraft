import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirFlag = process.argv.indexOf('--output-dir')
const requestedOutputDir = outputDirFlag >= 0 ? process.argv[outputDirFlag + 1] : undefined
const outputDir = requestedOutputDir || resolve(root, 'android/app/build/generated/embedded-core')
const output = resolve(outputDir, 'embedded-core.js')
const manifestOutput = resolve(outputDir, 'embedded-core.json')
const version = '1.1.0'
// 协议版本单一事实来源：src/core/protocol.ts（构建期提取；Java 侧 EmbeddedCoreArtifact 与之核对）。
const protocolSource = await readFile(resolve(root, 'src/core/protocol.ts'), 'utf8')
const protocolMatch = /^export const CORE_PROTOCOL_VERSION = '([^']+)'$/m.exec(protocolSource)
if (!protocolMatch) throw new Error('src/core/protocol.ts 缺少 CORE_PROTOCOL_VERSION 常量（共享协议事实来源被破坏）。')
const protocolVersion = protocolMatch[1]
await mkdir(dirname(output), { recursive: true })

/** 浏览器 bundle 里的 node 内建 stub：prompts.ts 的 fs 路径在 Android 本地运行时
 *  已被 setPromptStorage 注入的同源实现取代，这些引用只保证模块可求值，不会被调用。 */
const nodeBuiltinStubs = {
  'node:fs': `export const existsSync = () => { throw new Error('node:fs is unavailable in the Android local runtime (prompt IO is injected).') }\nexport const mkdirSync = () => { throw new Error('node:fs is unavailable in the Android local runtime.') }\nexport const readFileSync = () => { throw new Error('node:fs is unavailable in the Android local runtime.') }\nexport const writeFileSync = () => { throw new Error('node:fs is unavailable in the Android local runtime.') }\n`,
  'node:path': `export function join(...parts) { return parts.filter(p => p != null && p !== '').join('/').replace(/\\/+/g, '/') }\nexport function dirname(p) { const s = String(p); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i) }\n`,
  'node:url': `export function fileURLToPath() { return '/fs/prompts/prompts.json' }\n`,
}
const nodeBuiltinStubPlugin = {
  name: 'android-node-builtin-stubs',
  setup(pluginBuild) {
    for (const [specifier, contents] of Object.entries(nodeBuiltinStubs)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${specifier}$`) }, () => ({ path: specifier, namespace: 'android-node-stub' }))
      pluginBuild.onLoad({ filter: new RegExp(`^${specifier}$`), namespace: 'android-node-stub' }, () => ({ contents, loader: 'js' }))
    }
  },
}

await build({
  entryPoints: [resolve(root, 'src/portable/android-local-core.ts')],
  outfile: output,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  plugins: [nodeBuiltinStubPlugin],
})
const bytes = await readFile(output)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const manifest = { artifact: 'stagecraft-embedded-core', bundleVersion: version, protocolVersion, bridgeVersion: '1', sha256, bytes: bytes.length }
await writeFile(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ output, manifestOutput, ...manifest }))
