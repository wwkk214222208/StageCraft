#!/usr/bin/env node
/**
 * W1 API 清点扫描器：静态扫描三份接入层的 (method, path) 证据。
 *
 * 扫描对象（与 ISSUE-ANDROID-HOST-PARITY 的"三份实现"对应）：
 *  - frontend：public/app.js（主页面实际调用面，含 EventSource 与 api()/postJson() helper）
 *  - desktop ：src/app-boot.ts（桌面 Node 路由表，行为权威）
 *  - shim    ：android/app/src/main/assets/web/local-runtime-web-entry.js（Android 本地手抄路由，待整体删除）
 *
 * 本脚本只收集证据，不是路由权威；唯一事实来源是 src/api-route-registry.ts。
 * 用法：node scripts/scan-api-usage.mjs [--md]
 *   默认输出 JSON；--md 输出人读对照表（owner 评审用）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SOURCES = {
  frontend: ['public/app.js'],
  desktop: ['src/app-boot.ts'],
  shim: ['android/app/src/main/assets/web/local-runtime-web-entry.js'],
}

/** 提取字面量（单引号/反引号）路径并把模板段与 query 归一化为 pattern。 */
function normalizePathLiteral(raw) {
  let p = raw
    .replace(/^\$\{[^}]*\}/, '') // 以动态段开头（如 fetch(`${base}/api/..`))
    .replace(/\$\{[^}]*\}/g, '{param}')
  const queryAt = p.search(/[?{]/)
  if (queryAt >= 0) p = p.slice(0, queryAt)
  if (!p.startsWith('/api/')) return null
  return p.replace(/\{param\}/g, '{}').replace(/\/+$/, '') || '/api/'
}

function pushHit(list, hit) {
  if (!hit) return
  const existing = list.find(item => item.method === hit.method && item.path === hit.path)
  if (existing) {
    existing.count += 1
    if (hit.kind === 'sse') existing.kind = 'sse'
  } else {
    list.push({ ...hit, count: 1 })
  }
}

/** shim 特判路径的静态 method 证据（local-runtime-web-entry.js fetch 补丁块）。 */
const SPECIAL_METHODS = {
  '/api/core/view': 'GET',
  '/api/core/commands': 'POST',
  '/api/core/events': 'GET',
  '/api/core/ui/action': 'POST',
  '/api/update/check': 'GET',
}

/** 前端：fetch/EventSource/api()/postJson()/agentSessionRequest() 调用点 + 全量字面量兜底。 */
function scanFrontend(text) {
  const hits = []
  const literal = "(['`])(/api/[^'`]*)\\1"
  const patterns = [
    // fetch('/api/..' 或 fetch(`/api/..，同语句内找 method: 'X'
    { re: new RegExp(`\\bfetch\\(\\s*${literal}`, 'g'), defaultMethod: 'GET' },
    { re: new RegExp(`\\b(?:api|postJson|agentSessionRequest|creatorRequest)\\(\\s*${literal}`, 'g'), defaultMethod: 'POST' },
    { re: new RegExp(`\\bdownloadCurrentFile\\(\\s*${literal}`, 'g'), defaultMethod: 'GET' },
    { re: new RegExp(`\\bEventSource\\(\\s*${literal}`, 'g'), defaultMethod: 'GET', kind: 'sse' },
  ]
  for (const { re, defaultMethod, kind = 'json' } of patterns) {
    for (const match of text.matchAll(re)) {
      const p = normalizePathLiteral(match[2])
      if (!p) continue
      // 同行向后找 method: 'X'（app.js 以单行 handler 为主，行内窗口足够）
      const lineEnd = text.indexOf('\n', match.index)
      const window = text.slice(match.index, lineEnd === -1 ? match.index + 240 : lineEnd)
      const methodMatch = window.match(/method:\s*'(\w+)'/)
      pushHit(hits, { method: methodMatch ? methodMatch[1].toUpperCase() : defaultMethod, path: p, kind })
    }
  }
  // 兜底：三元/动态构造（如 fetch(cond ? '/api/a' : '/api/b')）的路径也必须登记。
  // method 精确性（CP-W1）：同一语句可见 method: 'X' 时登记真实 method；
  // 否则记 'method-unknown'（仅表示证据不足，Gate B 需人工裁决或 fixture），不得冒充 ANY 通过。
  for (const match of text.matchAll(/['"`](\/api\/[a-zA-Z0-9_./-]*)['"`]/g)) {
    const p = normalizePathLiteral(match[1])
    if (!p) continue
    const lineEnd = text.indexOf('\n', match.index)
    const window = text.slice(text.lastIndexOf('\n', match.index) + 1, lineEnd === -1 ? match.index + 400 : lineEnd)
    const methodMatch = window.match(/method:\s*'(\w+)'/)
    if (methodMatch) {
      pushHit(hits, { method: methodMatch[1].toUpperCase(), path: p, kind: 'json' })
    } else {
      pushHit(hits, { method: 'method-unknown', path: p, kind: 'method-unknown' })
    }
  }
  return hits
}

/** 桌面 app-boot.ts：`url.pathname === '/api/..' && request.method === 'X'`；无 method 判定为 GET。 */
function scanDesktop(text) {
  const hits = []
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const pathMatch = line.match(/url\.pathname\s*(?:===\s*'([^']*api[^']*)'|\.startsWith\s*\('([^']*api[^']*)'\))/)
    if (!pathMatch) return
    const rawPath = pathMatch[1] ?? pathMatch[2]
    const methodMatch = line.match(/request\.method\s*===\s*'(\w+)'/)
    const methods = methodMatch ? [methodMatch[1]] : ['GET']
    for (const method of methods) {
      if (rawPath.endsWith('/')) {
        // startsWith 前缀守卫（如 /api/agent/）：逐路径登记，不作为通配路由
        pushHit(hits, { method, path: rawPath, kind: 'prefix-guard' })
      } else {
        pushHit(hits, { method, path: rawPath, kind: line.includes('event-stream') ? 'sse' : 'json' })
      }
    }
    void index
  })
  return hits
}

/** shim：routes = { get: {...}, post: {...} } 分组键 + 特判 pathname。 */
function scanShim(text) {
  const hits = []
  const lines = text.split('\n')
  let currentMethod = null
  let depthAtRoutes = -1
  lines.forEach((line, index) => {
    const groupMatch = line.match(/^\s{4}(get|post|put|delete):\s*\{/)
    if (groupMatch) currentMethod = groupMatch[1].toUpperCase()
    // 路由对象关闭（2 空格缩进的 `}`）后不再归属任何 method——否则会把 DEGRADED 等后续对象键误捕为路由
    if (/^\s{2}\}/.test(line)) currentMethod = null
    const routeMatch = line.match(/^\s*'([^']*api[^']*)':/)
    if (routeMatch && currentMethod) {
      const p = normalizePathLiteral(routeMatch[1])
      if (p) pushHit(hits, { method: currentMethod, path: p, kind: 'json' })
      return
    }
    const special = line.match(/pathname\s*===\s*'([^']*api[^']*)'/)
    if (special) {
      // 特判分派的 method 在 shim 源码中静态可判定（CP-W1 要求能静态确定的必须登记真实 method）：
      // /api/core/view → GET（respondJsonAsync 只读快照）；/api/core/commands → POST（读 body 派发）；
      // /api/core/events → GET SSE（fetch 读流）；/api/core/ui/action → POST（前端以 method POST 调用）；
      // /api/update/check → GET（gateway 模式下页面直连 GitHub 的更新检查分支）。
      const p = normalizePathLiteral(special[1])
      if (!p) return
      const known = SPECIAL_METHODS[p]
      if (known) pushHit(hits, { method: known, path: p, kind: known === 'GET' && line.includes('event-stream') ? 'sse' : 'json' })
      else pushHit(hits, { method: 'method-unknown', path: p, kind: 'method-unknown' })
    }
    void index
  })
  return hits
}

function collect() {
  const result = {}
  for (const [layer, files] of Object.entries(SOURCES)) {
    const hits = []
    for (const file of files) {
      const text = readFileSync(path.join(ROOT, file), 'utf8')
      const scanned = layer === 'frontend' ? scanFrontend(text) : layer === 'desktop' ? scanDesktop(text) : scanShim(text)
      for (const hit of scanned) hits.push({ ...hit, file })
    }
    result[layer] = hits.sort((a, b) => a.method.localeCompare(b.method) || a.path.localeCompare(b.path))
  }
  return result
}

export { scanFrontend, scanDesktop, scanShim, collect }

function markdown(inventory) {
  const lines = ['# API 清点扫描（生成于 scripts/scan-api-usage.mjs，仅供评审）', '']
  for (const [layer, hits] of Object.entries(inventory)) {
    lines.push(`## ${layer}（${hits.length} 条）`, '', '| method | path | kind | 次数 | 文件 |', '|---|---|---|---|---|')
    for (const hit of hits) lines.push(`| ${hit.method} | \`${hit.path}\` | ${hit.kind} | ${hit.count} | ${hit.file} |`)
    lines.push('')
  }
  // 三方对照：前端调用了但桌面/shim 缺失的条目
  const key = hit => `${hit.method} ${hit.path}`
  const frontendKeys = new Set(inventory.frontend.map(key))
  const desktopKeys = new Set(inventory.desktop.map(key))
  const shimKeys = new Set(inventory.shim.map(key))
  lines.push('## 对照（前端调用 − 桌面 / − shim）', '')
  for (const hit of inventory.frontend) {
    const gaps = []
    if (!desktopKeys.has(key(hit))) gaps.push('桌面缺失')
    if (!shimKeys.has(key(hit))) gaps.push('shim 缺失')
    if (gaps.length) lines.push(`- \`${key(hit)}\`：${gaps.join('、')}`)
  }
  const shimOnly = [...shimKeys].filter(k => !frontendKeys.has(k) && !desktopKeys.has(k))
  if (shimOnly.length) {
    lines.push('', '## shim 独有（前端与桌面都没有）', '')
    for (const k of shimOnly) lines.push(`- \`${k}\``)
  }
  lines.push('')
  return lines.join('\n')
}

const inventory = collect()
if (process.argv.includes('--md')) {
  console.log(markdown(inventory))
} else {
  console.log(JSON.stringify(inventory, null, 2))
}
