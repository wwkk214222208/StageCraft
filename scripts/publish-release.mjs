/**
 * StageCraft GitHub Release 发布脚本（依赖 gh CLI）。
 *
 * 前置：gh auth login 已授权；npm run release 已生成产物（release/ 目录）。
 * 用法：node scripts/publish-release.mjs [version]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const version = process.argv[2] ?? '0.1.0'
const releaseDir = join(repoRoot, 'release')
const repo = 'wwkk214222208/StageCraft'
const tag = `v${version}`

const gh = 'gh' // gh 是单文件二进制，无需 .cmd 处理
const git = 'git'
const run = (bin, args, opts = {}) => execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts })

function notes() {
  const file = join(releaseDir, `RELEASE-NOTES-v${version}.md`)
  return existsSync(file) ? readFileSync(file, 'utf8') : `StageCraft v${version}`
}

 function main() {  const zip = join(releaseDir, `stagecraft-${version}.zip`)
  const tgz = join(releaseDir, `dsh-rp-${version}.tgz`)
  const apk = join(releaseDir, `stagecraft-${version}-android.apk`)
  for (const file of [zip, tgz, apk]) {
    if (!existsSync(file)) throw new Error(`产物缺失: ${file}（先运行 npm run release）`)
  }

  // 检查 tag 是否存在（git 管理 tag）
  const tagExists = (() => {
    try {
      run(git, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { stdio: 'ignore' })
      return true
    } catch { return false }
  })()
  if (tagExists) console.log(`[publish] tag ${tag} 已存在`)
  else { run(git, ['tag', tag]); run(git, ['push', 'origin', tag]); console.log(`[publish] tag ${tag} 已创建并推送`) }

  // 检查 release 是否已存在
  let releaseUrl
  try {
    const existing = run(gh, ['release', 'view', tag, '--json', 'url', '--jq', '.url']).trim()
    console.log(`[publish] release ${tag} 已存在: ${existing}`)
    releaseUrl = existing
  } catch {
    // 创建 release（先只建，不传附件；附件单独 upload 以便复用）
    const body = notes().replace(/\r?\n/g, '\n')
    const bodyFile = join(releaseDir, '.release-body.md')
    writeFileSync(bodyFile, body, 'utf8')
    const created = run(gh, ['release', 'create', tag, '--title', `StageCraft v${version}`, '--notes-file', bodyFile]).trim()
    releaseUrl = created
    console.log(`[publish] release 已创建: ${releaseUrl}`)
  }

  // 上传附件（已存在同名附件时用 --clobber 覆盖）
  for (const [label, file] of [['Windows 独立版', zip], ['DSH 插件', tgz], ['Android APK', apk]]) {
    try {
      run(gh, ['release', 'upload', tag, file, '--clobber'])
      console.log(`[publish] 已上传 ${label}: ${file}`)
    } catch (error) {
      console.error(`[publish] 上传 ${label} 失败: ${String(error).split('\n')[0]}`)
    }
  }

  console.log(`[publish] 完成。查看: https://github.com/${repo}/releases/tag/${tag}`)
}

try {
  main()
} catch (error) {
  console.error(`[publish] 失败: ${error.message ?? error}`)
  process.exitCode = 1
}
