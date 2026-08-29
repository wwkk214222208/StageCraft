#!/usr/bin/env node
/**
 * W1 owner 清单报告生成器：把 ApiRouteRegistry 渲染为 CP-W1 评审用 markdown。
 * 用法：node --experimental-strip-types scripts/api-owner-report.mjs [输出路径]
 * 默认输出 custom/docs/pending/API-OWNER-INVENTORY.zh.md（目录不入 git，仅供评审）。
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_ROUTES, REGISTRY_VERSION } from '../src/api-route-registry.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outPath = process.argv[2] ?? path.join(ROOT, 'custom', 'docs', 'pending', 'API-OWNER-INVENTORY.zh.md')

const lines = []
lines.push('# API Owner 清单（W1-R，CP-W1 裁决版）', '',
  `> 来源：\`src/api-route-registry.ts\`（${REGISTRY_VERSION}）· 生成：\`scripts/api-owner-report.mjs\` · ${new Date().toISOString().slice(0, 10)}`,
  '> 完备性由 `test/api-route-registry.test.ts` 对前端/桌面/shim 三方扫描自动验证；method-unknown 裁决见 fixture。', '')

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
  lines.push(`## ${owner}（${routes.length} 条）—— ${ownerDesc[owner]}`, '', '| method | path | capability | handlerId | adjudication | fixPackage |', '|---|---|---|---|---|---|')
  for (const route of routes) {
    lines.push(`| ${route.method} | \`${route.pattern}\` | ${route.capability} | ${route.handlerId} | ${route.adjudication ?? '—'} | ${route.fixPackage ?? '—'} |`)
  }
  lines.push('')
}

const adjudicated = API_ROUTES.filter(route => route.adjudication)
lines.push('## CP-W1 裁决表（原"待合流评审"条目，逐条 接受/改判/暂缓）', '')
for (const route of adjudicated) {
  lines.push(`- **接受** \`${route.method} ${route.pattern}\`（${route.owner}）→ 修复包 ${route.fixPackage}，期限 ${route.fixDeadline}。依据：${route.note ?? ''}`)
}

lines.push('', '## method-unknown 人工裁决清单（test/fixtures/api-method-adjudications.json）', '')
const fixture = JSON.parse(await readFile(path.join(ROOT, 'test', 'fixtures', 'api-method-adjudications.json'), 'utf8'))
for (const item of fixture.adjudications) {
  lines.push(`- \`${item.methods.join('/')} ${item.path}\`：${item.basis}（证据：${item.evidence}）`)
}

lines.push('', '## 三方漂移实证与修复责任（CP-W1 要求逐项指定修复包与期限）', '',
  '| 漂移 | 目标行为 | 修复包 | 期限 |', '|---|---|---|---|',
  '| `POST /api/prompts/presets` 仅 shim 手抄存在 | 删除，不迁移（已登记 deprecated） | W6 | Gate D |',
  '| `POST /api/core/ui/action` 桌面未实现、前端在调 | W4 共享 handler 补齐桌面与 Core 实现 | W4 | Gate D 前 |',
  '| `POST /api/agent/context` 前端在调、三端无实现 | gateway 返回稳定 unsupported_capability | W6 | Gate D 前 |',
  '| `POST /api/remote/pairing-code` 前端在调、桌面无实现 | main-host handler（Android）+ 桌面稳定错误 | W6 | Gate D 前 |',
  '| `GET /api/prompts/presets/export`、`POST /api/prompts/import-st` shim 缺失 | 共享 handler 承载后自然补齐 | W4 | Gate D 前 |',
  '', '## Native 暴露面（CP-W1 第 1 条）', '',
  '- 目标 allowlist：`coreNativeAllowlist()` 26 条 / `mainHostAllowlist()` 16 条，两份集合不相交由测试以真实 Java 分派键证明。',
  '- legacy 债务：26 条 generic-dispatch 操作今天仍可从主 WebView 经 `invokeSync`/`invokeAsync` 执行，如实登记为 `legacy-main-core` 封闭例外；通用入口本体登记为债务条目并写明 Gate D 强制移除。',
  '- `SYNC_OPERATIONS` 全部命中 core-native；Gate D 后 Java 分派层拒绝主 WebView 跨 owner 调用。', '')

await writeFile(outPath, lines.join('\n'), 'utf8')
console.log(`written ${outPath} (${API_ROUTES.length} routes)`)
