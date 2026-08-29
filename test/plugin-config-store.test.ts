/**
 * W3 评审修订：PluginConfigStore 实际实现测试（阶段 1 验收锚点——Core 不可用时配置仍可读写）。
 * store 不得依赖 Core runtime：整条链路无 Core 参与。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInMemoryPluginConfigStore, createNodeFilePluginConfigStore } from '../src/plugin-config-store.ts'
import { buildPluginLaunchPlan } from '../src/plugin-bootstrap.ts'
import type { PluginConfigStore, PluginManifest } from '../src/plugin-contract.ts'

const manifest: PluginManifest = { id: 'stagecraft.base', version: '1.0.0', kind: 'solution', title: '基础插件' }

async function roundtrip(store: PluginConfigStore): Promise<void> {
  store.writeEnabled('stagecraft.base', false)
  store.writeEnabled('stagecraft.other', true)
  store.writeConfig('stagecraft.base', { threshold: 3 })
  const quarantine = [{ pluginId: 'stagecraft.bad', manifestVersion: '1.0.0', manifestHash: 'h', reason: 'install 抛错', stage: 'install' as const, at: new Date(0).toISOString() }]
  store.writeQuarantine(quarantine)
  const plan = buildPluginLaunchPlan({ manifests: [manifest], desiredEnabled: { 'stagecraft.base': false }, stateSchemaVersion: 's1' })
  store.writeLaunchPlan(plan)

  assert.deepEqual(store.readEnabled(), { 'stagecraft.base': false, 'stagecraft.other': true })
  assert.deepEqual(store.readConfig(), { 'stagecraft.base': { threshold: 3 } })
  assert.deepEqual(store.readQuarantine(), quarantine)
  assert.deepEqual(store.readLaunchPlan(), plan)
}

test('InMemoryPluginConfigStore：配置/启用/隔离/launch plan 全部可读写且互不影响', async () => {
  await roundtrip(createInMemoryPluginConfigStore())
})

test('Node 文件 PluginConfigStore：跨实例持久化、原子替换写、Core 完全不参与', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'plugin-store-'))
  try {
    const filePath = path.join(directory, 'plugin-config.json')
    const first = createNodeFilePluginConfigStore(filePath)
    await roundtrip(first)

    // 模拟 Core 不可用：新实例直接从文件读取（无任何 Core 调用）
    const second = createNodeFilePluginConfigStore(filePath)
    assert.equal(second.readEnabled()['stagecraft.base'], false)
    assert.equal(second.readLaunchPlan()?.pluginSetHash, first.readLaunchPlan()?.pluginSetHash)

    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { formatVersion: number; enabled: Record<string, boolean> }
    assert.equal(onDisk.formatVersion, 1)
    assert.equal(onDisk.enabled['stagecraft.base'], false)
    assert.ok(!filePath.endsWith('.tmp'), '不得遗留临时文件')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Node 文件 PluginConfigStore：损坏文件兜底为空状态并回调 onCorrupt，不抛出', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'plugin-store-'))
  try {
    const filePath = path.join(directory, 'plugin-config.json')
    writeFileSync(filePath, '{ 半截 JSON', 'utf8')
    let corrupted = false
    const store = createNodeFilePluginConfigStore(filePath, { onCorrupt: () => { corrupted = true } })
    assert.deepEqual(store.readEnabled(), {}, '损坏时以空状态起步，管理器仍可用')
    assert.equal(corrupted, true)
    // 首次写入即重建合法文件
    store.writeEnabled('stagecraft.base', true)
    assert.equal(createNodeFilePluginConfigStore(filePath).readEnabled()['stagecraft.base'], true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
