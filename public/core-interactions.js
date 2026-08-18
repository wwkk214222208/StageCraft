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
    // 旧 footer/导演输入框仍负责 text；本阶段只让通用面板接管审批，避免重复输入框。
    const interactions = (this.view?.interactions ?? []).filter(interaction => interaction.kind === 'approval')
    if (!this.root || !this.section || interactions.length === 0) return this.hide()
    this.section.hidden = false
    this.root.innerHTML = interactions.map(interaction => this.renderInteraction(interaction)).join('')
    // 审批由 Core Command 主通道处理；原按钮保留在 DOM，Core 不可用时会恢复为回退入口。
    document.querySelectorAll('#speech-approve,#world-change-approve,#center-approve').forEach(button => { button.hidden = true })
    for (const button of this.root.querySelectorAll('[data-core-command]')) {
      button.addEventListener('click', () => this.submit(button.dataset.coreCommand, button.dataset.interactionId))
    }
  }

  renderInteraction(interaction) {
    const description = interaction.description ? `<p class="hint">${escapeHtml(interaction.description)}</p>` : ''
    if (interaction.kind === 'approval') {
      const reject = interaction.id.includes('draft') ? '' : interaction.id.includes('speech') ? `<button data-core-command="cancel" data-interaction-id="${escapeHtml(interaction.id)}">放弃</button>` : `<button data-core-command="reject" data-interaction-id="${escapeHtml(interaction.id)}">拒绝</button>`
      return `<article class="core-interaction" data-id="${escapeHtml(interaction.id)}"><h3>${escapeHtml(interaction.title ?? '待确认')}</h3>${description}<div class="core-interaction-actions"><button data-core-command="approve" data-interaction-id="${escapeHtml(interaction.id)}">${escapeHtml(interaction.submitLabel ?? '批准')}</button>${reject}</div></article>`
    }
    if (interaction.kind === 'text') return `<article class="core-interaction" data-id="${escapeHtml(interaction.id)}"><h3>${escapeHtml(interaction.title ?? '输入')}</h3>${description}<textarea data-core-text="${escapeHtml(interaction.id)}" placeholder="输入内容"></textarea><button data-core-command="submit-text" data-interaction-id="${escapeHtml(interaction.id)}">${escapeHtml(interaction.submitLabel ?? '提交')}</button></article>`
    return `<article class="core-interaction"><h3>${escapeHtml(interaction.title ?? interaction.kind)}</h3>${description}</article>`
  }

  async submit(type, interactionId) {
    const command = { id: `ui-${Date.now()}`, actor: 'player', interactionId, type, payload: {} }
    if (type === 'submit-text') command.payload.text = this.root.querySelector(`[data-core-text="${CSS.escape(interactionId)}"]`)?.value ?? ''
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
    document.querySelectorAll('#speech-approve,#world-change-approve,#center-approve').forEach(button => { button.hidden = false })
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}
