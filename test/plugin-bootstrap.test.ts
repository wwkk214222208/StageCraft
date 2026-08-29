/**
 * W3：插件与存档地基测试（计划 §6.1–6.3、§7.4、阶段 1 验收）。
 *
 * 验收锚点：Core 完全不可用时配置层不受影响（类型纯度）；坏插件被隔离且不阻断其他可选插件；
 * 缺必需插件的存档只能进入恢复/只读；launch plan 确定且不可变。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bootstrapPlugins,
  buildPluginLaunchPlan,
  checkProvidesConflicts,
  computePluginSetHash,
  manifestHash,
  resolveLoadOrder,
  stableHash,
  stableStringify,
  validateArchiveDependencies,
  validateManifest,
} from '../src/plugin-bootstrap.ts'
import type { PluginDependencySnapshot, PluginLaunchPlan, PluginManifest } from '../src/plugin-contract.ts'

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return { id: 'stagecraft.base', version: '1.0.0', kind: 'solution', title: '基础插件', ...overrides }
}

test('manifest 校验：id/version/kind/provides 形状错误逐项报出', () => {
  assert.deepEqual(validateManifest(manifest()), [])
  const errors = validateManifest(manifest({ id: 'bad', version: 'v1', kind: 'unknown' as PluginManifest['kind'], title: '', provides: { stateModules: ['ok', 1 as unknown as string] } }))
  assert.equal(errors.length, 5, errors.join('；'))
})

test('manifestHash 确定性：键序无关、宿主无关，内容变化即变化', () => {
  const a = manifest({ provides: { stateModules: ['m1'] }, author: 'x' })
  const b = { author: 'x', provides: { stateModules: ['m1'] }, title: '基础插件', kind: 'solution', version: '1.0.0', id: 'stagecraft.base' } as unknown as PluginManifest
  assert.equal(manifestHash(a), manifestHash(b), '键序不同内容相同 → 同 hash')
  assert.notEqual(manifestHash(a), manifestHash(manifest({ version: '1.0.1' })))
  assert.equal(stableHash('stagecraft'), stableHash('stagecraft'))
  assert.equal(stableStringify({ b: 2, a: [1, { d: 4, c: 3 }] }), '{"a":[1,{"c":3,"d":4}],"b":2}')
})

test('依赖拓扑：被依赖者先装载；成环时 bootstrap 全部隔离且不装载', () => {
  const order = resolveLoadOrder([
    manifest({ id: 'stagecraft.app', requires: { plugins: ['stagecraft.core'] } }),
    manifest({ id: 'stagecraft.core' }),
  ])
  assert.deepEqual(order.map(item => item.id), ['stagecraft.core', 'stagecraft.app'])

  const cycle = bootstrapPlugins({
    manifests: [
      manifest({ id: 'stagecraft.a', requires: { plugins: ['stagecraft.b'] } }),
      manifest({ id: 'stagecraft.b', requires: { plugins: ['stagecraft.a'] } }),
    ],
    install: () => assert.fail('成环时不得触发 install'),
  })
  assert.equal(cycle.report.degraded, true)
  assert.deepEqual(cycle.report.enabled, [])
  assert.ok(cycle.report.quarantined.every(record => record.stage === 'dependency'))
  assert.match(cycle.report.quarantined[0].reason, /依赖成环/)
})

test('provides 冲突预检：同 id 双声明 → 双方隔离，其他插件继续', () => {
  assert.deepEqual(checkProvidesConflicts([manifest(), manifest({ id: 'stagecraft.other' })]).length, 0)
  const result = bootstrapPlugins({
    manifests: [
      manifest({ id: 'stagecraft.p1', provides: { stateModules: ['shared'] } }),
      manifest({ id: 'stagecraft.p2', provides: { stateModules: ['shared'] } }),
      manifest({ id: 'stagecraft.ok' }),
    ],
    install: () => undefined,
  })
  assert.deepEqual(result.report.enabled, ['stagecraft.ok'])
  assert.deepEqual(result.report.quarantined.map(record => record.pluginId).sort(), ['stagecraft.p1', 'stagecraft.p2'])
  assert.ok(result.report.quarantined.every(record => record.stage === 'dependency' && record.reason.includes('provides')))
})

test('单插件 install 抛错只隔离该插件，其余继续装载（§6.3）', () => {
  const result = bootstrapPlugins({
    manifests: [manifest({ id: 'stagecraft.good' }), manifest({ id: 'stagecraft.bad' }), manifest({ id: 'stagecraft.good2', requires: { plugins: ['stagecraft.good'] } })],
    install: candidate => {
      if (candidate.id === 'stagecraft.bad') throw new Error('install 爆炸')
      return { dispose: () => undefined }
    },
  })
  assert.deepEqual(result.report.enabled, ['stagecraft.good', 'stagecraft.good2'], '依赖 good 的 good2 不受 bad 隔离影响')
  const record = result.report.quarantined.find(item => item.pluginId === 'stagecraft.bad')
  assert.equal(record?.stage, 'install')
  assert.equal(record?.reason, 'install 爆炸')
  assert.equal(result.report.degraded, true)
  assert.equal(result.disposables.length, 2)
})

test('desiredEnabled=false → disabled（不装载、不隔离）；coreApi 不匹配 → dependency 隔离', () => {
  const result = bootstrapPlugins({
    manifests: [manifest({ id: 'stagecraft.off' }), manifest({ id: 'stagecraft.old', requires: { coreApi: '1.0' } })],
    desiredEnabled: { 'stagecraft.off': false },
    coreApiVersion: '1.1',
    install: () => undefined,
  })
  assert.deepEqual(result.report.disabled, ['stagecraft.off'])
  assert.deepEqual(result.report.enabled, [])
  assert.equal(result.report.quarantined[0].pluginId, 'stagecraft.old')
  assert.match(result.report.quarantined[0].reason, /coreApi 不匹配/)
})

test('PluginLaunchPlan：确定、不可变、排除隔离插件、hash 随启用集变化', () => {
  const manifests = [manifest({ id: 'stagecraft.a' }), manifest({ id: 'stagecraft.b', version: '2.1.0' })]
  const plan = buildPluginLaunchPlan({ manifests, desiredEnabled: { 'stagecraft.b': false }, quarantinedIds: ['stagecraft.c'], stateSchemaVersion: 's1' })
  assert.equal(Object.isFrozen(plan), true)
  assert.ok(plan.plugins.every(plugin => Object.isFrozen(plugin)))
  assert.equal(plan.protocolVersion, '1.1')

  const again = buildPluginLaunchPlan({ manifests, desiredEnabled: { 'stagecraft.b': false }, quarantinedIds: ['stagecraft.c'], stateSchemaVersion: 's1' })
  assert.equal(computePluginSetHash(plan), computePluginSetHash(again))

  const enabledChanged = buildPluginLaunchPlan({ manifests, stateSchemaVersion: 's1' })
  assert.notEqual(plan.pluginSetHash, enabledChanged.pluginSetHash, '启用集变化必须改变 pluginSetHash（重启握手校验依据）')
  assert.equal(plan.plugins.find(plugin => plugin.id === 'stagecraft.b')?.enabled, false)
  assert.equal(enabledChanged.plugins.find(plugin => plugin.id === 'stagecraft.b')?.enabled, true)

  const quarantined = buildPluginLaunchPlan({ manifests, quarantinedIds: ['stagecraft.a'], stateSchemaVersion: 's1' })
  assert.equal(quarantined.plugins.find(plugin => plugin.id === 'stagecraft.a')?.enabled, false, '被隔离插件不进入 enabled 集')
})

test('存档依赖判定：全存在 ok；可选缺失 degraded；必需缺失或 schema 不兼容 blocked（§7.4）', () => {
  const available = [
    manifest({ id: 'stagecraft.core', version: '1.2.0', stateSchemaVersion: 's1' }),
    manifest({ id: 'stagecraft.optional', version: '1.0.0' }),
  ]
  const ok = validateArchiveDependencies(
    [{ id: 'stagecraft.core', version: '1.0.0', manifestHash: 'h' }],
    available,
  )
  assert.equal(ok.verdict, 'ok')

  const degraded = validateArchiveDependencies(
    [{ id: 'stagecraft.core', version: '1.0.0', manifestHash: 'h' }, { id: 'stagecraft.optional', version: '1.0.0', manifestHash: 'h', required: false }],
    [available[0]],
  )
  assert.equal(degraded.verdict, 'degraded')
  assert.deepEqual(degraded.missing, ['stagecraft.optional'])

  const blocked = validateArchiveDependencies(
    [
      { id: 'stagecraft.core', version: '1.0.0', manifestHash: 'h', stateSchemaVersion: 's2' },
      { id: 'stagecraft.gone', version: '1.0.0', manifestHash: 'h' },
    ] satisfies PluginDependencySnapshot[],
    available,
  )
  assert.equal(blocked.verdict, 'blocked')
  if (blocked.verdict === 'blocked') {
    assert.deepEqual(blocked.missing, ['stagecraft.gone'])
    assert.match(blocked.reason, /禁止产生新剧情/)
  }
})

test('launch plan 形状符合 §2.4 契约（供 Java/数据面 fixture 复用）', () => {
  const plan: PluginLaunchPlan = buildPluginLaunchPlan({ manifests: [manifest()], stateSchemaVersion: 's1' })
  assert.deepEqual(
    Object.keys(plan).sort(),
    ['pluginSetHash', 'plugins', 'protocolVersion', 'stateSchemaVersion'],
  )
  assert.deepEqual(Object.keys(plan.plugins[0]).sort(), ['enabled', 'id', 'manifestHash', 'version'], 'config 未配置时省略键（与 JSON 持久化形状一致）')

  const withConfig = buildPluginLaunchPlan({ manifests: [manifest()], stateSchemaVersion: 's1', config: { 'stagecraft.base': { threshold: 3 } } })
  assert.deepEqual(withConfig.plugins[0].config, { threshold: 3 })
})

test('反例（评审修订）：依赖缺失的插件不得安装，必须 dependency 隔离', () => {
  const result = bootstrapPlugins({
    manifests: [manifest({ id: 'stagecraft.app', requires: { plugins: ['stagecraft.missing'] } })],
    install: () => assert.fail('依赖缺失时不得触发 install'),
  })
  assert.deepEqual(result.report.enabled, [])
  const record = result.report.quarantined[0]
  assert.equal(record.stage, 'dependency')
  assert.match(record.reason, /依赖缺失：stagecraft.missing/)
})

test('反例（评审修订）：依赖被禁用 / 被隔离 / install 失败，依赖者都不得安装', () => {
  const disabled = bootstrapPlugins({
    manifests: [
      manifest({ id: 'stagecraft.dep' }),
      manifest({ id: 'stagecraft.app', requires: { plugins: ['stagecraft.dep'] } }),
    ],
    desiredEnabled: { 'stagecraft.dep': false },
    install: candidate => { assert.notEqual(candidate.id, 'stagecraft.app', '依赖被禁用时不得安装依赖者'); return undefined },
  })
  assert.deepEqual(disabled.report.enabled, [])
  assert.match(disabled.report.quarantined[0].reason, /依赖被禁用/)

  const failed = bootstrapPlugins({
    manifests: [
      manifest({ id: 'stagecraft.dep' }),
      manifest({ id: 'stagecraft.app', requires: { plugins: ['stagecraft.dep'] } }),
    ],
    install: candidate => { if (candidate.id === 'stagecraft.dep') throw new Error('install 失败'); return undefined },
  })
  assert.deepEqual(failed.report.enabled, [])
  const record = failed.report.quarantined.find(item => item.pluginId === 'stagecraft.app')
  assert.match(record?.reason ?? '', /依赖未装载成功（被隔离或 install 失败）：stagecraft.dep/)

  const quarantined = bootstrapPlugins({
    manifests: [
      manifest({ id: 'stagecraft.dep', version: 'bad-version' }),
      manifest({ id: 'stagecraft.app', requires: { plugins: ['stagecraft.dep'] } }),
    ],
    install: candidate => { if (candidate.id === 'stagecraft.dep') return undefined; return assert.fail('不可达') },
  })
  assert.deepEqual(quarantined.report.enabled, [], 'manifest 校验失败被隔离的依赖同样阻断依赖者')
})

test('反例（评审修订）：被禁用插件不参与 provides 冲突，正常插件不受误伤', () => {
  const result = bootstrapPlugins({
    manifests: [
      manifest({ id: 'stagecraft.enabled', provides: { stateModules: ['shared'] } }),
      manifest({ id: 'stagecraft.disabled', provides: { stateModules: ['shared'] } }),
    ],
    desiredEnabled: { 'stagecraft.disabled': false },
    install: () => undefined,
  })
  assert.deepEqual(result.report.enabled, ['stagecraft.enabled'], '禁用方声明冲突不得隔离启用方')
  assert.deepEqual(result.report.quarantined, [])
})

test('反例（评审修订）：存档版本必须比较——主版本不同 / 降级装载 / schema 未声明都判 blocked', () => {
  const current = [manifest({ id: 'stagecraft.core', version: '1.2.0', stateSchemaVersion: 's1' })]
  assert.equal(validateArchiveDependencies([{ id: 'stagecraft.core', version: '1.0.0', manifestHash: 'h' }], current).verdict, 'ok')
  assert.equal(validateArchiveDependencies([{ id: 'stagecraft.core', version: '1.2.0', manifestHash: 'h' }], current).verdict, 'ok', '完全同版本兼容')
  assert.equal(validateArchiveDependencies([{ id: 'stagecraft.core', version: '2.0.0', manifestHash: 'h' }], current).verdict, 'blocked', '主版本不同不兼容')
  assert.equal(validateArchiveDependencies([{ id: 'stagecraft.core', version: '1.5.0', manifestHash: 'h' }], current).verdict, 'blocked', '存档高于当前（降级装载）不兼容')
  assert.equal(
    validateArchiveDependencies([{ id: 'stagecraft.core', version: '1.0.0', manifestHash: 'h', stateSchemaVersion: 's9' }], [manifest({ id: 'stagecraft.core', version: '1.2.0' })]).verdict,
    'blocked',
    '存档声明 schema 而当前未声明 → 无法证明兼容',
  )
  assert.equal(validateArchiveDependencies([{ id: 'stagecraft.core', version: '1.0.0', manifestHash: 'h' }], [manifest({ id: 'stagecraft.core', version: '1.2.0' })]).verdict, 'ok', '存档未声明 schema 时不追加约束')
})
