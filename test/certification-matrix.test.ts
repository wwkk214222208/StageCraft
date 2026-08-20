import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const matrix = readFileSync(join(root, 'docs', 'certification-matrix.md'), 'utf8')
const runner = readFileSync(join(root, 'scripts', 'certify-platform.mjs'), 'utf8')

test('phase-eight certification artifacts cover every required platform and mode', () => {
  assert.ok(existsSync(join(root, 'docs', 'certification-matrix.md')))
  assert.ok(existsSync(join(root, 'scripts', 'certify-platform.mjs')))
  for (const term of ['Windows', 'Linux', 'macOS', 'DSH/Cordis', 'Android', 'Local mode', 'Remote mode', 'Performance', 'Security', 'Private ST/MVU card']) assert.match(matrix, new RegExp(term.replace('/', '\\/')))
  for (const status of ['pass', 'fail', 'skip']) assert.match(runner, new RegExp(`'${status}'`))
})

test('certification runner never reads or packages private card contents', () => {
  assert.doesNotMatch(runner, /custom[\\/].*(readFile|copy|hash)/i)
  assert.match(runner, /privateAssets: 'not inspected, copied, hashed, or included'/)
  assert.match(matrix, /private card contents are never copied, printed, hashed, or packaged/i)
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /certification-report\.json/)
})

test('certification matrix records device limitations instead of claiming hardware acceptance', () => {
  assert.match(matrix, /Requires explicit AVD or physical device/i)
  assert.match(matrix, /physical device/i)
  assert.match(runner, /android\.emulator/)
  assert.match(runner, /android\.device/)
})

test('certification runner executes Gradle from the Android project directory', () => {
  assert.match(runner, /gradleExecutable/)
  assert.match(runner, /gradleArgs/)
  assert.match(runner, /command\('android\.gradle',[\s\S]*\{ cwd: join\(root, 'android'\) \}\)/)
})

test('certification runner honors JAVA_HOME for Android checks', () => {
  assert.match(runner, /process\.env\.JAVA_HOME/)
  assert.match(runner, /javaExecutable/)
})
