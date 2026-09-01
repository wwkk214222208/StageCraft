/**
 * 插件管理层测试（D2：独立于 Core；计划 §6.3/阶段 5 + 2026-09-01 拍板的存档提示语义）。
 *
 * 覆盖：
 *  - PluginAdminService 聚合（quarantined > disabled > enabled）、setEnabled 校验与 launch plan 重生成；
 *  - 存档依赖建议：只产出提示信息，缺失/不兼容都不阻断（用户拍板：不做强制放行校验）；
 *  - handlePluginAdminApi 路由形状（页面/列表/启用/未匹配）；
 *  - 兜底服务器真实监听：Core 未启动语义下仍可读写配置（D2 判据）；
 *  - 依赖边界：兜底链（plugin-fallback-server/plugin-admin/plugin-config-store/plugin-manifests）
 *    不得 import 主运行时（app-boot/store/core runtime/room-runtime）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { PluginAdminService, desktopPluginConfigFilePath, handlePluginAdminApi, pluginAdminPageHtml, PLUGIN_ADMIN_PAGE_PATH } from '../src/plugin-admin.ts'
import { createInMemoryPluginConfigStore } from '../src/plugin-config-store.ts'
import { DESKTOP_BUILTIN_PLUGIN_MANIFESTS } from '../src/plugin-manifests.ts'
import { startPluginFallbackServer } from '../src/plugin-fallback-server.ts'
import type { QuarantineRecord } from '../src/plugin-contract.ts'

function service(): PluginAdminService {
  return new PluginAdminService(createInMemoryPluginConfigStore(), DESKTOP_BUILTIN_PLUGIN_MANIFESTS)
}

function quarantineRecord(pluginId: string): QuarantineRecord {
  return { pluginId, manifestVersion: '1.0.0', manifestHash: 'deadbeef', reason: '测试隔离', stage: 'install', at: '2026-09-01T00:00:00.000Z' }
}

test('PluginAdminService.list：缺省全启用；quarantined > disabled > enabled', () => {
  const admin = service()
  const states = new Map(admin.list().map(record => [record.id, record.state]))
  assert.equal(states.size, DESKTOP_BUILTIN_PLUGIN_MANIFESTS.length)
  assert.ok([...states.values()].every(state => state === 'enabled'))
  const solution = admin.list().find(record => record.id === 'stagecraft.solution')
  assert.equal(solution?.title, 'StageCraft Solution（Chat/Director/Management）')
  assert.equal(solution?.kind, 'solution')
  assert.ok(solution?.capabilities?.includes('workflow.register'))

  const disabledStore = createInMemoryPluginConfigStore()
  disabledStore.writeEnabled('stagecraft.solution', false)
  disabledStore.writeQuarantine([quarantineRecord('stagecraft.core')])
  const aggregated = new PluginAdminService(disabledStore, DESKTOP_BUILTIN_PLUGIN_MANIFESTS)
  assert.equal(aggregated.list().find(record => record.id === 'stagecraft.solution')?.state, 'disabled')
  const quarantined = aggregated.list().find(record => record.id === 'stagecraft.core')
  assert.equal(quarantined?.state, 'quarantined')
  assert.equal(quarantined?.quarantine?.reason, '测试隔离')
})

test('setEnabled：校验候选集 id、重生成 launch plan、quarantined 覆盖 desired', () => {
  const store = createInMemoryPluginConfigStore()
  const admin = new PluginAdminService(store, DESKTOP_BUILTIN_PLUGIN_MANIFESTS)
  assert.throws(() => admin.setEnabled('stagecraft.missing', false), /不在候选集内/)
  const result = admin.setEnabled('stagecraft.solution', false)
  assert.deepEqual(result, { ok: true, restartRequired: true })
  assert.equal(store.readEnabled()['stagecraft.solution'], false)
  const plan = store.readLaunchPlan()
  assert.ok(plan, 'setEnabled 必须重生成并持久化 launch plan')
  assert.equal(plan?.plugins.find(plugin => plugin.id === 'stagecraft.solution')?.enabled, false)
  const hashBefore = plan?.pluginSetHash
  admin.setEnabled('stagecraft.solution', true)
  assert.notEqual(store.readLaunchPlan()?.pluginSetHash, hashBefore, '启用集变化必须改变 pluginSetHash')
})

test('archiveDependencyAdvice：只提示不阻断；旧存档（无 plugins 字段）不提示', () => {
  const admin = service()
  const old = admin.archiveDependencyAdvice(undefined)
  assert.equal(old.recorded, false)
  assert.equal(old.message, '')

  const empty = admin.archiveDependencyAdvice([])
  assert.equal(empty.recorded, false)

  const current = admin.archiveDependencyAdvice(DESKTOP_BUILTIN_PLUGIN_MANIFESTS.map(manifest => ({
    id: manifest.id, version: manifest.version, manifestHash: 'h',
  })))
  assert.equal(current.recorded, true)
  assert.equal(current.message, '')

  const missing = admin.archiveDependencyAdvice([
    { id: 'stagecraft.solution', version: '1.0.0', manifestHash: 'h' },
    { id: 'stagecraft.gone', version: '1.0.0', manifestHash: 'h' },
    { id: 'stagecraft.core', version: '2.0.0', manifestHash: 'h' },
  ])
  assert.equal(missing.recorded, true)
  assert.ok(missing.missing.includes('stagecraft.gone'))
  assert.ok(missing.incompatible.some(entry => entry.startsWith('stagecraft.core')))
  assert.match(missing.message, /缺失/)
  assert.match(missing.message, /不兼容/)
  // 提示语义（2026-09-01 拍板）：只产出信息，没有"禁止产生新剧情"式的放行门
  assert.ok(!/禁止/.test(missing.message))
})

test('handlePluginAdminApi：页面/列表/启用的响应形状；未匹配返回 undefined', () => {
  const admin = service()
  const page = handlePluginAdminApi(admin, { method: 'GET', pathname: PLUGIN_ADMIN_PAGE_PATH })
  assert.equal(page?.status, 200)
  assert.equal(page?.body, pluginAdminPageHtml())

  const list = handlePluginAdminApi(admin, { method: 'GET', pathname: '/api/plugins' })
  assert.equal(list?.status, 200)
  const state = list?.body as { plugins: unknown[]; report: unknown; pluginSetHash: string }
  assert.equal(state.plugins.length, DESKTOP_BUILTIN_PLUGIN_MANIFESTS.length)
  assert.equal(state.report, null, '兜底入口未跑 bootstrap → report 为 null')

  const enable = handlePluginAdminApi(admin, { method: 'POST', pathname: '/api/plugins/enable', body: { id: 'stagecraft.core', enabled: false } })
  assert.equal(enable?.status, 200)
  assert.deepEqual(enable?.body, { ok: true, restartRequired: true })

  const invalid = handlePluginAdminApi(admin, { method: 'POST', pathname: '/api/plugins/enable', body: { id: 'nope', enabled: true } })
  assert.equal(invalid?.status, 400)

  assert.equal(handlePluginAdminApi(admin, { method: 'GET', pathname: '/api/other' }), undefined)
})

test('desktopPluginConfigFilePath：userDataRoot 优先，其次 dataDir，缺省 root/data', () => {
  assert.equal(desktopPluginConfigFilePath({ root: 'R', userDataRoot: 'U', dataDir: 'D' }), join('U', 'data', 'plugins.json'))
  assert.equal(desktopPluginConfigFilePath({ root: 'R', dataDir: 'D' }), join('D', 'plugins.json'))
  assert.equal(desktopPluginConfigFilePath({ root: 'R' }), join('R', 'data', 'plugins.json'))
})

test('兜底服务器（Core 未启动语义）：真实监听 + 配置可读写（D2 判据）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-plugin-fallback-'))
  const server = await startPluginFallbackServer({ root, dataDir: join(root, 'data'), port: 0 })
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const redirect = await fetch(`${base}/`, { redirect: 'manual' })
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), '/admin/plugins')

    const page = await fetch(`${base}/admin/plugins`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /StageCraft 插件管理/)

    const list = await fetch(`${base}/api/plugins`)
    assert.equal(list.status, 200)
    const state = await list.json() as { plugins: Array<{ id: string; state: string }> }
    assert.equal(state.plugins.length, DESKTOP_BUILTIN_PLUGIN_MANIFESTS.length)

    const enable = await fetch(`${base}/api/plugins/enable`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'stagecraft.solution', enabled: false }) })
    assert.equal(enable.status, 200)
    const after = await (await fetch(`${base}/api/plugins`)).json() as { plugins: Array<{ id: string; state: string }> }
    assert.equal(after.plugins.find(plugin => plugin.id === 'stagecraft.solution')?.state, 'disabled')

    const missing = await fetch(`${base}/api/room`)
    assert.equal(missing.status, 404, '兜底服务器不承载业务路由')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})

test('依赖边界（D2）：兜底链不得 import 主运行时模块', () => {
  const moduleRoot = fileURLToPath(new URL('../src/', import.meta.url))
  const chain = ['plugin-fallback-server.ts', 'plugin-admin.ts', 'plugin-config-store.ts', 'plugin-manifests.ts']
  const forbidden: Array<[RegExp, string]> = [
    [/from '\.\/app-boot\.ts'/, 'app-boot'],
    [/from '\.\.\/src\/app-boot\.ts'/, 'app-boot'],
    [/from '\.\/store\.ts'/, 'store'],
    [/from '\.\/room-runtime\.ts'/, 'room-runtime'],
    [/core\/runtime\.ts/, 'core runtime'],
    [/core\/container\.ts/, 'core container'],
    [/core\/solutions\.ts/, 'core solutions'],
    [/from '\.\/stagecraft-/, 'store-backed 领域服务'],
    [/from '\.\/server\.ts'/, 'server 入口'],
  ]
  for (const file of chain) {
    const source = readFileSync(`${moduleRoot}${file}`, 'utf8')
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} 不得依赖主运行时（${label}）`)
    }
  }
})
