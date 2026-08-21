import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

test('dsh-rp declares explicit embedded and sandboxed runtime modes', () => {
  const source = readFileSync(new URL('../dsh-rp/src/index.ts', import.meta.url), 'utf8')
  assert.match(source, /runtimeMode\?: RuntimeMode/)
  assert.match(source, /runtimeMode = config\.runtimeMode \?\? 'embedded'/)
  assert.match(source, /new WorkerManager\(/)
  assert.match(source, /ctx\.provide\('stagecraftDebug', debug\)/)
  assert.match(source, /StageCraft sandbox is disabled in embedded runtime mode/)
})

test('dsh-rp patch keeps sandboxed runtime and loopback default', () => {
  const patch = readFileSync(new URL('../dsh-rp/cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /runtimeMode:\s*'sandboxed'/)
  assert.match(patch, /host:\s*'127\.0\.0\.1'/)
  assert.doesNotMatch(patch, /inspector|0\.0\.0\.0/i)
})

test('built bundle contains a worker entry and excludes private custom content', () => {
  const dist = new URL('../dsh-rp/dist/', import.meta.url)
  if (!existsSync(dist)) return
  assert.ok(existsSync(new URL('worker.js', dist)))
  assert.ok(existsSync(new URL('index.js', dist)))
  const files = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
  assert.match(files, /dsh-rp\/dist\//)
  const packaged = readdirSync(dist, { recursive: true }).map(String)
  assert.ok(packaged.every(file => !/(^|\/)(providers\.json|stagecraft\.sqlite|[^/]+\.tgz)$/.test(file)))
  const build = readFileSync(new URL('../dsh-rp/scripts/build.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(build, /copyFileSync\([^\n]*(custom|save|data)/)
})
