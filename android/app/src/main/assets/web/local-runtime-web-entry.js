/**
 * StageCraft 本地运行时 Web 入口（Android APK 内置）。
 *
 * 把打包的完整 Web UI（public/）与页面内运行的本地 Core 连接起来：
 * - fetch / EventSource 桥接 /api/* 请求与 StageCraft 本地运行时；
 * - 与 PC 端 app-boot.ts 复用同一套 HTTP 契约与 Core 命令协议（{roomId, scope, action}）；
 * - /api/events、/api/thinking-events 由本地 Core 消息流驱动。
 */
(function () {
  'use strict'
  const core = window.StageCraftOfflineCore
  if (!core) throw new Error('本地 Core 未加载（local-runtime-web-entry.js 必须在 embedded-core.js 之后执行）。')
  const ROOM_ID = core.roomId || 'android-local-room'

  // ── 内部事件总线 ──
  const channels = { room: [], thinking: [], summary: [], core: [] }
  function publish(channel, payload) {
    const listeners = channels[channel]
    if (!listeners || listeners.length === 0) return
    for (const listener of [...listeners]) {
      try { listener(payload) } catch (error) { console.error('[offline] listener error', error) }
    }
  }
  function onChannel(channel, listener) {
    channels[channel].push(listener)
    return () => { const index = channels[channel].indexOf(listener); if (index >= 0) channels[channel].splice(index, 1) }
  }

  // ── 与 app-boot.ts publicRoomSnapshot 相同的归一化 ──
  function publicRoomSnapshot(room) {
    return { ...room, roles: (room.roles ?? []).map(role => ({ ...role, name: role.name ?? '', currentState: role.currentState ?? '', presence: role.presence ?? 'present', portraitRef: role.portraitRef ?? '/assets/default.svg', selfModel: role.selfModel ?? '', goals: role.goals ?? [], impressions: role.impressions ?? {}, memories: role.memories ?? [] })) }
  }

  // ── 离线核心消息 → 频道 ──
  core.start(messageStr => {
    let message
    try { message = typeof messageStr === 'string' ? JSON.parse(messageStr) : messageStr } catch { return }
    if (message.type === 'connection.state') {
      if (message.state === 'connected') publish('core', { type: 'offline.connected' })
      console.info('[offline]', message.state)
    } else if (message.type === 'core.resync' || message.type === 'room.changed') {
      try { publish('room', publicRoomSnapshot(core.getRoom())) } catch { /* 房间尚未就绪 */ }
    } else if (message.type === 'thinking') {
      publish('thinking', message.event)
    } else if (message.type === 'core.event') {
      publish('core', message.event)
    } else if (message.type === 'connection.error') {
      console.error('[offline]', message.message)
      publish('core', { type: 'error', message: message.message })
      if (typeof window.showOperationError === 'function') window.showOperationError('本地文件操作', new Error(message.message || '操作失败。'))
    }
  })

  // ── SSE 模拟（EventSource 补丁）──
  const NativeEventSource = window.EventSource
  class OfflineEventSource {
    constructor(url, options) {
      this.url = String(url)
      this.readyState = 0
      this._listeners = new Map()
      this._unsub = null
      const path = new URL(this.url, window.location.href).pathname
      const channel = path.includes('thinking') ? 'thinking' : path.includes('debug') ? 'summary' : 'room'
      if (path.includes('debug')) {
        // 调试通道：无事件可发，保持连接
        this._push('summary', { text: '离线模式调试摘要：仅记录本地生成事件。', at: new Date().toISOString() })
      } else if (channel === 'room') {
        try { this._push('room', publicRoomSnapshot(core.getRoom())) } catch { /* 稍后由消息流补齐 */ }
      }
      this._unsub = onChannel(channel, payload => this._push(channel, payload))
      this.readyState = 1
      queueMicrotask(() => { try { this.onopen && this.onopen(new Event('open')) } catch { /* 忽略 */ } })
    }
    _push(eventName, payload) {
      const event = new MessageEvent(eventName, { data: typeof payload === 'string' ? payload : JSON.stringify(payload) })
      for (const listener of this._listeners.get(eventName) ?? []) {
        try { listener.call(this, event) } catch (error) { console.error('[offline]', error) }
      }
      try { if (this.onmessage && eventName === 'message') this.onmessage(event) } catch { /* 忽略 */ }
    }
    addEventListener(type, listener) {
      const set = this._listeners.get(type) ?? new Set()
      set.add(listener)
      this._listeners.set(type, set)
    }
    removeEventListener(type, listener) {
      const set = this._listeners.get(type)
      if (set) set.delete(listener)
    }
    close() {
      this.readyState = 2
      if (this._unsub) this._unsub()
      this._unsub = null
    }
  }
  window.EventSource = OfflineEventSource
  window.NativeEventSource = NativeEventSource

  // ── 通用工具 ──
  const jsonHeaders = { 'content-type': 'application/json' }
  function respondJson(status, value) {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
  }
  /** 降级：POST 返回 {ok:false,error}（前端 alert 展示），GET 返回 400 {error}。 */
  function unavailable(message) {
    return { status: 200, body: { ok: false, error: `离线模式暂不支持：${message}` } }
  }
  function throwError(message) {
    return { throw: new Error(message) }
  }
  function dispatchCommand(command) {
    return core.dispatchCommand(command)
  }
  function management(operation, payload = {}) {
    return dispatchCommand({ id: `offline-mgmt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, actor: 'operator', type: 'role-management', payload: { roomId: ROOM_ID, operation, ...payload } })
  }
  function playerCommand(type, payload) {
    return dispatchCommand({ id: `offline-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, actor: 'player', type, payload })
  }
  const guardRoom = () => {
    try { return core.getRoom() } catch { throw new Error('离线房间不可用。') }
  }
  function providerMeta() {
    try {
      const raw = window.StageCraftNative.invokeSync('secret.get', JSON.stringify({ key: 'offline.provider.meta' }))
      const parsed = raw ? JSON.parse(raw) : {}
      if (parsed && typeof parsed === 'object' && parsed.found && typeof parsed.value === 'string') return JSON.parse(parsed.value)
    } catch { /* 无配置 */ }
    return { providers: [], defaults: {} }
  }
  function saveProviderMeta(meta) {
    nativeInvokeSync('secret.set', { key: 'offline.provider.meta', value: JSON.stringify(meta) })
  }
  function nativeInvokeSync(operation, input) {
    const raw = window.StageCraftNative.invokeSync(operation, JSON.stringify(input ?? {}))
    const result = JSON.parse(String(raw ?? 'null'))
    if (result && typeof result === 'object' && result.error) throw new Error(result.error.message || '本地操作失败。')
    return result
  }

  // ── 路由表 ──
  const routes = {
    /** GET 数据端点 */
    get: {
      '/api/room': () => respondJson(200, publicRoomSnapshot(guardRoom())),
      '/api/stories': () => respondJson(200, core.stories()),
      '/api/archive/export': () => respondJson(200, { version: 1, exportedAt: new Date().toISOString(), room: guardRoom() }),
      '/api/archive/list': () => respondJson(200, nativeInvokeSync('archive.list', {})),
      '/api/story/get': (params) => core.story(String(params.get('id') ?? '')).then(story => respondJson(200, story)).catch(error => respondJson(400, { error: error.message })),
      '/api/providers': () => respondJson(200, providerMeta()),
      '/api/usage': () => {
        const configured = core.getProvider().configured === true
        return respondJson(200, { route: configured ? '离线' : '模拟', model: configured ? core.getProvider().model : '模拟', requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalDurationMs: 0, avgDurationMs: 0, mode: configured ? 'offline' : 'fake', billing: { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 } })
      },
      '/api/billing': () => respondJson(200, { prices: {}, stats: { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 } }),
      '/api/prompts/presets': () => { const data = nativeInvokeSync('preset.list', {}); return respondJson(200, { presets: Array.isArray(data.presets) ? data.presets : [], activeByScope: data.activeByScope ?? {}, modes: [{ id: 'director', name: '导演模式' }, { id: 'chat', name: '群聊模式' }], promptTemplates: null, gameplayScenarios: {} }) },
      '/api/prompts/private-toggles': () => respondJson(200, {}),
      '/api/roles/memories': (params) => {
        const roleId = String(params.get('roleId') ?? '')
        const room = guardRoom()
        return respondJson(200, { memories: (room.roles ?? []).find(role => role.id === roleId)?.memories ?? [] })
      },
      '/api/agent/capability': () => respondJson(200, { enabled: false, reason: '独立模式未接入 DSH' }),
    },
    /** POST 命令端点 */
    post: {
      '/api/restart': async (body) => {
        const room = guardRoom()
        const story = await core.story(String(body.storyId ?? room.storyId ?? 'eldoria'))
        core.restart(story, { ...(body.mode === 'chat' || body.mode === 'director' ? { mode: body.mode } : {}), ...(typeof body.autoPublish === 'boolean' ? { autoPublish: body.autoPublish } : {}) })
        return respondJson(200, { ok: true, roomId: ROOM_ID })
      },
      '/api/archive/save': (body) => respondJson(200, nativeInvokeSync('archive.save', { name: String(body.name ?? '').trim() || `存档-${Date.now()}`, archive: { version: 1, exportedAt: new Date().toISOString(), room: guardRoom() } })),
      '/api/archive/load': (body) => { const archive = nativeInvokeSync('archive.load', { name: String(body.name ?? '') }); nativeInvokeSync('stagecraft.repository', { method: 'importRoom', args: [ROOM_ID, archive] }); core.refresh(); return respondJson(200, { ok: true, name: body.name }) },
      '/api/archive/delete': (body) => respondJson(200, nativeInvokeSync('archive.delete', { name: String(body.name ?? '') })),
      '/api/story/import': () => respondJson(501, { error: '独立 APK 的剧本文件导入将在系统文件选择器接入后提供。' }),
      '/api/room-config': (body) => {
        const room = guardRoom()
        // room-config 走管理通道（与 app-boot dispatchManagement('set-room-config') 一致）
        management('set-room-config', {
          ...(['director', 'chat'].includes(body.mode) ? { mode: body.mode } : {}),
          ...(typeof body.autoPublish === 'boolean' ? { autoPublish: body.autoPublish } : {}),
          ...(['manual', 'director', 'all'].includes(body.speechMode) ? { speechMode: body.speechMode } : {}),
          ...(typeof body.hidePlayerSpeech === 'boolean' ? { hidePlayerSpeech: body.hidePlayerSpeech } : {}),
        })
        return respondJson(200, { ok: true, room: guardRoom() })
      },
      '/api/player-character': (body) => {
        management('update-player-character', { name: String(body.name ?? ''), persona: String(body.persona ?? ''), currentState: String(body.currentState ?? '') })
        return respondJson(200, { ok: true, room: guardRoom() })
      },
      '/api/player/avatar': () => respondJson(200, { ok: false, error: '离线模式暂不支持上传头像；可在角色设置里填写头像路径。' }),
      '/api/turn': (body) => {
        const room = guardRoom()
        const action = room.mode === 'chat' ? 'chat-contribution' : 'director-turn'
        return playerCommand('submit-text', { roomId: ROOM_ID, scope: room.mode, action, text: String(body.text ?? ''), requiredRoleIds: Array.isArray(body.requiredRoleIds) ? body.requiredRoleIds.map(String) : [] }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message }))
      },
      '/api/chat/speak': (body) => playerCommand('select-role', { roomId: ROOM_ID, scope: 'chat', action: 'chat-speech', roleId: String(body.roleId ?? ''), feedback: String(body.feedback ?? '') }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message })),
      '/api/chat/director-decide': () => playerCommand('select-role', { roomId: ROOM_ID, scope: 'chat', action: 'director-role-selection' }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message })),
      '/api/chat/speak-all': () => playerCommand('select-role', { roomId: ROOM_ID, scope: 'chat', action: 'chat-speech-all' }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message })),
      '/api/chat/approve-speech': (body) => {
        const worldChange = body.worldChange && typeof body.worldChange === 'object' ? body.worldChange : null
        return playerCommand('approve', { roomId: ROOM_ID, scope: 'chat', action: 'speech', text: String(body.text ?? ''), worldChange }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message }))
      },
      '/api/chat/reject-speech': () => playerCommand('reject', { roomId: ROOM_ID, scope: 'chat', action: 'speech' }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message })),
      '/api/chat/retry': () => playerCommand('retry', { roomId: ROOM_ID, scope: 'chat', action: 'chat-speech' }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message })),
      '/api/chat/director-chat': (body) => playerCommand('submit-text', { roomId: ROOM_ID, scope: 'chat', action: 'director-chat', text: String(body.text ?? '') }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message })),
      '/api/world-change/approve': (body) => {
        const worldChange = body.worldChange && typeof body.worldChange === 'object' ? body.worldChange : null
        return playerCommand('approve', { roomId: ROOM_ID, scope: 'chat', action: 'world-change', worldChange }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message }))
      },
      '/api/world-change/reject': () => playerCommand('reject', { roomId: ROOM_ID, scope: 'chat', action: 'world-change' }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message })),
      '/api/director/proceed': () => playerCommand('submit-text', { roomId: ROOM_ID, scope: 'director', action: 'director-proceed' }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message })),
      '/api/director/retry': () => playerCommand('retry', { roomId: ROOM_ID, scope: 'director', action: 'director-retry' }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message })),
      '/api/director/setting': (body) => {
        const text = String(body.text ?? '').trim()
        if (!text) return respondJson(400, { error: '设定内容为空。' })
        management('set-director-setting', { text })
        return respondJson(200, { ok: true })
      },
      '/api/approve': (body) => {
        const sceneUpdates = body.sceneUpdates && typeof body.sceneUpdates === 'object'
          ? { ...(typeof body.sceneUpdates.time === 'string' ? { time: body.sceneUpdates.time } : {}), ...(typeof body.sceneUpdates.location === 'string' ? { location: body.sceneUpdates.location } : {}) }
          : undefined
        return playerCommand('approve', { roomId: ROOM_ID, scope: 'director', action: 'draft-approval', draftId: String(body.draftId), text: String(body.text), stateUpdates: body.stateUpdates && typeof body.stateUpdates === 'object' ? body.stateUpdates : {}, ...(sceneUpdates ? { sceneUpdates } : {}) }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message }))
      },
      '/api/reactions/reconsider': (body) => playerCommand('retry', { roomId: ROOM_ID, scope: 'director', action: 'reconsider-reaction', roleId: String(body.roleId ?? ''), feedback: String(body.feedback ?? '') }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message })),
      '/api/consult': (body) => playerCommand('submit-text', { roomId: ROOM_ID, scope: 'director', action: 'director-consult', draftId: String(body.draftId ?? ''), text: String(body.text ?? ''), context: String(body.context ?? '') }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message })),
      '/api/consult/finish': () => playerCommand('approve', { roomId: ROOM_ID, scope: 'director', action: 'consult-finish' }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message })),
      '/api/redraft': (body) => playerCommand('retry', { roomId: ROOM_ID, scope: 'director', action: 'redraft', draftId: String(body.draftId ?? '') }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message })),
      '/api/cancel-turn': () => {
        const room = guardRoom()
        return playerCommand('cancel', { roomId: ROOM_ID, scope: room.mode, action: 'cancel-turn' }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: error.message }))
      },
      '/api/scene': (body) => {
        management('update-scene', { ...(typeof body.time === 'string' ? { time: body.time } : {}), ...(typeof body.location === 'string' ? { location: body.location } : {}) })
        return respondJson(200, { ok: true })
      },
      '/api/lore': (body) => {
        const lore = Array.isArray(body.lore) ? body.lore.map(entry => ({ name: String(entry.name ?? ''), content: String(entry.content ?? ''), ...(Array.isArray(entry.roles) ? { roles: entry.roles.map(String) } : {}) })).filter(entry => entry.name && entry.content) : []
        management('save-lore', { lore })
        return respondJson(200, { ok: true })
      },
      '/api/roles/create': (body) => {
        const id = String(body.id ?? '').trim() || `role-${Date.now()}`
        const portraitRef = String(body.portraitRef ?? '/assets/default.svg').startsWith('/') ? String(body.portraitRef ?? '/assets/default.svg') : '/assets/default.svg'
        management('create-role', { role: { id, name: String(body.name ?? '').trim(), portraitRef, currentState: String(body.currentState ?? '刚刚进入当前场景。'), presence: ['present', 'absent', 'unavailable'].includes(String(body.presence)) ? String(body.presence) : 'present', selfModel: String(body.selfModel ?? ''), ...(Array.isArray(body.memories) ? { memories: body.memories } : {}), ...(typeof body.goals === 'string' ? { goals: JSON.parse(body.goals) } : {}) } })
        return respondJson(200, { ok: true })
      },
      '/api/roles/delete': (body) => { management('delete-role', { roleId: String(body.roleId ?? '') }); return respondJson(200, { ok: true }) },
      '/api/roles/presence': (body) => {
        const presence = String(body.presence ?? '')
        if (!['present', 'absent', 'unavailable'].includes(presence)) return respondJson(400, { error: '无效的在场状态。' })
        management('set-role-presence', { roleId: String(body.roleId ?? ''), presence })
        return respondJson(200, { ok: true })
      },
      '/api/roles/thinking': (body) => { management('set-role-thinking', { roleId: String(body.roleId ?? ''), thinkingStrength: String(body.thinking ?? 'off') }); return respondJson(200, { ok: true }) },
      '/api/roles/reorder': (body) => {
        const roleIds = Array.isArray(body.roleIds) ? body.roleIds.map(String) : []
        if (!roleIds.length) return respondJson(400, { error: '缺少角色顺序列表。' })
        management('reorder-roles', { roleIds }); return respondJson(200, { ok: true })
      },
      '/api/roles/avatar': () => respondJson(200, { ok: false, error: '离线模式暂不支持上传头像；可在角色设置里填写头像路径。' }),
      '/api/roles/state': (body) => { management('set-role-state', { roleId: String(body.roleId ?? ''), currentState: String(body.currentState ?? '') }); return respondJson(200, { ok: true }) },
      '/api/roles/intervene': (body) => {
        management('intervene-role', { roleId: String(body.roleId ?? ''), selfModel: String(body.selfModel ?? ''), config: { ...(body.providerId ? { providerId: String(body.providerId) } : {}), ...(body.modelOverride ? { modelOverride: String(body.modelOverride) } : {}), ...(typeof body.impressions === 'string' ? { impressions: JSON.parse(body.impressions) } : {}), ...(typeof body.goals === 'string' ? { goals: JSON.parse(body.goals) } : {}), ...(body.thinkingStrength ? { thinkingStrength: String(body.thinkingStrength) } : {}) } })
        return respondJson(200, { ok: true })
      },
      '/api/roles/memories': (body) => {
        management('store-memories', { roleId: String(body.roleId ?? ''), entries: Array.isArray(body.entries) ? body.entries : [] })
        return respondJson(200, { ok: true })
      },
      '/api/roles/memories/retract': (body) => management('retract-memory', { memoryId: String(body.memoryId ?? '') }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: `离线暂不支持：${error.message}` })),
      '/api/roles/memories/update': (body) => management('update-memory', { memoryId: String(body.memoryId ?? ''), entry: body.entry ?? {} }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: `离线暂不支持：${error.message}` })),
      '/api/roles/memories/reorder': (body) => {
        const memoryIds = Array.isArray(body.memoryIds) ? body.memoryIds.map(String) : []
        if (!memoryIds.length) return respondJson(400, { error: '缺少记忆顺序列表。' })
        return management('reorder-memories', { roleId: String(body.roleId ?? ''), memoryIds }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: `离线暂不支持：${error.message}` }))
      },
      '/api/roles/memories/supersede': (body) => management('supersede-memory', { memoryId: String(body.memoryId ?? ''), entry: body.entry ?? {} }).then(() => respondJson(200, { ok: true })).catch(error => respondJson(200, { ok: false, error: `离线暂不支持：${error.message}` })),
      '/api/providers/save': (body) => {
        const meta = providerMeta()
        const baseUrl = String(body.baseUrl ?? '').replace(/\/$/, '')
        const apiKey = String(body.apiKey ?? '')
        const existing = meta.providers.find(provider => provider.id === 'offline-default')
        const models = Array.isArray(body.models) ? body.models.map(String) : typeof body.models === 'string' && body.models.trim() ? body.models.split(/[,，]/).map(item => item.trim()).filter(Boolean) : (existing?.models ?? [])
        const selectedModel = String(body.selectedModel ?? '') || models[0] || existing?.selectedModel || ''
        if (!baseUrl || !apiKey || !selectedModel) return respondJson(400, { error: '离线模式需要接口地址、API Key 与至少一个模型名。' })
        const provider = { id: 'offline-default', name: String(body.name ?? '离线供应商'), baseUrl, apiKey, models, selectedModel, responseFormat: body.responseFormat === 'none' ? 'none' : 'json_object', toolCalling: body.toolCalling !== false }
        meta.providers = [provider]
        saveProviderMeta(meta)
        core.setProvider({ baseUrl, apiKey, model: selectedModel, responseFormat: provider.responseFormat })
        return respondJson(200, { providers: meta.providers, defaults: meta.defaults, active: { route: '离线', model: selectedModel } })
      },
      '/api/providers/delete': () => {
        saveProviderMeta({ providers: [], defaults: {} })
        window.StageCraftNative.invokeSync('secret.remove', JSON.stringify({ key: 'offline.provider.default' }))
        return respondJson(200, { providers: [], defaults: {}, active: { route: '模拟', model: '模拟' } })
      },
      '/api/providers/default-role': (body) => {
        const meta = providerMeta()
        const provider = meta.providers.find(item => item.id === 'offline-default')
        if (provider) {
          if (body.model) provider.selectedModel = String(body.model)
          meta.defaults = { ...(meta.defaults ?? {}), role: { providerId: 'offline-default', model: String(body.model ?? provider.selectedModel) } }
          saveProviderMeta(meta)
          core.setProvider({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: String(body.model ?? provider.selectedModel), responseFormat: provider.responseFormat })
        }
        return respondJson(200, { providers: meta.providers, defaults: meta.defaults })
      },
      '/api/providers/director': (body) => {
        const meta = providerMeta()
        const provider = meta.providers.find(item => item.id === 'offline-default')
        if (provider) {
          if (body.model) provider.selectedModel = String(body.model)
          meta.defaults = { ...(meta.defaults ?? {}), director: { providerId: 'offline-default', model: String(body.model ?? provider.selectedModel) } }
          saveProviderMeta(meta)
          core.setProvider({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: String(body.model ?? provider.selectedModel), responseFormat: provider.responseFormat })
        }
        return respondJson(200, { providers: meta.providers, defaults: meta.defaults })
      },
      '/api/providers/director-thinking': () => respondJson(200, { ok: true, defaults: providerMeta().defaults }),
      '/api/providers/discover': () => respondJson(400, { error: '离线模式不支持自动发现模型；请直接在模型列表里填写模型名（如 deepseek-chat）。' }),
      '/api/prompts/presets': (body) => {
        try {
          if (body.scope && body.activePresetId) { const data = nativeInvokeSync('preset.list', {}); return respondJson(200, { ok: true, presets: data.presets ?? [], activeByScope: { ...(data.activeByScope ?? {}), [String(body.scope)]: String(body.activePresetId) } }) }
          const preset = body.preset && typeof body.preset === 'object' ? body.preset : body
          nativeInvokeSync('preset.save', { preset })
          const data = nativeInvokeSync('preset.list', {})
          return respondJson(200, { ok: true, presets: data.presets ?? [], activeByScope: data.activeByScope ?? {} })
        } catch (error) { return respondJson(400, { error: error instanceof Error ? error.message : String(error) }) }
      },
      '/api/story/save': (body) => {
        const story = body.story && typeof body.story === 'object' ? body.story : null
        if (!story?.id) return respondJson(400, { error: '剧本缺少 id。' })
        try {
          const result = nativeInvokeSync('story.save', { story })
          return respondJson(200, result)
        } catch (error) { return respondJson(400, { error: error.message }) }
      },
      '/api/story/save-as': (body) => {
        const story = body.story && typeof body.story === 'object' ? { ...body.story } : null
        if (!story) return respondJson(400, { error: '剧本缺少内容。' })
        const title = String(body.title ?? story.title ?? '未命名剧本').trim() || '未命名剧本'
        const id = String(body.id ?? '').trim() || `story-${Date.now().toString(36)}`
        try {
          const result = nativeInvokeSync('story.saveAs', { story, id, title })
          return respondJson(200, result)
        } catch (error) { return respondJson(400, { error: error.message }) }
      },
      '/api/stories': (body) => {
        const title = String(body.title ?? '').trim() || '未命名剧本'
        try {
          const result = nativeInvokeSync('story.create', { title, opening: body.opening, sceneTime: body.sceneTime, sceneLocation: body.sceneLocation })
          if (!result || typeof result !== 'object' || !result.id) throw new Error('本地剧本创建未返回有效 ID。')
          return respondJson(200, result)
        } catch (error) { console.error('[local-runtime] story.create failed', error); return respondJson(400, { error: error instanceof Error ? error.message : String(error) }) }
      },
    },
    delete: {
      '/api/prompts/presets': (params) => {
        try { nativeInvokeSync('preset.delete', { id: String(params.get('id') ?? '') }); const data = nativeInvokeSync('preset.list', {}); return respondJson(200, { ok: true, presets: data.presets ?? [], activeByScope: data.activeByScope ?? {} }) }
        catch (error) { return respondJson(400, { error: error instanceof Error ? error.message : String(error) }) }
      },
      '/api/stories': (params) => {
        const id = String(params.get('id') ?? '')
        if (!id) return respondJson(400, { error: '缺少剧本 id。' })
        try {
          const result = nativeInvokeSync('story.delete', { id })
          return respondJson(200, result)
        } catch (error) { return respondJson(400, { error: error.message }) }
      },
    },
  }
  const DEGRADED = {
    '/api/archive/import': '导入存档',
    '/api/state/scene-revision': '正文字段回滚',
    '/api/state/rollback': '正文回滚',
    '/api/state/branch': '正文分支',
    '/api/creator/preview': '创作者工作台预览',
    '/api/creator/apply': '创作者工作台应用',
    '/api/creator/revert': '创作者工作台撤销',
    '/api/story/save': '剧本保存',
    '/api/story/save-as': '剧本另存为',
    '/api/story/sync-role': '同步人物到剧本',
    '/api/story/sync-roles': '同步人物到剧本',
    '/api/st-cards/import': 'ST 角色卡导入',
    '/api/agent/session': 'DSH 剧本助手会话',
    '/api/agent/history': 'DSH 会话历史',
    '/api/agent/models': 'DSH 会话模型',
    '/api/agent/model': 'DSH 会话模型',
    '/api/agent/message': 'DSH 助手消息',
    '/api/agent/archive': 'DSH 会话存档',
    '/api/billing/prices': '价目表修改',
    '/api/billing/reset': '计费重置',
    '/api/prompts/private-toggles': '预设私设开关',
    '/api/prompts/import-st': 'ST 预设导入',
    '/api/remote/revoke': '远程会话管理',
  }

  // ── /api/core/* 协议端点（CoreClient 交互面板）──
  function respondJsonAsync(status, value) { return Promise.resolve(respondJson(status, value)) }

  // ── fetch 补丁 ──
  const originalFetch = window.fetch.bind(window)
  window.fetch = (input, init = {}) => {
    let url
    try { url = typeof input === 'string' ? new URL(input, window.location.href) : (input && input.url ? new URL(input.url, window.location.href) : null) } catch { return originalFetch(input, init) }
    if (!url || url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return originalFetch(input, init)
    const method = String(init.method ?? (typeof input === 'object' && input && input.method ? input.method : 'GET')).toUpperCase()
    const pathname = url.pathname
    // SSE（CoreClient 用 fetch 读流）
    if (pathname === '/api/core/events') {
      const abortSignal = init.signal ?? null
      const stream = new ReadableStream({
        start(controller_) {
          const push = (event) => {
            try { controller_.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)) } catch { /* 流已关闭 */ }
          }
          const unsubscribe = onChannel('core', push)
          const abort = () => { unsubscribe() }
          if (abortSignal) {
            if (abortSignal.aborted) abort()
            else abortSignal.addEventListener('abort', abort, { once: true })
          }
        },
        cancel() { /* 订阅随流关闭由 GC 收回 */ },
      })
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    }
    if (pathname === '/api/core/view') return respondJsonAsync(200, core.getView())
    if (pathname === '/api/core/commands') {
      return new Promise(resolve => {
        const body = JSON.parse(String(init.body ?? '{}'))
        core.dispatchCommand(body)
          .then(() => resolve(respondJson(200, { ok: true, view: core.getView() })))
          .catch(error => resolve(respondJson(400, { error: error.message })))
      })
    }
    if (pathname === '/api/core/ui/action') return respondJsonAsync(200, { ok: false, error: '离线模式暂不支持扩展面板操作。' })

    const handler = routes[method.toLowerCase()] && routes[method.toLowerCase()][pathname]
    if (handler) {
      return new Promise(resolve => {
        let body = {}
        const raw = String(init.body ?? '')
        if (raw) { try { body = JSON.parse(raw) } catch { /* 非 JSON 忽略 */ } }
        try {
          const result = (method === 'GET' || method === 'DELETE') ? handler(url.searchParams) : handler(body)
          if (result && typeof result.then === 'function') result.then(resolve).catch(error => resolve(respondJson(400, { error: error instanceof Error ? error.message : String(error) })))
          else resolve(result)
        } catch (error) {
          resolve(respondJson(400, { error: error instanceof Error ? error.message : String(error) }))
        }
      })
    }
    if (pathname in DEGRADED) {
      const message = DEGRADED[pathname]
      return Promise.resolve(method === 'GET' ? respondJson(503, { error: `本地运行时暂不支持：${message}` }) : respondJson(503, { error: `本地运行时暂不支持：${message}` }))
    }
    return Promise.resolve(method === 'GET' ? respondJson(404, { error: 'Not found' }) : respondJson(404, { error: '未知的本地接口。' }))
  }

  // ── 与电脑双向同步（原生桥承载配对与远端 HTTP；配对凭据不进入页面） ──
  const syncPendingFetches = new Map()
  window.StageCraftSyncFetchResult = result => {
    const entry = result && syncPendingFetches.get(result.callbackId)
    if (!entry) return
    syncPendingFetches.delete(result.callbackId)
    if (!result.ok) { entry.reject(new Error(result.message || '同步请求失败。')); return }
    try { entry.resolve(result.body ? JSON.parse(result.body) : null) } catch { entry.reject(new Error('同步响应无效。')) }
  }
  function syncRemoteFetch(method, body) {
    return new Promise((resolve, reject) => {
      const callbackId = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      syncPendingFetches.set(callbackId, { resolve, reject })
      window.StageCraftNative.syncRemoteFetch(method, body ? JSON.stringify(body) : '', callbackId)
    })
  }
  window.StageCraftSyncPairResult = result => {
    const pending = window.__syncPairPending
    if (!pending) return
    window.__syncPairPending = null
    pending(result || { ok: false, message: '绑定无响应。' })
  }
  const syncRemote = {
    async status() {
      try { const raw = window.StageCraftNative.syncStatus(); const parsed = raw ? JSON.parse(String(raw)) : null; return parsed && typeof parsed === 'object' ? parsed : { paired: false } }
      catch { return { paired: false } }
    },
    pair(address, code) {
      return new Promise(resolve => {
        window.__syncPairPending = resolve
        window.StageCraftNative.syncPair(String(address || ''), !/^https:\/\//i.test(String(address || '')), String(code || ''))
      })
    },
    async pull() {
      const payload = await syncRemoteFetch('GET')
      if (!payload || typeof payload !== 'object') throw new Error('电脑返回的同步数据无效。')
      const result = { room: false, providers: false, saves: 0, stories: 0, presets: 0 }
      const providerList = payload.providers && Array.isArray(payload.providers.providers) ? payload.providers.providers : []
      if (providerList.length) {
        const preferred = providerList.find(item => item && item.selectedModel) || providerList[0]
        const baseUrl = String(preferred?.baseUrl ?? '').replace(/\/$/, '')
        const models = Array.isArray(preferred?.models) ? preferred.models.map(String) : []
        const selectedModel = String(preferred?.selectedModel ?? models[0] ?? '')
        if (baseUrl && String(preferred?.apiKey ?? '') && selectedModel) {
          const provider = { id: 'offline-default', name: String(preferred?.name ?? '同步供应商'), baseUrl, apiKey: String(preferred.apiKey ?? ''), models, selectedModel, responseFormat: preferred?.responseFormat === 'none' ? 'none' : 'json_object', toolCalling: preferred?.toolCalling !== false }
          saveProviderMeta({ providers: [provider], defaults: {} })
          core.setProvider({ baseUrl, apiKey: String(preferred.apiKey ?? ''), model: selectedModel, responseFormat: provider.responseFormat })
          result.providers = true
        }
      }
      if (payload.room && typeof payload.room === 'object' && payload.room.room && typeof payload.room.room === 'object') {
        nativeInvokeSync('stagecraft.repository', { method: 'importRoom', args: [ROOM_ID, payload.room] })
        core.refresh()
        result.room = true
      }
      if (Array.isArray(payload.saves)) for (const item of payload.saves) if (item && typeof item === 'object' && String(item.name ?? '').trim() && item.archive && typeof item.archive === 'object') { try { nativeInvokeSync('archive.save', { name: String(item.name), archive: item.archive }); result.saves++ } catch { /* 跳过无效存档 */ } }
      if (Array.isArray(payload.stories)) for (const story of payload.stories) if (story && typeof story === 'object' && String(story.id ?? '').trim()) { try { nativeInvokeSync('story.save', { story }); result.stories++ } catch { /* 跳过本机不支持的剧本 */ } }
      const presetList = Array.isArray(payload.prompts?.presets) ? payload.prompts.presets : (Array.isArray(payload.prompts?.presets?.presets) ? payload.prompts.presets.presets : [])
      for (const preset of presetList) if (preset && typeof preset === 'object' && String(preset.id ?? '').trim()) { try { nativeInvokeSync('preset.save', { preset }); result.presets++ } catch { /* 跳过无效预设 */ } }
      return result
    },
    async push() {
      const result = { room: false, providers: false, saves: 0, stories: 0, presets: 0 }
      const roomPayload = (() => { try { return { version: 1, exportedAt: new Date().toISOString(), room: guardRoom() } } catch { return null } })()
      if (roomPayload) result.room = true
      const saves = []
      try { for (const name of (nativeInvokeSync('archive.list', {}).files ?? [])) { try { saves.push({ name, archive: nativeInvokeSync('archive.load', { name }) }) } catch { /* 跳过损坏存档 */ } } } catch { /* 无存档 */ }
      result.saves = saves.length
      const stories = []
      try {
        const raw = core.stories()
        const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.stories) ? raw.stories : [])
        for (const item of list) { const id = String(item?.id ?? '').trim(); if (!id) continue; try { stories.push(await core.story(id)) } catch { /* 跳过不可读剧本 */ } }
      } catch { /* 本地剧本不可用 */ }
      result.stories = stories.length
      const presets = []
      try { const data = nativeInvokeSync('preset.list', {}); if (Array.isArray(data.presets)) presets.push(...data.presets) } catch { /* 无预设 */ }
      result.presets = presets.length
      const meta = providerMeta()
      const providerEntry = Array.isArray(meta.providers) && meta.providers.length ? meta : null
      result.providers = Boolean(providerEntry)
      await syncRemoteFetch('PUT', { version: 1, generatedAt: new Date().toISOString(), room: roomPayload, saves, stories, providers: providerEntry, prompts: { presets, privateToggles: {} } })
      return result
    },
  }
  window.StageCraftSyncRemote = syncRemote

  // ── 连接徽标 ──
  window.__STAGECRAFT_OFFLINE__ = true
  console.info('[offline] StageCraft 离线模式就绪（复用完整 Web UI）。')
})()