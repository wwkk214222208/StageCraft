/**
 * W1-R CP-W1：NativeOperationRegistry 覆盖、目标暴露面不相交与 legacy 债务测试。
 *
 * 事实来源（穷举真实代码，不是 registry 自证）：
 *  - AndroidCompositionOperations.java 的 `"op".equals(operation)` 分派键（generic-dispatch 全集）；
 *  - NativeBridge.java 的 @JavascriptInterface 方法名（interface-method 全集）；
 *  - src/portable/android-local-core.ts 的 SYNC_OPERATIONS（WebView 侧同步操作白名单）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  NATIVE_OPERATIONS,
  assertDisjointExposure,
  coreNativeAllowlist,
  legacyMainCoreException,
  mainHostAllowlist,
} from '../src/native-operation-registry.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]) => readFileSync(path.join(ROOT, ...segments), 'utf8')

const registered = new Set(NATIVE_OPERATIONS.map(operation => operation.name))

test('目标暴露面不相交：core-native 与 main-host 两份 allowlist 无交集（Q9/CP-W1）', () => {
  assert.doesNotThrow(() => assertDisjointExposure())
  const coreNative = coreNativeAllowlist()
  const mainHost = mainHostAllowlist()
  assert.ok(coreNative.length >= 20, `core-native 应覆盖全部 Core 平台端口，实际 ${coreNative.length}`)
  assert.ok(mainHost.length >= 10, `main-host 应覆盖全部宿主端口，实际 ${mainHost.length}`)
  const overlap = coreNative.filter(name => mainHost.includes(name))
  assert.deepEqual(overlap, [], '目标 allowlist 交集必须为空')
})

test('Java invokeSync 分派键全部登记，且目标归属均为 core-native（穷举真实 dispatch key）', () => {
  const java = read('android', 'app', 'src', 'main', 'java', 'ai', 'stagecraft', 'android', 'AndroidCompositionOperations.java')
  const dispatched = [...new Set([...java.matchAll(/"([a-zA-Z][a-zA-Z0-9.]*)"\.equals\(operation\)/g)].map(match => match[1]))]
  assert.ok(dispatched.length >= 20, `Java 分派键应全部发现，实际 ${dispatched.length}`)
  const unregistered = dispatched.filter(name => !registered.has(name))
  assert.deepEqual(unregistered, [], `Java 新增了 registry 未登记的 operation：${unregistered.join(', ')}`)
  const mainHostSet = new Set(mainHostAllowlist())
  const misowned = dispatched.filter(name => {
    const operation = NATIVE_OPERATIONS.find(item => item.name === name)
    return !operation || operation.owner !== 'core-native' || mainHostSet.has(name)
  })
  assert.deepEqual(misowned, [], `真实 Java 分派键中存在目标归属非 core-native（或混入主暴露面）：${misowned.join(', ')}`)
})

test('legacy 债务如实登记：全部 Java 分派键今天仍可从主 WebView 通用入口到达，例外集合封闭', () => {
  const java = read('android', 'app', 'src', 'main', 'java', 'ai', 'stagecraft', 'android', 'AndroidCompositionOperations.java')
  const dispatched = [...new Set([...java.matchAll(/"([a-zA-Z][a-zA-Z0-9.]*)"\.equals\(operation\)/g)].map(match => match[1]))]
  const legacy = new Set(legacyMainCoreException())
  const notDebt = dispatched.filter(name => !legacy.has(name))
  assert.deepEqual(notDebt, [], `分派键 ${notDebt.join(', ')} 今天可从主 WebView 到达，必须登记为 legacy-main-core 债务`)
  // 封闭性：legacy 例外只允许 core-native generic-dispatch + 通用入口本身；
  // 通用入口必须写明 Gate D 强制移除（债务的清偿点是通用入口的跨 owner 调用拒绝）。
  for (const operation of NATIVE_OPERATIONS) {
    if (operation.legacyExposure !== 'legacy-main-core') continue
    if (operation.owner === 'core-native') {
      assert.equal(operation.surface, 'generic-dispatch', `${operation.name} 例外通道非法`)
    } else {
      assert.ok(['invokeSync', 'invokeAsync'].includes(operation.name), `${operation.name} 不得作为新增 legacy 例外`)
    }
  }
  const generic = NATIVE_OPERATIONS.filter(operation => ['invokeSync', 'invokeAsync'].includes(operation.name))
  assert.equal(generic.length, 2, '通用入口必须显式登记为 legacy-main-core 债务')
  for (const entry of generic) assert.match(entry.note ?? '', /Gate D/, `${entry.name} 必须写明 Gate D 强制移除`)
  assert.ok(NATIVE_OPERATIONS.every(operation => !operation.name.startsWith('legacy-')), '不得以改名方式逃避通用入口登记')
})

test('WebView 侧 SYNC_OPERATIONS 全部命中 core-native 目标归属', () => {
  const ts = read('src', 'portable', 'android-local-core.ts')
  const block = ts.match(/const SYNC_OPERATIONS = new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(block, 'SYNC_OPERATIONS 白名单必须存在')
  const ops = [...block![1].matchAll(/'([a-zA-Z][a-zA-Z0-9.]*)'/g)].map(match => match[1])
  assert.ok(ops.length >= 10, `SYNC_OPERATIONS 应全部发现，实际 ${ops.length}`)
  const coreNativeSet = new Set(coreNativeAllowlist())
  const misowned = ops.filter(name => !coreNativeSet.has(name))
  assert.deepEqual(misowned, [], `SYNC_OPERATIONS 中存在非 core-native 操作（Gate D 后 Java 分派层将拒绝）：${misowned.join(', ')}`)
})

test('NativeBridge @JavascriptInterface 方法全部登记为 main-host（interface-method 全集）', () => {
  const bridge = read('android', 'app', 'src', 'main', 'java', 'ai', 'stagecraft', 'android', 'NativeBridge.java')
  const methods = [...new Set([...bridge.matchAll(/@JavascriptInterface\s+public\s+\S+\s+(\w+)\(/g)].map(match => match[1]))]
  const coreNativeSet = new Set(coreNativeAllowlist())
  const unregistered = methods.filter(name => !registered.has(name))
  assert.deepEqual(unregistered, [], `主 WebView bridge 新增了 registry 未登记的方法：${unregistered.join(', ')}`)
  const misowned = methods.filter(name => {
    const operation = NATIVE_OPERATIONS.find(item => item.name === name)
    return !operation || operation.owner !== 'main-host' || coreNativeSet.has(name)
  })
  assert.deepEqual(misowned, [], `NativeBridge 存在非 main-host 方法（或混入 Core 暴露面）：${misowned.join(', ')}`)
})
