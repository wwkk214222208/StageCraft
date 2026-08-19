import type { ThinkingStrength } from './types.ts'

/**
 * 模型家族识别与思维链参数映射。
 *
 * 本项目统一走 OpenAI 兼容 /chat/completions 格式，因此：
 * - DeepSeek / GLM / Gemini(OpenAI 兼容层) / OpenAI / Kimi K3 / 豆包 seed
 *   都能用 OpenAI 兼容字段注入（thinking 对象 / reasoning_effort）；
 * - Claude 原生 Messages API 的 thinking/output_config 参数在 OpenAI 兼容层
 *   下不可靠，命中 Claude 时走提示词引导；
 * - 匹配不上的家族同样走提示词引导。
 *
 * 强度档位：off / brief / standard / deep。
 */

export type ModelFamily = 'deepseek' | 'glm' | 'gemini' | 'openai' | 'claude' | 'kimi' | 'doubao' | 'unknown'

export interface ThinkingParams {
  /** 要合并进 /chat/completions 请求体的字段（OpenAI 兼容） */
  body?: Record<string, unknown>
  /** 匹配不上（或原生参数不可用）时附加到 system 提示词末尾的思考引导 */
  promptSuffix?: string
}

/** 按模型名识别家族（注意顺序：更具体的匹配在前） */
export function detectModelFamily(model: string): ModelFamily {
  const name = model.toLowerCase()
  if (/claude/.test(name)) return 'claude'
  if (/kimi/.test(name)) return 'kimi'
  if (/glm/.test(name)) return 'glm'
  if (/gemini/.test(name)) return 'gemini'
  if (/doubao|seed/.test(name)) return 'doubao'
  if (/deepseek/.test(name)) return 'deepseek'
  if (/gpt-|o1-|o3-|o4-|chatgpt|gpt\./.test(name)) return 'openai'
  return 'unknown'
}

export function familyLabel(family: ModelFamily): string {
  return { deepseek: 'DeepSeek', glm: 'GLM', gemini: 'Gemini', openai: 'OpenAI', claude: 'Claude', kimi: 'Kimi', doubao: '豆包/Seed', unknown: '未知（提示词引导）' }[family]
}

/** 匹配不上（或原生参数不可用）时的提示词引导 */
function promptGuidance(strength: ThinkingStrength): string {
  switch (strength) {
    case 'off': return '\n\n【思考控制】直接给出结果，不要输出任何分析或推理过程。'
    case 'brief': return '\n\n【思考控制】先在心里简要过一遍要点（一两句即可），然后直接输出结果，不要展开长分析。'
    case 'standard': return '\n\n【思考控制】先简要分析再回答，思考步骤保持精简。'
    case 'deep': return '\n\n【思考控制】请深入分析后再回答：拆解问题、核对事实与一致性、权衡取舍后给出结论。'
  }
}

/**
 * 根据模型家族与强度档位，生成 OpenAI 兼容请求体字段或提示词引导。
 * 各家族参数标准（官方文档确认）：
 * - DeepSeek：thinking 可关闭，开启时使用 high/max 两档 reasoning_effort
 * - GLM 5.2：thinking {type: enabled/disabled} + reasoning_effort max/xhigh/high/medium/low/minimal/none
 * - Gemini 3.x（OpenAI 兼容层）：reasoning_effort 自动映射 thinking_level（minimal/low/medium/high；2.5 可用 none 关）
 * - OpenAI GPT-5.6：reasoning_effort none/minimal/low/medium/high/xhigh/max（Chat Completions）
 * - Kimi K3：始终思考，顶层 reasoning_effort low/high/max（默认 max；无法关闭）
 * - 豆包/seed 2.1：thinking {type: enabled/disabled/auto}
 */
export function buildThinkingParams(model: string, strength: ThinkingStrength): ThinkingParams {
  const family = detectModelFamily(model)
  switch (family) {
    case 'deepseek':
      return off(strength)
        ? { body: { thinking: { type: 'disabled' } } }
        : { body: { thinking: { type: 'enabled' }, reasoning_effort: effort(strength, { brief: 'high', standard: 'high', deep: 'max' }) } }
    case 'glm':
      return off(strength)
        ? { body: { thinking: { type: 'disabled' } } }
        : { body: { thinking: { type: 'enabled' }, reasoning_effort: effort(strength, { brief: 'medium', standard: 'high', deep: 'max' }) } }
    case 'gemini':
      // OpenAI 兼容层自动映射 thinking_level；off 用 minimal（3.x 无法完全关闭，官方映射到各模型最低档）
      return { body: { reasoning_effort: effort(strength, { off: 'minimal', brief: 'low', standard: 'medium', deep: 'high' }) } }
    case 'openai':
      return { body: { reasoning_effort: effort(strength, { off: 'none', brief: 'low', standard: 'medium', deep: 'high' }) } }
    case 'kimi':
      // K3 始终思考、无法关闭：off 退化为最低档
      return { body: { reasoning_effort: effort(strength, { off: 'low', brief: 'low', standard: 'high', deep: 'max' }) } }
    case 'doubao':
      return off(strength)
        ? { body: { thinking: { type: 'disabled' } } }
        : { body: { thinking: { type: strength === 'brief' ? 'auto' : 'enabled' } } }
    case 'claude':
      // 原生 thinking/output_config 在 OpenAI 兼容层不可靠 → 提示词引导
      return { promptSuffix: promptGuidance(strength) }
    case 'unknown':
      return { promptSuffix: promptGuidance(strength) }
  }
}

function off(strength: ThinkingStrength): boolean {
  return strength === 'off'
}

function effort(strength: ThinkingStrength, table: Record<Exclude<ThinkingStrength, 'off'> | 'off', string>): string {
  return table[strength] ?? table.standard
}
