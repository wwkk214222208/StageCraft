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
test('W5-R1-1：命令门禁必须接入数据面（CoreDataServer 检查 + CoreService 注入）', () => {
  const server = read('java', 'ai', 'stagecraft', 'android', 'CoreDataServer.java')
  assert.match(server, /interface CommandGate/, 'CoreDataServer 必须定义 CommandGate')
  assert.match(server, /needsCommandGate && !commandGate\.canSubmitCommands\(\)/,
    '命令类请求必须经 CommandGate 门禁（W5-R1-1）')
  assert.match(server, /core is not ready to accept commands \(state gate closed\)/,
    '门禁关闭时必须返回冻结契约等价错误 core_not_ready')
  const service = read('java', 'ai', 'stagecraft', 'android', 'CoreService.java')
  assert.match(service, /dataServer\.setCommandGate\(stateMachine::canSubmitCommands\)/,
    'CoreService 必须注入状态机门禁到数据面（W5-R1-1）')
})

test('W5-R1-2：Binder Stub 必须一行委托 CoreControlBinder（可运行 seam）', () => {
  const source = read('java', 'ai', 'stagecraft', 'android', 'CoreService.java')
  assert.match(source, /private final CoreControlBinder controlBinder/, 'CoreService 必须持有 CoreControlBinder')
  assert.match(source, /@Override public String getStatusSummary\(\) \{\s*\n\s*\/\/ 一行委托[^\n]*\n\s*return controlBinder\.getStatusSummary\(\);/,
    'Stub.getStatusSummary 必须一行委托 CoreControlBinder（W5-R1-2 可运行 seam）')
  assert.match(source, /@Override public String getEndpoint\(\) \{[\s\S]*?return controlBinder\.getEndpoint\(\);/,
    'Stub.getEndpoint 必须一行委托 CoreControlBinder')
  const binder = read('java', 'ai', 'stagecraft', 'android', 'CoreControlBinder.java')
  assert.match(binder, /BINDER_HARD_LIMIT_BYTES = 64 \* 1024/, '64KiB 硬上限必须在 CoreControlBinder')
})

test('W5-1：CoreService Binder getStatusSummary 无递归（Stub 委托 + 执行体无自调用）', () => {
  const source = read('java', 'ai', 'stagecraft', 'android', 'CoreService.java')
  // Stub 区间内 getStatusSummary() 只允许出现在委托行（return controlBinder.getStatusSummary();）
  const stubStart = source.indexOf('private final ICoreControl.Stub control')
  const stubEnd = source.indexOf('private final RemoteCallbackList', stubStart)
  assert.ok(stubStart >= 0 && stubEnd > stubStart, 'Stub 区间定位失败')
  const stubBody = source.slice(stubStart, stubEnd)
  const callsInStub = (stubBody.match(/getStatusSummary\(\)/g) ?? []).length
  const delegatedInStub = (stubBody.match(/controlBinder\.getStatusSummary\(\)/g) ?? []).length
  const stubDefinition = (stubBody.match(/@Override public String getStatusSummary\(\)/g) ?? []).length
  const bareInStub = callsInStub - delegatedInStub - stubDefinition
  assert.equal(bareInStub, 0,
    `Stub 区间内裸 getStatusSummary() 调用 ${bareInStub} 处（总 ${callsInStub} - 委托 ${delegatedInStub} - 定义 ${stubDefinition}）——W5-1 递归回归`)
  // 执行体 CoreControlBinder 不得自调用 getStatusSummary（防递归）
  const binder = read('java', 'ai', 'stagecraft', 'android', 'CoreControlBinder.java')
  const binderCalls = (binder.match(/getStatusSummary\(\)/g) ?? []).length
  const binderDefinition = (binder.match(/public String getStatusSummary\(\)/g) ?? []).length
  assert.equal(binderCalls, binderDefinition,
    `CoreControlBinder 内 getStatusSummary() 只允许定义（${binderDefinition} 处），实际 ${binderCalls}——执行体自调用即递归`)
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

test('W4 合流：CoreDataServer 协议端点必须经 forwardApi 转发（可移植 handler 语义单一来源）', () => {
  const server = read('java', 'ai', 'stagecraft', 'android', 'CoreDataServer.java')
  assert.match(server, /default void forwardApi\(String method, String path, Map<String, String> headers, String bodyJson, java\.util\.function\.Consumer<String> resultConsumer\)/,
    'CommandForwarder 必须提供 forwardApi 扩展（W4 合流契约）')
  const commands = (server.match(/forwardApiAndRespond\(socket, "POST", "\/api\/core\/commands"/g) ?? []).length
  const cancel = (server.match(/forwardApiAndRespond\(socket, "POST", "\/api\/core\/cancel"/g) ?? []).length
  const uiAction = (server.match(/forwardApiAndRespond\(socket, "POST", "\/api\/core\/ui\/action"/g) ?? []).length
  assert.equal(commands, 1, `commands 必须走 forwardApi（实际 ${commands}）`)
  assert.equal(cancel, 1, `cancel 必须走 forwardApi（实际 ${cancel}）`)
  assert.equal(uiAction, 1, `ui/action 必须走 forwardApi（实际 ${uiAction}）`)
  assert.match(server, /case 504 -> "Gateway Timeout"/, '超时语义保留')
  // 传输层职责仍在：nonce/415/413/门禁不因合流移除
  assert.match(server, /!nonce\.equals\(headers\.get\("x-core-nonce"\)\)/, 'nonce 校验保留')
  assert.match(server, /needsCommandGate && !commandGate\.canSubmitCommands\(\)/, '命令门禁保留')
})

test('W4 合流：CoreService 必须实现 forwardApi（pending 表 + protocol-result 桥回传）', () => {
  const service = read('java', 'ai', 'stagecraft', 'android', 'CoreService.java')
  assert.match(service, /pendingApi\.put\(requestId, resultConsumer\)/, 'pending 请求必须登记')
  assert.match(service, /case "protocol-result"/, '桥消息必须处理 protocol-result')
  assert.match(service, /dispatchRequest\(/, 'JS 侧必须调用 dispatchRequest')
  assert.match(service, /pendingApi\.remove\(requestId\)/, '结果到达必须移除 pending')
  // Core 进程桥只暴露 core-native allowlist（Gate B）——合流不得绕过
  assert.match(service, /CoreNativeBridge bridge;/, '桥实例必须存在')
})

test('W4 合流：Core WebView JS 必须暴露协议端点分发（可移植 handler 在组合根侧）', () => {
  const bridge = read('assets', 'web', 'core-host-bridge.js')
  assert.match(bridge, /dispatchRequest: function/, 'CoreHostBridge 必须暴露 dispatchRequest')
  assert.match(bridge, /protocol-result/, '结果必须经桥消息 protocol-result 回传')
  assert.match(bridge, /handlePortableRequest/, '必须调用组合根的 handlePortableRequest')
  const localCore = read('..', '..', '..', '..', 'src', 'portable', 'android-local-core.ts')
  assert.match(localCore, /handlePortableRequest/, 'android-local-core 必须暴露 handlePortableRequest')
  assert.match(localCore, /CoreProtocolPortableHandler/, '必须实例化 W4 可移植 handler')
  assert.match(localCore, /handlePortableApi\(/, '必须经 handlePortableApi 分发')
})
