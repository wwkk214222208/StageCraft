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
    const interactions = this.view?.interactions ?? []
    if (!this.root || !this.section || interactions.length === 0) return this.hide()
    this.section.hidden = false
    this.root.innerHTML = interactions.map(interaction => this.renderInteraction(interaction)).join('')
    for (const button of this.root.querySelectorAll('[data-core-command]')) {
      button.addEventListener('click', () => this.submit(button.dataset.coreCommand, button.dataset.interactionId))
    }
  }

  renderInteraction(interaction) {
    const description = interaction.description ? `<p class="hint">${escapeHtml(interaction.description)}</p>` : ''
    if (interaction.kind === 'approval') return `<article class="core-interaction" data-id="${escapeHtml(interaction.id)}"><h3>${escapeHtml(interaction.title ?? '待确认')}</h3>${description}<div class="core-interaction-actions"><button data-core-command="approve" data-interaction-id="${escapeHtml(interaction.id)}">${escapeHtml(interaction.submitLabel ?? '批准')}</button><button data-core-command="reject" data-interaction-id="${escapeHtml(interaction.id)}">拒绝</button></div></article>`
    if (interaction.kind === 'text') return `<article class="core-interaction" data-id="${escapeHtml(interaction.id)}"><h3>${escapeHtml(interaction.title ?? '输入')}</h3>${description}<textarea data-core-text="${escapeHtml(interaction.id)}" placeholder="输入内容"></textarea><button data-core-command="submit-text" data-interaction-id="${escapeHtml(interaction.id)}">${escapeHtml(interaction.submitLabel ?? '提交')}</button></article>`
    return `<article class="core-interaction"><h3>${escapeHtml(interaction.title ?? interaction.kind)}</h3>${description}</article>`
  }

  async submit(type, interactionId) {
    const command = { id: `ui-${Date.now()}`, actor: 'player', interactionId, type, payload: {} }
    if (type === 'submit-text') command.payload.text = this.root.querySelector(`[data-core-text="${CSS.escape(interactionId)}"]`)?.value ?? ''
    if (type === 'approve' || type === 'reject') command.payload.action = interactionId.includes('world-change') ? 'world-change' : interactionId.includes('speech') ? 'speech' : 'draft'
    try {
      await this.client.dispatch(command)
      if (this.onCommand) this.onCommand(command)
      this.view = this.client.view
      this.render()
    } catch (error) { window.alert(error.message || '交互提交失败') }
  }

  hide() { if (this.section) this.section.hidden = true }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}
