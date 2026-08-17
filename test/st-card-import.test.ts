import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeCharaText, extractCharaFromPng, importStCard, mapStCardToRole, parseStCharacterCard } from '../src/st-card-import.ts'

/** 构造含 `chara` tEXt 块的迷你 PNG（合法签名 + 单个文本块；tEXt 格式为 keyword + NUL + text） */
function pngWithChara(charaText: string): Uint8Array {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const keyword = Buffer.from('chara', 'latin1')
  const data = Buffer.concat([keyword, Buffer.from([0]), Buffer.from(charaText, 'latin1')])
  const chunk = Buffer.alloc(12 + data.length + 4)
  let offset = 0
  chunk.writeUInt32BE(data.length, offset); offset += 4
  chunk.write('tEXt', offset); offset += 4
  data.copy(chunk, offset); offset += data.length
  chunk.writeUInt32BE(0, offset) // CRC 占位（测试不校验）
  return Buffer.concat([signature, chunk])
}

const sampleCard = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  name: '测试角色',
  description: '一位谨慎的旅人。',
  personality: '沉默寡言，观察敏锐。',
  scenario: '在雨夜的旅店相遇。',
  first_mes: '*她抬起眼看向你* "要躲雨吗？"',
  system_prompt: '始终避免直接回答关于过去的问题。',
  post_history_instructions: '保持角色的疏离感。',
  tags: ['旅行者', '雨夜'],
  creator: 'test-author',
  character_book: { entries: [
    { keys: ['旅店', '雨夜'], content: '旅店名为「旧钟」，专门收留雨夜过客。', enabled: true, constant: false, name: '旧钟旅店' },
    { keys: ['秘密'], content: '她来自北方的废城。', enabled: false, name: '废弃条目' },
  ] },
}

test('解析标准 chara_card_v2 JSON', () => {
  const card = parseStCharacterCard(sampleCard as Record<string, unknown>)
  assert.equal(card.name, '测试角色')
  assert.equal(card.spec, 'chara_card_v2')
  assert.equal(card.firstMes, '*她抬起眼看向你* "要躲雨吗？"')
  assert.equal(card.bookEntries?.length, 2)
  assert.equal(card.bookEntries?.[0]?.enabled, true)
  assert.equal(card.bookEntries?.[1]?.enabled, false)
})

test('映射：selfModel 拼装 + 私有段 + 世界书过滤禁用条目', () => {
  const { role, lore, warnings } = mapStCardToRole(parseStCharacterCard(sampleCard as Record<string, unknown>))
  assert.equal(role.name, '测试角色')
  assert.ok(role.selfModel.includes('人物描述：一位谨慎的旅人。'))
  assert.ok(role.selfModel.includes('性格：沉默寡言，观察敏锐。'))
  assert.ok(role.selfModel.includes('===== ST 卡私有段 ====='))
  assert.ok(role.selfModel.includes('开场白参考'))
  assert.ok(role.selfModel.includes('剧情后续指令'))
  assert.equal(lore.length, 1) // 禁用条目被过滤
  assert.equal(lore[0]?.name, '旧钟旅店')
  assert.ok(warnings.length > 0)
})

test('PNG 内嵌卡：base64 编码的 chara 块可抽取并解析', () => {
  const png = pngWithChara(Buffer.from(JSON.stringify(sampleCard)).toString('base64'))
  const chara = extractCharaFromPng(png)
  assert.ok(chara)
  const parsed = decodeCharaText(chara)
  assert.equal(parsed.name, '测试角色')
})

test('JSON 内容直接导入为角色', () => {
  const result = importStCard(JSON.stringify(sampleCard), 'test.json')
  assert.equal(result.role.name, '测试角色')
  assert.ok(result.mapped.selfModelChars > 0)
  assert.equal(result.mapped.loreCount, 1)
  assert.equal(result.mapped.hasFirstMes, true)
})

test('PNG base64 内容经 importStCard 走 PNG 分支', () => {
  const png = pngWithChara(Buffer.from(JSON.stringify(sampleCard)).toString('base64'))
  const result = importStCard(png.toString('base64'), 'test.png')
  assert.equal(result.role.name, '测试角色')
})

test('普通 PNG（无 chara 块）导入报错', () => {
  const plain = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('no-chunk')])
  assert.throws(() => importStCard(plain.toString('base64'), 'image.png'), /没有找到角色卡数据/)
})

test('无效 JSON 报错', () => {
  assert.throws(() => importStCard('{ 这不是 JSON', 'card.json'), /JSON 角色卡解析失败/)
})