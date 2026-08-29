#!/usr/bin/env node
/**
 * W1 owner 清单报告生成器：把 ApiRouteRegistry 渲染为待合流评审的 markdown。
 * 用法：node --experimental-strip-types scripts/api-owner-report.mjs [输出路径]
 * 默认输出 custom/docs/pending/API-OWNER-INVENTORY.zh.md（目录不入 git，仅供评审）。
 */

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_ROUTES, REGISTRY_VERSION } from '../src/api-route-registry.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outPath = process.argv[2] ?? path.join(ROOT, 'custom', 'docs', 'pending', 'API-OWNER-INVENTORY.zh.md')

const lines = []
lines.push('# API Owner 清单（W1 草案，待合流评审）', '',
  `> 来源：\`src/api-route-registry.ts\`（${REGISTRY_VERSION}）· 生成：\`scripts/api-owner-report.mjs\` · ${new Date().toISOString().slice(0, 10)}`,
  '> 完备性由 `test/api-route-registry.test.ts` 对前端/桌面/shim 三方扫描自动验证。', '')

const byOwner = {}
for (const route of API_ROUTES) (byOwner[route.owner] ??= []).push(route)
const ownerDesc = {
  core: '代理到 CoreDataServer（本地）或已配对桌面（远程，Q2）',
  'main-host': '主进程宿主 handler',
  'desktop-only': 'Android 返回 unsupported_capability；远程端声明 capability 时可代理',
  deprecated: '迁移期 adapter，最终删除',
}
for (const owner of ['core', 'main-host', 'desktop-only', 'deprecated']) {
  const routes = byOwner[owner] ?? []
  lines.push(`## ${owner}（${routes.length} 条）—— ${ownerDesc[owner]}`, '', '| method | path | capability | handlerId |', '|---|---|---|---|')
  for (const route of routes) lines.push(`| ${route.method} | \`${route.pattern}\` | ${route.capability} | ${route.handlerId} |`)
  lines.push('')
}

const pending = API_ROUTES.filter(route => route.note?.includes('待合流评审'))
lines.push('## 待合流评审条目（Gate B 定版前逐条裁决）', '')
for (const route of pending) lines.push(`- \`${route.method} ${route.pattern}\`（${route.owner}）：${route.note}`)

lines.push('', '## 漂移实证（登记过程中发现的三方不一致）', '',
  '- `POST /api/prompts/presets`：仅 shim 手抄存在，桌面与前端均无（登记为 deprecated，随 shim 删除）。',
  '- `POST /api/core/ui/action`：前端在调、shim 显式降级、桌面未实现（登记为 core，W4 共享 handler 补齐）。',
  '- `POST /api/agent/context`、`POST /api/remote/pairing-code`：前端在调、桌面与 shim 均无实现（登记 owner，消除静默 404）。',
  '- `GET /api/prompts/presets/export`、`POST /api/prompts/import-st`：桌面已实现、shim 缺失（共享 handler 补齐后消除）。', '')

await writeFile(outPath, lines.join('\n'), 'utf8')
console.log(`written ${outPath} (${API_ROUTES.length} routes)`)
