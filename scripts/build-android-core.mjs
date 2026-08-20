import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'android/app/build/generated/embedded-core/embedded-core.js')
const manifestOutput = resolve(root, 'android/app/build/generated/embedded-core/embedded-core.json')
const version = '1.1.0'
const protocolVersion = '1.0'
await mkdir(dirname(output), { recursive: true })
await build({
  entryPoints: [resolve(root, 'src/portable/android-core.ts')],
  outfile: output,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  sourcemap: false,
})
const bytes = await readFile(output)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const manifest = { artifact: 'stagecraft-embedded-core', bundleVersion: version, protocolVersion, bridgeVersion: '1', sha256, bytes: bytes.length }
await writeFile(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ output, manifestOutput, ...manifest }))
