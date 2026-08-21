/**
 * 剧本反向同步：把插件侧/用户数据侧的剧本同步回仓库 stories/。
 *
 * 方向：
 *   - 插件默认剧本（dsh-rp/dist/stories/*.json）→ 仓库 stories/*.json（覆盖默认剧本）
 *   - AppData 用户剧本（<STAGECRAFT_USER_DATA>/stories/*.json 与 custom/*.json）→ 仓库 stories/ 与 stories/custom/
 *
 * 用途：开发者在插件/运行时里编辑了剧本（含默认 eldoria），想把这些改动固化回仓库源码。
 * 用法：node scripts/sync-stories-back.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const distStories = join(repoRoot, 'dsh-rp', 'dist', 'stories')
const appDataStories = process.env.STAGECRAFT_USER_DATA
  ? join(process.env.STAGECRAFT_USER_DATA, 'stories')
  : join(process.env.APPDATA ?? process.env.HOME ?? '', 'stagecraft', 'stories')
const repoStories = join(repoRoot, 'stories')

function syncDir(fromDir, toDir, label) {
  if (!existsSync(fromDir)) { console.log(`[sync] 跳过 ${label}：${fromDir} 不存在`); return 0 }
  mkdirSync(toDir, { recursive: true })
  let count = 0
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    copyFileSync(join(fromDir, entry.name), join(toDir, entry.name))
    console.log(`[sync] ${label}: ${entry.name} → ${join(toDir, entry.name)}`)
    count++
  }
  return count
}

let total = 0
// 1) 插件默认剧本 → 仓库默认
total += syncDir(distStories, repoStories, '插件默认')
// 2) AppData 主目录 → 仓库默认（用户编辑过的默认剧本也同步）
total += syncDir(appDataStories, repoStories, 'AppData 默认')
// 3) AppData custom → 仓库 custom
total += syncDir(join(appDataStories, 'custom'), join(repoStories, 'custom'), 'AppData custom')

console.log(`[sync] 完成：共同步 ${total} 个剧本文件到 ${repoStories}`)
