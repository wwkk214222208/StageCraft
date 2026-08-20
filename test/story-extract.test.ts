import assert from 'node:assert/strict'
import test from 'node:test'
import { createStoryExtractService, standaloneStoryExtractPlugin } from '../src/story-extract.ts'
import { createCordisRuntime } from '../src/cordis-runtime.ts'

test('standalone text extraction returns bounded reviewable candidates', async () => {
  const service = createStoryExtractService({ maxChars: 80, maxEntries: 2 })
  const result = await service.extract({ text: '角色：林舟\n设定：旧钟旅店属于北境。\n设定：她寻找银钥匙。\n<script>alert(1)</script>' })
  assert.equal(result.applied, false)
  assert.equal(result.roles.length, 0)
  assert.ok(result.diagnostics.some(item => item.code === 'unsafe.content'))
})

test('parsed synthetic ST card maps to validated candidates without private filesystem access', async () => {
  const service = createStoryExtractService()
  const result = await service.extract({ parsed: { spec: 'chara_card_v2', name: '合成角色', description: '谨慎的旅人', character_book: { entries: [{ name: '旧钟', content: '雨夜旅店。', enabled: true }] } } })
  assert.equal(result.source, 'st-card')
  assert.equal(result.roles[0]?.candidate, true)
  assert.equal(result.lore[0]?.candidate, true)
  assert.equal(result.applied, false)
})

test('model route is bounded, schema validated, and never auto-applies', async () => {
  let seen: unknown
  const service = createStoryExtractService()
  const result = await service.extract({ text: '角色：测试', requestModel: async request => {
    seen = request
    return { requestId: request.requestId, output: { roles: [{ id: 'r', name: '模型角色', portraitRef: '/assets/default.svg', currentState: '待确认', presence: 'present', memoryTimeline: {}, selfModel: '候选设定' }], lore: [] } }
  } })
  assert.equal(result.source, 'model')
  assert.equal(result.roles[0]?.name, '模型角色')
  assert.equal(result.applied, false)
  assert.equal((seen as { capability: string }).capability, 'story.extract')
})

test('Cordis plugin owns service lifecycle', async () => {
  const runtime = createCordisRuntime()
  const { service, plugin } = standaloneStoryExtractPlugin()
  await runtime.install(plugin)
  assert.equal(runtime.ctx.storyExtract, service)
  await runtime.dispose()
  await assert.rejects(() => service.extract({ text: '角色：已释放' }), /disposed/)
})
