import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('..', import.meta.url)))

export interface VersionInfo {
  version: string
  commit: string
  tag: string
  buildTime: string
}

/** 读取构建期注入的版本信息（发布包内置 version.json）；开发环境从 git 动态取。 */
export function getVersionInfo(): VersionInfo {
  const file = join(repoRoot, 'version.json')
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<VersionInfo>
      return {
        version: String(parsed.version ?? ''),
        commit: String(parsed.commit ?? ''),
        tag: String(parsed.tag ?? ''),
        buildTime: String(parsed.buildTime ?? new Date().toISOString()),
      }
    } catch { /* 损坏则回退 git */ }
  }
  let commit = ''
  let tag = ''
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { /* 无 git 环境 */ }
  try { tag = execFileSync('git', ['describe', '--tags', '--always'], { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { /* 无 git 环境 */ }
  return { version: tag.replace(/^v/, '') || 'dev', commit, tag, buildTime: new Date().toISOString() }
}

/** 当前提交是否严格落后于指定提交（用于更新判断；相等视为已最新）。 */
export function isCommitBehind(compareRef: string, cwd = repoRoot): boolean | undefined {
  try {
    const compareSha = execFileSync('git', ['rev-parse', `${compareRef}^{commit}`], { cwd, encoding: 'utf8' }).trim()
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    if (!compareSha || compareSha === headSha) return false
    // git merge-base --is-ancestor <ref> HEAD：ref 是 HEAD 的祖先（且不等）→ HEAD 落后 → true
    execFileSync('git', ['merge-base', '--is-ancestor', compareSha, 'HEAD'], { cwd, stdio: 'ignore' })
    return true
  } catch (error) {
    const code = (error as { status?: number }).status
    if (code === 1) return false // 不是祖先 → 不落后（领先或分叉）
    return undefined // git 不可用
  }
}
