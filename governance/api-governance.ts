/**
 * API 治理层 —— 与运行时契约彻底分离。
 *
 * 本文件是项目治理数据的唯一持久来源：路由裁决、修复工单、迁移决策、删除目标。
 * 它按路由身份 (method, pattern) 索引，只读引用运行时 registry（src/api-route-registry.ts）
 * 以做交叉校验，但运行时（src/）与资产生成器（scripts/generate-*.mjs）永远不 import 本目录。
 *
 * 依赖方向（单向）：
 *   governance/ → src/（只读，取路由身份做校验）
 *   scripts/    → src/ + governance/（报告与检查）
 *   src/        → 永不 import governance/
 *
 * 约束（由 scripts/check-governance.mjs 强制）：
 *   - 每条治理条目引用的 (method, pattern) 必须真实存在于 API_ROUTES；
 *   - 运行时 registry 的 note 不得再携带 裁决/W\d+/R\d+/Gate/Q\d+ 治理令牌；
 *   - governance/ 不得出现在任何 src/ 或资产生成脚本的 import 中。
 *
 * 状态语义：
 *   - 已关闭（closed）：对应历史任务已完成，保留为考古记录，不再要求修复；
 *   - 未关闭（open）：仍处于迁移/修复中，报告与治理检查会要求覆盖。
 */

import type { ApiMethod } from '../src/api-route-registry.ts'

/** 路由身份：与运行时 registry 的 (method, pattern) 精确对应。 */
export interface RouteIdentity {
  method: ApiMethod
  pattern: string
}

/** 治理状态：open = 仍待修复；closed = 已完成，仅存考古记录。 */
export type GovernanceStatus = 'open' | 'closed'

/** 单条路由的治理决策。 */
export interface RouteGovernance {
  identity: RouteIdentity
  /** 裁决结论（accepted/revised/deferred 沿用原语义）。 */
  adjudication: 'accepted' | 'revised' | 'deferred'
  /** 修复工单（W4/W5/W6/R13 等；closed 后仍保留作历史记录）。 */
  fixPackage: string
  /** 迁移截止语义（Gate D 前/后等；仅存于治理层，不再进入运行时）。 */
  fixDeadline: string
  /** 迁移/修复的临时原因（为什么需要这条裁决）。 */
  migrationReason: string
  /** 删除目标：路由最终是移除还是保留（如 deprecated 迁移路由最终删除）。 */
  removalTarget?: string
  status: GovernanceStatus
}

/** 按 (method, pattern) 索引的治理表。 */
export const API_GOVERNANCE: readonly RouteGovernance[] = [
  {
    identity: { method: 'POST', pattern: '/api/core/ui/action' },
    adjudication: 'accepted',
    fixPackage: 'W4（共享 handler 补齐桌面实现）',
    fixDeadline: 'Gate D 前',
    migrationReason: '桌面 app-boot.ts 当前未实现该路由（前端调用即 404，HOST-PARITY 实证三），W4 需在共享 handler 中补齐。',
    removalTarget: '保留（补齐后成为正式 core 路由）',
    status: 'open',
  },
  {
    identity: { method: 'POST', pattern: '/api/prompts/presets' },
    adjudication: 'accepted',
    fixPackage: 'W6（随 shim 删除，不迁移）',
    fixDeadline: 'Gate D',
    migrationReason: '仅 Android shim 手抄存在，桌面与前端均无此调用（漂移实证，HOST-PARITY §3）；随 shim 删除，不迁移。',
    removalTarget: '删除（不迁移）',
    status: 'open',
  },
  {
    identity: { method: 'GET', pattern: '/api/prompts/presets/export' },
    adjudication: 'accepted',
    fixPackage: 'W4（共享 handler 补齐 shim 缺失）',
    fixDeadline: 'Gate D 前',
    migrationReason: '桌面已实现，shim 缺失（HOST-PARITY 实证四），Android 走共享 handler 后自然补齐。',
    removalTarget: '保留（补齐后成为正式 core 路由）',
    status: 'open',
  },
  {
    identity: { method: 'POST', pattern: '/api/prompts/import-st' },
    adjudication: 'accepted',
    fixPackage: 'W4（共享 handler 补齐 shim 缺失）',
    fixDeadline: 'Gate D 前',
    migrationReason: 'ST 预设转换为纯 TS 共享实现；shim 缺失由共享 handler 补齐。',
    removalTarget: '保留（补齐后成为正式 core 路由）',
    status: 'open',
  },
  {
    identity: { method: 'GET', pattern: '/api/archive/export' },
    adjudication: 'accepted',
    fixPackage: 'W5（StageCraftArchive 迁入 Core 进程端口）',
    fixDeadline: 'Gate D 前',
    migrationReason: '存档文件存储归属 Core 进程端口（与 §5.3 单一写入者一致）；主进程只承担 SAF 选择器桥，不承载该 API。',
    removalTarget: '保留（迁入 Core 进程端口）',
    status: 'open',
  },
  {
    identity: { method: 'GET', pattern: '/api/archive/list' },
    adjudication: 'accepted',
    fixPackage: 'W5（StageCraftArchive 迁入 Core 进程端口）',
    fixDeadline: 'Gate D 前',
    migrationReason: '同上；StageCraftArchive 随 W5 迁入 Core 进程。',
    removalTarget: '保留（迁入 Core 进程端口）',
    status: 'open',
  },
  {
    identity: { method: 'POST', pattern: '/api/remote/pairing-code' },
    adjudication: 'accepted',
    fixPackage: 'W6（main-host handler；桌面返回稳定 unsupported_capability）',
    fixDeadline: 'Gate D 前',
    migrationReason: '桌面未实现该路径（Android UI 专用宿主操作）；桌面返回稳定 unsupported_capability。',
    removalTarget: '保留（Android 专用宿主操作）',
    status: 'open',
  },
  {
    identity: { method: 'GET', pattern: '/api/version' },
    adjudication: 'accepted',
    fixPackage: 'W6（coreBundleVersion 经数据面 health 聚合，Q8）',
    fixDeadline: 'Gate D 前',
    migrationReason: '含 coreBundleVersion 时由主进程经数据面聚合 Core health（Q8：Binder 只走摘要）。',
    removalTarget: '保留',
    status: 'open',
  },
  {
    identity: { method: 'POST', pattern: '/api/restart' },
    adjudication: 'accepted',
    fixPackage: 'R13（重开剧本语义修正）',
    fixDeadline: 'Gate D 后',
    migrationReason: '原错误映射为 host.restart（重启 Core 进程）导致每次重开=Core 重启+数据面断连，已修正为业务语义（重开剧本）。',
    removalTarget: '保留（业务语义重开剧本）',
    status: 'open',
  },
  {
    identity: { method: 'POST', pattern: '/api/host/restart' },
    adjudication: 'accepted',
    fixPackage: 'R13（与 /api/restart 语义分离）',
    fixDeadline: 'Gate D 后',
    migrationReason: '宿主重启（Core 进程/launch plan 变更生效）：生成新 launch plan 并重启 Core 进程（§4.3）。与业务重开剧本（/api/restart）分离。',
    removalTarget: '保留（宿主生命周期操作）',
    status: 'open',
  },
  {
    identity: { method: 'POST', pattern: '/api/agent/context' },
    adjudication: 'accepted',
    fixPackage: 'W6（gateway 返回稳定 unsupported_capability，消除 404）',
    fixDeadline: 'Gate D 前',
    migrationReason: '三端均未实现（HOST-PARITY 实证四的 404 项）；登记后 Android 得到稳定错误而非 404。',
    removalTarget: '保留（desktop-only，远程声明 capability 时代理）',
    status: 'open',
  },
]

/** 按路由身份索引（供双向校验与报告快速查找）。 */
export const governanceByRoute = new Map<string, RouteGovernance>(
  API_GOVERNANCE.map(item => [`${item.identity.method} ${item.identity.pattern}`, item]),
)

/** 治理层要求覆盖的路由集合（open 状态）。 */
export function openGovernanceRoutes(): RouteGovernance[] {
  return API_GOVERNANCE.filter(item => item.status === 'open')
}

/** 运行时 note 中禁止出现的治理令牌（净化护栏，由 check-governance.mjs 强制）。 */
export const GOVERNANCE_TOKEN_PATTERN = /裁决|W\d+|R\d+|Gate [A-D]|Q\d+/
