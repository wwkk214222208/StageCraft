/**
 * StageCraft 发布脚本：构建并打包两个分发产物（安卓跳过）。
 *
 *   1. 独立版 zip —— 源码 + public + 默认剧本/提示词 + 启动脚本，直接 `node src/server.ts` 运行
 *   2. dsh-rp tgz  —— `npm pack` 的 dsh 插件包（含 dist / cordis.patch.yml / LICENSE / NOTICE）
 *
 * 用法：node scripts/release.mjs [version]
 * 产物输出到 release/ 目录：release/stagecraft-<version>.zip、release/dsh-rp-<version>.tgz
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const version = process.argv[2] ?? '0.1.0'
const releaseDir = join(repoRoot, 'release')
const stageDir = join(releaseDir, `stagecraft-${version}`)

/** 排除敏感/本地内容（密钥、用户自定义、构建产物） */
const EXCLUDE = [
  'data', 'save', 'node_modules', 'release', '.git', 'test', 'android',
  'public/assets/custom', 'stories/custom', 'prompts/custom',
  'providers.json', 'build.log', 'clone.log', 'install2.log', 'skins-build.log', '*.log',
  'dsh-rp/dist', 'dsh-rp/node_modules', 'dsh-web-ui', 'custom', 'docs/certification-matrix.md',
  'start-wsl.bat', 'start-wsl.ps1', 'wsl-start.sh', 'wsl-stop.sh', 'close-wsl.bat',
  'certification-report.json', '.npm-cache', '.pnpm-home', '.toolchains', '.workbuddy',
]
const EXCLUDE_BASENAMES = new Set(['.gitkeep', 'providers.json'])

function shouldExclude(relative) {
  if (EXCLUDE_BASENAMES.has(relative.split(/[\\/]/).pop())) return true
  return EXCLUDE.some(pattern => {
    const p = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')
    return new RegExp(`(^|[/\\\\])${p}([/\\\\]|$)`).test(relative)
  })
}

/** 递归复制目录，应用排除规则 */
function copyTree(src, dest, base = '') {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name
    if (shouldExclude(relative)) continue
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true })
      copyTree(from, to, relative)
    } else if (entry.isFile()) {
      cpSync(from, to)
    }
  }
}

/** 定位 npm-cli.js：优先本地 node_modules，其次 npm.cmd/npm 同目录，最后 PATH 解析 */
function resolveNpmCli() {
  const candidates = [
    join(repoRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  const which = execFileSync(process.platform === 'win32' ? 'where' : 'which', [process.platform === 'win32' ? 'npm.cmd' : 'npm'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
  if (which) {
    const cli = join(dirname(which), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(cli)) return cli
  }
  return 'npm'
}

function ensureStartScripts() {  // 打包一个通用的独立启动脚本（Windows/Linux 都可用，避免引用仓库里的 WSL 专用脚本）
  const bat = `@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nset "PORT=8787"\r\necho StageCraft starting on http://127.0.0.1:%PORT% ...\r\nnode --experimental-strip-types src/server.ts\r\npause\r\n`
  const sh = `#!/usr/bin/env bash\ncd "$(dirname "$0")"\nexport PORT="\${PORT:-8787}"\necho "StageCraft starting on http://127.0.0.1:$PORT ..."\nexec node --experimental-strip-types src/server.ts\n`
  writeFileSync(join(stageDir, 'start.bat'), bat, 'utf8')
  writeFileSync(join(stageDir, 'start.sh'), sh, 'utf8')
}

function makeZip() {
  // Windows: PowerShell Compress-Archive；其他平台：tar
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${join(releaseDir, `stagecraft-${version}.zip`)}' -Force`], { stdio: 'inherit' })
  } else {
    execFileSync('tar', ['-czf', join(releaseDir, `stagecraft-${version}.tar.gz`), '-C', stageDir, '.'], { stdio: 'inherit' })
  }
}

async function main() {
  console.log(`[release] building dsh-rp bundle...`)
  execFileSync(process.execPath, ['dsh-rp/scripts/build.mjs'], { cwd: repoRoot, stdio: 'inherit' })

  // 1. 独立版
  console.log(`[release] assembling standalone ${version}...`)
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  copyTree(repoRoot, stageDir)
  ensureStartScripts()
  // 清理 staging 里的 release 自身
  rmSync(join(stageDir, 'release'), { recursive: true, force: true })
  makeZip()
  console.log(`[release] standalone zip: ${join(releaseDir, process.platform === 'win32' ? `stagecraft-${version}.zip` : `stagecraft-${version}.tar.gz`)}`)

  // 2. dsh-rp tgz（npm pack）—— 定位 npm-cli.js 直接以 node 运行，避免 shell 拼接
  console.log(`[release] packing dsh-rp tgz...`)
  rmSync(join(repoRoot, 'dsh-rp', 'release'), { recursive: true, force: true })
  const npmCli = resolveNpmCli()
  const packOutput = execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', releaseDir], { cwd: join(repoRoot, 'dsh-rp'), encoding: 'utf8' })
  const tgzName = packOutput.trim().split(/\r?\n/).pop().trim()
  console.log(`[release] dsh-rp tgz: ${join(releaseDir, tgzName)}`)

  console.log(`[release] done. artifacts in ${releaseDir}`)
}

main().catch(error => { console.error(`[release] failed: ${error}`); process.exitCode = 1 })
