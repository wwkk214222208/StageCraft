import { CoreClient } from './core-client.js'

/** 通用 InteractionRequest 渲染器；旧页面仍可继续渲染 RoomSnapshot。 */
export class CoreInteractionPanel {
  constructor({ client = new CoreClient(), root = '#core-interaction-list', section = '#core-interactions' } = {}) {
    this.client = client
    this.root = typeof root === 'string' ? document.querySelector(root) : root
    this.section = typeof section === 'string' ? document.querySelector(section) : section
    this.view = null
    this.onCommand = null
  }

  async start() {
    try { this.view = await this.client.getView(); this.render() } catch { this.hide() }
    this.client.subscribe(event => {
      if (event.type === 'interaction.created' || event.type === 'state.changed' || event.type === 'workflow.changed') this.client.getView().then(view => { this.view = view; this.render() }).catch(() => {})
    })
  }

  render() {
    // 这些交互已有明确的领域 UI：导演建议框、底部玩家输入框、中央审批区和左侧角色按钮。
    // Core Interaction Panel 只保留协议能力，不再抢占或复制前台控件。
    this.hide()
  }

  renderInteraction(interaction) {
    const description = interaction.description ? `<p class="hint">${escapeHtml(interaction.description)}</p>` : ''
    if (interaction.kind === 'approval') {
      const reject = interaction.id.includes('speech') ? `<button data-core-command="reject" data-interaction-id="${escapeHtml(interaction.id)}">拒绝</button>` : `<button data-core-command="reject" data-interaction-id="${escapeHtml(interaction.id)}">拒绝</button>`
      return `<article class="core-interaction" data-id="${escapeHtml(interaction.id)}"><h3>${escapeHtml(interaction.title ?? '待确认')}</h3>${description}<div class="core-interaction-actions"><button data-core-command="approve" data-interaction-id="${escapeHtml(interaction.id)}">${escapeHtml(interaction.submitLabel ?? '批准')}</button>${reject}</div></article>`
    }
    if (interaction.kind === 'text') return `<article class="core-interaction" data-id="${escapeHtml(interaction.id)}"><h3>${escapeHtml(interaction.title ?? '输入')}</h3>${description}<textarea data-core-text="${escapeHtml(interaction.id)}" placeholder="输入内容"></textarea><button data-core-command="submit-text" data-interaction-id="${escapeHtml(interaction.id)}">${escapeHtml(interaction.submitLabel ?? '提交')}</button></article>`
    if (interaction.kind === 'role-select') return `<article class="core-interaction" data-id="${escapeHtml(interaction.id)}"><h3>${escapeHtml(interaction.title ?? '选择角色')}</h3>${description}<select data-core-role="${escapeHtml(interaction.id)}">${(interaction.options ?? []).map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`).join('')}</select><button data-core-command="select-role" data-interaction-id="${escapeHtml(interaction.id)}">${escapeHtml(interaction.submitLabel ?? '发言')}</button></article>`
    return `<article class="core-interaction"><h3>${escapeHtml(interaction.title ?? interaction.kind)}</h3>${description}</article>`
  }

  async submit(type, interactionId) {
    const command = { id: `ui-${Date.now()}`, actor: 'player', interactionId, type, payload: {} }
    if (type === 'submit-text') command.payload.text = this.root.querySelector(`[data-core-text="${CSS.escape(interactionId)}"]`)?.value ?? ''
    if (type === 'select-role') command.payload.roleId = this.root.querySelector(`[data-core-role="${CSS.escape(interactionId)}"]`)?.value ?? ''
    if (type === 'approve' || type === 'reject') {
      command.payload.action = interactionId.includes('world-change') ? 'world-change' : interactionId.includes('speech') ? 'speech' : 'draft'
      if (command.payload.action === 'speech') {
        command.payload.text = document.querySelector('#speech-text')?.value ?? ''
        const worldChange = this.#worldChangePayload()
        if (worldChange) command.payload.worldChange = worldChange
      } else if (command.payload.action === 'world-change') {
        command.payload.worldChange = this.#worldChangePayload()
      } else {
        command.payload.draftId = window.stagecraftRoom?.draft?.id ?? ''
        command.payload.text = document.querySelector('#center-draft-text')?.value ?? ''
        command.payload.stateUpdates = Object.fromEntries([...document.querySelectorAll('[data-state-update]')].map(el => [el.dataset.stateUpdate, el.value]))
        command.payload.sceneUpdates = { time: document.querySelector('#scene-time-input')?.value ?? '', location: document.querySelector('#scene-location-input')?.value ?? '' }
      }
    }
    try {
      await this.client.dispatch(command)
      if (this.onCommand) this.onCommand(command)
      this.view = this.client.view
      this.render()
    } catch (error) { window.alert(error.message || '交互提交失败') }
  }

  #worldChangePayload() {
    const current = window.stagecraftRoom?.pendingWorldChange
    if (!current) return null
    const time = document.querySelector('#wc-time')?.value
    const location = document.querySelector('#wc-location')?.value
    return { ...current, ...(time !== undefined ? { sceneTime: time.trim() } : {}), ...(location !== undefined ? { sceneLocation: location.trim() } : {}) }
  }

  hide() {
    if (this.section) this.section.hidden = true
    document.querySelectorAll('#speech-approve,#speech-cancel,#world-change-approve,#world-change-reject,#center-approve,#center-reconsider,#center-proceed-draft').forEach(button => { button.hidden = false })
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}
