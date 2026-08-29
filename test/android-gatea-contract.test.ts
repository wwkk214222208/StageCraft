/**
 * W0 Gate A spike 源码契约测试（JVM/harness 级；真机证据另由 gatea-report.json 提供）。
 *
 * 锚定计划与答疑的硬边界：
 *  - manifest 声明 :core 进程服务；
 *  - :core 进程 WebView suffix 唯一初始化入口先于 WebView 使用；
 *  - CoreDataServer 强制 nonce、请求体上限；gateway 逐块 flush 透传；
 *  - Binder 控制面只交换小消息（Q8 契约方法齐备）；
 *  - 进程内桥不复用 StageCraftNative（Q1/Q9）；
 *  - core-host 禁止 file:// 与外发业务请求。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]) => readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', ...segments), 'utf8')

test('manifest：spike 组件 debug-only 隔离（评审第 8 条：release 剔除自杀入口）', () => {
  const mainManifest = read('AndroidManifest.xml')
  assert.doesNotMatch(mainManifest, /GateASpikeActivity/, 'release 主 manifest 不得含 spike 入口')
  assert.doesNotMatch(mainManifest, /GateACoreService/, 'release 主 manifest 不得含 spike 服务')
  const debugManifest = readFileSync(path.join(ROOT, 'android', 'app', 'src', 'debug', 'AndroidManifest.xml'), 'utf8')
  assert.match(debugManifest, /android:name="\.GateACoreService"/)
  assert.match(debugManifest, /android:process=":core"/)
  assert.match(debugManifest, /android:name="\.GateASpikeActivity"/)
  assert.doesNotMatch(mainManifest, /android:debuggable/, 'debuggable 由 buildType 管理，不得写入 manifest')
})

test('WebView suffix：唯一初始化入口先于 WebView 使用（§5.1）', () => {
  const guard = read('java', 'ai', 'stagecraft', 'android', 'ProcessGuard.java')
  assert.match(guard, /setDataDirectorySuffix/)
  assert.match(guard, /AtomicBoolean/, 'suffix 只允许设置一次（幂等守卫）')
  const service = read('java', 'ai', 'stagecraft', 'android', 'GateACoreService.java')
  const onCreate = service.slice(service.indexOf('void onCreate'), service.indexOf('private void boot'))
  assert.match(onCreate, /ProcessGuard\.init/, ':core 进程入口 onCreate 首行必须走唯一初始化入口')
  assert.ok(service.indexOf('GateACoreService') < service.indexOf('new WebView'), '声明先于使用')
  assert.ok(service.indexOf('ProcessGuard.init') < service.indexOf('new WebView'), 'suffix 初始化必须先于 WebView 创建')
  const activity = read('java', 'ai', 'stagecraft', 'android', 'GateASpikeActivity.java')
  const activityOnCreate = activity.slice(activity.indexOf('void onCreate'), activity.indexOf('private void buildUi'))
  assert.match(activityOnCreate, /ProcessGuard\.init/, '主进程入口同样走唯一初始化入口')
})

test('CoreDataServer：nonce 强制、body 上限、SSE 逐条 flush', () => {
  const server = read('java', 'ai', 'stagecraft', 'android', 'GateACoreDataServer.java')
  assert.match(server, /x-core-nonce/, '必须校验 nonce 请求头')
  assert.match(server, /401/, '缺 nonce 拒绝')
  assert.match(server, /MAX_BODY_BYTES/, '请求体大小上限存在')
  assert.match(server, /413/, '超限返回 413')
  assert.match(server, /output\.flush\(\)/, 'SSE 逐条 flush（不得整包缓冲）')
  assert.match(server, /getByName\("127\.0\.0\.1"\)/, '显式绑定 IPv4 回环（设备上 getLoopbackAddress 可能返回 ::1，真机实测根因）')
  assert.match(server, /subscribers\.remove/, '客户端断开后清理订阅（取消传播）')
})

test('Gateway：字节流透传、取消传播、nonce 只由 gateway 注入', () => {
  const gateway = read('java', 'ai', 'stagecraft', 'android', 'GateAGatewayServer.java')
  assert.match(gateway, /x-core-nonce/, 'gateway 注入 nonce')
  assert.match(gateway, /downstream\.flush\(\)/, '逐块 flush 透传')
  assert.match(gateway, /upstreamClosedByClient/, '页面断开 → 关闭上游（取消传播计数）')
  assert.match(gateway, /503/, 'Core 未就绪返回稳定错误')
  assert.match(gateway, /URI\.create\(parts\[1\]\)\.getPath\(\)/, '只按路径代理，不改写 payload')
})

test('Binder 发送侧 64KiB 断言 + 客户端 linkToDeath + 幂等重绑（评审第 1 条）', () => {
  const service = read('java', 'ai', 'stagecraft', 'android', 'GateACoreService.java')
  assert.match(service, /enforceBinderLimit/, '发送侧 64KiB 硬断言存在')
  assert.match(service, /64 \* 1024/, '上限字面量')
  assert.match(service, /maxBinderPayloadBytes/, '最大单条字节观测记录')
  const activity = read('java', 'ai', 'stagecraft', 'android', 'GateASpikeActivity.java')
  assert.match(activity, /linkToDeath/, '客户端 death recipient（RemoteCallbackList 不覆盖客户端）')
  assert.match(activity, /rebindPending/, '幂等重绑守卫（三种死亡通知去重）')
})

test('数据服务与 gateway：超时护栏 / 溢出关闭信号 / 明确 502（评审第 5 条+实现风险）', () => {
  const server = read('java', 'ai', 'stagecraft', 'android', 'GateACoreDataServer.java')
  assert.match(server, /responded\.await\(20/, 'latch 必须带超时（防连接线程泄漏）')
  assert.match(server, /504/, '桥超时返回明确错误')
  assert.match(server, /overflowClosed/, 'SSE 溢出通知写循环关闭连接')
  assert.match(server, /: connected/, '订阅确认行（消除 setTimeout(0) 竞态）')
  const gateway = read('java', 'ai', 'stagecraft', 'android', 'GateAGatewayServer.java')
  assert.match(gateway, /502/, '上游失败且未写出字节时返回明确 502')
  assert.match(gateway, /downstreamBytes\[0\] == 0/, '502 仅在零字节写出时注入（防响应协议损坏）')
  const alog = read('java', 'ai', 'stagecraft', 'android', 'GateALog.java')
  assert.match(alog, /gatea-log-/, '日志必须落盘（华为 logcat 抑制的替代证据通道）')
})

test('Binder 控制面：Q8 最小契约经 AIDL 冻结（真机实测修复 BinderProxy 强转）', () => {
  const control = read('aidl', 'ai', 'stagecraft', 'android', 'ICoreControl.aidl')
  for (const method of ['getEndpoint', 'requestStop', 'getStatusSummary', 'registerCallback']) {
    assert.match(control, new RegExp(method), `缺少 Q8 契约方法 ${method}`)
  }
  const callback = read('aidl', 'ai', 'stagecraft', 'android', 'ICoreControlCallback.aidl')
  assert.match(callback, /onStatus/)
  assert.match(callback, /onEndpointReady/)
  const service = read('java', 'ai', 'stagecraft', 'android', 'GateACoreService.java')
  assert.match(service, /ICoreControl\.Stub/, '服务端实现 AIDL Stub')
  assert.match(service, /RemoteCallbackList/, '跨进程回调列表（死亡自动清理）')
  assert.match(service, /failureCode/, '崩溃原因进入状态摘要')
  assert.match(service, /enforceBinderLimit\(GateACoreService\.this\.getStatusSummary\(\)\.toString\(\)\)/, 'getStatusSummary 出口同样过 64KiB 断言（评审：并非所有出口都有断言）')
  const activity = read('java', 'ai', 'stagecraft', 'android', 'GateASpikeActivity.java')
  assert.match(activity, /ICoreControl\.Stub\.asInterface/, '跨进程必须 asInterface（真机实锤：强转 BinderProxy 崩溃）')
  assert.match(activity, /rebindPending[.]set[(]false[)]/, 'rebindPending 必须在绑定完成后清零（评审：清零过早有重复重绑窗口）')
  assert.match(activity, /rendererGoneStatusAt/, 'onRenderProcessGone 时刻必须被捕获为证据')
  assert.match(activity, /rawEvents/, 'SSE 原始事件内容随报告存档')
  assert.doesNotMatch(activity, /findRendererPid/, 'isolated UID 下进程枚举不可用（真机实测），不得保留死代码路径')
})

test('进程内桥：独立命名 CoreNative，不得复用 StageCraftNative（Q1/Q9）', () => {
  const service = read('java', 'ai', 'stagecraft', 'android', 'GateACoreService.java')
  assert.match(service, /"CoreNative"/)
  // 只断言实际注册行为：接口名不得是 StageCraftNative（注释提及不视为违规）
  assert.match(service, /addJavascriptInterface\(new CoreNativeMeasure\(\), \"CoreNative\"\)/)
  assert.doesNotMatch(service, /addJavascriptInterface\([^)]*StageCraftNative/)
  assert.match(service, /createWebMessageChannel/, 'Q1 优先 WebMessagePort')
})

test('core-host：appassets 加载、禁 file://、零外发业务请求', () => {
  const loader = read('java', 'ai', 'stagecraft', 'android', 'CoreHostAssetLoader.java')
  assert.match(loader, /appassets\.androidplatform\.net/)
  assert.match(loader, /shouldOverrideUrlLoading/, '外部导航一律拒绝')
  assert.match(loader, /onRenderProcessGone/, 'renderer 崩溃钩子（Gate A 项）')
  const html = read('assets', 'core-host.html')
  assert.doesNotMatch(html, /file:\/\//, '禁止 file://（Q7）')
  assert.doesNotMatch(html, /fetch\(/, 'core host 页面零外发业务请求（Q7）')
  assert.match(html, /core-host-bridge\.js/)
  const bridge = read('assets', 'web', 'core-host-bridge.js')
  assert.doesNotMatch(bridge, /fetch\(/, '桥脚本同样零外发请求')
  assert.match(bridge, /emit-events/, 'SSE 事件由 Core 页面经桥发布（数据面闭环）')
})

test('EmbeddedCoreArtifact 与共享协议版本一致（1.1）', () => {
  const artifact = read('java', 'ai', 'stagecraft', 'android', 'EmbeddedCoreArtifact.java')
  assert.match(artifact, /EXPECTED_PROTOCOL = "1\.1"/)
  const protocol = readFileSync(path.join(ROOT, 'src', 'core', 'protocol.ts'), 'utf8')
  assert.match(protocol, /CORE_PROTOCOL_VERSION = '1\.1'/)
})
