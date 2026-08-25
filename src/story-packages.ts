import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LoreEntry, PlayerCharacter, Role } from './types.ts'

export interface StoryPackage {
  id: string
  title: string
  opening: string
  playerCharacter: PlayerCharacter
  roles: Role[]
  /** 初始场景时间（如「夜晚」），可选 */
  sceneTime?: string
  /** 初始场景地点，可选 */
  sceneLocation?: string
  /** 世界书条目；`roles` 缺省或为空 = 常开 */
  lore?: LoreEntry[]
  /**
   * 玩法声明（gameplay 配置）：故事声明本玩法的领域规则与默认设置，
   * 由程序读取后写入房间数据；程序顶层不持有「玩法 → 规则」映射。
   * 例如 `chat.speechMode` = 群聊发言模式（manual / director / all），缺省 manual。
   */
  gameplay?: StoryGameplayConfig
}

/** 玩法级声明配置。各玩法模式在此声明自己的领域默认值（玩家可覆盖并持久化）。 */
export interface StoryGameplayConfig {
  chat?: {
    /** 群聊发言模式：手动发言 / 导演决定发言角色 / 所有人依次发言 */
    speechMode?: import('./types.ts').ChatSpeechMode
  }
}

/** 把旧剧本中写在人设末尾的长期目标迁移到独立字段，并从人设正文移除。 */
function normalizeRoleGoals(role: Role): Role {
  if (Array.isArray(role.goals) && role.goals.length) return role
  const match = String(role.selfModel ?? '').match(/(?:^|\n)\s*={3,}\s*长期目标\s*={3,}\s*\n([\s\S]*)$/)
  if (!match) return role
  const goals = match[1].split(/\r?\n/).map(line => line.trim()).filter(line => /^[-*•]/.test(line)).map(line => line.replace(/^[-*•]\s*/, '').trim()).filter(Boolean)
  const selfModel = String(role.selfModel).slice(0, match.index).trimEnd()
  return { ...role, selfModel, ...(goals.length ? { goals } : {}) }
}

/** 旧格式兼容：memoryTimeline（时间桶）→ memories（列表）。新格式（memories）原样通过。 */
function normalizeRoleMemories(role: Role): Role {
  const legacy = role as Role & { memoryTimeline?: Record<string, string[]> }
  if (Array.isArray(role.memories)) {
    const { memoryTimeline: _legacy, ...clean } = legacy
    return clean
  }
  const timeline = legacy.memoryTimeline
  if (!timeline || typeof timeline !== 'object') return role
  const memories = Object.entries(timeline).flatMap(([occurredAt, items]) =>
    (Array.isArray(items) ? items : []).filter(text => typeof text === 'string' && text.trim()).map(text => ({ text: String(text).trim(), occurredAt })))
  const { memoryTimeline: _legacyTimeline, ...clean } = legacy
  return { ...clean, memories }
}

function normalizeStoryRoles(story: StoryPackage): StoryPackage {
  story.roles = (story.roles ?? []).map(normalizeRoleGoals).map(normalizeRoleMemories)
  return story
}

/** 查找顺序：custom/（玩家剧本，AppData）→ 附加目录（程序/仓库文件夹里的默认剧本）→ 主目录 → default/（AppData 副本）。 */
function storyPath(directory: string, id: string, extraDirectories: string[] = []): string {
  const candidates = [
    join(directory, 'custom', `${id}.json`),
    ...extraDirectories.flatMap(dir => [join(dir, `${id}.json`), join(dir, 'default', `${id}.json`)]),
    join(directory, `${id}.json`),
    join(directory, 'default', `${id}.json`),
    ...extraDirectories.flatMap(dir => [join(dir, 'custom', `${id}.json`)]),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return candidates[0]
}

/** 故事包资产目录：<故事包所在目录>/<storyId>.assets/。肖像等资源随故事包存放，可整体分发。 */
export function storyAssetsDir(directory: string, id: string, extraDirectories: string[] = []): string {
  const story = storyPath(directory, id, extraDirectories)
  return join(dirname(story), `${id}.assets`)
}

/** 解析故事包内相对肖像引用（`assets/xxx.png`）为可访问的全局 URL（`/story-assets/<id>/xxx.png`） */
export function storyPortraitUrl(id: string, portraitRef: string): string {
  const cleaned = portraitRef.replace(/^\.?\//, '')
  return `/story-assets/${encodeURIComponent(id)}/${cleaned.replace(/^assets\//, '')}`
}

/** 把全局 URL 转回故事包资产目录下的相对文件路径（`assets/xxx.png`），供落盘存储 */
export function storyPortraitFileName(portraitRef: string): string {
  return `assets/${portraitRef.replace(/^\/story-assets\/[^/]+\//, '').replace(/^assets\//, '')}`
}

/** 静态 URL → 故事包资产目录内文件（返回绝对路径；不存在返回 undefined） */
export function resolveStoryAssetFile(directory: string, urlPath: string, extraDirectories: string[] = []): string | undefined {
  const match = urlPath.match(/^\/story-assets\/([^/]+)\/(.+)$/)
  if (!match) return undefined
  const storyId = decodeURIComponent(match[1])
  const file = match[2]
  for (const base of [directory, ...extraDirectories]) {
    for (const sub of ['', 'custom', 'default']) {
      const candidate = join(base, sub, `${storyId}.assets`, file)
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
  }
  return undefined
}

export function loadStoryPackage(directory: string, id: string, extraDirectories: string[] = []): StoryPackage {
  const path = storyPath(directory, id, extraDirectories)
  const value = JSON.parse(readFileSync(path, 'utf8')) as StoryPackage
  value.playerCharacter ??= { name: '玩家', persona: '由玩家自由定义的参与者。', currentState: '刚刚进入当前场景。' }
  normalizeStoryRoles(value)
  validateStoryPackage(value)
  return value
}

/** 把剧本写回磁盘（覆盖 ${id}.json）。用于「编辑原始剧本」选项；custom 剧本写回 custom/。 */
export function saveStoryPackage(directory: string, story: StoryPackage): void {
  normalizeStoryRoles(story)
  validateStoryPackage(story)
  const path = storyPath(directory, story.id)
  writeFileSync(path, `${JSON.stringify(story, null, 2)}\n`, 'utf8')
}

/** 新建用户剧本（自定义模板）：默认玩家 + 一位向导角色，写入 custom/，随 listStoryPackages 标记 custom。 */
export function createStoryPackage(directory: string, input: { title?: string; id?: string; opening?: string; sceneTime?: string; sceneLocation?: string } = {}): StoryPackage {
  const title = String(input.title ?? '').trim() || '未命名剧本'
  const id = String(input.id ?? '').trim() || `story-${Date.now()}`
  const story: StoryPackage = {
    id,
    title,
    opening: String(input.opening ?? '').trim() || `${title}：一个全新的故事即将展开。`,
    playerCharacter: { name: '玩家', persona: '由玩家自由定义的参与者。', currentState: '刚刚进入当前场景。' },
    roles: [{
      id: 'guide',
      name: '向导',
      portraitRef: '/assets/default.svg',
      currentState: '刚刚进入当前场景。',
      presence: 'present',
      selfModel: '一位介绍当前世界与背景的向导。',
    }],
    ...(input.sceneTime?.trim() ? { sceneTime: input.sceneTime.trim() } : {}),
    ...(input.sceneLocation?.trim() ? { sceneLocation: input.sceneLocation.trim() } : {}),
  }
  validateStoryPackage(story)
  const dir = join(directory, 'custom')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(story, null, 2)}\n`, 'utf8')
  return story
}

/** 另存为：以新 id 把完整剧本写入 custom/（玩家剧本，AppData），保留全部内容；返回新剧本。 */
export function saveStoryAsPackage(directory: string, story: StoryPackage, newId: string, title?: string): StoryPackage {
  const copy: StoryPackage = { ...story, id: newId, ...(title?.trim() ? { title: title.trim() } : {}) }
  validateStoryPackage(copy)
  const dir = join(directory, 'custom')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${newId}.json`), `${JSON.stringify(copy, null, 2)}\n`, 'utf8')
  return copy
}

/**
 * 世界书 txt 导入：解析 `=== 条目名 ===` + `> 角色: a, b`（可选，缺省=常开）+ 正文。
 * 返回条目列表；JSON 里已有的 lore 优先（txt 仅补充 JSON 缺失的同名条目）。
 */
export function parseWorldBookTxt(text: string): LoreEntry[] {
  const entries: LoreEntry[] = []
  let current: { name: string; roles?: string[]; lines: string[] } | undefined
  const push = () => { if (current) { const content = current.lines.join('\n').trim(); if (content) entries.push({ name: current.name, ...(current.roles?.length ? { roles: current.roles } : {}), content }) } }
  for (const line of String(text).split(/\r?\n/)) {
    const header = line.match(/^===\s*(.+?)\s*===/)
    if (header) { push(); current = { name: header[1], lines: [] }; continue }
    if (!current) continue
    const roleMatch = line.match(/^>\s*角色\s*[:：]\s*(.+)$/)
    if (roleMatch) {
      current.roles = (current.roles ?? []).concat(roleMatch[1].split(/[,，、]/).map(item => item.trim()).filter(Boolean))
      continue
    }
    current.lines.push(line)
  }
  push()
  return entries
}

/** 加载剧本并合并同目录 txt 世界书（如 `${id}.txt` 或 `世界书.txt`） */
export function loadStoryPackageWithTxt(directory: string, id: string): StoryPackage {
  const story = loadStoryPackage(directory, id)
  const candidates = [`${id}.txt`, '世界书.txt']
  for (const candidate of candidates) {
    const txtPath = join(directory, candidate)
    if (existsSync(txtPath)) {
      const parsed = parseWorldBookTxt(readFileSync(txtPath, 'utf8'))
      const existing = new Map((story.lore ?? []).map(entry => [entry.name, entry]))
      for (const entry of parsed) if (!existing.has(entry.name)) existing.set(entry.name, entry)
      story.lore = [...existing.values()]
    }
  }
  return story
}

export function listStoryPackages(directory: string, extraDirectories: string[] = []): Array<Pick<StoryPackage, 'id' | 'title'> & { custom?: boolean }> {
  const read = (dir: string): Array<{ id: string; title: string; custom?: boolean; source: string }> => {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => {
        try {
          const value = JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) as StoryPackage
          value.playerCharacter ??= { name: '玩家', persona: '由玩家自由定义的参与者。', currentState: '刚刚进入当前场景。' }
          validateStoryPackage(value)
          return { id: value.id, title: value.title, source: dir }
        } catch { return null }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  }
  // 优先级从低到高：主目录(AppData 副本) → 主目录 default → 附加目录（程序/仓库文件夹，默认剧本优先）→ 附加目录 custom → 主目录 custom（玩家剧本，最高）。
  // Map 后者覆盖前者，所以最后填充的 AppData/custom 优先级最高。
  const all = [
    ...read(directory),
    ...read(join(directory, 'default')),
    ...extraDirectories.flatMap(dir => [...read(dir), ...read(join(dir, 'default')), ...read(join(dir, 'custom')).map(entry => ({ ...entry, custom: true }))]),
    ...read(join(directory, 'custom')).map(entry => ({ ...entry, custom: true })),
  ]
  const byId = new Map<string, { id: string; title: string; custom?: boolean }>()
  for (const entry of all) byId.set(entry.id, { id: entry.id, title: entry.title, ...(entry.custom ? { custom: true } : {}) })
  return [...byId.values()]
}

export function validateStoryPackage(value: StoryPackage): void {
  if (!value.id || !value.title || !value.opening || !value.playerCharacter?.name || !value.playerCharacter?.persona || !value.playerCharacter?.currentState || !Array.isArray(value.roles) || value.roles.length === 0) throw new Error('Invalid story package.')
  const roleIds = new Set<string>()
  for (const role of value.roles) {
    if (!role.id || !role.name || !role.currentState || !role.selfModel || !role.portraitRef) throw new Error(`Invalid role in story package: ${role.id || 'unknown'}`)
    if (!['present', 'absent', 'unavailable'].includes(role.presence)) throw new Error(`Invalid role presence: ${role.id}`)
    if (roleIds.has(role.id)) throw new Error(`Duplicate role id in story package: ${role.id}`)
    roleIds.add(role.id)
  }
}
