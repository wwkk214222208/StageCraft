/**
 * W1（Q9 裁决）：NativeOperationRegistry 覆盖与暴露面不相交测试。
 *
 * 事实来源：
 *  - AndroidCompositionOperations.java 的 `"op".equals(operation)` 分派键（generic-dispatch 全集）；
 *  - NativeBridge.java 的 @JavascriptInterface 方法名（interface-method 全集）；
 *  - src/portable/android-local-core.ts 的 SYNC_OPERATIONS（WebView 侧同步操作白名单）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { NATIVE_OPERATIONS, assertDisjointExposure, nativeOperationsByOwner } from '../src/native-operation-registry.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]) => readFileSync(path.join(ROOT, ...segments), 'utf8')

const registered = new Set(NATIVE_OPERATIONS.map(operation => operation.name))

test('主/Core 暴露集合无交集（Q9 不相交断言）', () => {
  assert.doesNotThrow(() => assertDisjointExposure())
  const coreNative = nativeOperationsByOwner('core-native')
  const mainHost = nativeOperationsByOwner('main-host')
  assert.ok(coreNative.length >= 20, `core-native 应覆盖全部 Core 平台端口，实际 ${coreNative.length}`)
  assert.ok(mainHost.length >= 10, `main-host 应覆盖全部宿主端口，实际 ${mainHost.length}`)
})

test('Java invokeSync 分派键全部登记（防手写新操作绕过归属表）', () => {
  const java = read('android', 'app', 'src', 'main', 'java', 'ai', 'stagecraft', 'android', 'AndroidCompositionOperations.java')
  const dispatched = [...java.matchAll(/"([a-zA-Z][a-zA-Z0-9.]*)"\.equals\(operation\)/g)].map(match => match[1])
  assert.ok(dispatched.length >= 20, `Java 分派键应全部发现，实际 ${dispatched.length}`)
  const unregistered = [...new Set(dispatched)].filter(name => !registered.has(name))
  assert.deepEqual(unregistered, [], `Java 新增了 registry 未登记的 operation：${unregistered.join(', ')}`)
})

test('WebView 侧 SYNC_OPERATIONS 全部为 core-native（Core WebView 不得见宿主操作）', () => {
  const ts = read('src', 'portable', 'android-local-core.ts')
  const block = ts.match(/const SYNC_OPERATIONS = new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(block, 'SYNC_OPERATIONS 白名单必须存在')
  const ops = [...block![1].matchAll(/'([a-zA-Z][a-zA-Z0-9.]*)'/g)].map(match => match[1])
  assert.ok(ops.length >= 10, `SYNC_OPERATIONS 应全部发现，实际 ${ops.length}`)
  const misowned = ops.filter(name => {
    const operation = NATIVE_OPERATIONS.find(item => item.name === name)
    return !operation || operation.owner !== 'core-native'
  })
  assert.deepEqual(misowned, [], `SYNC_OPERATIONS 中存在非 core-native 操作：${misowned.join(', ')}`)
})

test('NativeBridge @JavascriptInterface 方法全部登记为 main-host', () => {
  const bridge = read('android', 'app', 'src', 'main', 'java', 'ai', 'stagecraft', 'android', 'NativeBridge.java')
  const methods = [...bridge.matchAll(/@JavascriptInterface\s+public\s+\S+\s+(\w+)\(/g)].map(match => match[1])
  const transportSurface = new Set(['invokeSync', 'invokeAsync'])
  const unregistered = [...new Set(methods)].filter(name => !transportSurface.has(name) && !registered.has(name))
  assert.deepEqual(unregistered, [], `主 WebView bridge 新增了 registry 未登记的方法：${unregistered.join(', ')}`)
  const misowned = [...new Set(methods)].filter(name => {
    if (transportSurface.has(name)) return false
    const operation = NATIVE_OPERATIONS.find(item => item.name === name)
    return !operation || operation.owner !== 'main-host'
  })
  assert.deepEqual(misowned, [], `NativeBridge 存在非 main-host 操作：${misowned.join(', ')}`)
})

test('generic-dispatch 操作不得出现在 interface-method surface（通道归属唯一）', () => {
  for (const operation of NATIVE_OPERATIONS) {
    if (operation.surface === 'generic-dispatch') {
      assert.ok(!/^localCoreAllowed|^ready$|^pair$|^sync/.test(operation.name), `${operation.name} 通道归属可疑`)
    }
  }
  assert.ok(NATIVE_OPERATIONS.every(operation => ['generic-dispatch', 'interface-method'].includes(operation.surface)))
})
