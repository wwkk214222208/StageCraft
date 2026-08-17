import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PromptTemplates {
  role: { system: string; user: string; retrySystem: string; retryUser: string; digestSystem: string; digestUser: string }
  director: { request: string; retrySystem: string; retryUser: string }
  consult: { user: string }
  skills: { director: string; consultation: string }
}

const defaultPath = join(fileURLToPath(new URL('..', import.meta.url)), 'prompts', 'prompts.json')

/** 加载提示词模板；可用环境变量 PROMPTS_FILE 指向自定义文件 */
export function loadPrompts(filePath = process.env.PROMPTS_FILE ?? defaultPath): PromptTemplates {
  if (!existsSync(filePath)) throw new Error(`Prompts file not found: ${filePath}`)
  return JSON.parse(readFileSync(filePath, 'utf8')) as PromptTemplates
}

/** 用 {占位符} 替换模板变量；未提供的占位符保留原样 */
export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] !== undefined ? values[key] : match)
}
