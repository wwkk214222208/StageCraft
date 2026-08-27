import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PromptNode {
  id: string
  name: string
  content: string
  type: 'system' | 'user'
  enabled: boolean
  editable: boolean
  runtimeBinding?: string
  removable?: boolean
  dynamic?: boolean
}

export interface PromptRegexRule {
  id: string
  name: string
  pattern: string
  replacement: string
  enabled: boolean
}

export type PromptPresetScope = 'director.role-decision' | 'director.draft' | 'director.consult' | 'director.memory-digest' | 'chat.role-speech' | 'chat.world-director' | 'chat.role-selection' | 'prompt-preset.transform'

export const PROMPT_PRESET_SCOPES: PromptPresetScope[] = ['director.role-decision', 'director.draft', 'director.consult', 'director.memory-digest', 'chat.role-speech', 'chat.world-director', 'chat.role-selection', 'prompt-preset.transform']

/** 模式 ID 鐢辫繍琛屾椂娉ㄥ唽锛涢璁炬牸寮忎笉闄愬埗鏈潵妯″紡銆?*/
export type PromptMode = string
export interface GameplayComponent { id: string; name: string; templatePath: string[]; template?: string; dynamic: boolean; role?: 'system' | 'user' }
export interface GameplayScenario { mode: PromptMode; scope: PromptPresetScope; name: string; components: GameplayComponent[]; forceThinkingOff?: boolean; /** 标记该玩法场景是否允许用户在预设编辑器中改动；缺省 = 内部提示词（不展示、不进预设）。 */ userEditable?: boolean }
export interface PromptScenario {
  forceThinkingOff?: boolean
  nodes: PromptNode[]
  regexRules: PromptRegexRule[]
  order?: string[]
  privateNodes?: PromptNode[]
}
export interface PromptPreset {
  id: string
  name: string
  enabled?: boolean
  /** 棰勮鍖呮槑纭０鏄庢湇鍔＄殑娓哥帺妯″紡锛岃嚦灏戜竴涓€?*/
  modes: PromptMode[]
  /** 涓€濂楅璁惧寘鍙负鍏跺０鏄庣殑妯″紡鎻愪緵澶氫釜璋冪敤鎯呮櫙銆?*/
  scenarios?: Partial<Record<PromptPresetScope, PromptScenario>>
  /** 鍏煎鏃ф牸寮忥紱淇濆瓨鏃堕€愭杩佺Щ鍒?scenarios銆?*/
  nodes: PromptNode[]
  regexRules: PromptRegexRule[]
  compatibility?: { source?: 'sillytavern'; regexEnabled?: boolean }
}

export interface PromptPresetState { presets: PromptPreset[]; activeByScope: Partial<Record<PromptPresetScope, string>> }

/**
 * 提示词 IO 端口：双端只有这里不同（桌面=fs 文件，Android=构建期内联 gameplay + SQLite 预设）。
 * 运行时 prompt 行为（渲染 / 预设应用 / userEditable 过滤 / 归一化）与 IO 无关，全部共享本文件逻辑。
 */
export interface PromptStorage {
  loadGameplayScenario(scope: PromptPresetScope, filePath?: string): GameplayScenario
  loadPresetState(filePath?: string): PromptPresetState
  savePresetState(state: PromptPresetState, filePath?: string): void
  loadPrivateToggles(filePath?: string): PromptToggleState
  savePrivateToggle(presetId: string, nodeId: string, enabled: boolean, filePath?: string): PromptToggleState
}

let activePromptStorage: PromptStorage | undefined
/** 注入提示词 IO 实现：桌面/测试默认 fs；Android 本地注入同源实现。 */
export function setPromptStorage(storage: PromptStorage | undefined): void { activePromptStorage = storage }
function promptStorage(): PromptStorage { return activePromptStorage ?? fsPromptStorage }
const presetFileName = 'presets.json'
function presetPath(filePath?: string): string { return join(customDir(filePath), presetFileName) }
function gameplayDir(filePath?: string): string { return join(dirname(filePath ?? getPromptsFilePath()), 'gameplay') }
function bundledGameplayDir(): string { return join(dirname(defaultPath), 'gameplay') }
const gameplayDefaults: Record<PromptPresetScope, { mode: PromptMode; name: string; components: GameplayComponent[] }> = {
  'director.role-decision': { mode: 'director', name: '导演模式 · 角色决策', components: [] },
  'director.draft': { mode: 'director', name: '导演模式 · 场景草稿', components: [] },
  'director.consult': { mode: 'director', name: '导演模式 · 导演咨询', components: [] },
  'director.memory-digest': { mode: 'director', name: '导演模式 · 记忆消化', components: [] },
  'chat.role-speech': { mode: 'chat', name: '群聊模式 · 角色发言', components: [] },
  'chat.world-director': { mode: 'chat', name: '群聊模式 · 世界导演', components: [] },
  'chat.role-selection': { mode: 'chat', name: '群聊模式 · 导演选角', components: [] },
  'prompt-preset.transform': { mode: 'system', name: '提示词预设助手', components: [] },
}
export function loadGameplayScenario(scope: PromptPresetScope, filePath?: string): GameplayScenario {
  return promptStorage().loadGameplayScenario(scope, filePath)
}

/** 桌面默认 IO：从 prompts/gameplay 文件读取玩法场景（Android 注入内联实现）。 */
function fsLoadGameplayScenario(scope: PromptPresetScope, filePath?: string): GameplayScenario {
  const fallback = gameplayDefaults[scope]
  const localFile = join(gameplayDir(filePath), `${scope}.json`)
  const bundledFile = join(bundledGameplayDir(), `${scope}.json`)
  const file = existsSync(localFile) ? localFile : bundledFile
  if (!existsSync(file)) return { ...fallback }
  try { const data = JSON.parse(readFileSync(file, 'utf8')) as GameplayScenario; return { mode: data.mode ?? fallback.mode, scope, name: data.name ?? fallback.name, components: Array.isArray(data.components) ? data.components.map(component => ({ ...component, template: typeof component.template === 'string' ? component.template : undefined })) : fallback.components, ...(data.forceThinkingOff === true ? { forceThinkingOff: true } : {}), ...(data.userEditable === true ? { userEditable: true } : {}) } } catch { return { ...fallback } }
}

/** 允许用户在预设编辑器中改动的玩法场景（= 新格式标记 userEditable 的 scope）。 */
export function userEditableScopes(filePath?: string): PromptPresetScope[] {
  return PROMPT_PRESET_SCOPES.filter(scope => loadGameplayScenario(scope, filePath).userEditable === true)
}
const runtimeSystemLabels: Record<PromptPresetScope, string[]> = {
  'director.role-decision': ['角色身份、目标、记忆与边界', '玩家贡献与决策输出要求'],
  'director.draft': ['Director 身份与创作职责', '世界书与公开信息边界', '玩家、场景与角色意图上下文', '状态变更与提案规则', '工具输出与审批约束'],
  'director.consult': ['Director 咨询身份', '非正文与信息边界', '当前草稿、提案与咨询上下文', '工具输出约束'],
  'director.memory-digest': ['记忆消化职责', '角色视角与事实边界', '已批准正文与精炼规则', '工具输出约束'],
  'chat.role-speech': ['角色人设、世界设定、目标与发言边界', '场景、记忆、公共状态与玩家行动'],
  'chat.world-director': ['世界导演身份与职责', '不替角色发言的边界', '场景、历史与世界状态上下文', '世界变更与工具输出约束'],
  'chat.role-selection': ['导演选角身份与职责', '玩家行动与角色在场清单', '选角决策与输出格式'],
  'prompt-preset.transform': ['预设助手安全与转换规则', '玩家请求与导入的 ST 预设'],
}
function runtimeSystemNodes(scope: PromptPresetScope, filePath?: string): PromptNode[] {
  const components = loadGameplayScenario(scope, filePath).components
  if (components.length) return components.map(component => ({ id: component.id, name: component.name, content: '', type: (component.role ?? 'system') as 'system' | 'user', enabled: true, editable: false, runtimeBinding: component.id, removable: false, dynamic: component.dynamic }))
  return (runtimeSystemLabels[scope] ?? ['系统规则']).map((name, index) => ({ id: `runtime.${scope}.${index + 1}`, name, content: '', type: 'system' as const, enabled: true, editable: false, runtimeBinding: `${scope}.${index + 1}`, removable: false, dynamic: index > 1 }))
}
function defaultPromptNodes(scope: PromptPresetScope): PromptNode[] {
  const labels: Record<PromptPresetScope, [string, string]> = {
  'director.role-decision': ['角色身份、目标、记忆与边界', '玩家贡献与决策输出要求'],
  'director.draft': ['Director 创作职责与审批约束', '世界书、角色意图、场景与玩家贡献'],
  'director.consult': ['Director 咨询身份', '非正文与信息边界', '当前草稿、提案与咨询上下文', '工具输出约束'],
  'director.memory-digest': ['记忆消化职责', '角色视角与事实边界', '已批准正文与精炼规则', '工具输出约束'],
  'chat.role-speech': ['角色人设、世界设定、目标与发言边界', '场景、记忆、公共状态与玩家行动'],
  'chat.world-director': ['世界导演身份与职责', '不替角色发言的边界', '场景、历史与世界状态上下文', '世界变更与工具输出约束'],
  'chat.role-selection': ['导演选角职责', '玩家行动与角色清单'],
  'prompt-preset.transform': ['预设助手安全与转换规则', '玩家请求与导入的 ST 预设'],
  }
 return [...runtimeSystemNodes(scope), { id: 'stagecraft-user', name: labels[scope][1], content: '', type: 'user', enabled: true, editable: false, removable: false }]
}
function normalizeNodes(raw: unknown, scope: PromptPresetScope): PromptNode[] {
  const source = Array.isArray(raw) ? raw.map((node, nodeIndex) => ({
    id: String((node as Partial<PromptNode>).id ?? `node-${nodeIndex}`), name: String((node as Partial<PromptNode>).name ?? '未命名节点'), content: String((node as Partial<PromptNode>).content ?? ''),
    type: (node as Partial<PromptNode>).type === 'system' ? 'system' as const : 'user' as const, enabled: (node as Partial<PromptNode>).type === 'system' ? true : (node as Partial<PromptNode>).enabled !== false,
    editable: (node as Partial<PromptNode>).type !== 'system' && (node as Partial<PromptNode>).editable !== false, ...((node as Partial<PromptNode>).runtimeBinding ? { runtimeBinding: String((node as Partial<PromptNode>).runtimeBinding) } : {}), removable: (node as Partial<PromptNode>).type === 'system' ? false : (node as Partial<PromptNode>).removable !== false, ...((node as Partial<PromptNode>).dynamic !== undefined ? { dynamic: Boolean((node as Partial<PromptNode>).dynamic) } : {}),
  })) : []
  if (!source.length) return defaultPromptNodes(scope)
  if (source.some(node => node.runtimeBinding || node.id.startsWith('runtime.'))) return source.map((node, index) => {
    if (node.type !== 'system') return node
    const componentIndex = Number((node.runtimeBinding ?? node.id).match(/(\d+)$/)?.[1] ?? index + 1) - 1
    return { ...node, name: node.name || runtimeSystemLabels[scope]?.[componentIndex] || `系统组件 ${componentIndex + 1}`, enabled: true, editable: false, removable: false, dynamic: node.dynamic ?? componentIndex > 1 }
  })
  const runtime = runtimeSystemNodes(scope)
  if (!source.some(node => node.id === 'stagecraft-system')) return [...runtime, ...source]
  const migrated: PromptNode[] = []
  for (const node of source) migrated.push(...(node.id === 'stagecraft-system' ? runtime : [node]))
  return migrated
}
function normalizeScenario(source: Partial<PromptScenario> | undefined, scope: PromptPresetScope): PromptScenario {
  if (Array.isArray(source?.order)) {
    const systems = runtimeSystemNodes(scope)
    const systemById = new Map(systems.map(node => [node.id, node]))
    // 以调用方提交的全量 nodes 为准推导私设（编辑器可能携带陈旧的空 privateNodes，忽略 nodes 会丢新增私设）；
    // 仅当未提供 nodes（collect 落盘格式 order+privateNodes）时才回退到 privateNodes。
    const privateSource = Array.isArray(source.nodes) && source.nodes.length
      ? source.nodes.filter(node => node?.type === 'user' && node.removable !== false)
      : Array.isArray(source.privateNodes) ? source.privateNodes : []
    const privateNodes = privateSource.filter(node => node?.type !== 'system').map((node, index) => ({ id: String(node.id ?? `user-${index}`), name: String(node.name ?? '私有提示词'), content: String(node.content ?? ''), type: 'user' as const, enabled: node.enabled !== false, editable: true, removable: true }))
    const privateById = new Map(privateNodes.map(node => [node.id, node]))
    const nodes = source.order.map(String).map(id => systemById.get(id) ?? privateById.get(id)).filter((node): node is PromptNode => Boolean(node))
    for (const system of systems) if (!nodes.some(node => node.id === system.id)) nodes.push(system)
    for (const node of privateNodes) if (!nodes.some(item => item.id === node.id)) nodes.push(node)
    return { ...(source.forceThinkingOff === true ? { forceThinkingOff: true } : {}), nodes, regexRules: Array.isArray(source.regexRules) ? source.regexRules : [], order: nodes.map(node => node.id), privateNodes }
  }
  return { ...(source?.forceThinkingOff === true ? { forceThinkingOff: true } : {}), nodes: normalizeNodes(source?.nodes, scope), regexRules: Array.isArray(source?.regexRules) ? source.regexRules : [] }
}
function normalizePreset(input: Partial<PromptPreset>, index = 0, filePath?: string): PromptPreset {
  const nodes = normalizeNodes(input.nodes, 'director.draft')
  const regexRules = Array.isArray(input.regexRules) ? input.regexRules.map((rule, ruleIndex) => ({
    id: String(rule.id ?? `regex-${ruleIndex}`), name: String(rule.name ?? '未命名规则'), pattern: String(rule.pattern ?? ''),
    replacement: String(rule.replacement ?? ''), enabled: rule.enabled !== false,
  })) : []
  const modes = Array.isArray(input.modes) ? input.modes.map(String).map(mode => mode.trim()).filter(Boolean) : ['director']
  const scenarios = Object.fromEntries(userEditableScopes(filePath).filter(scope => scope.startsWith('chat.') ? modes.includes('chat') : modes.includes('director')).map(scope => { const source = input.scenarios?.[scope] ?? (!input.scenarios ? { nodes: input.nodes, regexRules: input.regexRules } : undefined); const normalized = normalizeScenario(source, scope); const scopedRules = Array.isArray(normalized.regexRules) ? normalized.regexRules.map((rule, ruleIndex) => ({ id: String(rule.id ?? `regex-${ruleIndex}`), name: String(rule.name ?? '未命名规则'), pattern: String(rule.pattern ?? ''), replacement: String(rule.replacement ?? ''), enabled: rule.enabled === true })) : []; return [scope, { ...normalized, regexRules: scopedRules }] })) as Record<PromptPresetScope, PromptScenario>
  return { id: String(input.id ?? `preset-${Date.now()}-${index}`), name: String(input.name ?? `鎻愮ず璇嶉璁?${index + 1}`), enabled: input.enabled === true, modes: modes.length ? [...new Set(modes)] : (String(input.id ?? '') === 'default' ? ['director', 'chat'] : ['director']), scenarios, nodes, regexRules, ...(input.compatibility ? { compatibility: { source: input.compatibility.source === 'sillytavern' ? 'sillytavern' as const : undefined, regexEnabled: input.compatibility.regexEnabled === true } } : {}) }
}
function readPresetState(filePath?: string): PromptPresetState { return promptStorage().loadPresetState(filePath) }
function fsLoadPresetState(filePath?: string): PromptPresetState {
  const target = presetPath(filePath)
  if (!existsSync(target)) return { presets: [normalizePreset({ id: 'default', name: '默认预设', enabled: true }, 0, filePath)], activeByScope: {} }
  try {
    const data = JSON.parse(readFileSync(target, 'utf8')) as Partial<PromptPresetState> | PromptPreset[]
    if (Array.isArray(data)) return { presets: data.map((item, index) => normalizePreset(item, index, filePath)), activeByScope: {} }
    return { presets: Array.isArray(data.presets) ? data.presets.map((item, index) => normalizePreset(item, index, filePath)) : [normalizePreset({ id: 'default', name: '默认预设' }, 0, filePath)], activeByScope: data.activeByScope ?? {} }
  } catch { return { presets: [normalizePreset({ id: 'default', name: '默认预设', enabled: true }, 0, filePath)], activeByScope: {} } }
}
export function getPromptPresetState(filePath?: string): PromptPresetState { return readPresetState(filePath) }
export function savePromptPresets(presets: PromptPreset[], filePath?: string, activeByScope: Partial<Record<PromptPresetScope, string>> = readPresetState(filePath).activeByScope): void {
  promptStorage().savePresetState({ presets, activeByScope }, filePath)
}
function fsSavePresetState(state: PromptPresetState, filePath?: string): void {
  const stored = state.presets.map((preset, index) => normalizePreset(preset, index, filePath)).map(preset => ({ ...preset, scenarios: Object.fromEntries(Object.entries(preset.scenarios ?? {}).map(([scope, scenario]) => { const nodes = scenario.nodes ?? []; return [scope, { ...(scenario.forceThinkingOff === true ? { forceThinkingOff: true } : {}), order: nodes.map(node => node.runtimeBinding ?? node.id), privateNodes: nodes.filter(node => node.type === 'user' && node.removable !== false), regexRules: scenario.regexRules }] })), nodes: preset.nodes.filter(node => node.type === 'user' && node.removable !== false) }))
  const dir = customDir(filePath); mkdirSync(dir, { recursive: true }); writeFileSync(presetPath(filePath), `${JSON.stringify({ presets: stored, activeByScope: state.activeByScope }, null, 2)}\n`, 'utf8')
}
export function updatePromptPreset(preset: PromptPreset, filePath?: string): PromptPreset[] {
  const state = readPresetState(filePath); const next = normalizePreset(preset, 0, filePath); if (!next.modes.length) throw new Error('提示词预设至少需要服务一个游玩模式。'); const index = state.presets.findIndex(item => item.id === next.id)
  if (index >= 0) state.presets[index] = next; else state.presets.push(next)
  if (next.enabled) for (const scope of userEditableScopes(filePath)) { const mode = scope.startsWith('chat.') ? 'chat' : scope.startsWith('director.') ? 'director' : undefined; if (!mode || next.modes.includes(mode)) state.activeByScope[scope] = next.id }
  savePromptPresets(state.presets, filePath, state.activeByScope); return state.presets
}
export function setPromptPresetForScope(scope: PromptPresetScope, id: string, filePath?: string): PromptPresetState {
  const state = readPresetState(filePath); if (!state.presets.some(item => item.id === id)) throw new Error('提示词预设不存在。')
  state.activeByScope[scope] = id; savePromptPresets(state.presets, filePath, state.activeByScope); return state
}
export function deletePromptPreset(id: string, filePath?: string): PromptPreset[] {
  const state = readPresetState(filePath); if (id === 'default' || state.presets.length <= 1) return state.presets
  const next = state.presets.filter(item => item.id !== id); for (const scope of userEditableScopes(filePath)) if (state.activeByScope[scope] === id) delete state.activeByScope[scope]
  savePromptPresets(next, filePath, state.activeByScope); return next
}

export function isPromptThinkingForcedOff(scope: PromptPresetScope, filePath?: string): boolean {
  if (loadGameplayScenario(scope, filePath).forceThinkingOff === true) return true
  const state = readPresetState(filePath)
  const mode: PromptMode = scope.startsWith('chat.') ? 'chat' : 'director'
  const id = state.activeByScope[scope] ?? state.presets.find(item => item.enabled && item.modes.includes(mode))?.id
  return state.presets.find(item => item.id === id)?.scenarios?.[scope]?.forceThinkingOff === true
}

export function applyPromptPreset(system: string, user: string, scopeOrFilePath: PromptPresetScope | string = 'director.draft', filePath?: string, componentContents?: Record<string, string>): { system: string; user: string; messages: Array<{ role: 'system' | 'user'; content: string }> } {
  const scope = PROMPT_PRESET_SCOPES.includes(scopeOrFilePath as PromptPresetScope) ? scopeOrFilePath as PromptPresetScope : 'director.draft'
  const resolvedFilePath = scope === 'director.draft' && scopeOrFilePath !== scope ? scopeOrFilePath : filePath
  // 非用户可编辑 scope（新格式未标记 userEditable）= 内部提示词：原样透传，不进预设管线。
  if (!userEditableScopes(resolvedFilePath).includes(scope)) return { system, user, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }
  const state = readPresetState(resolvedFilePath); const mode: PromptMode = scope.startsWith('chat.') ? 'chat' : 'director'
  const id = state.activeByScope[scope] ?? (state.presets.find(item => item.enabled && item.modes.includes(mode))?.id ?? 'default'); const preset = state.presets.find(item => item.id === id && item.modes.includes(mode))
  if (!preset) {
    if (componentContents) {
      const gameplay = loadGameplayScenario(scope, resolvedFilePath)
      const messages = gameplay.components.map(component => ({ role: component.role ?? 'system' as const, content: componentContents[component.id] ?? '' })).filter(message => message.content)
      return { system: messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'), user: messages.filter(message => message.role === 'user').map(message => message.content).join('\n\n'), messages }
    }
    return { system, user, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }
  }
  const scoped = preset.scenarios?.[scope]
  const nodes = scoped?.nodes ?? preset.nodes
  const legacy = nodes.some(node => node.id === 'stagecraft-system' || node.id === 'stagecraft-user')
  const runtimeParts = system.split(/\n{2,}/).map(part => part.trim()).filter(Boolean)
  const runtimeNodes = runtimeSystemNodes(scope)
  const gameplay = loadGameplayScenario(scope, resolvedFilePath)
  const hasRuntimeNodes = nodes.some(node => node.runtimeBinding || node.id.startsWith('runtime.') || gameplay.components.some(component => component.id === node.id))
  const ordered = legacy ? nodes : hasRuntimeNodes ? nodes : [...runtimeNodes, { id: 'stagecraft-user', name: '用户上下文', content: '', type: 'user' as const, enabled: true, editable: false, removable: false } as PromptNode, ...nodes]
  const parts: Array<{ type: PromptNode['type']; content: string }> = []
  let emittedGameplaySystem = false
  let emittedGameplayUser = false
  for (const node of ordered) {
    let content = node.content.trim()
    const binding = node.runtimeBinding ?? node.id
    const gameplayComponent = gameplay.components.find(component => component.id === binding)
    const required = node.removable === false && (gameplayComponent || node.runtimeBinding || node.id.startsWith('runtime.'))
    if (gameplayComponent) {
      if (componentContents?.[gameplayComponent.id] !== undefined) content = componentContents[gameplayComponent.id]
      else if (gameplayComponent.role === 'user') { content = emittedGameplayUser ? '' : user; emittedGameplayUser = true }
      else { content = emittedGameplaySystem ? '' : system; emittedGameplaySystem = true }
    }
    else if (required) { const match = binding.match(/(?:\.|\D)(\d+)$/); content = runtimeParts[Math.max(0, Number(match?.[1] ?? 1) - 1)] ?? '' }
    else if (node.id === 'stagecraft-system') content = system
    else if (node.id === 'stagecraft-user') content = user
    else if (node.id === 'stagecraft-user' || node.name === '用户上下文') content = user
    if ((required || node.id === 'stagecraft-system' || node.id === 'stagecraft-user' || node.name === '用户上下文' || node.enabled) && content) parts.push({ type: gameplayComponent?.role ?? node.type, content })
  }
  const regexRules = preset.compatibility?.regexEnabled === true ? (scoped?.regexRules ?? preset.regexRules) : []
  const nextSystem = applyRules(parts.filter(part => part.type === 'system').map(part => part.content).join('\n\n'), regexRules)
  const nextUser = applyRules(parts.filter(part => part.type === 'user').map(part => part.content).join('\n\n'), regexRules)
  const messages = parts.map(part => ({ role: part.type, content: applyRules(part.content, regexRules) }))
  return { system: nextSystem, user: nextUser, messages }
}
function applyRules(text: string, rules: PromptRegexRule[]): string {
  let result = text
  for (const rule of rules) if (rule.enabled && rule.pattern) { try { const match = rule.pattern.match(new RegExp('^/(.*)/([a-z]*)$', 's')); result = result.replace(new RegExp(match?.[1] ?? rule.pattern, match?.[2] ?? 'g'), rule.replacement) } catch { /* invalid rules are ignored */ } }
  return result
}

const defaultPath = join(fileURLToPath(new URL('..', import.meta.url)), 'prompts', 'prompts.json')

/** 运行时提示词模板路径（包内只读）；由 startTavern 瑁呴厤鏃惰缃紝鏈缃椂鍥為€€榛樿銆?*/
let activePromptsPath: string | undefined
export function setPromptsFilePath(filePath: string): void { activePromptsPath = filePath }
export function getPromptsFilePath(): string { return activePromptsPath ?? defaultPath }

/** 用户自定义提示词目录（AppData锛屽彲鍐欙級锛涙ā鏉胯矾寰勪笌鐢ㄦ埛鏁版嵁鍒嗙銆?*/
let activeUserPromptsDir: string | undefined
export function setUserPromptsDir(dir: string): void { activeUserPromptsDir = dir }
/**
 * 鑷畾涔夋彁绀鸿瘝鐩綍瑙ｆ瀽锛? * - 显式传入 filePath锛堟祴璇?独立调用）→ 用其所在目录的 custom/ 瀛愮洰褰? * - 否则优先 AppData 用户目录（setUserPromptsDir 璁剧疆锛? * - 閮芥病鏈?鈫?回退模板文件同目录的 custom/
 */
function customDir(filePath?: string): string {
  if (filePath) return join(dirname(filePath), 'custom')
  if (activeUserPromptsDir) return activeUserPromptsDir
  return join(dirname(getPromptsFilePath()), 'custom')
}

/** 鐢?{占位符} 替换模板变量；未提供的占位符保留原样 */
export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] !== undefined ? values[key] : match)
}

/* 私设条目开关：独立于预设文件持久（用户数据目录/prompts/private-toggles.json）。
 * 预设文件里的 enabled 仅作为加载时的初始开关状态；此处覆盖保存当前开关状态（服务端持久）。 */
function privateTogglesFilePath(filePath?: string): string {
  return join(dirname(customDir(filePath)), 'private-toggles.json')
}
export type PromptToggleState = Record<string, Record<string, boolean>>
export function loadPrivateToggles(filePath?: string): PromptToggleState { return promptStorage().loadPrivateToggles(filePath) }
export function savePrivateToggle(filePath: string | undefined, presetId: string, nodeId: string, enabled: boolean): PromptToggleState {
  return promptStorage().savePrivateToggle(presetId, nodeId, enabled, filePath)
}
function fsLoadPrivateToggles(filePath?: string): PromptToggleState {
  try { return JSON.parse(readFileSync(privateTogglesFilePath(filePath), 'utf8')) as PromptToggleState } catch { return {} }
}
function fsSavePrivateToggle(presetId: string, nodeId: string, enabled: boolean, filePath?: string): PromptToggleState {
  const toggles = fsLoadPrivateToggles(filePath)
  toggles[presetId] = toggles[presetId] ?? {}
  toggles[presetId][nodeId] = enabled
  mkdirSync(dirname(privateTogglesFilePath(filePath)), { recursive: true })
  writeFileSync(privateTogglesFilePath(filePath), JSON.stringify(toggles, null, 2))
  return toggles
}
/** 应用开关覆盖：把 private-toggles 里的开关状态合并进各预设节点 enabled（不写回预设文件）。 */
export function mergePrivateToggles(presets: PromptPreset[], toggles: PromptToggleState): PromptPreset[] {
  return presets.map(preset => {
    const over = toggles[preset.id]
    if (!over || !preset.scenarios) return preset
    const scenarios: Partial<Record<PromptPresetScope, PromptScenario>> = {}
    for (const [scope, scenario] of Object.entries(preset.scenarios) as [PromptPresetScope, PromptScenario][]) {
      if (!scenario?.nodes?.length) { scenarios[scope] = scenario; continue }
      scenarios[scope] = { ...scenario, nodes: scenario.nodes.map(node => over[node.id] === undefined ? node : { ...node, enabled: over[node.id] }) }
    }
    return { ...preset, scenarios }
  })
}

/** 桌面默认 IO 实现：fs 文件存储（Android 本地通过 setPromptStorage 注入同源实现）。 */
const fsPromptStorage: PromptStorage = {
  loadGameplayScenario: fsLoadGameplayScenario,
  loadPresetState: fsLoadPresetState,
  savePresetState: fsSavePresetState,
  loadPrivateToggles: fsLoadPrivateToggles,
  savePrivateToggle: fsSavePrivateToggle,
}
