/**
 * Core host 桥（W0 spike；计划 §5.2 / Q1）：
 *  - 经 WebMessagePort 与 :core 宿主通信（Java init 时下发端口）；
 *  - 提供 echo / measure-eval / emit-events 命令（数据服务转发与进程内桥量测）；
 *  - 真实 bundle 求值冒烟与就绪上报。
 * 本文件不得包含业务路由；业务逻辑仍在 embedded-core.js 与共享 TS。
 */
;(function () {
  'use strict'
  const logEl = document.getElementById('log')
  const lines = []
  function log(text) {
    lines.push(new Date().toISOString() + '  ' + text)
    logEl.textContent = lines.slice(-8).join('\n')
    if (window.CoreHostBridgePort) window.CoreHostBridgePort.send({ type: 'log', text: text })
  }
  window.CoreHostLog = log

  window.CoreHostBridge = {
    // 统一命令入口：echo / measure-eval / emit-events（此前 echo/dispatch 分离导致
    // forwardCommand 把 emit-events 发进 echo，SSE 检查永远等不到事件——实测根因）。
    dispatch: function (requestJson) {
      const request = JSON.parse(requestJson)
      if (request.command === 'echo') {
        return JSON.stringify({ requestId: request.requestId, payloadBytes: (request.payload || '').length, echoed: true })
      }
      if (request.command === 'measure-eval') {
        let payload = ''
        const unit = '0123456789abcdef'
        while (payload.length < request.bytes) payload += unit
        return JSON.stringify({ requestId: request.requestId, payloadBytes: payload.slice(0, request.bytes).length })
      }
      if (request.command === 'emit-events') {
        const count = request.count || 3
        const interval = request.intervalMs || 300
        for (let index = 0; index < count; index++) {
          setTimeout(function () {
            window.CoreHostBridgePort.send({
              type: 'core-event',
              event: { type: 'state.changed', revision: index + 1, source: 'gatea-spike', sequence: index + 1 },
            })
          }, interval * index)
        }
        return JSON.stringify({ requestId: request.requestId, scheduled: count })
      }
      return JSON.stringify({ requestId: request.requestId, error: 'unknown command ' + request.command })
    },
  }

  // WebMessagePort 通道：Java 在页面加载后 postWebMessage 传入端口（Q1 优先通道）。
  // WebView 的 message 事件在不同实现中可能派发到 window 或 document——两处都挂，幂等防重。
  let bridgeBooted = false
  function onHostMessage(event) {
    if (bridgeBooted) return
    bridgeBooted = true
    try {
      console.log('[core-host] init received: ' + event.data)
      JSON.parse(event.data) // init 消息内容仅记录用途，端口才是关键
      window.CoreHostBridgePort = {
        _port: event.ports[0],
        send: function (message) { this._port.postMessage(JSON.stringify(message)) },
      }
      window.CoreHostBridgePort._port.onmessage = function (message) { log('host: ' + message.data) }
      // 量测：32KB 端口消息（JS→Java 方向）
      const measureBytes = 32 * 1024
      let measure = ''
      while (measure.length < measureBytes) measure += '0123456789abcdef'
      const startedAt = Date.now()
      window.CoreHostBridgePort.send({
        type: 'log',
        text: 'port-measure bytes=' + measure.length + ' buildMs=' + (Date.now() - startedAt),
      })
      // 就绪上报：协议版本与 bundle hash 透传（构建期 embedded-core.json 为准）
      const manifest = window.StageCraftEmbeddedCoreManifest || null
      window.CoreHostBridgePort.send({
        type: 'core-ready',
        protocolVersion: '1.1',
        bundleVersion: (manifest && manifest.bundleVersion) || 'unknown',
        bundleSha256: (manifest && manifest.sha256) || '',
        measure: { portMeasureBytes: measureBytes },
      })
      log('bridge ready (web message port)')
      console.log('[core-host] bridge ready')
    } catch (error) {
      log('bridge init failed: ' + error)
      console.error('[core-host] bridge init failed: ' + error)
    }
  }
  window.addEventListener('message', onHostMessage)
  document.addEventListener('message', onHostMessage)
  console.log('[core-host] bridge listeners registered (window+document)')

  window.addEventListener('DOMContentLoaded', function () {
    const bundleGlobals = Object.getOwnPropertyNames(globalThis).filter(function (name) {
      return /StageCraft|EmbeddedCore/i.test(name)
    })
    log('bundle globals: ' + (bundleGlobals.join(', ') || '(none)'))
    log('core-host-bridge ready; waiting for host bridge port')
  })
})()
