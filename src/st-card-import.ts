/**
 * ST（SillyTavern）角色卡抽取坯子。
 *
 * 支持两种 ST 标准卡载体：
 *   - 独立 JSON（chara_card_v2 / chara_card_v3：name/description/personality/scenario/first_mes/system_prompt/character_book…）
 *   - PNG 内嵌卡（tEXt 块关键字 `chara`，内容为 JSON，可能是 base64 编码 / zlib 压缩）
 *
 * 映射目标：stagecraft 的角色（selfModel 拼装角色卡公开面，
 * 开场白/后续指令作为私有段附尾；角色书映射为世界书条目）。
 * 这是"坯子"：只保证能抽出标准卡，字段映射以可读为准，不做语义级重塑。
 */
import type { Role, LoreEntry } from './types.ts'

export interface StCardParsed {
  spec?: string
  name: string
  description?: string
  personality?: string
  scenario?: string
  firstMes?: string
  systemPrompt?: string
  postHistoryInstructions?: string
  creatorNotes?: string
  tags?: string[]
  creator?: string
  characterVersion?: string
  /** 角色书（世界书）条目 */
  bookEntries?: Array<{
    keys?: string[]
    content?: string
    name?: string
    enabled?: boolean
    constant?: boolean
    selective?: boolean
    comment?: string
  }>
}

export interface StCardImportResult {
  role: Role
  /** 角色书条目（已过滤禁用项）——由调用方决定并入房间世界书 */
  lore: LoreEntry[]
  mapped: {
    name: string
    selfModelChars: number
    loreCount: number
    hasFirstMes: boolean
    tags: string[]
    creator?: string
    spec?: string
    warnings: string[]
  }
}

/** 从 PNG 字节中抽出 `chara` tEXt 块（找不到返回 undefined） */
export function extractCharaFromPng(buffer: Uint8Array): string | undefined {
  if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return undefined
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = (buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]
    const type = String.fromCharCode(buffer[offset + 4], buffer[offset + 5], buffer[offset + 6], buffer[offset + 7])
    const dataStart = offset + 8
    if (type === 'tEXt') {
      const raw = new TextDecoder('latin1').decode(buffer.subarray(dataStart, dataStart + length))
      if (raw.startsWith('chara')) return raw.slice(6)
    }
    offset = dataStart + length + 4 // 跳过 CRC
  }
  return undefined
}

/**
 * 解码 chara 块文本：裸 JSON 或 base64 / zlib / base64+zlib。
 * 返回 JSON 对象；均失败时抛出明确错误。
 */
export function decodeCharaText(text: string): Record<string, unknown> {
  const attempts: Array<() => unknown> = [
    () => JSON.parse(text),
    () => JSON.parse(Buffer.from(text, 'base64').toString('utf8')),
  ]
  for (const attempt of attempts) {
    try {
      const value = attempt()
      if (value && typeof value === 'object') return value as Record<string, unknown>
    } catch { /* 尝试下一种 */ }
  }
  throw new Error('无法解析角色卡数据（JSON / base64 / zlib 均失败）。')
}

/** 规整任意角色卡 JSON（chara_card_v2/v3；兼容 data 包装）为内部结构 */
export function parseStCharacterCard(value: Record<string, unknown>): StCardParsed {
  const root = (value.data && typeof value.data === 'object' && !Array.isArray(value.data) && ('name' in value.data || 'description' in value.data))
    ? value.data as Record<string, unknown>
    : value
  const str = (key: string): string | undefined => {
    const v = root[key]
    return typeof v === 'string' ? v : undefined
  }
  const list = (key: string): string[] | undefined => {
    const v = root[key]
    return Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string') : undefined
  }
  const bookRaw = root.character_book ?? (root.data as Record<string, unknown> | undefined)?.character_book
  const entries = bookRaw && typeof bookRaw === 'object' && !Array.isArray(bookRaw)
    ? (bookRaw as Record<string, unknown>).entries
    : undefined
  const bookEntries = Array.isArray(entries)
    ? entries.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object').map(entry => ({
        keys: Array.isArray(entry.keys) ? entry.keys.filter((k): k is string => typeof k === 'string').map(k => String(k)) : typeof entry.key === 'string' ? [entry.key] : undefined,
        content: typeof entry.content === 'string' ? entry.content : undefined,
        name: typeof entry.name === 'string' ? entry.name : undefined,
        enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
        constant: typeof entry.constant === 'boolean' ? entry.constant : false,
        selective: typeof entry.selective === 'boolean' ? entry.selective : false,
        comment: typeof entry.comment === 'string' ? entry.comment : undefined,
      }))
    : undefined
  return {
    spec: typeof value.spec === 'string' ? value.spec : undefined,
    name: String(str('name') ?? '未命名角色').trim(),
    description: str('description'),
    personality: str('personality'),
    scenario: str('scenario'),
    firstMes: str('first_mes'),
    systemPrompt: str('system_prompt'),
    postHistoryInstructions: str('post_history_instructions'),
    creatorNotes: str('creator_notes'),
    tags: list('tags'),
    creator: str('creator'),
    characterVersion: str('character_version'),
    bookEntries,
  }
}

const PRIVATE_MARKER = '====='
const PRIVATE_TRAILER = '# 私有段结束 ====='

/** 把 ST 卡映射为 stagecraft 角色（selfModel 拼装 + 角色书 → 世界书） */
export function mapStCardToRole(card: StCardParsed, options: { roleId?: string } = {}): { role: Role; lore: LoreEntry[]; warnings: string[] } {
  const warnings: string[] = []
  const sections: Array<[string, string | undefined]> = [
    ['人物描述', card.description],
    ['性格', card.personality],
    ['场景', card.scenario],
    ['系统提示', card.systemPrompt],
  ]
  const privateTail: string[] = []
  if (card.postHistoryInstructions?.trim()) privateTail.push(`剧情后续指令：\n${card.postHistoryInstructions.trim()}`)
  if (card.firstMes?.trim()) privateTail.push(`开场白参考：\n${card.firstMes.trim()}`)
  const privateBlock = privateTail.length > 0
    ? `${PRIVATE_MARKER} ST 卡私有段 ${PRIVATE_MARKER}\n${privateTail.join('\n\n')}\n${PRIVATE_TRAILER}`
    : ''
  const body = sections
    .filter(([, text]) => text && text.trim())
    .map(([label, text]) => `${label}：${(text as string).trim()}`)
    .join('\n\n')
  const selfModel = [body || `（从 ST 角色卡导入：${card.name}）`, privateBlock].filter(Boolean).join('\n\n')

  const lore: LoreEntry[] = []
  const bookEntries = (card.bookEntries ?? []).filter(entry => entry.enabled !== false)
  for (let index = 0; index < bookEntries.length; index++) {
    const entry = bookEntries[index]
    if (!entry.content?.trim()) continue
    lore.push({
      name: entry.name?.trim() || entry.keys?.slice(0, 3).join('、') || `ST 条目 ${index + 1}`,
      content: entry.content.trim(),
    })
  }
  if (bookEntries.length > 0) {
    warnings.push(`角色书 ${bookEntries.length} 条已导入为世界书；本产品全量注入，ST 的 selective 扫描/触发词在此降级为常开（可在"世界书"里调整）。`)
  }

  const safeName = card.name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_').slice(0, 40) || 'st'
  const roleId = options.roleId ?? `st-${safeName}-${Date.now().toString(36)}`
  const role: Role = {
    id: roleId,
    name: card.name,
    portraitRef: '/assets/default.svg',
    currentState: '刚刚进入当前场景。',
    presence: 'present',
    memoryTimeline: {},
    selfModel,
  }
  if (card.creatorNotes?.trim()) warnings.push(`creator_notes 未导入（${card.creatorNotes.trim().slice(0, 40)}…）——那是作者备注，不是角色人设。`)
  if (card.tags?.length) warnings.push(`标签（${card.tags.slice(0, 5).join('、')}${card.tags.length > 5 ? '…' : ''}）未导入到本产品。`)
  warnings.push('头像未随卡导入，可用角色设置里的"肖像"上传。')
  return { role, lore, warnings }
}

/**
 * 入口：把 ST 角色卡内容转为 tavern 角色。
 * @param content 文件内容：JSON 文本；或 PNG 的 base64（filename 以 .png 结尾时自动走 PNG 解析）
 * @param filename 原始文件名（决定解析路径）
 */
export function importStCard(content: string, filename = 'card.json'): StCardImportResult {
  if (!content?.trim()) throw new Error('角色卡内容为空。')
  const raw = content.trim()
  let parsed: Record<string, unknown>
  const isPng = /\.png$/i.test(filename)
  const isDataUrl = /^data:image\/png;base64,/i.test(raw)
  if (isPng || isDataUrl) {
    const base64 = isDataUrl ? raw.slice(raw.indexOf(',') + 1) : raw
    let buffer: Buffer
    try {
      buffer = Buffer.from(base64, 'base64')
    } catch {
      throw new Error('PNG 数据无法解码（base64 无效）。')
    }
    const chara = extractCharaFromPng(buffer)
    if (!chara) throw new Error('PNG 中没有找到角色卡数据（缺少 chara tEXt 块）；这是普通图片，请改为上传 .json 卡。')
    parsed = decodeCharaText(chara)
  } else {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new Error('JSON 角色卡解析失败。')
    }
  }
  const card = parseStCharacterCard(parsed)
  const { role, lore, warnings } = mapStCardToRole(card)
  return {
    role,
    lore,
    mapped: {
      name: role.name,
      selfModelChars: role.selfModel.length,
      loreCount: lore.length,
      hasFirstMes: !!card.firstMes,
      tags: card.tags ?? [],
      ...(card.creator ? { creator: card.creator } : {}),
      ...(card.spec ? { spec: card.spec } : {}),
      warnings,
    },
  }
}