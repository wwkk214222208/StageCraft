/**
 * 桌面组合根接引导层的行为测试（§6.3/D2 + §7.4 存档依赖快照）。
 *
 * 验收锚点（定稿计划 阶段 1/5）：
 *  - 注入必失败插件 → 其余插件照常装载、主运行时照常启动、隔离记录经 /api/plugins 可见；
 *  - launch plan 持久化到独立 PluginConfigStore（data/plugins.json）；
 *  - 存档导出/保存写入插件依赖快照；/api/archive/check 只产出提示（不阻断，2026-09-01 拍板）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startTavern, type TavernApp } from '../src/app-boot.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

async function boot(options: { pluginInstallFault?: string } = {}): Promise<{ app: TavernApp; base: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'stagecraft-app-plugins-'))
  const app = await startTavern({
    root: repositoryRoot, dataDir: join(root, 'data'), saveRoot: join(root, 'save'), port: 0, host: '127.0.0.1',
    ...(options.pluginInstallFault ? { pluginInstallFault: options.pluginInstallFault } : {}),
  })
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
  return { app, base, root }
}

test('坏插件被隔离但主运行时照常启动：隔离记录经 /api/plugins 可见，其余插件 enabled', async () => {
  const { app, base, root } = await boot({ pluginInstallFault: 'stagecraft.human.http' })
  try {
    const state = await (await fetch(`${base}/api/plugins`)).json() as {
      plugins: Array<{ id: string; state: string; quarantine?: { reason: string; stage: string } }>
      report: { enabled: string[]; quarantined: Array<{ pluginId: string; stage: string }>; degraded: boolean }
    }
    assert.equal(state.report.degraded, true)
    const quarantined = state.report.quarantined
    assert.deepEqual(quarantined.map(record => record.pluginId), ['stagecraft.human.http'])
    assert.equal(quarantined[0]?.stage, 'install')
    assert.match(quarantined[0]?.reason ?? '', /注入的插件装载失败/)
    const human = state.plugins.find(plugin => plugin.id === 'stagecraft.human.http')
    assert.equal(human?.state, 'quarantined')
    assert.equal(state.plugins.find(plugin => plugin.id === 'stagecraft.solution')?.state, 'enabled', '其余插件不受隔离影响')

    // 隔离记录持久化（Core 未启动语义下仍可读写——D2 判据）
    const persisted = JSON.parse(readFileSync(join(root, 'data', 'plugins.json'), 'utf8')) as { quarantine: unknown[]; launchPlan: { pluginSetHash: string } }
    assert.equal(persisted.quarantine.length, 1)
    assert.ok(persisted.launchPlan.pluginSetHash)

    // /admin/plugins 页面可用（主服务器直接承载，非兜底也可访问）
    const page = await fetch(`${base}/admin/plugins`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /StageCraft 插件管理/)

    // 启用意图修改闭环：写配置 → 重生成 plan（提示重启，不做运行时装卸）
    const enable = await fetch(`${base}/api/plugins/enable`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'stagecraft.solution', enabled: false }) })
    assert.deepEqual(await enable.json(), { ok: true, restartRequired: true })
    const after = await (await fetch(`${base}/api/plugins`)).json() as { plugins: Array<{ id: string; state: string }> }
    assert.equal(after.plugins.find(plugin => plugin.id === 'stagecraft.solution')?.state, 'disabled')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('正常启动：launch plan 覆盖全部候选插件；存档导出/保存携带插件依赖快照；check 只提示不阻断', async () => {
  const { app, base, root } = await boot()
  try {
    const state = await (await fetch(`${base}/api/plugins`)).json() as { plugins: Array<{ id: string; state: string }>; report: { degraded: boolean; quarantined: unknown[] } }
    assert.equal(state.report.degraded, false)
    assert.equal(state.report.quarantined.length, 0)
    assert.equal(state.plugins.length, 4)

    // 存档导出：plugins 快照 = 导出时启用的插件集（§7.4）
    const exported = await (await fetch(`${base}/api/archive/export`)).json() as {
      version: number; room: unknown; plugins?: Array<{ id: string; version: string; manifestHash: string }>
    }
    assert.ok(Array.isArray(exported.plugins) && exported.plugins.length === 4, '启用插件集必须写入存档')
    assert.ok(exported.plugins.every(plugin => plugin.manifestHash && plugin.manifestHash !== 'unknown'))
    assert.ok(exported.plugins.some(plugin => plugin.id === 'stagecraft.solution'))

    // check：本地插件集 → 无警告；缺失插件 → 提示信息（不阻断）
    const okCheck = await (await fetch(`${base}/api/archive/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archive: exported }) })).json() as { recorded: boolean; message: string }
    assert.equal(okCheck.recorded, true)
    assert.equal(okCheck.message, '')
    const missingCheck = await (await fetch(`${base}/api/archive/check`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archive: { ...exported, plugins: [{ id: 'stagecraft.gone', version: '1.0.0', manifestHash: 'h' }] } }),
    })).json() as { recorded: boolean; missing: string[]; message: string }
    assert.deepEqual(missingCheck.missing, ['stagecraft.gone'])
    assert.match(missingCheck.message, /缺失/)

    // 保存存档 → 文件带 plugins；读档响应带 warning（服务端兜底提示）
    const save = await (await fetch(`${base}/api/archive/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'plugin-snapshot' }) })).json() as { ok: boolean; name: string }
    assert.equal(save.ok, true)
    const savePath = join(root, 'save', `${save.name}.json`)
    assert.ok(existsSync(savePath))
    const savedArchive = JSON.parse(readFileSync(savePath, 'utf8')) as { plugins?: unknown[] }
    assert.equal(savedArchive.plugins?.length, 4)
    const load = await (await fetch(`${base}/api/archive/load`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'plugin-snapshot' }),
    })).json() as { ok: boolean; warning?: string }
    assert.equal(load.ok, true)
    assert.equal(load.warning, undefined, '同环境读档不应产生插件警告')

    // 旧存档（无 plugins 字段）静默兼容
    const legacyCheck = await (await fetch(`${base}/api/archive/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archive: { version: 1, room: {} } }) })).json() as { recorded: boolean }
    assert.equal(legacyCheck.recorded, false)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})
