/**
 * Core host 桥（W5：正式 Core 进程承载；计划 §5.2 / Q1）。
 *
 *  - 经 WebMessagePort 与 :core 宿主通信（Java init 时下发端口）；
 *  - 桥建立后启动真实 Core 组合根（StageCraftLocalCore，embedded-core.js 已注入）；
 *  - core.event / core.resync / connection.state 等消息经端口回流 → CoreDataServer SSE；
 *  - 提供 echo / measure-eval / emit-events（spike 量测）与 view / dispatch 命令；
 *  - 本文件不得包含业务路由；业务逻辑仍在 embedded-core.js 与共享 TS。
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

  let localCore = null

  /** 把 Core 组合根消息转成 1.1 envelope（与 src/core/http-human-plugin.ts buildEnvelope 同形状）。 */
  function toEnvelope(message) {
    if (message && typeof message === 'object') {
      if (message.type === 'core.event' && message.event) return message.event
      if (message.type === 'core.resync') {
        return {
          protocolVersion: '1.1',
          roomId: (localCore && localCore.roomId) || '',
          revision: message.revision || 0,
          type: 'core.resync',
          payload: { type: 'core.resync', revision: message.revision || 0, reason: message.reason || 'resync', view: message.view || null },
          createdAt: new Date().toISOString(),
        }
      }
      if (message.type === 'connection.state') {
        return {
          protocolVersion: '1.1',
          roomId: (localCore && localCore.roomId) || '',
          revision: 0,
          type: 'connection.state',
          payload: { type: 'connection.state', state: message.state || 'unknown' },
          createdAt: new Date().toISOString(),
        }
      }
      if (message.type === 'connection.error') {
        return {
          protocolVersion: '1.1',
          roomId: (localCore && localCore.roomId) || '',
          revision: 0,
          type: 'connection.error',
          payload: { type: 'connection.error', message: message.message || 'unknown error' },
          createdAt: new Date().toISOString(),
        }
      }
      if (message.type === 'thinking') {
        return {
          protocolVersion: '1.1',
          roomId: (localCore && localCore.roomId) || '',
          revision: 0,
          type: 'model.thinking.delta',
          payload: { type: 'model.thinking.delta', revision: 0, requestId: (message.event && message.event.requestId) || '', text: (message.event && message.event.text) || '' },
          createdAt: new Date().toISOString(),
        }
      }
      if (message.type === 'room.changed') {
        return {
          protocolVersion: '1.1',
          roomId: (localCore && localCore.roomId) || '',
          revision: (message.view && message.view.revision) || 0,
          type: 'state.changed',
          payload: { type: 'state.changed', revision: (message.view && message.view.revision) || 0, transition: { revision: (message.view && message.view.revision) || 0, events: [], changes: [] } },
          createdAt: new Date().toISOString(),
        }
      }
    }
    return message
  }

  window.CoreHostBridge = {
    // 统一命令入口：view / echo / measure-eval / emit-events / crash-renderer
    dispatch: function (requestJson) {
      const request = JSON.parse(requestJson)
      if (request.command === 'view') {
        if (!localCore) return JSON.stringify({ requestId: request.requestId, error: 'core not started' })
        try {
          const view = localCore.getView ? localCore.getView() : null
          return JSON.stringify({ requestId: request.requestId, view: view })
        } catch (error) {
          return JSON.stringify({ requestId: request.requestId, error: error.message || String(error) })
        }
      }
      if (request.command === 'echo') {
        return JSON.stringify({ requestId: request.requestId, payloadBytes: (request.payload || '').length, echoed: true })
      }
      if (request.command === 'measure-eval') {
        let payload = ''
        const unit = '0123456789abcdef'
        while (payload.length < request.bytes) payload += unit
        return JSON.stringify({ requestId: request.requestId, payloadBytes: payload.slice(0, request.bytes).length })
      }
      if (request.command === 'crash-renderer') {
        // Gate A 实测项（评审第 4 条）：在沙箱渲染进程内提交物理内存直到 OOM。
        // 关键：必须"写入"才提交——仅 new ArrayBuffer 只保留虚拟内存，64 位设备上永远压不垮。
        console.log('[core-host] crash-renderer: committing memory until renderer OOM')
        const chunks = []
        let committed = 0
        const commit = function (bytes) {
          const buf = new ArrayBuffer(bytes)
          new Uint8Array(buf).fill(1)
          chunks.push(buf)
          committed += bytes
        }
        try {
          while (true) commit(32 * 1024 * 1024)
        } catch (bigFailure) {
          console.error('[core-host] big alloc halted at ' + committed + ' bytes: ' + bigFailure)
          try {
            while (true) commit(1024 * 1024)
          } catch (smallFailure) {
            console.error('[core-host] small alloc halted: ' + smallFailure)
          }
        }
        return JSON.stringify({ requestId: request.requestId, committed: committed })
      }
      if (request.command === 'emit-events') {
        const count = request.count || 3
        const interval = request.intervalMs || 300
        for (let index = 0; index < count; index++) {
          setTimeout(function () {
            window.CoreHostBridgePort.send({
              type: 'core-event',
              event: { type: 'state.changed', revision: index + 1, source: 'core-service', sequence: index + 1 },
            })
          }, interval * index)
        }
        return JSON.stringify({ requestId: request.requestId, scheduled: count })
      }
      return JSON.stringify({ requestId: request.requestId, error: 'unknown command ' + request.command })
    },

    /**
     * W4 合流：协议端点分发（method/path/headers/body → 可移植 handler → 标准回执）。
     * handlePortableApi 是异步的（core.dispatch 是 async），结果经 CoreHostBridgePort
     * 以 {type:'protocol-result', requestId, status, body} 回传，Java 侧唤醒 pending。
     */
    dispatchRequest: function (requestId, method, path, headersJson, bodyJson) {
      if (!localCore || typeof localCore.handlePortableRequest !== 'function') {
        if (window.CoreHostBridgePort) {
          window.CoreHostBridgePort.send({
            type: 'protocol-result', requestId: requestId, status: 503,
            body: JSON.stringify({ error: { code: 'core_not_ready', message: 'core is not started' } }),
          })
        }
        return
      }
      localCore.handlePortableRequest(method, path, headersJson, bodyJson).then(function (result) {
        if (window.CoreHostBridgePort) {
          window.CoreHostBridgePort.send({
            type: 'protocol-result', requestId: requestId, status: result.status, body: result.body,
          })
        }
      }).catch(function (error) {
        if (window.CoreHostBridgePort) {
          window.CoreHostBridgePort.send({
            type: 'protocol-result', requestId: requestId, status: 500,
            body: JSON.stringify({ error: { code: 'internal_error', message: error.message || String(error) } }),
          })
        }
      })
    },

    /**
     * W6：接收主进程 PluginLaunchPlan（经桥下发）→ 组合根校验 → plugin-report 回报隔离记录。
     */
    applyLaunchPlan: function (planJson) {
      if (!localCore || typeof localCore.applyLaunchPlan !== 'function') {
        if (window.CoreHostBridgePort) {
          window.CoreHostBridgePort.send({
            type: 'plugin-report', ok: false, error: 'local core is not started',
          })
        }
        return
      }
      localCore.applyLaunchPlan(planJson)
    },

    /**
     * R3-5：客户端断开 → Java 侧 cancel(requestId) → 本方法 abort 对应请求（长模型请求停止）。
     */
    cancelPortableRequest: function (requestId) {
      if (localCore && typeof localCore.cancelPortableRequest === 'function') {
        localCore.cancelPortableRequest(requestId)
      }
    },

    /** 供 CoreService currentView() 调用：返回权威 CoreView 文本。 */
    view: function () {
      if (!localCore) return null
      try {
        const view = localCore.getView ? localCore.getView() : null
        return view ? JSON.stringify(view) : null
      } catch (error) {
        log('view failed: ' + error)
        return null
      }
    },
  }

  // WebMessagePort 通道：Java 在页面加载后 postWebMessage 传入端口（Q1 优先通道）。
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
      // 启动真实 Core 组合根（W5）：StageCraftLocalCore 由 embedded-core.js 注入，
      // 依赖 CoreNative（CoreService 注册的原生端口）。组合根消息经端口回流 → SSE。
      startLocalCore()
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

  /** W5：启动 StageCraftLocalCore（真实组合根），消息经端口回流。 */
  function startLocalCore() {
    try {
      const candidate = window.StageCraftLocalCore || window.StageCraftEmbeddedCore
      if (!candidate || typeof candidate.start !== 'function') {
        log('local core not available (StageCraftLocalCore missing)')
        // bundle 可能仍在加载：DOMContentLoaded 后重试一次
        if (document.readyState !== 'complete') {
          window.addEventListener('DOMContentLoaded', function retry() {
            startLocalCore()
          }, { once: true })
        }
        return
      }
      localCore = candidate
      candidate.start(function (messageText) {
        let message
        try { message = JSON.parse(messageText) } catch (error) { return }
        // W6：plugin-report（launch plan 隔离记录）原样转发给宿主，不包 core-event
        if (message && message.type === 'plugin-report' && window.CoreHostBridgePort) {
          window.CoreHostBridgePort.send(message)
          return
        }
        const envelope = toEnvelope(message)
        if (envelope && window.CoreHostBridgePort) {
          window.CoreHostBridgePort.send({ type: 'core-event', event: envelope })
        }
      })
      log('local core started (roomId=' + (candidate.roomId || '?') + ')')
    } catch (error) {
      log('local core start failed: ' + error)
      console.error('[core-host] local core start failed: ' + error)
    }
  }

  window.addEventListener('DOMContentLoaded', function () {
    const bundleGlobals = Object.getOwnPropertyNames(globalThis).filter(function (name) {
      return /StageCraft|EmbeddedCore/i.test(name)
    })
    log('bundle globals: ' + (bundleGlobals.join(', ') || '(none)'))
    log('core-host-bridge ready; waiting for host bridge port')
  })
})()
