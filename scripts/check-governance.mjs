#!/usr/bin/env node
/**
 * 治理层独立检查脚本（独立于运行时测试，但已接入构建：package.json pretest 自动执行）。
 *
 * 与运行时契约分离的三条护栏：
 *  1. 双向完整性：每条治理条目引用的 (method, pattern) 必须真实存在于运行时 API_ROUTES；
 *     open 状态的治理条目必须覆盖所有"仍要求修复"的路由（deprecated/desktop-only 迁移路由）。
 *  2. 运行时 note 净化：src/api-route-registry.ts 的 note 不得再携带 裁决/W\d+/R\d+/Gate/Q\d+ 治理令牌。
 *  3. 依赖方向：governance/ 不得被 src/ 或资产生成脚本（scripts/generate-*.mjs）import。
 *
 * 用法：node --experimental-strip-types scripts/check-governance.mjs
 * 接线：`npm test` 前经 pretest 自动执行（npm run check:governance）；CI 也可单独调用。
 * 退出码：0 = 通过；1 = 治理缺口（阻塞 pretest / 测试流程，提醒修复后重跑）。
 */

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_ROUTES } from '../src/api-route-registry.ts'
import { API_GOVERNANCE, openGovernanceRoutes, governanceByRoute, GOVERNANCE_TOKEN_PATTERN } from '../governance/api-governance.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const errors = []

// ── 护栏 1a：治理条目引用的路由必须真实存在 ──
const registryKeys = new Set(API_ROUTES.map(route => `${route.method} ${route.pattern}`))
for (const item of API_GOVERNANCE) {
  const key = `${item.identity.method} ${item.identity.pattern}`
  if (!registryKeys.has(key)) {
    errors.push(`治理条目引用了 registry 不存在的路由：${key}`)
  }
}

// ── 护栏 1b：治理条目中的迁移路由（deprecated/desktop-only）必须为 open ──
// 注意：不是所有 deprecated/desktop-only 路由都要进治理表——desktop-only 远程代理、
// deprecated 迁移 adapter 是设计上的长期状态，owner 语义本身即迁移原因。
// 只有"确实有裁决/工单/待办"的路由才需要治理条目；凡登记了治理条目的迁移路由必须 open。
for (const item of API_GOVERNANCE) {
  if (item.status === 'closed') {
    const route = API_ROUTES.find(r => `${r.method} ${r.pattern}` === `${item.identity.method} ${item.identity.pattern}`)
    if (route && (route.owner === 'deprecated' || route.owner === 'desktop-only')) {
      errors.push(`迁移路由 ${item.identity.method} ${item.identity.pattern} 的治理条目不得标记 closed（迁移未完成前）`)
    }
  }
}

// ── 护栏 1c：open 治理条目的数量与 registry 裁决字段移除前一致（考古锚点） ──
// 原 11 条带 adjudication 的路由全部迁入治理层；移入后 open 集合不应比历史裁决少。
const openCount = openGovernanceRoutes().length
if (openCount < 11) {
  errors.push(`open 治理条目不足历史裁决数（原 11 条，现 ${openCount}）`)
}

// ── 护栏 2：运行时 note 不得携带治理令牌 ──
const registrySource = await readFile(path.join(ROOT, 'src', 'api-route-registry.ts'), 'utf8')
for (const route of API_ROUTES) {
  if (route.note && GOVERNANCE_TOKEN_PATTERN.test(route.note)) {
    errors.push(`运行时 note 携带治理令牌（${route.method} ${route.pattern}）：${route.note}`)
  }
}

// ── 护栏 3：governance/ 不得被 src/ 或资产生成脚本（scripts/generate-*.mjs）import ──
// 报告/检查脚本（api-owner-report.mjs、check-governance.mjs）本身就该读治理层，不禁止。
const importScanTargets = ['src']
const governanceImportPattern = /from\s+['"].*governance[/'"]|import\s*\(\s*['"].*governance[/'"]/
for (const dir of importScanTargets) {
  const files = await walk(path.join(ROOT, dir))
  for (const file of files) {
    if (!file.endsWith('.ts') && !file.endsWith('.mjs') && !file.endsWith('.js')) continue
    const content = await readFile(file, 'utf8')
    if (governanceImportPattern.test(content)) {
      errors.push(`禁止反向依赖：${path.relative(ROOT, file)} import 了 governance/`)
    }
  }
}
// 资产生成脚本（generate-*.mjs）只允许 import 运行时模块，禁止 import governance/
for (const file of await readdir(path.join(ROOT, 'scripts'))) {
  if (!file.startsWith('generate-') || !file.endsWith('.mjs')) continue
  const content = await readFile(path.join(ROOT, 'scripts', file), 'utf8')
  if (governanceImportPattern.test(content)) {
    errors.push(`禁止反向依赖：scripts/${file}（资产生成器）import 了 governance/`)
  }
}

if (errors.length) {
  console.error('治理检查失败：')
  for (const error of errors) console.error('  - ' + error)
  process.exit(1)
}
console.log(`治理检查通过（${API_GOVERNANCE.length} 条治理条目，open ${openCount}；运行时 registry ${API_ROUTES.length} 条路由）`)

/** 递归收集目录下全部文件。 */
async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full))
    else out.push(full)
  }
  return out
}
