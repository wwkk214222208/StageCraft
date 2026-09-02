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
  let coreFailureReported = false

  function reportCoreFailure(code, message) {
    if (coreFailureReported) return
    coreFailureReported = true
    if (window.CoreHostBridgePort) {
      window.CoreHostBridgePort.send({
        type: 'core-failed',
        code: code || 'core_failed',
        message: message || 'Core failed',
      })
    }
  }

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
      // `thinking` is the legacy service callback. The composition Core event listener
      // emits the same delta authoritatively; converting this callback would duplicate every chunk.
      if (message.type === 'thinking') return null
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
        const thinkingEvent = message.event || {}
        const correlation = {
          actor: thinkingEvent.actor === 'role' ? 'role' : 'director',
          ...(thinkingEvent.roleId ? { roleId: thinkingEvent.roleId } : {}),
          ...(thinkingEvent.turnId ? { turnId: thinkingEvent.turnId } : {}),
          roomId: message.roomId || ((localCore && localCore.roomId) || ''),
        }
        return {
          protocolVersion: '1.1',
          roomId: (localCore && localCore.roomId) || '',
          revision: (localCore && localCore.getView && localCore.getView().revision) || 0,
          type: thinkingEvent.done ? 'model.thinking.completed' : 'model.thinking.delta',
          payload: thinkingEvent.done
            ? { type: 'model.thinking.completed', revision: (localCore && localCore.getView && localCore.getView().revision) || 0, text: thinkingEvent.text || '', correlation }
            : { type: 'model.thinking.delta', revision: (localCore && localCore.getView && localCore.getView().revision) || 0, requestId: thinkingEvent.requestId || '', text: thinkingEvent.text || '', correlation },
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
      if (request.command === 'invoke') {
        if (!localCore || typeof localCore.invoke !== 'function') return JSON.stringify({ requestId: request.requestId, error: 'core invoke unavailable' })
        try {
          const result = localCore.invoke(request.operation || '', request.input)
          if (result && typeof result.then === 'function') {
            return result.then(function (value) { return JSON.stringify({ requestId: request.requestId, result: value }) })
          }
          return JSON.stringify({ requestId: request.requestId, result: result })
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
      if (localCore && typeof localCore.invoke === 'function') {
        try {
          const result = localCore.invoke(request.command || '', request.input !== undefined ? request.input : request.payload)
          if (result && typeof result.then === 'function') return result.then(function (value) { return JSON.stringify({ requestId: request.requestId, result: value }) }).catch(function (error) { return JSON.stringify({ requestId: request.requestId, error: error.message || String(error) }) })
          return JSON.stringify({ requestId: request.requestId, result: result })
        } catch (error) {
          return JSON.stringify({ requestId: request.requestId, error: error.message || String(error) })
        }
      }
      return JSON.stringify({ requestId: request.requestId, error: 'unknown command ' + request.command })
    },

    /**
     * W4 合流：协议端点分发（method/path/headers/body → 可移植 handler → 标准回执）。
     * handlePortableApi 是异步的（core.dispatch 是 async），结果经 CoreHostBridgePort
     * 以 {type:'protocol-result', requestId, status, body} 回传，Java 侧唤醒 pending。
     */
    dispatchRequest: function (requestId, method, path, headersJson, bodyJson) {
      const sendProtocolResult = function (status, body) {
        if (window.CoreHostBridgePort) {
          window.CoreHostBridgePort.send({
            type: 'protocol-result', requestId: requestId, status: status, body: JSON.stringify(body),
          })
        }
      }
      if (!localCore) {
        sendProtocolResult(503, { error: { code: 'core_not_ready', message: 'core is not started' } })
        return
      }
      if (typeof localCore.handlePortableRequest !== 'function') {
        // v2 HostCoreEntry only promises generic invoke(). Adapt the command
        // protocol without changing the richer v1 portable handler path.
        if (method === 'POST' && path === '/api/core/commands' && typeof localCore.invoke === 'function') {
          let command
          try {
            command = JSON.parse(bodyJson || '{}')
          } catch (error) {
            sendProtocolResult(400, { error: { code: 'invalid_json', message: 'command body must be valid JSON' } })
            return
          }
          if (!command || command.command !== 'invoke' || typeof command.operation !== 'string' || !command.operation) {
            sendProtocolResult(400, { error: { code: 'unsupported_command', message: 'invoke-only Core requires command:"invoke" and a non-empty operation' } })
            return
          }
          Promise.resolve().then(function () {
            return localCore.invoke(command.operation, command.input)
          }).then(function (result) {
            sendProtocolResult(200, { requestId: command.requestId || requestId, status: 'accepted', result: result })
          }).catch(function (error) {
            sendProtocolResult(200, { requestId: command.requestId || requestId, status: 'rejected', error: { code: 'command_failed', message: error.message || String(error) } })
          })
          return
        }
        if (method === 'POST' && path === '/api/core/cancel' && typeof localCore.cancelPortableRequest === 'function') {
          let cancelRequest
          try {
            cancelRequest = JSON.parse(bodyJson || '{}')
          } catch (error) {
            sendProtocolResult(400, { error: { code: 'invalid_json', message: 'cancel body must be valid JSON' } })
            return
          }
          const cancelId = cancelRequest && String(cancelRequest.requestId || '')
          if (!cancelId) {
            sendProtocolResult(400, { error: { code: 'invalid_request', message: 'cancel requires a requestId' } })
            return
          }
          Promise.resolve().then(function () { return localCore.cancelPortableRequest(cancelId) }).then(function () {
            sendProtocolResult(200, { ok: true, requestId: cancelId })
          }).catch(function (error) {
            sendProtocolResult(500, { error: { code: 'cancel_failed', message: error.message || String(error) } })
          })
          return
        }
        sendProtocolResult(503, { error: { code: 'core_not_ready', message: 'portable handler is not available for this route' } })
        return
      }
      // R7：transportId（requestId）作为请求身份贯穿——handlePortableRequest 用它注册
      // pendingPortableCancels（真实页面无 body requestId 时取消链仍可命中）。
      localCore.handlePortableRequest(requestId, method, path, headersJson, bodyJson).then(function (result) {
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

    /** Stop the selected Core before the WebView is destroyed. The optional
     * callback lets the Android host wait for an async third-party shutdown. */
    shutdown: function (done) {
      if (!localCore) {
        if (done) done()
        return Promise.resolve()
      }
      const shutdown = typeof localCore.shutdown === 'function'
        ? localCore.shutdown
        : (typeof localCore.stop === 'function' ? localCore.stop : null)
      if (!shutdown) {
        if (done) done()
        return Promise.resolve()
      }
      let result
      try {
        result = shutdown.call(localCore)
      } catch (error) {
        log('core shutdown failed: ' + (error.message || String(error)))
        if (done) done()
        return Promise.resolve()
      }
      return Promise.resolve(result).then(function (value) {
        if (done) done()
        return value
      }, function (error) {
        log('core shutdown failed: ' + (error.message || String(error)))
        if (done) done()
        return undefined
      })
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
      Promise.resolve(startLocalCore()).then(function () {
        const manifest = window.StageCraftEmbeddedCoreManifest || null
        window.CoreHostBridgePort.send({
          type: 'core-ready',
          protocolVersion: '1.1',
          bundleVersion: (manifest && manifest.bundleVersion) || (window.StageCraftV2Config && window.StageCraftV2Config.core.version) || 'unknown',
          bundleSha256: (manifest && manifest.sha256) || '',
          measure: { portMeasureBytes: measureBytes },
        })
        log('bridge ready (web message port)')
        console.log('[core-host] bridge ready')
      }).catch(function (error) {
        reportCoreFailure('core_boot_failed', error.message || String(error))
        log('bridge init failed: ' + error)
      })
    } catch (error) {
      reportCoreFailure('core_boot_failed', error.message || String(error))
      log('bridge init failed: ' + error)
      console.error('[core-host] bridge init failed: ' + error)
    }
  }
  window.addEventListener('message', onHostMessage)
  document.addEventListener('message', onHostMessage)
  console.log('[core-host] bridge listeners registered (window+document)')

  /** W5：启动 StageCraftLocalCore（真实组合根），消息经端口回流。 */
  function startLocalCore() {
    if (window.StageCraftV2Config) return startV2Core(window.StageCraftV2Config)
    return loadEmbeddedCore().then(function () {
      const candidate = window.StageCraftLocalCore || window.StageCraftEmbeddedCore
      if (!candidate || typeof candidate.start !== 'function') {
        throw new Error('local core not available (StageCraftLocalCore missing)')
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
    })
  }

  // The external v2 configuration is injected by Java before the bridge port
  // is posted. Only the legacy path reaches this loader, so an external Core
  // can never execute the embedded bundle as a side effect of page load.
  let embeddedCorePromise = null
  function loadEmbeddedCore() {
    if (window.StageCraftV2Config) return Promise.resolve()
    if (window.StageCraftLocalCore || window.StageCraftEmbeddedCore) return Promise.resolve()
    if (embeddedCorePromise) return embeddedCorePromise
    embeddedCorePromise = new Promise(function (resolve, reject) {
      const embedded = document.createElement('script')
      embedded.src = '/assets/embedded-core.js'
      embedded.onload = resolve
      embedded.onerror = function () { reject(new Error('embedded core asset failed to load')) }
      document.head.appendChild(embedded)
    })
    return embeddedCorePromise
  }

  /** Provisional v2 browser loader: verify Java has already checked files and
   * integrity, then load ordinary modules before the selected Core. */
  const HOST_AVAILABLE_CAPABILITIES = ['host.log', 'host.storage']
  function capabilityForHostOperation(operation) {
    if (operation === 'host.log') return 'host.log'
    if (operation === 'host.storage.read' || operation === 'host.storage.write') return 'host.storage'
    return null
  }
  function grantedCapabilities(manifest) {
    const granted = new Set()
    const declared = (manifest && manifest.capabilities) || {}
    for (const kind of ['required', 'optional']) {
      for (const capability of (declared[kind] || [])) if (HOST_AVAILABLE_CAPABILITIES.indexOf(capability) >= 0) granted.add(capability)
    }
    return granted
  }
  /** Per-capability authorization: operations map to capabilities that the
   * identified caller must have been granted; everything else fails closed.
   * host.storage goes through CoreNative, whose Java side re-verifies the
   * caller's manifest capability before touching per-component storage.
   * This is cooperative authorization inside one WebView, not a strong
   * security boundary: page code can manufacture caller fields and owns the
   * risk of sharing this WebView with untrusted content. */
  function createV2HostPort(config) {
    const grants = new Map()
    if (config.core && config.core.manifest) grants.set(config.core.id, grantedCapabilities(config.core.manifest))
    for (const plugin of (config.plugins || [])) if (plugin.manifest) grants.set(plugin.id, grantedCapabilities(plugin.manifest))
    return {
      call: function (operation, input, caller) {
        const capability = capabilityForHostOperation(operation)
        if (!capability) return Promise.reject(new Error('Host operation denied: ' + operation))
        if (!caller || !caller.pluginId) return Promise.reject(new Error('Host operation ' + operation + ' requires a caller identity'))
        const granted = grants.get(caller.pluginId)
        if (!granted || !granted.has(capability)) return Promise.reject(new Error('Host capability denied: ' + capability + ' for ' + caller.pluginId))
        if (operation === 'host.log') {
          if (window.CoreHostBridgePort) window.CoreHostBridgePort.send({ type: 'log', text: JSON.stringify(input) })
          return Promise.resolve({ ok: true })
        }
        if (operation === 'host.storage.read' || operation === 'host.storage.write') {
          if (!window.CoreNative || typeof window.CoreNative.invokeSync !== 'function') return Promise.reject(new Error('CoreNative storage port unavailable'))
          let raw
          try {
            raw = window.CoreNative.invokeSync(operation === 'host.storage.read' ? 'storage.read' : 'storage.write', JSON.stringify({ caller: caller, area: (input || {}).area, value: (input || {}).value }))
          } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)))
          }
          let result
          try { result = JSON.parse(raw) } catch (error) { return Promise.reject(new Error('storage result is not JSON')) }
          if (!result || result.ok !== true) return Promise.reject(new Error((result && result.error && result.error.message) || 'storage operation failed'))
          return Promise.resolve(result)
        }
        return Promise.reject(new Error('Host operation denied: ' + operation))
      },
    }
  }

  // Keep the request hash contract aligned with src/v2/launch-plan.ts. The
  // hash is an identity/integrity check, not a secret or an authorization
  // token. Filtering an import-quarantined plugin must produce a new hash;
  // the pre-quarantine hash must never masquerade as the effective plan.
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value == null ? null : value)
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
    return '{' + Object.keys(value).filter(function (key) { return value[key] !== undefined }).sort(function (a, b) { return a.localeCompare(b) }).map(function (key) {
      return JSON.stringify(key) + ':' + stableStringify(value[key])
    }).join(',') + '}'
  }
  function stableHash(value) {
    let hash = 0x811c9dc5
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  }
  function requestPlanHash(request, pluginSelections) {
    return stableHash(stableStringify({
      planVersion: request.planVersion,
      hostApiVersion: request.hostApiVersion,
      core: request.selectedCore,
      plugins: pluginSelections,
      stateSchemaVersion: request.stateSchemaVersion,
    }))
  }

  async function startV2Core(config) {
    // Plugin-level isolation: a plugin whose module fails at import time is
    // quarantined (diagnostic only); the Core boots with the remaining set.
    // Java-side verification failures never reach this loader (fail closed).
    const loadedPlugins = []
    for (const componentConfig of (config.plugins || [])) {
      try {
        loadedPlugins.push({ config: componentConfig, module: await import(componentConfig.url) })
      } catch (error) {
        const reason = error && error.message ? error.message : String(error)
        if (window.CoreHostBridgePort) window.CoreHostBridgePort.send({ type: 'log', text: 'plugin quarantined: ' + componentConfig.id + '@' + componentConfig.version + ' import failed: ' + reason })
      }
    }
    const request = config.request || {}
    const requestedSelections = Array.isArray(request.pluginSelections) ? request.pluginSelections : []
    if (typeof request.planHash === 'string' && request.planHash !== requestPlanHash(request, requestedSelections)) {
      throw new Error('launch plan hash mismatch')
    }
    const effectiveSelections = requestedSelections.filter(function (selection) {
      return loadedPlugins.some(function (entry) { return entry.config.id === selection.id && entry.config.version === selection.version })
    })
    const effectiveRequest = Object.assign({}, request, {
      pluginSelections: effectiveSelections,
      planHash: requestPlanHash(request, effectiveSelections),
    })
    const effectiveConfig = Object.assign({}, config, {
      request: effectiveRequest,
      plugins: loadedPlugins.map(function (entry) { return entry.config }),
    })
    const coreModule = await import(config.core.url)
    const candidate = coreModule.default
    if (candidate && candidate.manifest) {
      if (candidate.manifest.id !== config.core.id || candidate.manifest.version !== config.core.version) throw new Error('v2 Core export manifest identity mismatch')
    }
    if (candidate && typeof candidate.boot === 'function') {
      // Preserve the entry object as `this`; third-party Core methods are
      // allowed to keep state on their exported HostCoreEntry instance.
      const coreEntry = {
        invoke: function (operation, input) {
          if (typeof candidate.invoke !== 'function') throw new Error('core invoke unavailable')
          return candidate.invoke.call(candidate, operation, input)
        },
        shutdown: function () {
          if (typeof candidate.shutdown !== 'function') return undefined
          return candidate.shutdown.call(candidate)
        },
      }
      // These are optional Android portable-host extensions. Keep them when a
      // Core supplies them so the data-plane business route and view adapters
      // survive the v2 wrapper as well.
      if (typeof candidate.getView === 'function') coreEntry.getView = function () { return candidate.getView.call(candidate) }
      if (typeof candidate.handlePortableRequest === 'function') coreEntry.handlePortableRequest = function () { return candidate.handlePortableRequest.apply(candidate, arguments) }
      if (typeof candidate.cancelPortableRequest === 'function') coreEntry.cancelPortableRequest = function (requestId) { return candidate.cancelPortableRequest.call(candidate, requestId) }
      localCore = coreEntry
      let readyCalled = false
      let failedCalled = false
      await candidate.boot({
        request: effectiveRequest,
        components: loadedPlugins.map(function (entry) { return Object.freeze({ manifest: entry.config.manifest, defaultExport: entry.module.default, module: entry.module }) }),
        host: createV2HostPort(effectiveConfig),
        ready: function (signal) {
          if (failedCalled) throw new Error('Core already reported failure')
          if (readyCalled) throw new Error('Core ready called more than once')
          if (signal && signal.hostApiVersion && signal.hostApiVersion !== effectiveRequest.hostApiVersion) throw new Error('Host API mismatch')
          if (signal && signal.coreId && signal.coreId !== config.core.id) throw new Error('Core identity mismatch')
          if (signal && signal.coreVersion && signal.coreVersion !== config.core.version) throw new Error('Core version mismatch')
          if (signal && signal.planHash && signal.planHash !== effectiveRequest.planHash) throw new Error('launch plan mismatch')
          readyCalled = true
        },
        // failed() may be called from a later async callback after boot()
        // returned, so notify Java directly instead of relying on a Promise
        // rejection that no longer belongs to the boot call stack.
        failed: function (code, message) {
          failedCalled = true
          reportCoreFailure(code || 'core_failed', message || 'Core failed')
        },
      })
      if (!readyCalled) throw new Error('v2 Core boot returned without ready handshake')
      return
    }
    if (candidate && candidate.kind === 'core' && typeof candidate.start === 'function') {
      const commands = {}
      let readyCalled = false
      const hostPort = createV2HostPort(effectiveConfig)
      const coreCaller = { pluginId: config.core.id, version: config.core.version }
      const startContext = { apiVersion: config.request.hostApiVersion, pluginId: config.core.id, config: {}, components: loadedPlugins.map(function (entry) { return Object.freeze({ manifest: entry.config.manifest, defaultExport: entry.module.default, module: entry.module }) }), log: function (level, message, details) { hostPort.call('host.log', { level: level, message: message, details: details }, coreCaller).catch(function () { }) }, registerCommand: function (name, handler) { commands[name] = handler }, ready: function () { readyCalled = true } }
      await candidate.start(startContext)
      if (!readyCalled) throw new Error('v2 Core start returned without ready handshake')
      const coreEntry = {
        invoke: function (operation, input) {
          if (!commands[operation]) throw new Error('unknown Core operation ' + operation)
          return commands[operation](input)
        },
        shutdown: function () {
          if (typeof candidate.stop !== 'function') return undefined
          return candidate.stop.call(candidate, startContext)
        },
      }
      if (typeof candidate.getView === 'function') coreEntry.getView = function () { return candidate.getView.call(candidate) }
      if (typeof candidate.handlePortableRequest === 'function') coreEntry.handlePortableRequest = function () { return candidate.handlePortableRequest.apply(candidate, arguments) }
      if (typeof candidate.cancelPortableRequest === 'function') coreEntry.cancelPortableRequest = function (requestId) { return candidate.cancelPortableRequest.call(candidate, requestId) }
      localCore = coreEntry
      return
    }
    throw new Error('v2 Core default export does not implement Host-Core ABI or M2 defineCore')
  }

  window.addEventListener('DOMContentLoaded', function () {
    const bundleGlobals = Object.getOwnPropertyNames(globalThis).filter(function (name) {
      return /StageCraft|EmbeddedCore/i.test(name)
    })
    log('bundle globals: ' + (bundleGlobals.join(', ') || '(none)'))
    log('core-host-bridge ready; waiting for host bridge port')
  })
})()
