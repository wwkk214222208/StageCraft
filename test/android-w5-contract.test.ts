import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]) => readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', ...segments), 'utf8')

/**
 * W5 源码锚点契约测试（与 android-gatea-contract.test.ts 同法）：
 * 防止 W5 关键整改被后续修改回退（评审 W5-1/W5-3/W5-2）。
 */
test('W5-1：CoreService Binder getStatusSummary 必须显式限定外层方法（防递归回归）', () => {
  const source = read('java', 'ai', 'stagecraft', 'android', 'CoreService.java')
  // 匿名 Stub 内必须显式 CoreService.this.getStatusSummary()，不得裸调自身
  assert.match(source, /return enforceBinderLimit\(CoreService\.this\.getStatusSummary\(\)\.toString\(\)\);/,
    'Stub.getStatusSummary 必须显式限定 CoreService.this，否则无限递归（W5-1 P0）')
  // 取 Stub 匿名类区间（ICoreControl.Stub 定义到 RemoteCallbackList 之前）内的调用：
  // 该区间内除 Stub 自身定义外，任何 getStatusSummary() 调用都必须带 CoreService.this 前缀
  const stubStart = source.indexOf('private final ICoreControl.Stub control')
  const stubEnd = source.indexOf('private final RemoteCallbackList', stubStart)
  assert.ok(stubStart >= 0 && stubEnd > stubStart, 'Stub 区间定位失败')
  const stubBody = source.slice(stubStart, stubEnd)
  const callsInStub = (stubBody.match(/getStatusSummary\(\)/g) ?? []).length
  const qualifiedInStub = (stubBody.match(/CoreService\.this\.getStatusSummary\(\)/g) ?? []).length
  const stubDefinition = (stubBody.match(/@Override public String getStatusSummary\(\)/g) ?? []).length
  const bareInStub = callsInStub - qualifiedInStub - stubDefinition
  assert.equal(bareInStub, 0,
    `Stub 区间内裸 getStatusSummary() 调用 ${bareInStub} 处（总 ${callsInStub} - 限定 ${qualifiedInStub} - 定义 ${stubDefinition}）——W5-1 递归回归`)
})

test('W5-3：CoreService 必须委托 CoreServiceStateMachine（状态机接入服务）', () => {
  const source = read('java', 'ai', 'stagecraft', 'android', 'CoreService.java')
  assert.match(source, /private CoreServiceStateMachine stateMachine = new CoreServiceStateMachine\(\);/,
    'CoreService 必须持有 CoreServiceStateMachine（W5-3）')
  assert.match(source, /stateMachine\.onBridgeReady\(\)/, 'bridge ready 必须经状态机迁移')
  assert.match(source, /stateMachine\.onFailure\(/, '失败必须经状态机迁移')
  assert.match(source, /stateMachine\.summary\(/, '控制面摘要必须由状态机生成')
})

test('W5-2：CoreDataServer 必须实现 415 content-type 语义（Gate C 冻结）', () => {
  const source = read('java', 'ai', 'stagecraft', 'android', 'CoreDataServer.java')
  assert.match(source, /unsupported_media_type/, '415 错误码必须存在')
  assert.match(source, /isJsonContentType/, '必须有 content-type 校验 helper')
  const counts = (source.match(/requires application\/json/g) ?? []).length
  assert.ok(counts >= 3, `commands/cancel/ui-action 三个 POST 端点都应有 415 校验，实际: ${counts}`)
  assert.match(source, /case 415 -> "Unsupported Media Type"/, 'reason() 必须含 415')
})

test('W5-5：CoreDataServer 必须对未挂载 core 路由返回稳定 handler_not_mounted', () => {
  const source = read('java', 'ai', 'stagecraft', 'android', 'CoreDataServer.java')
  assert.match(source, /handler_not_mounted/, '未挂载 core 路由必须返回 handler_not_mounted')
  assert.match(source, /setRouteRegistry/, '必须提供 registry 注入点')
  assert.match(source, /unsupported_capability/, 'desktop-only 必须返回 unsupported_capability')
})

test('W5 非阻塞项：CoreNativeBridge 超时必须调用取消句柄且输出上限按 UTF-8 字节', () => {
  const source = read('java', 'ai', 'stagecraft', 'android', 'CoreNativeBridge.java')
  assert.match(source, /Runnable invoke\(String operation, JSONObject input, Callback callback\)/,
    'AsyncInvoker 必须返回可取消句柄（评审非阻塞项 1）')
  assert.match(source, /cancel\.run\(\)/, '超时路径必须调用取消句柄')
  assert.match(source, /getBytes\(StandardCharsets\.UTF_8\)\.length > MAX_OUTPUT_BYTES/,
    '输出上限必须按 UTF-8 字节口径（评审非阻塞项 2）')
})
