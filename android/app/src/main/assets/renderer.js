let commandSequence = 0
let mediaSequence = 0

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

export function commandForInteraction(interaction, action, value = '', context = {}) {
  if (!interaction || typeof interaction.id !== 'string') throw new Error('Interaction id is required.')
  const base = { id: `android-${Date.now()}-${++commandSequence}`, actor: 'player', interactionId: interaction.id, payload: {} }
  if (interaction.kind === 'role-select' && action === 'submit') return { ...base, type: 'select-role', payload: { roleId: String(value) } }
  if ((interaction.kind === 'text' || interaction.kind === 'edit') && action === 'submit') return { ...base, type: 'submit-text', payload: { text: String(value) } }
  if (interaction.kind === 'approval' && (action === 'approve' || action === 'reject')) {
    if (interaction.id.endsWith(':speech-approval')) return { ...base, type: action, payload: action === 'approve' ? { action: 'speech', text: String(value) } : { action: 'speech' } }
    if (interaction.id.endsWith(':draft-approval')) {
      const payload = { action: 'draft-approval' }
      if (action === 'approve') {
        Object.assign(payload, {
          draftId: String(context.draft?.id ?? ''),
          text: String(value),
          stateUpdates: cloneJson(context.draft?.stateUpdates ?? {}),
          ...(context.draft?.sceneUpdates ? { sceneUpdates: cloneJson(context.draft.sceneUpdates) } : {}),
        })
      }
      return { ...base, type: action, payload }
    }
    if (interaction.id.endsWith(':world-change-approval')) {
      if (action === 'reject') return { ...base, type: action, payload: { action: 'world-change' } }
      const worldChange = typeof value === 'string' && value.trim() ? JSON.parse(value) : context.worldChange
      return { ...base, type: action, payload: { action: 'world-change', worldChange } }
    }
    return { ...base, type: action }
  }
  if ((interaction.kind === 'choice' || interaction.kind === 'multi-choice') && action === 'submit') return { ...base, type: 'choose', payload: { value } }
  if (action === 'cancel' && interaction.cancelable) return { ...base, type: 'cancel' }
  throw new Error('Unsupported interaction action.')
}

export function dispatchInteraction(bridge, interaction, action, value = '', context = {}) {
  const command = commandForInteraction(interaction, action, value, context)
  bridge.dispatch(JSON.stringify(command))
  return command
}

export function summarizeCoreView(view) {
  const state = view?.state && typeof view.state === 'object' ? view.state : {}
  const room = state.room && typeof state.room === 'object' ? state.room : {}
  const world = state.world && typeof state.world === 'object' ? state.world : {}
  const entities = state.entities && typeof state.entities === 'object' ? state.entities : {}
  const narrative = state.narrative && typeof state.narrative === 'object' ? state.narrative : {}
  const scenes = Array.isArray(narrative.scenes) ? narrative.scenes : []
  return {
    revision: Number(view?.revision ?? 0),
    room,
    world,
    roles: Array.isArray(entities.roles) ? entities.roles : [],
    speech: entities.speech && typeof entities.speech === 'object' ? entities.speech : null,
    draft: narrative.draft && typeof narrative.draft === 'object' ? narrative.draft : null,
    worldChange: world.pendingWorldChange && typeof world.pendingWorldChange === 'object' ? world.pendingWorldChange : null,
    scene: (scenes.length ? scenes[scenes.length - 1] : null) ?? narrative.draft ?? null,
    interactions: Array.isArray(view?.interactions) ? view.interactions : [],
  }
}

export function portraitInitial(role) {
  const label = String(role?.name ?? role?.id ?? '角').trim()
  return Array.from(label)[0] ?? '角'
}

function element(document, tag, text, className) {
  const node = document.createElement(tag)
  if (text != null) node.textContent = String(text)
  if (className) node.className = className
  return node
}

export function createRenderer({ document, bridge }) {
  let currentView = null
  let currentSummary = summarizeCoreView(null)
  const byId = id => document.getElementById(id)
  const status = (text, error = '') => { byId('connection-status').textContent = text; byId('connection-error').textContent = error }
  const statusLabels = { idle: '未连接', connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', disconnected: '已断开', pairing: '正在配对' }

  function renderView(view) {
    currentView = cloneJson(view)
    const summary = summarizeCoreView(view)
    currentSummary = summary
    const scenePanel = byId('scene-panel')
    scenePanel.hidden = !summary.scene
    byId('room-title').textContent = summary.room.title ?? summary.room.id ?? ''
    byId('scene-meta').textContent = [summary.world.time, summary.world.location].filter(Boolean).join(' · ')
    byId('scene-text').textContent = summary.scene?.prose ?? summary.scene?.content ?? summary.scene?.text ?? ''

    const roles = byId('roles')
    roles.replaceChildren(...summary.roles.map(role => {
      const row = element(document, 'article', null, 'role')
      const portraitBox = element(document, 'span', null, 'portrait')
      portraitBox.append(element(document, 'span', portraitInitial(role), 'portrait-initial'))
      if (typeof role.portraitRef === 'string' && role.portraitRef.startsWith('/assets/')) {
        const portrait = element(document, 'img')
        portrait.alt = ''
        portrait.dataset.mediaPath = role.portraitRef
        portrait.dataset.mediaRequest = `portrait-${++mediaSequence}`
        portraitBox.append(portrait)
      }
      row.append(portraitBox)
      const description = element(document, 'div')
      description.append(element(document, 'strong', role.name ?? role.id ?? '角色'))
      description.append(element(document, 'div', role.status ?? role.presence ?? '', 'role-meta'))
      row.append(description)
      return row
    }))
    for (const portrait of roles.querySelectorAll('[data-media-request]')) {
      bridge.loadMedia(portrait.dataset.mediaPath, portrait.dataset.mediaRequest)
    }
    byId('roles-panel').hidden = summary.roles.length === 0

    const interactions = byId('interactions')
    interactions.replaceChildren(...summary.interactions.map(renderInteraction))
    byId('interactions-panel').hidden = summary.interactions.length === 0
  }

  function renderInteraction(interaction) {
    const row = element(document, 'article', null, 'interaction')
    row.dataset.interactionId = interaction.id
    row.append(element(document, 'strong', interaction.title ?? interaction.kind))
    if (interaction.description) row.append(element(document, 'p', interaction.description, 'interaction-description'))
    if (interaction.kind === 'role-select' || interaction.kind === 'choice') {
      const select = element(document, 'select')
      select.dataset.interactionValue = 'true'
      for (const option of interaction.options ?? []) {
        const item = element(document, 'option', option.label ?? option.id)
        item.value = option.value ?? option.id
        select.append(item)
      }
      row.append(select)
    } else if (interaction.kind === 'text' || interaction.kind === 'edit') {
      const input = element(document, 'textarea')
      input.dataset.interactionValue = 'true'
      row.append(input)
    }
    const actions = element(document, 'div', null, 'interaction-actions')
    if (interaction.kind === 'approval') {
      let editableValue
      if (interaction.id.endsWith(':speech-approval')) editableValue = currentSummary.speech?.text ?? ''
      else if (interaction.id.endsWith(':draft-approval')) editableValue = currentSummary.draft?.text ?? ''
      else if (interaction.id.endsWith(':world-change-approval')) editableValue = JSON.stringify(currentSummary.worldChange ?? {}, null, 2)
      if (editableValue !== undefined) {
        const input = element(document, 'textarea')
        input.dataset.interactionValue = 'true'
        input.value = editableValue
        row.append(input)
      }
      for (const action of ['approve', 'reject']) {
        const button = element(document, 'button', action === 'approve' ? (interaction.submitLabel ?? '批准') : '拒绝', action === 'reject' ? 'danger' : '')
        button.dataset.interactionAction = action
        actions.append(button)
      }
    } else if (interaction.kind !== 'progress' && interaction.kind !== 'error') {
      const button = element(document, 'button', interaction.submitLabel ?? '提交')
      button.dataset.interactionAction = 'submit'
      actions.append(button)
    }
    if (interaction.cancelable) {
      const cancel = element(document, 'button', '取消', 'secondary')
      cancel.dataset.interactionAction = 'cancel'
      actions.append(cancel)
    }
    row.append(actions)
    return row
  }

  function receive(message) {
    const value = typeof message === 'string' ? JSON.parse(message) : message
    if (value.type === 'connection.state') status(statusLabels[value.state] ?? '连接状态未知')
    else if (value.type === 'core.resync') { status('已连接'); renderView(value.view) }
    else if (value.type === 'core.event' && ['state.changed', 'workflow.changed', 'interaction.created', 'interaction.resolved'].includes(value.event?.type)) bridge.refresh()
    else if (value.type === 'auth.required') { status('需要重新配对', value.message ?? '会话已失效。'); byId('pairing-panel').hidden = false }
    else if (value.type === 'connection.error') status('连接失败', value.message ?? '网络请求失败。')
    else if (value.type === 'media.result') {
      const portrait = [...document.querySelectorAll('[data-media-request]')].find(node => node.dataset.mediaRequest === value.requestId)
      if (portrait && typeof value.dataUrl === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(value.dataUrl)) {
        portrait.src = value.dataUrl
        portrait.parentElement?.classList.add('loaded')
      }
    }
    else if (value.type === 'media.error') {
      const portrait = [...document.querySelectorAll('[data-media-request]')].find(node => node.dataset.mediaRequest === value.requestId)
      if (portrait) portrait.parentElement?.classList.remove('loaded')
    }
    else if (value.type === 'card.imported') { byId('card-import-status').textContent = '角色卡已导入。'; bridge.refresh() }
    else if (value.type === 'card.import.error') byId('card-import-status').textContent = '角色卡导入失败；请确认它是有效的 PNG 角色卡。'
    else if (value.type === 'session.restored') {
      byId('server-address').value = value.address || 'https://'
      byId('allow-http').checked = value.allowInsecureHttp === true
      byId('http-warning').hidden = !byId('allow-http').checked
      byId('pairing-code').value = ''
    }
    return currentView
  }

  byId('allow-http').addEventListener('change', event => { byId('http-warning').hidden = !event.target.checked })
  // 地址输入为本机回环（adb reverse 隧道）时提示可免配对码直连
  byId('server-address').addEventListener('input', event => {
    const host = (() => { try { return new URL(event.target.value).hostname } catch { return '' } })()
    byId('adb-hint').hidden = !(host === '127.0.0.1' || host === 'localhost' || host === '::1')
  })
  byId('pair-button').addEventListener('click', () => bridge.pair(byId('server-address').value.trim(), byId('allow-http').checked, byId('pairing-code').value.trim()))
  // ADB reverse 免码直连：地址必须是本机回环（adb reverse tcp:8787 tcp:8787 后手机 localhost 直达电脑）
  byId('adb-pair-button').addEventListener('click', () => {
    const address = byId('server-address').value.trim() || 'http://127.0.0.1:8787'
    const host = (() => { try { return new URL(address).hostname } catch { return '' } })()
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      status('地址无效', 'ADB 直连地址必须是本机回环（http://127.0.0.1:8787）。')
      return
    }
    byId('server-address').value = address
    bridge.adbPair(address, true)
  })
  byId('reconnect-button').addEventListener('click', () => bridge.reconnect())
  byId('disconnect-button').addEventListener('click', () => bridge.disconnect())
  byId('forget-button').addEventListener('click', () => bridge.clearSession())
  byId('card-import-button').addEventListener('click', () => { byId('card-import-status').textContent = '请选择 PNG 文件…'; bridge.chooseCharacterCard() })
  byId('interactions').addEventListener('click', event => {
    const button = event.target.closest('[data-interaction-action]')
    const row = button?.closest('[data-interaction-id]')
    if (!button || !row || !currentView) return
    const interaction = currentView.interactions.find(item => item.id === row.dataset.interactionId)
    const value = row.querySelector('[data-interaction-value]')?.value ?? ''
    try { dispatchInteraction(bridge, interaction, button.dataset.interactionAction, value, currentSummary) } catch (error) { status('命令无效', error.message) }
  })
  return { receive, renderView }
}

if (typeof window !== 'undefined' && window.document) {
  const embedded = window.StageCraftEmbeddedCore
  const native = window.StageCraftNative
  // 默认进入远程配对页（?mode=remote 由原生层指定）；本地嵌入模式改为显式 ?mode=local。
  const modeParam = new URLSearchParams(window.location.search).get('mode')
  const localAvailable = Boolean(embedded && native?.localCoreAllowed?.() === true)
  const useLocal = modeParam === 'local' && localAvailable
  if (useLocal) {
    const bridge = {
      dispatch: embedded.dispatch,
      refresh: embedded.refresh,
      reconnect: embedded.reconnect,
      disconnect: embedded.stop,
      loadMedia: () => {},
      pair: () => {},
      adbPair: () => {},
      clearSession: () => {},
      chooseCharacterCard: () => {},
    }
    const renderer = createRenderer({ document: window.document, bridge })
    embedded.start(message => renderer.receive(message))
  } else if (native) {
    const renderer = createRenderer({ document: window.document, bridge: native })
    window.StageCraftNativeReceive = message => renderer.receive(message)
    native.ready()
    if (localAvailable) {
      const button = element(window.document, 'button', '本地模式（不连电脑，完整界面）', 'secondary')
      button.id = 'local-mode-button'
      button.onclick = () => { window.location.href = '/web/local.html' }
      const anchor = window.document.getElementById('connection-error')
      if (anchor?.parentElement) anchor.parentElement.insertBefore(button, anchor)
      else window.document.getElementById('pairing-panel')?.append(button)
    }
  }
}
