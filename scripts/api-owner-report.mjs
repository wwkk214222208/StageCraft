#!/usr/bin/env node
/**
 * API 治理报告生成器：把治理层（governance/api-governance.ts）与运行时 registry
 * （src/api-route-registry.ts）联合渲染为评审用 markdown。
 *
 * 与运行时契约分离：治理数据（裁决/工单/期限/迁移原因）只从 governance/ 读取，
 * 运行时 registry 不再携带任何治理字段。本报告是生成物，不是事实来源。
 *
 * 用法：node --experimental-strip-types scripts/api-owner-report.mjs [输出路径]
 * 默认输出 custom/docs/pending/API-OWNER-INVENTORY.zh.md（目录不入 git，仅供评审）。
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_ROUTES, REGISTRY_VERSION } from '../src/api-route-registry.ts'
import { API_GOVERNANCE, openGovernanceRoutes, governanceByRoute } from '../governance/api-governance.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outPath = process.argv[2] ?? path.join(ROOT, 'custom', 'docs', 'pending', 'API-OWNER-INVENTORY.zh.md')

const lines = []
lines.push('# API 路由清单（运行时契约）与治理状态', '',
  `> 运行时来源：\`src/api-route-registry.ts\`（${REGISTRY_VERSION}）· 治理来源：\`governance/api-governance.ts\` · 生成：\`scripts/api-owner-report.mjs\` · ${new Date().toISOString().slice(0, 10)}`,
  '> 完备性由 `test/api-route-registry.test.ts` 对前端/桌面/shim 三方扫描自动验证；method-unknown 调用点证据见 test/fixtures/api-method-evidence.json。', '')

const byOwner = {}
for (const route of API_ROUTES) (byOwner[route.owner] ??= []).push(route)
const ownerDesc = {
  core: '代理到 CoreDataServer（本地）或已配对桌面（远程）',
  'main-host': '主进程宿主 handler',
  'desktop-only': 'Android 返回 unsupported_capability；远程端声明 capability 时可代理',
  deprecated: '迁移期 adapter，最终删除',
}
for (const owner of ['core', 'main-host', 'desktop-only', 'deprecated']) {
  const routes = byOwner[owner] ?? []
  lines.push(`## ${owner}（${routes.length} 条）—— ${ownerDesc[owner]}`, '', '| method | path | capability | handlerId |', '|---|---|---|---|')
  for (const route of routes) {
    lines.push(`| ${route.method} | \`${route.pattern}\` | ${route.capability} | ${route.handlerId} |`)
  }
  lines.push('')
}

const open = openGovernanceRoutes()
lines.push('## 治理状态（open：仍待修复；数据源 governance/api-governance.ts）', '')
if (open.length === 0) {
  lines.push('（无未完成治理条目）', '')
} else {
  lines.push('| method | path | 裁决 | 修复工单 | 期限 | 迁移原因 |', '|---|---|---|---|---|---|')
  for (const item of open) {
    lines.push(`| ${item.identity.method} | \`${item.identity.pattern}\` | ${item.adjudication} | ${item.fixPackage} | ${item.fixDeadline} | ${item.migrationReason} |`)
  }
  lines.push('')
}

const closed = API_GOVERNANCE.filter(item => item.status === 'closed')
if (closed.length > 0) {
  lines.push('## 已关闭治理条目（历史记录）', '')
  for (const item of closed) {
    lines.push(`- \`${item.identity.method} ${item.identity.pattern}\`：${item.adjudication} / ${item.fixPackage}（${item.fixDeadline}）。${item.migrationReason}`)
  }
  lines.push('')
}

lines.push('', '## method-unknown 调用点证据（test/fixtures/api-method-evidence.json）', '')
const fixture = JSON.parse(await readFile(path.join(ROOT, 'test', 'fixtures', 'api-method-evidence.json'), 'utf8'))
for (const item of fixture.evidence) {
  lines.push(`- \`${item.methods.join('/')} ${item.path}\`：${item.basis}（证据：${item.evidence}）`)
}

lines.push('', '## Native 暴露面（allowlist 由 src/native-operation-registry.ts 生成，Java 侧只读资产）', '',
  '- 目标 allowlist：`coreNativeAllowlist()` 与 `mainHostAllowlist()` 两份集合不相交（测试以真实 Java 分派键证明）。',
  '- legacy 债务：generic-dispatch 操作今天仍可从主 WebView 经 `invokeSync`/`invokeAsync` 执行，如实登记为 `legacy-main-core` 封闭例外；通用入口本体登记为债务条目。', '')

await writeFile(outPath, lines.join('\n'), 'utf8')
console.log(`written ${outPath} (${API_ROUTES.length} routes, ${open.length} open governance)`)
