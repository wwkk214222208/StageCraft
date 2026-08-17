import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PromptTemplates {
  role: { system: string; user: string; retrySystem: string; retryUser: string; digestSystem: string; digestUser: string }
  director: { request: string; retrySystem: string; retryUser: string }
  consult: { user: string }
  skills: { director: string; consultation: string }
}

/** 创作理念（私有，随项目保留目录但不提交内容）：角色世界运行原则 + 导演创作宪法/文风 */
export interface PromptIdeology {
  roleIdeals?: string
  directorIdeals?: string
}

const defaultPath = join(fileURLToPath(new URL('..', import.meta.url)), 'prompts', 'prompts.json')

/** 私有理念文件：<prompts 目录>/custom/ideology.json（默认）；若 active.json 指定了其他文件则用该文件 */
export function loadIdeology(filePath = defaultPath): PromptIdeology {
  const dir = join(dirname(filePath), 'custom')
  const active = join(dir, 'active.json')
  if (existsSync(active)) {
    try {
      const record = JSON.parse(readFileSync(active, 'utf8')) as { file?: string }
      const target = join(dir, String(record.file ?? ''))
      if (record.file && existsSync(target)) return loadIdeologyFile(target)
    } catch { /* 损坏则回退默认 */ }
  }
  const fallback = join(dir, 'ideology.json')
  return existsSync(fallback) ? loadIdeologyFile(fallback) : {}
}

/** 激活指定提示词文件：写 active.json；此后 loadPrompts 注入该文件的理念 */
export function setActiveIdeologyFile(name: string, filePath = defaultPath): void {
  const dir = join(dirname(filePath), 'custom')
  mkdirSync(dir, { recursive: true })
  const safe = name.endsWith('.json') ? name : `${name}.json`
  writeFileSync(join(dir, 'active.json'), `${JSON.stringify({ file: safe }, null, 2)}\n`, 'utf8')
}

/** 提示词文件名是否合法（仅允许写入 prompts/custom/ 下的 json；空/越界返回 false） */
export function isValidIdeologyFileName(name: string): boolean {
  return /^[\w\u4e00-\u9fff-]+\.json$/.test(name)
}

/** 受保护的内部文件：不能被删除/改名 */
function isProtected(file: string): boolean {
  return file === 'active.json' || file === 'ideology.json'
}

function ideologyDir(filePath: string): string {
  return join(dirname(filePath), 'custom')
}

/** 删除提示词文件；受保护文件（active.json / ideology.json）返回 false */
export function removeIdeologyFile(name: string, filePath = defaultPath): boolean {
  const file = name.endsWith('.json') ? name : `${name}.json`
  if (!isValidIdeologyFileName(file) || isProtected(file)) return false
  const target = join(ideologyDir(filePath), file)
  if (!existsSync(target)) return false
  rmSync(target)
  return true
}

/** 重命名提示词文件；受保护文件返回 false；若重命名的是激活文件则同步 active.json */
export function renameIdeologyFile(from: string, to: string, filePath = defaultPath): boolean {
  const fromFile = from.endsWith('.json') ? from : `${from}.json`
  const toFile = to.endsWith('.json') ? to : `${to}.json`
  if (!isValidIdeologyFileName(fromFile) || !isValidIdeologyFileName(toFile) || isProtected(fromFile)) return false
  const dir = ideologyDir(filePath)
  const source = join(dir, fromFile)
  if (!existsSync(source) || existsSync(join(dir, toFile))) return false
  renameSync(source, join(dir, toFile))
  const active = join(dir, 'active.json')
  if (existsSync(active)) {
    try {
      const record = JSON.parse(readFileSync(active, 'utf8')) as { file?: string }
      if (record.file === fromFile) setActiveIdeologyFile(toFile, filePath)
    } catch { /* 忽略损坏的 active.json */ }
  }
  return true
}

/** 保存创作理念到 <prompts 目录>/custom/{name}.json（私有，不进仓库） */
export function saveIdeologyFile(name: string, ideology: PromptIdeology, filePath = defaultPath): void {
  const safe = name.endsWith('.json') ? name : `${name}.json`
  const dir = join(dirname(filePath), 'custom')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, safe), `${JSON.stringify(ideology, null, 2)}\n`, 'utf8')
}

/** 列出 <prompts 目录>/custom/ 下的全部提示词文件（含各自内容），供编辑页下拉选择 */
export function listIdeologyFiles(filePath = defaultPath): Array<{ name: string; roleIdeals: string; directorIdeals: string }> {
  const dir = join(dirname(filePath), 'custom')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.json') && name !== 'active.json')
    .map(name => {
      const data = loadIdeologyFile(join(dir, name))
      return { name, roleIdeals: data.roleIdeals ?? '', directorIdeals: data.directorIdeals ?? '' }
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 读取任意 custom 提示词文件（按绝对路径） */
function loadIdeologyFile(path: string): PromptIdeology {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PromptIdeology
    return {
      ...(typeof parsed.roleIdeals === 'string' ? { roleIdeals: parsed.roleIdeals } : {}),
      ...(typeof parsed.directorIdeals === 'string' ? { directorIdeals: parsed.directorIdeals } : {}),
    }
  } catch {
    return {}
  }
}

/** 把 {roleIdeals}/{directorIdeals} 占位符换成私有理念；缺失则替换为空串（不留占位符泄漏） */
function applyIdeology(templates: PromptTemplates, ideology: PromptIdeology): void {
  templates.role.system = templates.role.system.replace('{roleIdeals}', ideology.roleIdeals ?? '')
  templates.skills.director = templates.skills.director.replace('{directorIdeals}', ideology.directorIdeals ?? '')
}

/** 加载提示词模板；可用环境变量 PROMPTS_FILE 指向自定义文件；自动合并私有创作理念 */
export function loadPrompts(filePath = process.env.PROMPTS_FILE ?? defaultPath): PromptTemplates {
  if (!existsSync(filePath)) throw new Error(`Prompts file not found: ${filePath}`)
  const templates = JSON.parse(readFileSync(filePath, 'utf8')) as PromptTemplates
  applyIdeology(templates, loadIdeology(filePath))
  return templates
}

/** 用 {占位符} 替换模板变量；未提供的占位符保留原样 */
export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] !== undefined ? values[key] : match)
}