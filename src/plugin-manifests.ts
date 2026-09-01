/**
 * 桌面内置插件候选集（构建期确定；与 src/portable/android-local-core.ts 的
 * BUILTIN_PLUGIN_MANIFESTS 同一契约、同一校验规则）。
 *
 * 本模块必须保持零运行时依赖（只 import 类型）：PluginConfigStore / 管理层 / 兜底入口
 * 都要能在 Core 未启动时使用（D2：管理层独立于 Core）。
 * 深度校验唯一实现在 src/plugin-bootstrap.ts；本文件只声明静态清单。
 *
 * requires 声明装载拓扑（引导层按依赖序装载，与 app-boot 历史装配顺序一致：
 * core → state → human → solution）。
 */

import type { PluginManifest } from './plugin-contract.ts'

export const DESKTOP_BUILTIN_PLUGIN_MANIFESTS: readonly PluginManifest[] = Object.freeze([
  {
    id: 'stagecraft.core', version: '1.0.0', kind: 'core',
    title: 'StageCraft Core Runtime',
    description: '核心运行时插件：状态事务、Workflow、事件广播（Core 是唯一状态权威）',
    capabilities: ['core.runtime'],
  },
  {
    id: 'stagecraft.state', version: '1.0.0', kind: 'repository',
    title: 'StageCraft State Repository（SQLite）',
    description: '桌面状态仓储：Core state / 事件 / Workflow 的唯一写入者',
    requires: { plugins: ['stagecraft.core'] },
    capabilities: ['state.persist'],
  },
  {
    id: 'stagecraft.human.http', version: '1.0.0', kind: 'human',
    title: 'Core Protocol Human Adapter（HTTP/SSE）',
    description: 'HTTP 人机交互适配：/api/core/* 协议端点与 SSE envelope',
    requires: { plugins: ['stagecraft.core'] },
    capabilities: ['http.entry'],
  },
  {
    id: 'stagecraft.solution', version: '1.0.0', kind: 'solution',
    title: 'StageCraft Solution（Chat/Director/Management）',
    description: '内置聊天/导演/管理解决方案插件：三条 Workflow、默认状态类别与命令处理器',
    requires: { plugins: ['stagecraft.core', 'stagecraft.state'] },
    capabilities: ['workflow.register', 'state.transact'],
  },
])
