import { execFileSync } from 'node:child_process'
const log = execFileSync('git', ['log', '--format=%H', '--', 'public/index.html'], { encoding: 'utf8' }).trim().split(/\r?\n/)
for (const sha of log) {
  let content
  try { content = execFileSync('git', ['show', `${sha}:public/index.html`], { encoding: 'utf8' }) } catch { continue }
  const garbled = /鏈|鍚|瀵煎|鐨勬|鍥炲悎/.test(content)
  const hasChinese = /[\u4e00-\u9fff]/.test(content)
  console.log(`${sha.slice(0, 12)} garbled=${garbled} hasChinese=${hasChinese} len=${content.length}`)
}
