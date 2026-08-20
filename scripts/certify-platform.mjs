import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const reportArg = args.indexOf('--report')
const reportPath = resolve(root, reportArg >= 0 ? args[reportArg + 1] : 'certification-report.json')
const skipGradle = args.includes('--skip-gradle')
const results = []
const startedAt = new Date().toISOString()

function record(id, area, status, detail, durationMs = 0) {
  results.push({ id, area, status, detail, durationMs: Math.round(durationMs) })
  const mark = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL'
  console.log(`[${mark}] ${id}: ${detail}`)
}

function command(id, area, executable, commandArgs, options = {}) {
  const started = performance.now()
  try {
    execFileSync(executable, commandArgs, { cwd: root, stdio: 'ignore', windowsHide: true, ...options })
    record(id, area, 'pass', `${executable} ${commandArgs.join(' ')}`, performance.now() - started)
    return true
  } catch (error) {
    const detail = error?.status === undefined
      ? `${executable} unavailable or could not start`
      : `${executable} exited with status ${error.status}`
    record(id, area, 'fail', detail, performance.now() - started)
    return false
  }
}

function skip(id, area, detail) { record(id, area, 'skip', detail) }

const node = process.execPath
const npm = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
const npmArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm test'] : ['test']
const gradle = process.platform === 'win32' ? join(root, 'android', 'gradlew.bat') : join(root, 'android', 'gradlew')

for (const target of ['win32', 'linux', 'darwin']) {
  if (process.platform === target) record(`platform.${target}`, 'platform', 'pass', `runner executing on ${target}`)
  else skip(`platform.${target}`, 'platform', `not running on ${target}; execute this runner on that OS`)
}

command('web.node.tests', 'web', npm, npmArgs)
command('dsh.bundle.build', 'dsh', node, ['dsh-rp/scripts/build.mjs'])
command('dsh.cordis.lifecycle', 'dsh', node, ['dsh-rp/verify.mjs'])
command('repository.diff-check', 'security', 'git', ['diff', '--check'])
const privateCheckStarted = performance.now()
try {
  const tracked = execFileSync('git', ['ls-files', 'custom', 'data', 'save', 'public/assets/custom', 'prompts/custom'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(path => path !== 'custom/.gitkeep' && !path.startsWith('custom/docs/') && path !== 'prompts/custom/.gitkeep')
  if (tracked.length > 0) record('repository.tracked-private-check', 'security', 'fail', `tracked private paths found`, performance.now() - privateCheckStarted)
  else record('repository.tracked-private-check', 'security', 'pass', 'no private paths are tracked', performance.now() - privateCheckStarted)
} catch {
  record('repository.tracked-private-check', 'security', 'fail', 'git private-path inspection failed', performance.now() - privateCheckStarted)
}

const gradleAvailable = existsSync(gradle) && existsSync(join(root, 'android', 'local.properties'))
let javaAvailable = true
try { execFileSync('java', ['-version'], { stdio: 'ignore' }) } catch { javaAvailable = false }
if (skipGradle) skip('android.gradle', 'android', 'disabled by --skip-gradle')
else if (!gradleAvailable) skip('android.gradle', 'android', 'Gradle wrapper or Android local.properties unavailable')
else if (!javaAvailable) skip('android.gradle', 'android', 'Java/JAVA_HOME unavailable in this environment')
else command('android.gradle', 'android', gradle, ['testDebugUnitTest', 'assembleDebug', 'lintDebug', '--offline', '--no-daemon'])
skip('android.emulator', 'android', 'requires an explicitly provisioned AVD; repository run does not create one')
skip('android.device', 'android', 'requires a physical Android device; repository run does not claim hardware acceptance')

const perfScript = `import { parseCardPackage, compileCardPackage } from './src/compat/st-mvu.ts'; const raw = JSON.stringify({ name: 'certification', alternate_greetings: ['hello'], character_book: { entries: [{ id: 'constant', content: 'safe', constant: true }] }, extensions: { ui: { panels: [{ id: 'status', nodes: [{ type: 'text', path: '/stat_data/score' }] }] } } }); for (let i = 0; i < 100; i++) compileCardPackage(parseCardPackage(raw));`
const perfStarted = performance.now()
command('performance.synthetic-compat', 'performance', node, ['--experimental-strip-types', '--input-type=module', '--eval', perfScript])
const perfMs = performance.now() - perfStarted
if (perfMs > 2_000) record('performance.smoke-limit', 'performance', 'fail', `synthetic compatibility compile exceeded 2000ms`, perfMs)
else record('performance.smoke-limit', 'performance', 'pass', `synthetic compatibility compile completed within 2000ms`, perfMs)

const report = {
  schemaVersion: 1,
  phase: 8,
  startedAt,
  finishedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  privateAssets: 'not inspected, copied, hashed, or included',
  results,
  summary: {
    pass: results.filter(item => item.status === 'pass').length,
    fail: results.filter(item => item.status === 'fail').length,
    skip: results.filter(item => item.status === 'skip').length,
  },
}
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
console.log(`Certification report written to ${reportPath}`)
if (report.summary.fail > 0) process.exitCode = 1
