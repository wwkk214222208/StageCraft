import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/** 私有理念文件：<prompts 目录>/custom/ideology.json；不存在视为空 */
export function loadIdeology(filePath = defaultPath): PromptIdeology {
  const custom = join(join(dirname(filePath), 'custom'), 'ideology.json')
  if (!existsSync(custom)) return {}
  try {
    const parsed = JSON.parse(readFileSync(custom, 'utf8')) as PromptIdeology
    return {
      ...(typeof parsed.roleIdeals === 'string' ? { roleIdeals: parsed.roleIdeals } : {}),
      ...(typeof parsed.directorIdeals === 'string' ? { directorIdeals: parsed.directorIdeals } : {}),
    }
  } catch {
    return {}
  }
}

/** 保存创作理念到 <prompts 目录>/custom/ideology.json（私有，不进仓库） */
export function saveIdeology(ideology: PromptIdeology, filePath = defaultPath): void {
  const dir = join(dirname(filePath), 'custom')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ideology.json'), `${JSON.stringify(ideology, null, 2)}\n`, 'utf8')
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