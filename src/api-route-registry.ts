/**
 * ApiRouteRegistry —— 全部 `/api/*` 路由的唯一事实来源（计划 v0.4 §1.4）。
 *
 * 每条 method/pattern 只能有一个 owner：
 *  - core        ：读取或修改 Core 权威状态/workflow/repository/模型/运行时配置。
 *                  Android 上由 UI gateway 注入 nonce 代理到 CoreDataServer；
 *                  远程模式下代理到已配对桌面（Q2 裁决）。
 *  - main-host   ：宿主操作（进程/插件/配对/同步/更新/SAF），始终由主进程处理。
 *  - desktop-only：依赖 Node/DSH/桌面更新器；Android 返回稳定 unsupported_capability，
 *                  仅当远程端声明对应 capability 时才可代理（Q2 裁决）。
 *  - deprecated  ：已由统一协议替代；迁移期保留显式 adapter，最终删除（Q5 裁决）。
 *
 * 构建期由 generateRegistryJson() 生成确定性排序的 api-route-registry.json 资产供 Java gateway 消费：
 * method 精确匹配；静态段优先于参数段；更具体 pattern 优先；同形状 pattern 视为歧义并使构建失败（Q6 裁决）。
 * v1 的 request/responseSchema 为命名 fixture 引用（供对等性与边界测试使用），不要求 Java 做运行期完整校验。
 *
 * owner 清单已按 CP-W1 完成实施方裁决：原存疑条目逐条标注 adjudication（accepted/revised/deferred）
 * 并指定 fixPackage/fixDeadline；'待评审'状态不得流入 W4/W6。裁决明细见 custom/docs/pending/API-OWNER-INVENTORY.zh.md。
 */

export const REGISTRY_VERSION = '1.0.0-gateb'

export type ApiOwner = 'core' | 'main-host' | 'desktop-only' | 'deprecated'
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'
/** CP-W1：草案条目的裁决状态——'待评审'不得流入 W4/W6；fixPackage 指向修复工作包，fixDeadline 以 Gate 为界。 */
export type RouteAdjudication = 'accepted' | 'revised' | 'deferred'

/**
 * 认证/代理策略（Gate B：不能以 auth:none 代替）：
 *  - local-open    ：本地明开放（main-host 本地回应 / deprecated 迁移 adapter / desktop-only 的本地稳定错误）
 *  - core-nonce    ：必须经 UI gateway 注入 nonce 代理到 CoreDataServer（远程模式下由配对凭据等价保护）
 *  - remote-paired ：仅在远程端声明对应 capability 且携带配对凭据时可代理（desktop-only 专属）
 */
export type AuthPolicy =
  | { kind: 'local-open' }
  | { kind: 'core-nonce' }
  | { kind: 'remote-paired' }

/** 按 owner 派生认证/代理策略（单一事实来源，禁止逐路由手写漂移）。 */
export function authPolicyFor(owner: ApiOwner): AuthPolicy {
  switch (owner) {
    case 'core':
      return { kind: 'core-nonce' }
    case 'desktop-only':
      return { kind: 'remote-paired' }
    case 'main-host':
    case 'deprecated':
      return { kind: 'local-open' }
  }
}

export interface ApiStreamContract {
  contentType: 'text/event-stream'
  eventNames: readonly string[]
  resume: 'resync-then-incremental'
  heartbeat: string
}

export interface ApiRoute {
  method: ApiMethod
  /** 精确路径，或以 `{}` 表示单段参数的 pattern（如 /api/story/{}/ 不使用——当前路由全部为静态路径）。 */
  pattern: string
  owner: ApiOwner
  capability: string
  /** v1 全部为 none：本地无鉴权；远程模式凭据由原生 gateway 注入，不进入页面（Q10 裁决）。 */
  auth: 'none'
  requestSchema?: string
  responseSchema?: string
  handlerId: string
  stream?: ApiStreamContract
  note?: string
  adjudication?: RouteAdjudication
  fixPackage?: string
  fixDeadline?: string
  /** 认证/代理策略：按 owner 派生（Gate B 显式化，见 authPolicyFor）。 */
  authPolicy?: AuthPolicy
}

const CORE_PROTOCOL_STREAM: ApiStreamContract = {
  contentType: 'text/event-stream',
  eventNames: ['core.event', 'core.resync', 'connection.state', 'connection.error'],
  resume: 'resync-then-incremental',
  heartbeat: '15s comment line',
}

/** 旧多频道/多连接 SSE 的 1.1 envelope 事件名，仅在 deprecated 迁移 adapter 中使用。 */
const LEGACY_STREAM: ApiStreamContract = {
  contentType: 'text/event-stream',
  eventNames: ['room', 'thinking', 'summary'],
  resume: 'resync-then-incremental',
  heartbeat: 'none',
}

export const API_ROUTES: readonly ApiRoute[] = [
  // ── Core 协议（1.1 数据平面；计划 §2.3/§3） ──────────────────────────────
  { method: 'GET', pattern: '/api/core/health', owner: 'core', capability: 'core.protocol', auth: 'none', handlerId: 'core.health', responseSchema: 'CoreHealth@1.1' },
  { method: 'GET', pattern: '/api/core/view', owner: 'core', capability: 'core.protocol', auth: 'none', handlerId: 'core.view', responseSchema: 'CoreViewSnapshot@1' },
  { method: 'POST', pattern: '/api/core/commands', owner: 'core', capability: 'core.protocol', auth: 'none', handlerId: 'core.commands', requestSchema: 'HumanCommand@1', responseSchema: 'CommandReceipt@1.1', note: '1.0 对端按协商版本整形为 {ok:true,view}（Q5 裁决）。' },
  { method: 'GET', pattern: '/api/core/events', owner: 'core', capability: 'core.protocol', auth: 'none', handlerId: 'core.events', stream: CORE_PROTOCOL_STREAM, note: '1.0 对端收到旧 CoreEvent 形状（Q5 裁决）；gateway 只透传字节。' },
  { method: 'POST', pattern: '/api/core/cancel', owner: 'core', capability: 'core.protocol', auth: 'none', handlerId: 'core.cancel', requestSchema: 'CancelRequest@1' },
  { method: 'GET', pattern: '/api/core/capabilities', owner: 'core', capability: 'core.protocol', auth: 'none', handlerId: 'core.capabilities', responseSchema: 'CoreCapabilityList@1' },
  { method: 'POST', pattern: '/api/core/ui/action', owner: 'core', capability: 'ui.panels', auth: 'none', handlerId: 'core.ui.action', requestSchema: 'UiActionRequest@1', responseSchema: 'UiActionResult@1', note: '裁决(accepted)：桌面 app-boot.ts 当前未实现该路由（前端调用即 404，HOST-PARITY 实证三），W4 需在共享 handler 中补齐。', adjudication: 'accepted', fixPackage: 'W4（共享 handler 补齐桌面实现）', fixDeadline: 'Gate D 前' },

  // ── 房间 / 回合 / workflow（core） ─────────────────────────────────────
  { method: 'GET', pattern: '/api/room', owner: 'core', capability: 'room.read', auth: 'none', handlerId: 'room.snapshot', responseSchema: 'PublicRoomSnapshot@1' },
  { method: 'POST', pattern: '/api/room-config', owner: 'core', capability: 'room.write', auth: 'none', handlerId: 'room.config', requestSchema: 'RoomConfigRequest@1' },
  { method: 'POST', pattern: '/api/scene', owner: 'core', capability: 'room.write', auth: 'none', handlerId: 'room.scene' },
  { method: 'POST', pattern: '/api/lore', owner: 'core', capability: 'room.write', auth: 'none', handlerId: 'room.lore' },
  { method: 'POST', pattern: '/api/turn', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'turn.start', requestSchema: 'TurnRequest@1', note: '非幂等；断线后标记 unknown-after-disconnect，禁止自动重放（§3.3/§7.2）。' },
  { method: 'POST', pattern: '/api/cancel-turn', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'turn.cancel' },
  { method: 'POST', pattern: '/api/approve', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'workflow.approve' },
  { method: 'POST', pattern: '/api/consult', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'workflow.consult' },
  { method: 'POST', pattern: '/api/consult/finish', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'workflow.consult.finish' },
  { method: 'POST', pattern: '/api/redraft', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'workflow.redraft' },
  { method: 'POST', pattern: '/api/reactions/reconsider', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'workflow.reactions.reconsider' },
  { method: 'POST', pattern: '/api/world-change/approve', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'workflow.world-change.approve' },
  { method: 'POST', pattern: '/api/world-change/reject', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'workflow.world-change.reject' },
  { method: 'POST', pattern: '/api/state/rollback', owner: 'core', capability: 'room.write', auth: 'none', handlerId: 'state.rollback' },
  { method: 'POST', pattern: '/api/state/branch', owner: 'core', capability: 'room.write', auth: 'none', handlerId: 'state.branch' },
  { method: 'POST', pattern: '/api/state/scene-revision', owner: 'core', capability: 'room.write', auth: 'none', handlerId: 'state.scene-revision' },

  // ── 聊天 / 导演（core） ────────────────────────────────────────────────
  { method: 'POST', pattern: '/api/chat/speak', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'chat.speak' },
  { method: 'POST', pattern: '/api/chat/speak-all', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'chat.speak-all' },
  { method: 'POST', pattern: '/api/chat/retry', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'chat.retry' },
  { method: 'POST', pattern: '/api/chat/approve-speech', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'chat.approve-speech' },
  { method: 'POST', pattern: '/api/chat/reject-speech', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'chat.reject-speech' },
  { method: 'POST', pattern: '/api/chat/director-chat', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'chat.director-chat' },
  { method: 'POST', pattern: '/api/chat/director-decide', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'chat.director-decide' },
  { method: 'POST', pattern: '/api/director/proceed', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'director.proceed' },
  { method: 'POST', pattern: '/api/director/retry', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'director.retry' },
  { method: 'POST', pattern: '/api/director/setting', owner: 'core', capability: 'room.write', auth: 'none', handlerId: 'director.setting' },

  // ── 角色 / 玩家（core） ────────────────────────────────────────────────
  { method: 'POST', pattern: '/api/roles/create', owner: 'core', capability: 'role.write', auth: 'none', handlerId: 'role.create' },
  { method: 'POST', pattern: '/api/roles/delete', owner: 'core', capability: 'role.write', auth: 'none', handlerId: 'role.delete' },
  { method: 'POST', pattern: '/api/roles/avatar', owner: 'core', capability: 'role.write', auth: 'none', handlerId: 'role.avatar', note: '头像字节随请求体进入 Core，经 Core 文件端口落盘；主进程不经手（§5.3）。' },
  { method: 'POST', pattern: '/api/roles/presence', owner: 'core', capability: 'role.write', auth: 'none', handlerId: 'role.presence' },
  { method: 'POST', pattern: '/api/roles/reorder', owner: 'core', capability: 'role.write', auth: 'none', handlerId: 'role.reorder' },
  { method: 'POST', pattern: '/api/roles/state', owner: 'core', capability: 'role.write', auth: 'none', handlerId: 'role.state' },
  { method: 'POST', pattern: '/api/roles/intervene', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'role.intervene' },
  { method: 'POST', pattern: '/api/roles/thinking', owner: 'core', capability: 'room.command', auth: 'none', handlerId: 'role.thinking' },
  { method: 'GET', pattern: '/api/roles/memories', owner: 'core', capability: 'role.read', auth: 'none', handlerId: 'role.memories.list', responseSchema: 'RoleMemories@1' },
  { method: 'POST', pattern: '/api/roles/memories', owner: 'core', capability: 'role.write', auth: 'none', handlerId: 'role.memories.upsert' },
  { method: 'POST', pattern: '/api/roles/memories/reorder', owner: 'core', capability: 'role.write', auth: 'none', handlerId: 'role.memories.reorder' },
  { method: 'POST', pattern: '/api/roles/memories/retract', owner: 'core', capability: 'role.write', auth: 'none', handlerId: 'role.memories.retract' },
  { method: 'POST', pattern: '/api/roles/memories/supersede', owner: 'core', capability: 'role.write', auth: 'none', handlerId: 'role.memories.supersede' },
  { method: 'POST', pattern: '/api/roles/memories/update', owner: 'core', capability: 'role.write', auth: 'none', handlerId: 'role.memories.update' },
  { method: 'POST', pattern: '/api/player-character', owner: 'core', capability: 'role.write', auth: 'none', handlerId: 'player.character' },
  { method: 'POST', pattern: '/api/player/avatar', owner: 'core', capability: 'role.write', auth: 'none', handlerId: 'player.avatar', note: '同 roles/avatar：字节进 Core 文件端口。' },

  // ── Provider / billing / usage（运行时配置与凭据经 Core secret 端口；Q10） ──
  { method: 'GET', pattern: '/api/providers', owner: 'core', capability: 'provider.config', auth: 'none', handlerId: 'provider.list', responseSchema: 'ProviderMetaView@1', note: '响应剔除 apiKey、补 hasApiKey（现有契约）。' },
  { method: 'POST', pattern: '/api/providers/save', owner: 'core', capability: 'provider.config', auth: 'none', handlerId: 'provider.save', note: 'apiKey 只落 Core 进程 AndroidSecretStore；Core absent 时恢复页明示不可编辑（Q10 裁决）。' },
  { method: 'POST', pattern: '/api/providers/delete', owner: 'core', capability: 'provider.config', auth: 'none', handlerId: 'provider.delete' },
  { method: 'POST', pattern: '/api/providers/discover', owner: 'core', capability: 'provider.config', auth: 'none', handlerId: 'provider.discover' },
  { method: 'POST', pattern: '/api/providers/default-role', owner: 'core', capability: 'provider.config', auth: 'none', handlerId: 'provider.default-role' },
  { method: 'POST', pattern: '/api/providers/director', owner: 'core', capability: 'provider.config', auth: 'none', handlerId: 'provider.director' },
  { method: 'POST', pattern: '/api/providers/director-thinking', owner: 'core', capability: 'provider.config', auth: 'none', handlerId: 'provider.director-thinking' },
  { method: 'GET', pattern: '/api/billing', owner: 'core', capability: 'billing.runtime', auth: 'none', handlerId: 'billing.summary' },
  { method: 'GET', pattern: '/api/billing/prices', owner: 'core', capability: 'billing.runtime', auth: 'none', handlerId: 'billing.prices.get' },
  { method: 'PUT', pattern: '/api/billing/prices', owner: 'core', capability: 'billing.runtime', auth: 'none', handlerId: 'billing.prices.put' },
  { method: 'POST', pattern: '/api/billing/reset', owner: 'core', capability: 'billing.runtime', auth: 'none', handlerId: 'billing.reset' },
  { method: 'GET', pattern: '/api/usage', owner: 'core', capability: 'billing.runtime', auth: 'none', handlerId: 'billing.usage' },

  // ── 剧本库（core；构建期资产 + repository） ─────────────────────────────
  { method: 'GET', pattern: '/api/stories', owner: 'core', capability: 'story.library', auth: 'none', handlerId: 'story.list' },
  { method: 'POST', pattern: '/api/stories', owner: 'core', capability: 'story.library', auth: 'none', handlerId: 'story.create' },
  { method: 'DELETE', pattern: '/api/stories', owner: 'core', capability: 'story.library', auth: 'none', handlerId: 'story.delete' },
  { method: 'GET', pattern: '/api/story/get', owner: 'core', capability: 'story.library', auth: 'none', handlerId: 'story.get' },
  { method: 'POST', pattern: '/api/story/save', owner: 'core', capability: 'story.library', auth: 'none', handlerId: 'story.save' },
  { method: 'POST', pattern: '/api/story/save-as', owner: 'core', capability: 'story.library', auth: 'none', handlerId: 'story.save-as' },
  { method: 'POST', pattern: '/api/story/import', owner: 'core', capability: 'story.library', auth: 'none', handlerId: 'story.import', note: 'content-type application/zip；W4 抽取时保留 zip 解析在可移植 handler 内。' },
  { method: 'GET', pattern: '/api/story/export', owner: 'core', capability: 'story.library', auth: 'none', handlerId: 'story.export' },
  { method: 'POST', pattern: '/api/story/sync-role', owner: 'core', capability: 'story.library', auth: 'none', handlerId: 'story.sync-role' },
  { method: 'POST', pattern: '/api/story/sync-roles', owner: 'core', capability: 'story.library', auth: 'none', handlerId: 'story.sync-roles' },

  // ── Prompt 预设（core，运行时 prompt 配置） ─────────────────────────────
  { method: 'GET', pattern: '/api/prompts/presets', owner: 'core', capability: 'prompt.presets', auth: 'none', handlerId: 'prompt.presets.list' },
  { method: 'PUT', pattern: '/api/prompts/presets', owner: 'core', capability: 'prompt.presets', auth: 'none', handlerId: 'prompt.presets.put' },
  { method: 'DELETE', pattern: '/api/prompts/presets', owner: 'core', capability: 'prompt.presets', auth: 'none', handlerId: 'prompt.presets.delete' },
  { method: 'POST', pattern: '/api/prompts/presets', owner: 'deprecated', capability: 'prompt.presets', auth: 'none', handlerId: 'prompt.presets.post', note: '裁决(accepted)：仅 Android shim 手抄存在，桌面与前端均无此调用（漂移实证，HOST-PARITY §3）；随 shim 删除，不迁移。', adjudication: 'accepted', fixPackage: 'W6（随 shim 删除，不迁移）', fixDeadline: 'Gate D' },
  { method: 'GET', pattern: '/api/prompts/presets/export', owner: 'core', capability: 'prompt.presets', auth: 'none', handlerId: 'prompt.presets.export', note: '裁决(accepted)：桌面已实现，shim 缺失（HOST-PARITY 实证四），Android 走共享 handler 后自然补齐。', adjudication: 'accepted', fixPackage: 'W4（共享 handler 补齐 shim 缺失）', fixDeadline: 'Gate D 前' },
  { method: 'GET', pattern: '/api/prompts/private-toggles', owner: 'core', capability: 'prompt.presets', auth: 'none', handlerId: 'prompt.private-toggles.get' },
  { method: 'PUT', pattern: '/api/prompts/private-toggles', owner: 'core', capability: 'prompt.presets', auth: 'none', handlerId: 'prompt.private-toggles.put' },
  { method: 'POST', pattern: '/api/prompts/import-st', owner: 'core', capability: 'prompt.presets', auth: 'none', handlerId: 'prompt.import-st', note: 'ST 预设转换为纯 TS 共享实现；shim 缺失由共享 handler 补齐。', adjudication: 'accepted', fixPackage: 'W4（共享 handler 补齐 shim 缺失）', fixDeadline: 'Gate D 前' },

  // ── 存档（core：导出/导入触碰权威状态；存储经 Core 文件端口） ─────────────
  { method: 'GET', pattern: '/api/archive/export', owner: 'core', capability: 'archive.port', auth: 'none', handlerId: 'archive.export', note: '裁决(accepted)：存档文件存储归属 Core 进程端口（与 §5.3 单一写入者一致）；主进程只承担 SAF 选择器桥，不承载该 API。', adjudication: 'accepted', fixPackage: 'W5（StageCraftArchive 迁入 Core 进程端口）', fixDeadline: 'Gate D 前' },
  { method: 'GET', pattern: '/api/archive/list', owner: 'core', capability: 'archive.port', auth: 'none', handlerId: 'archive.list', note: '同上；StageCraftArchive 随 W5 迁入 Core 进程。', adjudication: 'accepted', fixPackage: 'W5（StageCraftArchive 迁入 Core 进程端口）', fixDeadline: 'Gate D 前' },
  { method: 'POST', pattern: '/api/archive/save', owner: 'core', capability: 'archive.port', auth: 'none', handlerId: 'archive.save' },
  { method: 'POST', pattern: '/api/archive/load', owner: 'core', capability: 'archive.port', auth: 'none', handlerId: 'archive.load', note: '写入 Core state，必须由 Core 串行执行（§7.1）。' },
  { method: 'POST', pattern: '/api/archive/delete', owner: 'core', capability: 'archive.port', auth: 'none', handlerId: 'archive.delete' },
  { method: 'POST', pattern: '/api/archive/import', owner: 'core', capability: 'archive.port', auth: 'none', handlerId: 'archive.import' },

  // ── 创作者工作台 / ST 卡（core，桌面已实现；shim 降级项由共享 handler 补齐） ──
  { method: 'POST', pattern: '/api/creator/preview', owner: 'core', capability: 'creator.workbench', auth: 'none', handlerId: 'creator.preview' },
  { method: 'POST', pattern: '/api/creator/apply', owner: 'core', capability: 'creator.workbench', auth: 'none', handlerId: 'creator.apply' },
  { method: 'POST', pattern: '/api/creator/revert', owner: 'core', capability: 'creator.workbench', auth: 'none', handlerId: 'creator.revert' },
  { method: 'POST', pattern: '/api/st-cards/import', owner: 'core', capability: 'creator.workbench', auth: 'none', handlerId: 'creator.st-cards.import' },

  // ── 远程配对 / 同步（main-host，始终主进程处理；Q2） ─────────────────────
  { method: 'POST', pattern: '/api/remote/pairing-code', owner: 'main-host', capability: 'remote.pairing', auth: 'none', handlerId: 'host.remote.pairing-code', note: '裁决(accepted)：桌面未实现该路径（Android UI 专用宿主操作）；桌面返回稳定 unsupported_capability。', adjudication: 'accepted', fixPackage: 'W6（main-host handler；桌面返回稳定 unsupported_capability）', fixDeadline: 'Gate D 前' },
  { method: 'POST', pattern: '/api/remote/revoke', owner: 'main-host', capability: 'remote.pairing', auth: 'none', handlerId: 'host.remote.revoke' },
  { method: 'GET', pattern: '/api/remote/sync', owner: 'main-host', capability: 'remote.sync', auth: 'none', handlerId: 'host.remote.sync.get' },
  { method: 'PUT', pattern: '/api/remote/sync', owner: 'main-host', capability: 'remote.sync', auth: 'none', handlerId: 'host.remote.sync.put' },

  // ── 宿主（main-host） ──────────────────────────────────────────────────
  { method: 'GET', pattern: '/api/version', owner: 'main-host', capability: 'host.version', auth: 'none', handlerId: 'host.version', responseSchema: 'VersionInfo@1', note: '裁决(accepted)：含 coreBundleVersion 时由主进程经数据面聚合 Core health（Q8：Binder 只走摘要）。', adjudication: 'accepted', fixPackage: 'W6（coreBundleVersion 经数据面 health 聚合，Q8）', fixDeadline: 'Gate D 前' },
  { method: 'GET', pattern: '/api/update/check', owner: 'main-host', capability: 'host.update', auth: 'none', handlerId: 'host.update.check' },
  { method: 'POST', pattern: '/api/update/download', owner: 'main-host', capability: 'host.update', auth: 'none', handlerId: 'host.update.download' },
  { method: 'POST', pattern: '/api/restart', owner: 'main-host', capability: 'host.lifecycle', auth: 'none', handlerId: 'host.restart', note: 'Android 语义 = 生成新 launch plan 并重启 Core 进程（§4.3）；桌面语义 = 重启服务进程。', adjudication: 'accepted', fixPackage: 'W6（Android 语义=新 launch plan 重启 Core，§4.3）', fixDeadline: 'Gate D 前' },

  // ── DSH agent（desktop-only；Q2：仅远程端声明 capability 时可代理） ───────
  { method: 'GET', pattern: '/api/agent/capability', owner: 'desktop-only', capability: 'agent.dsh', auth: 'none', handlerId: 'agent.capability', note: '响应形状保持 {enabled,reason} 兼容；Android 端由 gateway 返回 unsupported_capability 时 UI 必须容错（W6 验证）。' },
  { method: 'GET', pattern: '/api/agent/session', owner: 'desktop-only', capability: 'agent.dsh', auth: 'none', handlerId: 'agent.session.get' , note: '远程模式仅当桌面端声明 agent.dsh capability 时可代理（Q2）；Android 本地返回 unsupported_capability。' },
  { method: 'POST', pattern: '/api/agent/session', owner: 'desktop-only', capability: 'agent.dsh', auth: 'none', handlerId: 'agent.session.post' , note: '远程模式仅当桌面端声明 agent.dsh capability 时可代理（Q2）；Android 本地返回 unsupported_capability。' },
  { method: 'DELETE', pattern: '/api/agent/session', owner: 'desktop-only', capability: 'agent.dsh', auth: 'none', handlerId: 'agent.session.delete' , note: '远程模式仅当桌面端声明 agent.dsh capability 时可代理（Q2）；Android 本地返回 unsupported_capability。' },
  { method: 'POST', pattern: '/api/agent/archive', owner: 'desktop-only', capability: 'agent.dsh', auth: 'none', handlerId: 'agent.archive' , note: 'DSH 会话归档；Android 本地返回 unsupported_capability（§1.4）。' },
  { method: 'POST', pattern: '/api/agent/history', owner: 'desktop-only', capability: 'agent.dsh', auth: 'none', handlerId: 'agent.history' , note: 'DSH 会话历史；Android 本地返回 unsupported_capability（§1.4）。' },
  { method: 'POST', pattern: '/api/agent/message', owner: 'desktop-only', capability: 'agent.dsh', auth: 'none', handlerId: 'agent.message' , note: 'DSH 会话消息；Android 本地返回 unsupported_capability（§1.4）。' },
  { method: 'POST', pattern: '/api/agent/model', owner: 'desktop-only', capability: 'agent.dsh', auth: 'none', handlerId: 'agent.model' , note: 'DSH 会话模型选择；Android 本地返回 unsupported_capability（§1.4）。' },
  { method: 'POST', pattern: '/api/agent/models', owner: 'desktop-only', capability: 'agent.dsh', auth: 'none', handlerId: 'agent.models' , note: 'DSH 会话模型目录；Android 本地返回 unsupported_capability（§1.4）。' },
  { method: 'POST', pattern: '/api/agent/context', owner: 'desktop-only', capability: 'agent.dsh', auth: 'none', handlerId: 'agent.context', note: '裁决(accepted)：三端均未实现（HOST-PARITY 实证四的 404 项）；登记后 Android 得到稳定错误而非 404。', adjudication: 'accepted', fixPackage: 'W6（gateway 返回稳定 unsupported_capability，消除 404）', fixDeadline: 'Gate D 前' },

  // ── 旧 SSE 通道（deprecated，Q5：/api/stream 为迁移路由，最终由 /api/core/events 取代） ──
  { method: 'GET', pattern: '/api/stream', owner: 'deprecated', capability: 'legacy.sse', auth: 'none', handlerId: 'legacy.stream', stream: LEGACY_STREAM, note: '迁移期由显式 adapter 转发到 /api/core/events 并按 event 名分发；UI 切换后删除（阶段 4）。' },
  { method: 'GET', pattern: '/api/events', owner: 'deprecated', capability: 'legacy.sse', auth: 'none', handlerId: 'legacy.events', stream: LEGACY_STREAM, note: '旧单频道 room SSE。' },
  { method: 'GET', pattern: '/api/thinking-events', owner: 'deprecated', capability: 'legacy.sse', auth: 'none', handlerId: 'legacy.thinking-events', stream: LEGACY_STREAM, note: '旧单频道 thinking SSE。' },
  { method: 'GET', pattern: '/api/debug-events', owner: 'deprecated', capability: 'legacy.sse', auth: 'none', handlerId: 'legacy.debug-events', stream: LEGACY_STREAM, note: '旧单频道 summary/debug SSE。' },
]

// ── 匹配语义（Q6 裁决） ───────────────────────────────────────────────────

interface PatternShape {
  segments: readonly string[]
  paramSlots: readonly boolean[]
  staticCount: number
}

function parsePattern(pattern: string): PatternShape {
  const segments = pattern.split('/').filter(Boolean)
  const paramSlots = segments.map(segment => segment === '{}' || segment.startsWith('{'))
  return { segments, paramSlots, staticCount: paramSlots.filter(isParam => !isParam).length }
}

function shapeKey(shape: PatternShape): string {
  return shape.segments.map((segment, index) => (shape.paramSlots[index] ? '{param}' : segment)).join('/')
}

export class AmbiguousRouteError extends Error {
  readonly patternA: string
  readonly patternB: string
  constructor(patternA: string, patternB: string) {
    super(`ApiRouteRegistry 存在歧义 pattern："${patternA}" 与 "${patternB}" 形状相同，构建失败（Q6 裁决）。`)
    this.patternA = patternA
    this.patternB = patternB
  }
}

/** 校验一组路由：重复 (method, pattern)、同形状歧义 pattern、缺 capability/handlerId 都使构建失败（Q6 裁决）。 */
export function validateRoutes(routes: readonly ApiRoute[]): void {
  const seen = new Map<string, string>()
  const shapes = new Map<string, string>()
  routes.forEach((route, index) => {
    const routeKey = `${route.method} ${route.pattern}`
    const duplicate = seen.get(routeKey)
    if (duplicate) throw new Error(`ApiRouteRegistry 重复登记：${routeKey}（第 ${duplicate} 条与第 ${index + 1} 条）。`)
    seen.set(routeKey, String(index + 1))
    const shape = shapeKey(parsePattern(route.pattern))
    const ambiguousWith = shapes.get(`${route.method} ${shape}`)
    if (ambiguousWith) throw new AmbiguousRouteError(ambiguousWith, route.pattern)
    shapes.set(`${route.method} ${shape}`, route.pattern)
    if (!route.capability || !route.handlerId) throw new Error(`ApiRouteRegistry 条目缺少 capability/handlerId：${routeKey}。`)
  })
}

// 模块加载即校验：任何登记错误在构建/测试第一时间失败。
validateRoutes(API_ROUTES)

function pathSegments(path: string): string[] {
  return path.split('?')[0].split('/').filter(Boolean)
}

/**
 * 匹配一条路由：method 精确匹配；段数与参数槽位必须同形状；
 * 多个候选时取静态段最多（最具体）者，同具体度取表序（生成序）。
 * routes 可注入以便对隔离路由表测试匹配语义；默认即全量 registry。
 */
export function matchApiRoute(method: string, path: string, routes: readonly ApiRoute[] = API_ROUTES): ApiRoute | null {
  const segments = pathSegments(path)
  let best: { route: ApiRoute; staticCount: number; order: number } | null = null
  routes.forEach((route, index) => {
    if (route.method !== method.toUpperCase()) return
    const shape = parsePattern(route.pattern)
    if (shape.segments.length !== segments.length) return
    const matched = shape.segments.every((segment, i) => shape.paramSlots[i] || segment === segments[i])
    if (!matched) return
    if (!best || shape.staticCount > best.staticCount) best = { route, staticCount: shape.staticCount, order: index }
  })
  return best?.route ?? null
}

/** 构建期产物：确定性排序（表序即生成序），供 Java gateway 加载（Q6 裁决）。 */
export function generateRegistryJson(): string {
  return JSON.stringify({
    registryVersion: REGISTRY_VERSION,
    generatedFrom: 'src/api-route-registry.ts',
    matchSemantics: { method: 'exact', precedence: 'static-over-param, more-specific-first', ambiguousPattern: 'build-error' },
    routes: API_ROUTES.map((route, index) => ({
      order: index,
      method: route.method,
      pattern: route.pattern,
      owner: route.owner,
      capability: route.capability,
      auth: route.auth,
      authPolicy: authPolicyFor(route.owner),
      requestSchema: route.requestSchema ?? null,
      responseSchema: route.responseSchema ?? null,
      handlerId: route.handlerId,
      stream: route.stream ? { ...route.stream, eventNames: [...route.stream.eventNames] } : null,
      note: route.note ?? null,
      adjudication: route.adjudication ?? null,
      fixPackage: route.fixPackage ?? null,
      fixDeadline: route.fixDeadline ?? null,
    })),
  }, null, 2) + '\n'
}
