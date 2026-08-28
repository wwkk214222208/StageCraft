import { getVersionInfo, isCommitBehind } from './version.ts'

export interface UpdateCheckResult {
  updateAvailable: boolean
  tag: string
  version: string
  apkUrl?: string
  zipUrl?: string
  currentCommit: string
  latestCommit?: string
}

const REPO = 'wwkk214222208/StageCraft'

async function githubJson<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'stagecraft-update-check' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GitHub API ${response.status}`)
  return response.json() as Promise<T>
}

/** 检查更新：最新 release tag 指向的 commit 是否领先于当前提交（落后才更新；无 tag/领先的开发版不更新）。 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const release = await githubJson<{ tag_name: string; assets: Array<{ name: string; browser_download_url: string }> }>('/releases/latest')
  const tag = String(release.tag_name ?? '')
  const version = tag.replace(/^v/, '')
  const zip = release.assets.find(asset => /^stagecraft-[\w.\-]+\.zip$/i.test(asset.name))
  const apk = release.assets.find(asset => /^stagecraft-[\w.\-]+-android\.apk$/i.test(asset.name))
  // tag → commit sha
  let latestCommit: string | undefined
  try {
    const commit = await githubJson<{ sha: string }>(`/commits/${encodeURIComponent(tag)}`)
    latestCommit = String(commit.sha ?? '')
  } catch { /* tag 取 commit 失败则无法比对，保守按无更新处理 */ }

  const current = getVersionInfo()
  let updateAvailable = false
  if (latestCommit && current.commit) {
    const behind = isCommitBehind(latestCommit)
    updateAvailable = behind === true
  } else if (latestCommit && !current.commit) {
    updateAvailable = false
  }

  return {
    updateAvailable,
    tag,
    version,
    apkUrl: apk?.browser_download_url,
    zipUrl: zip?.browser_download_url,
    currentCommit: current.commit,
    latestCommit,
  }
}
