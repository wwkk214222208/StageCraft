/**
 * StageCraft APK 发布构建脚本（固化发布流程，杜绝版本号/commit 错乱）。
 *
 * 用法：node scripts/build-android-release.mjs <version>   （如 0.4.8）
 *
 * 行为：
 *  1) 校验 git tag v<version> 存在；提示当前 HEAD 是否正好在 tag 上（最规范：先打 tag 再构建）。
 *  2) 用 gradle 构建 release APK（-Pversion=<version>，version.json 强制重新生成）。
 *  3) 解包校验 assets/version.json 的 version 与 tag/commit 一致性。
 *  4) 输出 APK 路径与校验结果。
 *
 * 工具链：优先使用环境变量 JAVA_HOME / GRADLE_USER_HOME / ANDROID_HOME；
 *          缺省回退仓库 .toolchains 目录（jdk-extract / gradle-home / android-sdk）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('[apk-release] 用法: node scripts/build-android-release.mjs <version>（如 0.4.8）')
  process.exit(1)
}
const tag = `v${version}`

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}
function run(bin, args, opts = {}) {
  return execFileSync(bin, args, { stdio: 'inherit', ...opts })
}

// 1) tag 校验与 HEAD 定位
let tagCommit = ''
let head = ''
try { tagCommit = git(['rev-parse', tag]) } catch { console.error(`[apk-release] tag ${tag} 不存在，请先创建：git tag ${tag} 并推送。`); process.exit(1) }
head = git(['rev-parse', 'HEAD'])
console.log(`[apk-release] tag ${tag} = ${tagCommit.slice(0, 7)}；当前 HEAD = ${head.slice(0, 7)}${head === tagCommit ? '（在 tag 上 ✓）' : '（领先/偏离 tag ⚠ 构建出的 commit 会领先 tag，语义仍正确但不最规范）'}`)

// 2) 工具链定位
const tools = resolve(repoRoot, '.toolchains')
const javaHome = process.env.JAVA_HOME || join(tools, 'jdk-extract', 'jdk-17.0.20+8')
const gradleUserHome = process.env.GRADLE_USER_HOME || join(tools, 'gradle-home')
const androidHome = process.env.ANDROID_HOME || join(tools, 'android-sdk')
if (!existsSync(join(javaHome, 'bin', 'java.exe'))) { console.error(`[apk-release] 找不到 JDK：${javaHome}`); process.exit(1) }
const gradlew = join(repoRoot, 'android', 'gradlew.bat')
if (!existsSync(gradlew)) { console.error(`[apk-release] 找不到 gradlew：${gradlew}`); process.exit(1) }

// 3) 构建 release APK（-Pversion 传入；inputs.property 保证 version.json 重新生成）
const gradleEnv = { ...process.env, JAVA_HOME: javaHome, GRADLE_USER_HOME: gradleUserHome, ANDROID_HOME: androidHome, ANDROID_SDK_ROOT: androidHome }
run(process.env.ComSpec || 'cmd.exe', ['/c', gradlew, '-p', join(repoRoot, 'android'), 'assembleRelease', '--offline', '--no-daemon', `-Pversion=${version}`], { env: gradleEnv, cwd: repoRoot })

// 4) 解包校验 assets/version.json
const apk = join(repoRoot, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
if (!existsSync(apk)) { console.error(`[apk-release] 构建产物缺失：${apk}`); process.exit(1) }
const checkScript = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${apk.replace(/'/g, "''")}')
$e = $zip.Entries | Where-Object { $_.FullName -eq 'assets/version.json' } | Select-Object -First 1
if (-not $e) { Write-Output 'MISSING'; $zip.Dispose(); exit 1 }
$r = [System.IO.StreamReader]::new($e.Open(), [System.Text.Encoding]::UTF8)
Write-Output $r.ReadToEnd()
$r.Close(); $zip.Dispose()
`
const versionJson = execFileSync('powershell', ['-NoProfile', '-Command', checkScript], { encoding: 'utf8' }).trim()
console.log(`[apk-release] APK 内 version.json: ${versionJson}`)
try {
  const parsed = JSON.parse(versionJson)
  if (parsed.version !== version) { console.error(`[apk-release] ✗ version 字段为 ${parsed.version}，应为 ${version}`); process.exit(1) }
  if (head === tagCommit && parsed.commit !== tagCommit) { console.error(`[apk-release] ✗ 在 tag 上构建但 commit 不匹配：${parsed.commit}`); process.exit(1) }
  console.log(`[apk-release] ✓ version.json 校验通过（version=${parsed.version}, commit=${parsed.commit.slice(0, 7)}）`)
} catch {
  console.error('[apk-release] ✗ version.json 解析失败'); process.exit(1)
}
console.log(`[apk-release] 完成。APK: ${apk}`)
console.log(`[apk-release] 发布：复制为 release/stagecraft-${version}-android.apk 并 gh release upload v${version} ... --clobber`)
