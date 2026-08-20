import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

function normalizeStoryRoles(story: StoryPackage): StoryPackage {
  story.roles = (story.roles ?? []).map(normalizeRoleGoals)
  return story
}

/** 优先主目录，其次 stories/custom/（用户自建剧本，随项目保留目录但不提交内容） */
function storyPath(directory: string, id: string): string {
  const direct = join(directory, `${id}.json`)
  if (existsSync(direct)) return direct
  return join(directory, 'custom', `${id}.json`)
}

export function loadStoryPackage(directory: string, id: string): StoryPackage {
  const path = storyPath(directory, id)
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

export function listStoryPackages(directory: string): Array<Pick<StoryPackage, 'id' | 'title'> & { custom?: boolean }> {
  const read = (dir: string) => {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => {
        const value = JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) as StoryPackage
        value.playerCharacter ??= { name: '玩家', persona: '由玩家自由定义的参与者。', currentState: '刚刚进入当前场景。' }
        validateStoryPackage(value)
        return { id: value.id, title: value.title }
      })
  }
  const main = read(directory)
  const custom = read(join(directory, 'custom')).map(entry => ({ ...entry, custom: true }))
  // custom 优先（同 id 时覆盖）：用户自建优先于随项目的同名剧本
  const byId = new Map<string, (typeof main)[number]>()
  for (const entry of [...main, ...custom]) byId.set(entry.id, entry)
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
