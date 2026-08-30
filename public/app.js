import { CoreClient } from './core-client.js'
import { CoreInteractionPanel } from './core-interactions.js'

const coreClient = new CoreClient()
const coreInteractionPanel = new CoreInteractionPanel({ client: coreClient })
window.stagecraftCore = coreClient
document.documentElement.classList.toggle('android-device', /Android/i.test(navigator.userAgent))

// 独立启动（无 DSH 宿主）时关闭依赖 DSH 会话的组件：剧本助手与预设助手。
const standaloneMode = globalThis.__STAGECRAFT_STANDALONE__ === true
if (standaloneMode) {
  // 剧本编辑器/预设管理器内的 DSH 助手：原位保留布局，内容替换为「未接入 DSH」提示（接入后自动开启）。
  const creatorPreview = document.querySelector('.creator-preview')
  if (creatorPreview) {
    creatorPreview.querySelector('.creator-agent-session-bar')?.remove()
    creatorPreview.querySelector('#creator-agent-preview')?.remove()
    creatorPreview.querySelector('#creator-session-chat')?.remove()
    creatorPreview.insertAdjacentHTML('beforeend', '<div class="creator-empty-state"><strong>未接入 DSH</strong><p>当前为独立启动，未连接 DeepSeek Harness（DSH）宿主；接入 DSH 后运行，剧情编辑助手自动开启。</p></div>')
  }
  document.querySelector('.prompt-preset-editor')?.insertAdjacentHTML('afterbegin', '<p class="prompt-standalone-note">AI 预设助手需要 DSH（DeepSeek Harness）宿主环境：接入 DSH 并重启后自动开启，届时此处显示助手栏。</p>')
  for (const selector of ['#creator-session-modal', '#creator-session-model-modal', '.prompt-preset-assistant', '#prompt-assistant-session-modal', '#prompt-assistant-session-model-modal']) {
    document.querySelector(selector)?.remove()
  }
  // 预设管理器去掉助手栏后改为两栏布局（左管理 + 中编排），不留空白列。
  document.querySelector('.prompt-preset-workspace')?.classList.add('compact')
}

// 侧栏私设条目开关：状态由服务端持久（/api/prompts/private-toggles），预设文件 enabled 仅作加载初始值；前端只负责渲染与提交请求。

let room
// 安全随机 ID：crypto.randomUUID 仅在安全上下文（HTTPS / localhost）可用；手机经局域网明文
// HTTP 访问时为非安全上下文，调用会抛 TypeError 导致整个模块图求值失败（空壳页面、按钮全失效）。
const genId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
let creatorSession = null
const creatorOwner = `creator-web:${genId()}`
let promptAssistantSession = null
const promptAssistantOwner = `prompt-assistant-web:${genId()}`
let providers = []
let storyCatalog = [] // /api/stories 最近一次列表（含 custom 标记：true=玩家自建，false=默认剧本）
let focalRoleIds = new Set()
let reconsideringRoleIds = new Set()
let activeAction = null
let skipArmed = false
let sidebarTab = 'roles' // 左侧栏标签：roles | lore | prompts
let promptPresets = []
let editingPromptPreset = null
let promptPresetState = { activeByScope: {} }
let promptPresetScope = 'director.draft'
let sidebarPromptPresetId = 'default'
// 侧栏「设置与预设」的预设作用域随游玩模式切换：群聊用有激活预设的 chat 作用域（私设条目对群聊生效并持久化），导演用 director.draft。与编辑器作用域（promptPresetScope）无关。
function promptSideScope() {
  if (room?.mode !== 'chat') return 'director.draft'
  const chatScopes = promptScopeEntries().filter(([id]) => id.startsWith('chat.')).map(([id]) => id)
  return chatScopes.find(scope => promptPresetState?.activeByScope?.[scope]) ?? chatScopes[0] ?? 'chat.role-speech'
}
let promptPresetSource = ''
let promptModes = [{ id: 'director', name: '导演模式' }, { id: 'chat', name: '群聊模式' }]
let promptGameplayScenarios = {}
let promptGameplayScenarioForceThinkingOff = false
const promptScopeEntries = () => Object.entries(promptGameplayScenarios ?? {}).filter(([, scenario]) => scenario && scenario.userEditable !== false)
const promptScopeLabel = scope => { const found = promptScopeEntries().find(([id]) => id === scope); return found ? String(found[1]?.name ?? scope) : String(scope) }
// 玩法组件归属来自后端 gameplayScenarios（/api/prompts/presets）；后端未下发时前端走空态，不再持有 scope→模板 兜底映射。
function gameplayComponents(scope) { return promptGameplayScenarios?.[scope]?.components ?? [] }
function defaultPromptEditorNodes(scope) { return gameplayComponents(scope).map(component => ({ id: component.id, name: component.name, content: '', type: component.role === 'user' ? 'user' : 'system', enabled: true, editable: false, runtimeBinding: component.id, removable: false, dynamic: component.dynamic === true })) }
function readTemplatePath(path, template) { return typeof template === 'string' ? template : '' }
function runtimePreview(scope, node) { const component = gameplayComponents(scope).find(item => item.id === (node.runtimeBinding ?? node.id)); return component ? readTemplatePath(component.templatePath, component.template) : '该组件来自当前玩法的固定提示词文件。' }
function normalizeEditorScenario(scenario, scope) { const components = gameplayComponents(scope); if (!components.length) return scenario; const oldNodes = Array.isArray(scenario.nodes) ? scenario.nodes : []; const fixedIds = new Set(components.map(component => component.id)); const privateNodes = oldNodes.filter(node => !fixedIds.has(node.runtimeBinding ?? node.id) && node.removable !== false); const fixedNodes = components.map((component, index) => { const old = oldNodes.find(node => (node.runtimeBinding ?? node.id) === component.id); return { id: component.id, name: component.name, content: '', type: component.role === 'user' ? 'user' : 'system', enabled: true, editable: false, runtimeBinding: component.id, removable: false, dynamic: component.dynamic === true, _oldIndex: old ? oldNodes.indexOf(old) : index } }); const combined = [...fixedNodes, ...privateNodes].sort((a, b) => (a._oldIndex ?? oldNodes.indexOf(a)) - (b._oldIndex ?? oldNodes.indexOf(b))); return { ...scenario, nodes: combined.map(({ _oldIndex, ...node }) => node) } }
// URL 导入：拉取为 blob → dataURL → 同样 3:4 裁剪；拉取/跨域失败时回退原 url（后端原样保存）
async function preparePortraitUrl(url) {
  try {
    const response = await fetch(url, { mode: 'cors', redirect: 'follow' })
    if (!response.ok) return url
    const blob = await response.blob()
    if (!/^image\/(png|jpeg|gif|webp)$/.test(blob.type || '')) return url
    const dataUrl = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => resolve(url); reader.readAsDataURL(blob) })
    return await cropPortraitToRatio(dataUrl)
  } catch { return url }
}
// 肖像载入时固定中心裁剪：输出 3:4（宽:高）PNG dataURL；任意原图（方形/横版/竖版）都裁到 3:4 再落盘
function cropPortraitToRatio(dataUrl, ratio = 3 / 4) {
  return new Promise(resolve => {
    if (!String(dataUrl).startsWith('data:image/')) return resolve(dataUrl)
    const img = new Image()
    img.onload = () => {
      try {
        const width = img.naturalWidth
        const height = img.naturalHeight
        if (!width || !height) return resolve(dataUrl)
        let targetWidth = width
        let targetHeight = height
        if (width / height > ratio) targetWidth = Math.round(height * ratio)
        else targetHeight = Math.round(width / ratio)
        const offsetX = Math.round((width - targetWidth) / 2)
        const offsetY = Math.round((height - targetHeight) / 2)
        const canvas = document.createElement('canvas')
        canvas.width = targetWidth
        canvas.height = targetHeight
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, offsetX, offsetY, targetWidth, targetHeight, 0, 0, targetWidth, targetHeight)
        resolve(canvas.toDataURL('image/png'))
      } catch { resolve(dataUrl) }
    }
    img.onerror = () => resolve(dataUrl)
    img.src = String(dataUrl)
  })
}
let expandedMemoryId = null
let draggingMemoryId = null
let expandedStoryMemoryIndex = null
const WHALE_MEME_PREFS_KEY = 'stagecraft-whale-meme'
let whaleMemeEnabled = false
try { whaleMemeEnabled = localStorage.getItem(WHALE_MEME_PREFS_KEY) === '1' } catch {}
const TOKEN_PREFS_KEY = 'stagecraft-token-count'
let tokenCountEnabled = false
try { tokenCountEnabled = localStorage.getItem(TOKEN_PREFS_KEY) === '1' } catch {}
const missingElement = new Proxy({ hidden: true, value: '', checked: false, innerHTML: '', textContent: '', disabled: false, dataset: {} }, { get(target, property) {
  if (property === 'addEventListener' || property === 'click' || property === 'focus' || property === 'blur' || property === 'showModal' || property === 'close') return () => {}
  if (property === 'querySelector' || property === 'querySelectorAll') return () => property === 'querySelectorAll' ? [] : null
  return target[property] ?? (() => {})
} })
const $ = selector => document.querySelector(selector) ?? missingElement
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const billingDialog = document.createElement('dialog'); billingDialog.id = 'billing-modal'; billingDialog.innerHTML = '<form method="dialog" class="billing-panel"><header><h3>计费与价格（人民币）</h3><button type="button" data-dialog-close>关闭</button></header><section class="billing-summary"><strong id="billing-total">--</strong><span id="billing-request-count"></span></section><section><h4>累计明细</h4><div id="billing-breakdown" class="billing-breakdown"></div></section><section><div class="billing-section-heading"><h4>价格表</h4><button id="billing-add" type="button">新增价格</button></div><p class="hint">金额单位：元 / 百万 token。峰值时段使用本机时间，可填写多个时段，例如 09:00-21:00。</p><div id="billing-rate-list" class="billing-rate-list"></div></section><footer><button id="billing-reset" type="button">清空累计</button><button id="billing-save" type="button" class="primary">保存价格</button></footer></form>'; document.body.append(billingDialog)
const money = (value, currency = 'RMB') => `${currency === 'RMB' ? '¥' : currency} ${Number(value || 0).toFixed(6)}`
let billingPrices = { version: 1, rates: [] }
function rateNumber(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : 0 }
function rateInput(label, value, field, step = '0.000001') { return `<label>${label}<input type="number" min="0" step="${step}" data-rate-field="${field}" value="${rateNumber(value)}"></label>` }
function providerChoices(selected) { return providers.map(provider => `<option value="${escape(provider.name)}"${provider.name === selected ? ' selected' : ''}>${escape(provider.name)}</option>`).join('') }
function modelChoices(providerName, selected) { const provider = providers.find(item => item.name === providerName); const models = provider?.models ?? []; return models.map(model => `<option value="${escape(model)}"${model === selected ? ' selected' : ''}>${escape(model)}</option>`).join('') }
function renderRateList() { $('#billing-rate-list').innerHTML = billingPrices.rates.map((rate, index) => { const providerExists = providers.some(provider => provider.name === rate.provider); const modelExists = providerExists && (providers.find(provider => provider.name === rate.provider)?.models ?? []).includes(rate.model); const peakEnabled = rate.peakPricingEnabled === true || (rate.peakHours?.length ?? 0) > 0; return `<article class="billing-rate" data-rate-index="${index}"><header><strong>价格规则 ${index + 1}</strong><button type="button" class="billing-rate-delete" data-rate-delete="${index}">删除</button></header><label class="billing-peak-toggle"><input type="checkbox" data-rate-field="peakPricingEnabled"${peakEnabled ? ' checked' : ''}>启用峰谷价格</label><div class="billing-rate-grid"><label>供应商<select data-rate-field="provider"><option value="">选择已配置供应商</option>${providerChoices(rate.provider)}</select></label><label>模型<select data-rate-field="model"${providerExists ? '' : ' disabled'}><option value="">${providerExists ? '选择该供应商的模型' : '请先选择供应商'}</option>${modelChoices(rate.provider, rate.model)}${rate.model && !modelExists ? `<option value="${escape(rate.model)}" selected>已不存在：${escape(rate.model)}</option>` : ''}</select></label>${rateInput('基础输入', rate.inputPerMillion, 'inputPerMillion')}${rateInput('基础输出', rate.outputPerMillion, 'outputPerMillion')}${rateInput('缓存输入', rate.cachedInputPerMillion, 'cachedInputPerMillion')}</div><details class="billing-tier"${peakEnabled ? ' open' : ''} ${peakEnabled ? '' : 'hidden'}><summary>峰值价格</summary><div class="billing-rate-grid">${rateInput('峰值输入', rate.peak?.inputPerMillion, 'peak.inputPerMillion')}${rateInput('峰值输出', rate.peak?.outputPerMillion, 'peak.outputPerMillion')}${rateInput('峰值缓存', rate.peak?.cachedInputPerMillion, 'peak.cachedInputPerMillion')}<label>峰值时段<input data-rate-field="peakHours" value="${escape((rate.peakHours || []).map(hour => `${hour.start}-${hour.end}`).join(', '))}" placeholder="09:00-21:00"></label><label class="billing-peak-toggle"><input type="checkbox" data-rate-field="peakExcludesWeekends"${rate.peakExcludesWeekends === true ? ' checked' : ''}>周末不计峰值</label></div></details><details class="billing-tier"${peakEnabled ? '' : ' hidden'}><summary>谷值价格（留空则沿用基础价格）</summary><div class="billing-rate-grid">${rateInput('谷值输入', rate.offPeak?.inputPerMillion, 'offPeak.inputPerMillion')}${rateInput('谷值输出', rate.offPeak?.outputPerMillion, 'offPeak.outputPerMillion')}${rateInput('谷值缓存', rate.offPeak?.cachedInputPerMillion, 'offPeak.cachedInputPerMillion')}</div></details></article>` }).join('') || '<p class="hint">还没有价格规则，请新增一条。</p>' }
function collectRateForm() { billingPrices.rates = [...document.querySelectorAll('.billing-rate')].map(card => { const get = field => card.querySelector(`[data-rate-field="${field}"]`)?.value ?? ''; const tier = prefix => ({ inputPerMillion: rateNumber(get(`${prefix}.inputPerMillion`)), outputPerMillion: rateNumber(get(`${prefix}.outputPerMillion`)), cachedInputPerMillion: rateNumber(get(`${prefix}.cachedInputPerMillion`)) }); const peakPricingEnabled = card.querySelector('[data-rate-field="peakPricingEnabled"]')?.checked === true; const hours = String(get('peakHours')).split(',').map(item => item.trim()).filter(Boolean).map(item => { const [start, end] = item.split('-').map(value => value.trim()); return { start, end } }).filter(item => /^\d{1,2}:\d{2}$/.test(item.start) && /^\d{1,2}:\d{2}$/.test(item.end)); const peak = tier('peak'); const offPeak = tier('offPeak'); const base = { provider: get('provider').trim(), model: get('model').trim(), currency: 'RMB', inputPerMillion: rateNumber(get('inputPerMillion')), outputPerMillion: rateNumber(get('outputPerMillion')), cachedInputPerMillion: rateNumber(get('cachedInputPerMillion')), peak, peakHours: peakPricingEnabled ? hours : [], peakPricingEnabled, peakExcludesWeekends: card.querySelector('[data-rate-field="peakExcludesWeekends"]')?.checked === true }; const hasOffPeak = ['inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion'].some(field => card.querySelector(`[data-rate-field="offPeak.${field}"]`)?.value !== ''); return hasOffPeak ? { ...base, offPeak } : base }).filter(rate => rate.provider && rate.model); return billingPrices }
function renderBilling(data) { const stats = data.stats; $('#billing-total').textContent = money(stats.totalCost, 'RMB'); $('#billing-request-count').textContent = `${stats.requests || 0} 次已计费调用`; const rows = (stats.byModel || []).slice().sort((a, b) => b.cost - a.cost); $('#billing-breakdown').innerHTML = rows.length ? `<table><thead><tr><th>源 / 模型</th><th>请求</th><th>输入</th><th>输出</th><th>费用</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(row.provider)} / ${escape(row.model)}</td><td>${row.requests}</td><td>${row.promptTokens}</td><td>${row.completionTokens}</td><td>${escape(money(row.cost, 'RMB'))}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">尚无已匹配价格规则的模型调用。</p>'; billingPrices = { version: 1, rates: (data.prices?.rates || []).map(rate => ({ ...rate, currency: 'RMB' })) }; renderRateList() }
async function loadBilling() { const response = await fetch('/api/billing'); if (!response.ok) throw new Error('无法读取计费数据。'); renderBilling(await response.json()) }
$('#billing-open').onclick = async () => { $('#connection-modal').close(); try { if (!providers.length) await loadProviders(); await loadBilling(); billingDialog.showModal() } catch (error) { alert(error instanceof Error ? error.message : '无法读取计费数据。') } }
$('#billing-add').onclick = () => { collectRateForm(); billingPrices.rates.push({ provider: '', model: '', currency: 'RMB', inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0, peakPricingEnabled: false, peakExcludesWeekends: false, peak: { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 }, peakHours: [] }); renderRateList(); document.querySelector('.billing-rate:last-of-type input')?.focus() }
document.addEventListener('click', event => { const button = event.target.closest?.('[data-rate-delete]'); if (!button) return; collectRateForm(); billingPrices.rates.splice(Number(button.dataset.rateDelete), 1); renderRateList() })
document.addEventListener('change', event => { const toggle = event.target.closest?.('[data-rate-field="peakPricingEnabled"]'); if (toggle) { collectRateForm(); renderRateList(); return } const select = event.target.closest?.('[data-rate-field="provider"]'); if (!select) return; collectRateForm(); const card = select.closest('.billing-rate'); const index = Number(card.dataset.rateIndex); billingPrices.rates[index].provider = select.value; billingPrices.rates[index].model = ''; renderRateList() })
$('#billing-save').onclick = async () => { try { const prices = collectRateForm(); const invalid = prices.rates.find(rate => !providers.some(provider => provider.name === rate.provider && provider.models.includes(rate.model))); if (invalid) throw new Error(`模型「${invalid.model || '未选择'}」不是供应商「${invalid.provider || '未选择'}」当前已配置的模型。`); const response = await fetch('/api/billing/prices', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(prices) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || '保存失败。'); renderBilling(data); alert('人民币价格已保存。') } catch (error) { alert(error instanceof Error ? error.message : '保存失败。') } }
$('#billing-reset').onclick = async () => { if (!confirm('清空所有累计费用？')) return; await fetch('/api/billing/reset', { method: 'POST' }); await loadBilling() }
// 角色设置固定为「人设 / 记忆 / 模型」；移除旧的文本时间线编辑器与关系独立页。
document.querySelector('[data-inspector-tab="basic"]').textContent = '人设'
document.querySelector('[data-inspector-tab="model"]').textContent = '模型'
const relationsTab = document.querySelector('[data-inspector-tab="relations"]')
const relationsPanel = document.querySelector('[data-inspector-panel="relations"]')
// 旧关系页与基本页内的关系编辑器重复，只保留基本页中的统一编辑器。
relationsPanel?.remove()
relationsTab?.remove()
const basicPanels = document.querySelectorAll('[data-inspector-panel="basic"]')
if (basicPanels.length > 1) { basicPanels[0].append(...basicPanels[1].childNodes); basicPanels[1].remove() }
const modelPanel = document.querySelector('[data-inspector-panel="model"]')
const modelSettings = document.querySelector('.inspector-fields > .inspector-row')
if (modelPanel && modelSettings) modelPanel.prepend(modelSettings)
document.querySelector('#model-mode')?.remove()
document.querySelector('#inspector-sync-story')?.remove()
document.querySelector('#load-archive')?.closest('.load-label')?.remove()
document.querySelector('#inspector-story-avatar')?.closest('label')?.remove()
const whaleMemeSetting = document.createElement('label')
whaleMemeSetting.className = 'settings-row'
whaleMemeSetting.innerHTML = '开启鲸鱼梗<input id="settings-whale-meme" type="checkbox">'
const debugSettingRow = document.querySelector('#settings-debug')?.closest('.settings-row')
const debugSettingHint = debugSettingRow?.nextElementSibling?.matches('.hint') ? debugSettingRow.nextElementSibling : debugSettingRow
if (debugSettingRow) { const text = [...debugSettingRow.childNodes].find(node => node.nodeType === Node.TEXT_NODE); if (text) text.textContent = '显示控制台'; debugSettingRow.title = '显示模型请求、工具回退和 Debug 详细返回' }
if (debugSettingHint && debugSettingHint !== debugSettingRow && debugSettingHint.classList.contains('hint')) debugSettingHint.textContent = '在页面底部显示模型请求、工具回退和 Debug 详细返回。'
debugSettingHint?.after(whaleMemeSetting)
const roomModeSelect = document.querySelector('#room-mode-select')
const directorModeOption = roomModeSelect?.querySelector('option[value="director"]')
const chatModeOption = roomModeSelect?.querySelector('option[value="chat"]')
if (directorModeOption) directorModeOption.textContent = '导演模式（由导演统筹角色行动与场景叙事）'
if (chatModeOption) chatModeOption.textContent = '群聊模式（角色直接发言；导演仍可参与讨论与推进）'
const thinkingSettingRow = document.querySelector('#show-thinking')?.closest('.settings-row')
thinkingSettingRow?.nextElementSibling?.matches('.hint') && thinkingSettingRow.nextElementSibling.remove()
const tokenSettingRow = document.querySelector('#settings-token-count')?.closest('.settings-row')
tokenSettingRow?.nextElementSibling?.matches('.hint') && tokenSettingRow.nextElementSibling.remove()
const stImportOpen = document.querySelector('#st-import-open')
if (stImportOpen) stImportOpen.textContent = '导入 ST 角色卡…'
const stImportInput = document.querySelector('#st-import-file')
if (stImportInput) stImportInput.accept = '.json,.png,application/json,image/png'
const stImportHint = document.querySelector('#st-import-modal .hint')
if (stImportHint) stImportHint.textContent = '支持 SillyTavern chara_card_v2/v3 JSON 或 PNG 内嵌卡。导入为当前房间的新角色，角色书条目成为世界书。'
const debugStream = document.querySelector('#debug-stream')
const debugWindow = document.createElement('section')
let debugDetailsEnabled = false
debugWindow.id = 'debug-window'
debugWindow.hidden = true
debugWindow.innerHTML = '<header id="debug-window-handle"><strong>控制台</strong><div><button id="debug-toggle" type="button" title="显示或隐藏模型详细返回">Debug</button><button id="debug-window-close" type="button" aria-label="关闭控制台">×</button></div></header>'
if (debugStream) {
  debugStream.replaceWith(debugWindow)
  debugStream.hidden = false
  debugWindow.append(debugStream)
}
let debugWindowDrag
document.querySelector('#debug-window-handle')?.addEventListener('pointerdown', event => {
  if (event.target.closest('button')) return
  const rect = debugWindow.getBoundingClientRect()
  debugWindow.style.left = `${rect.left}px`
  debugWindow.style.top = `${rect.top}px`
  debugWindow.style.right = 'auto'
  debugWindow.style.bottom = 'auto'
  debugWindowDrag = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top }
  event.currentTarget.setPointerCapture(event.pointerId)
})
document.querySelector('#debug-window-handle')?.addEventListener('pointermove', event => {
  if (!debugWindowDrag) return
  const x = Math.max(0, Math.min(window.innerWidth - debugWindow.offsetWidth, event.clientX - debugWindowDrag.offsetX))
  const y = Math.max(0, Math.min(window.innerHeight - debugWindow.offsetHeight, event.clientY - debugWindowDrag.offsetY))
  debugWindow.style.left = `${x}px`
  debugWindow.style.top = `${y}px`
})
document.querySelector('#debug-window-handle')?.addEventListener('pointerup', () => { debugWindowDrag = null })
document.querySelector('#debug-window-handle')?.addEventListener('pointercancel', () => { debugWindowDrag = null })
document.querySelector('#role-modal .inspector-portrait-panel .hint')?.remove()
modelPanel?.querySelector(':scope > .hint')?.remove()
document.querySelectorAll('#role-modal #inspector-memory, #new-role-memory').forEach(element => element.closest('label')?.remove())
document.querySelector('.inspector-goals-label small')?.remove()
const impressionsTitle = document.querySelector('.inspector-impressions-wrap .field-title')
if (impressionsTitle) impressionsTitle.textContent = '关系与印象'
document.addEventListener('click', event => { const roleId = event.target.closest?.('[data-memory-role]')?.dataset.memoryRole; if (roleId && room) inspectedRole = room.roles.find(role => role.id === roleId) })

// ── token 计数小字（可开关；只展示，不进入正文） ──
function tokenNoteHtml(kind, usage) {
  if (!tokenCountEnabled || !usage) return ''
  const labels = { role: '角色', director: '导演', consult: '咨询', scene: '场景', speech: '发言' }
  // 统一用与正文不同的一种颜色（灰），不做五颜六色
  const input = usage.promptTokens ?? 0
  const output = usage.completionTokens ?? 0
  const cached = usage.cachedTokens ?? 0
  const hitRate = input > 0 ? ((cached / input) * 100).toFixed(1) : '0.0'
  const duration = usage.durationMs ? ` · ${usage.durationMs}ms` : ''
  return `<small class="token-note" title="输入 / 输出 / 缓存命中 / 缓存命中率 / 耗时">${labels[kind] ?? kind} 输入${input} · 输出${output} · 缓存命中${cached} · 命中率${hitRate}%${duration}</small>`
}

// ── 思维链显示（ST 风格：流式 Thinking + 折叠/展开 + 显隐开关） ──
const THINKING_PREFS_KEY = 'stagecraft-thinking-prefs'
let thinkingPrefs = { show: true, autoExpand: false }
try { thinkingPrefs = { ...thinkingPrefs, ...JSON.parse(localStorage.getItem(THINKING_PREFS_KEY) || '{}') } } catch {}
const thinkingStreams = new Map() // key: 'role:xxx' | 'director' -> { text, done }
function thinkingKey(event) { return event.actor === 'director' ? 'director' : `role:${event.roleId}` }
function thinkingLabel(key) {
  if (key === 'director') return '导演'
  const role = room?.roles.find(item => item.id === key.slice(5))
  return role?.name ?? key.slice(5)
}
function renderThinkingPanel() {
  const panel = $('#thinking-panel')
  if (!panel) return
  if (!thinkingPrefs.show) { panel.hidden = true; panel.innerHTML = ''; return }
  // 已完成的思维链已在上方正文中展示，这里只保留进行中的流式内容
  const entries = [...thinkingStreams.entries()].filter(([, stream]) => !stream.done)
  panel.hidden = entries.length === 0
  panel.innerHTML = entries.map(([key, stream]) => {
    // 生成中实时展开；done 后移出本面板，正文里的已完成思维链由 thinkingBlockHtml 按 autoExpand 决定（默认折叠）
    return `<details class="thinking-block" open data-thinking="${escape(key)}"><summary>💭 ${escape(thinkingLabel(key))} 思考中</summary><pre>${escape(stream.text)}</pre></details>`
  }).join('')
}
function applyThinkingEvent(event) {
  const key = thinkingKey(event)
  if (event.done) {
    const stream = thinkingStreams.get(key)
    if (stream) { stream.done = true; stream.text = event.text || stream.text }
    else thinkingStreams.set(key, { text: event.text || '', done: true })
  } else {
    const stream = thinkingStreams.get(key) ?? { text: '', done: false }
    stream.text += event.text
    stream.done = false
    thinkingStreams.set(key, stream)
  }
  renderThinkingPanel()
  scrollStoryToBottom()
}
/** 流式生成期间，只把各思维链 pre 的内部滚动条拉到最底部；#story 正文区保持用户手动控制，不被抢占 */
function scrollStoryToBottom() {
  const panel = $('#thinking-panel')
  if (panel) {
    panel.querySelectorAll('.thinking-block pre').forEach(pre => { pre.scrollTop = pre.scrollHeight })
  }
}
function clearThinkingStreams() { thinkingStreams.clear(); renderThinkingPanel() }
function thinkingBlockHtml(label, text) {
  if (!text) return ''
  const open = thinkingPrefs.show && thinkingPrefs.autoExpand ? 'open' : ''
  return thinkingPrefs.show ? `<details class="thinking-block saved" ${open}><summary>💭 ${escape(label)}</summary><pre>${escape(text)}</pre></details>` : ''
}

function currentDraftText() { return $('#center-draft-text')?.value ?? room?.draft?.text ?? '' }
function setContribution(text) { const input = $('#contribution'); input.value = input.value ? `${input.value}\n${text}` : text; input.focus() }
function render(next) {
  // 数据完整性校验：/api/room 在 Core 重启/数据面切换窗口可能返回错误对象
  // （如 502 core_unreachable）——显示明确占位而非在 room.roles.filter 处崩溃。
  if (!next || typeof next !== 'object' || !Array.isArray(next.roles)) {
    console.error('[StageCraft] render skipped: room payload missing roles', next)
    const title = document.getElementById('room-title')
    if (title) title.textContent = next?.error?.code === 'core_unreachable' ? '核心正在重启…' : '房间数据不可用'
    const rolesEl = document.getElementById('roles')
    if (rolesEl) rolesEl.innerHTML = `<p class="hint">${escape(next?.error?.message || '房间数据不可用，请稍候。')}</p>`
    return
  }
  room = next
  window.stagecraftRoom = next
  focalRoleIds = new Set([...focalRoleIds].filter(id => room.roles.some(role => role.id === id && role.presence === 'present')))
  if (room.phase === 'awaiting-player-input') clearThinkingStreams()
  const states = { present: '在场', absent: '离场', unavailable: '离场' }
  $('#room-title').textContent = room.title
  const isChat = room.mode === 'chat'
  // 群聊回复中：底部主输入框按钮转为「取消回复」，侧栏不再重复显示取消回合
  const chatReplying = isChat && ['role-speaking', 'director-selecting-roles'].includes(room.phase)
  $('#mode-badge').textContent = `${isChat ? '群聊' : '导演'}${room.autoPublish ? ' · 沉浸' : ''}`
  $('#mode-badge').classList.toggle('chat', isChat)
  const readOnly = !!room.autoPublish // 沉浸模式：场景/角色状态/角色面板只读
  const sceneBar = $('#scene-bar')
  const sceneParts = readOnly
    ? [room.sceneTime ? `🕐 ${escape(room.sceneTime)}` : '🕐 未设置时间', room.sceneLocation ? `📍 ${escape(room.sceneLocation)}` : '📍 未设置地点']
    : [room.sceneTime ? `🕐 <button class="scene-edit" data-scene-field="time" title="点击修改场景时间">${escape(room.sceneTime)}</button>` : `<button class="scene-edit" data-scene-field="time">＋ 设置时间</button>`, room.sceneLocation ? `📍 <button class="scene-edit" data-scene-field="location" title="点击修改场景地点">${escape(room.sceneLocation)}</button>` : `<button class="scene-edit" data-scene-field="location">＋ 设置地点</button>`]
  sceneBar.hidden = false
  sceneBar.innerHTML = `<div class="scene-bar-inner"><span class="scene-context">${sceneParts[0]}</span><span class="scene-context">${sceneParts[1]}</span></div>`
  sceneBar.querySelectorAll('[data-scene-field]').forEach(button => button.addEventListener('click', () => {
    const field = button.dataset.sceneField
    const current = field === 'time' ? room.sceneTime : room.sceneLocation
    const input = document.createElement('input')
    input.className = 'scene-edit-input'
    input.value = current ?? ''
    input.placeholder = field === 'time' ? '场景时间' : '场景地点'
    input.dataset.sceneSave = field
    input.addEventListener('keydown', event => { if (event.key === 'Enter') input.blur() })
    button.replaceWith(input)
    input.focus()
  }))
  // 沉浸模式（readOnly）：隐藏未在场（absent/unavailable）角色，只显示在场角色
  const roleCards = room.roles.filter(role => !readOnly || role.presence === 'present').map(role => {
    const focused = focalRoleIds.has(role.id)
    const decision = room.decisions.find(item => item.roleId === role.id)
    const status = focused ? '焦点' : (states[role.presence] ?? '未知')
    const activity = decision?.status === 'pending' ? '正在回应' : decision?.status === 'completed' ? '已回应' : decision?.status === 'unavailable' ? '回应失败' : ''
    const speakActionable = isChat && role.presence === 'present' && room.phase === 'awaiting-player-input' && !activeAction
    // 始终为在场角色保留「发言」占位按钮：可点时正常点击，不可点（发言中/非空闲/有动作进行）时置灰而非移除，
    // 避免按钮消失后「在场」按钮补位移位造成误触
    const speakBtn = isChat && role.presence === 'present'
      ? `<button class="speak-toggle"${speakActionable ? ` data-speak="${escape(role.id)}"` : ' disabled'}>发言</button>`
      : ''
    return `<article class="role ${focused ? 'focal' : ''} ${role.presence !== 'present' ? 'away' : ''}" draggable="true" data-role-drag="${escape(role.id)}"><img src="${escape(role.portraitRef)}" onerror="this.onerror=null;this.src='/assets/default.svg'"><div><div class="role-heading"><button class="role-name" data-inspect="${escape(role.id)}">${escape(role.name)}</button>${speakBtn}${!isChat && role.presence === 'present' ? `<button class="focus-toggle" data-focus="${escape(role.id)}">焦</button>` : ''}<button class="presence-toggle" data-presence="${escape(role.id)}" title="点击切换在场/离场">${role.presence === 'present' ? '在场' : '离场'}</button></div><small>${status}${activity ? ` · ${activity}` : ''}</small></div><p>${readOnly ? `<span class="role-state">${escape(role.currentState ?? '')}</span>` : `<span class="role-state" data-state-edit="${escape(role.id)}" title="点击修改当前状态">${escape(role.currentState ?? '')}</span>`}</p></article>`
  }).join('')
  const loreCards = (room.lore ?? []).map((entry, index) => {
    const tags = entry.roles && entry.roles.length ? entry.roles.map(id => room.roles.find(role => role.id === id)?.name ?? id).join('、') : '常开'
    return `<article class="lore-entry"${readOnly ? '' : ` data-lore="${index}"`}><div class="lore-heading"><b>${escape(entry.name)}</b><small>${escape(tags)}</small></div><p>${escape(entry.content)}</p></article>`
  }).join('')
  const promptSideMode = room.mode === 'chat' ? 'chat' : 'director'
  const sideOptions = [...(promptPresets.some(item => item.id === 'default') ? [] : [DEFAULT_PROMPT_PRESET()]), ...promptPresets]
  const promptSideSelect = $('#prompt-preset-select-sidebar'); if (promptSideSelect) { promptSideSelect.innerHTML = sideOptions.map(item => `<option value="${escape(item.id)}">${escape(item.id === 'default' ? '默认预设' : item.name)}</option>`).join(''); promptSideSelect.value = sideOptions.some(item => item.id === sidebarPromptPresetId) ? sidebarPromptPresetId : 'default' }
  const promptSidePreset = promptPresets.find(item => item.id === (promptSideSelect?.value ?? 'default')) ?? DEFAULT_PROMPT_PRESET()
  const promptPrivateCards = promptScopeEntries().filter(([id]) => id.startsWith(promptSideMode + '.')).map(([id, scenario]) => { const label = String(scenario?.name ?? id); const scenarioNodes = promptSidePreset.scenarios?.[id]; const nodes = Array.isArray(scenarioNodes?.nodes) && scenarioNodes.nodes.length ? scenarioNodes.nodes : defaultPromptEditorNodes(id); const rows = nodes.filter(node => node.removable !== false).map(node => `<label class="prompt-private-entry"><input type="checkbox" class="prompt-private-toggle" data-prompt-private="${escape(node.id)}"${node.enabled !== false ? ' checked' : ''}><span>${escape(node.name)}</span></label>`).join(''); return rows ? `<section class="prompt-scene-card"><h4>${escape(label)}</h4>${rows}</section>` : '' }).filter(Boolean).join('')
  $('#roles').innerHTML = `<div class="sidebar-tabs"><button data-tab="roles" class="${sidebarTab === 'roles' ? 'active' : ''}">角色</button><button data-tab="lore" class="${sidebarTab === 'lore' ? 'active' : ''}">世界书</button><button data-tab="prompts" class="${sidebarTab === 'prompts' ? 'active' : ''}">设置<br>预设</button></div><div id="roles-list" ${sidebarTab === 'roles' ? '' : 'hidden'}>${isChat && room.phase === 'awaiting-player-input' && !activeAction ? `<div class="chat-mode-actions"><button id="chat-mode-trigger-director" type="button">🎬 让导演安排发言</button><button id="chat-mode-trigger-all" type="button">🗣 所有人依次发言</button></div>` : ''}${roleCards || '<p class="hint">暂无角色</p>'}<button id="role-add" class="role-add" ${readOnly ? 'disabled title="沉浸模式只读"' : ''}>＋ 新建人物</button></div><div id="lore-list" ${sidebarTab === 'lore' ? '' : 'hidden'}><button id="lore-add" class="lore-add" ${readOnly ? 'disabled title="沉浸模式只读"' : ''}>＋ 新增条目</button>${loreCards || '<p class="hint">暂无世界书条目</p>'}</div><div id="prompts-list" ${sidebarTab === 'prompts' ? '' : 'hidden'}><section class="prompt-scene-card sidebar-settings-card"><h4>设置${isChat ? ' · 发言模式' : ''}</h4>${isChat ? `<label class="prompt-preset-pick">模式<select id="speech-mode-select"><option value="manual"${room.speechMode === 'manual' ? ' selected' : ''}>手动发言</option><option value="director"${room.speechMode === 'director' ? ' selected' : ''}>导演决定</option><option value="all"${room.speechMode === 'all' ? ' selected' : ''}>所有人依次</option></select></label><p class="hint">提交行动后按此自动发言；上方按钮可手动安排。</p>` : ''}<label class="settings-row">沉浸模式<input id="sidebar-auto-publish" type="checkbox"${room.autoPublish ? ' checked' : ''}></label>${!isChat ? `<label class="settings-row">隐藏玩家发言<input id="sidebar-hide-player-speech" type="checkbox"${room.hidePlayerSpeech ? ' checked' : ''}></label>` : ''}</section><div class="sidebar-divider"></div><div class="sidebar-presets"><button id="prompt-preset-new" class="lore-add">＋ 管理预设</button><label class="prompt-preset-pick">选择预设<select id="prompt-preset-select-sidebar">${sideOptions.map(item => `<option value="${escape(item.id)}">${escape(item.id === 'default' ? '默认预设' : item.name)}</option>`).join('')}</select></label>${promptPrivateCards || '<p class="hint">该预设暂无用户私设条目</p>'}</div></div>`
  const promptSideValue = $('#prompt-preset-select-sidebar'); if (promptSideValue) promptSideValue.value = sideOptions.some(item => item.id === sidebarPromptPresetId) ? sidebarPromptPresetId : 'default'
  const visibleScenes = room.hidePlayerSpeech ? room.scenes.filter(scene => scene.speaker !== 'player') : room.scenes
  $('#scenes').innerHTML = visibleScenes.length ? visibleScenes.map(scene => {
    const snapshot = [scene.sceneTime ? `🕐 ${escape(scene.sceneTime)}` : '', scene.sceneLocation ? `📍 ${escape(scene.sceneLocation)}` : ''].filter(Boolean).join('　')
    const meta = snapshot ? `<time class="scene-snapshot">${snapshot}</time>` : `<time>${new Date(scene.createdAt).toLocaleString()}</time>`
    // 回滚/分支图标：仅对「状态记录点」显示——群聊的 LLM/角色发言、导演的正文/旁白；
    // 玩家消息只是输入回显，不构成记录点。
    const isPlayerMsg = scene.speaker === 'player'
    const stateActions = isPlayerMsg
      ? ''
      : `<span class="scene-state-actions"><button type="button" class="icon-btn scene-rollback" data-scene-id="${escape(scene.id)}" title="回滚到此处（删除之后的所有记录）">↩</button><button type="button" class="icon-btn scene-branch" data-scene-id="${escape(scene.id)}" title="分支（先存档当前，再回滚到此处）">⑂</button></span>`
    if (scene.speaker) {
      const isPlayer = scene.speaker === 'player'
      const role = isPlayer ? null : room.roles.find(item => item.id === scene.speaker)
      const name = isPlayer ? room.playerCharacter.name : (role?.name ?? scene.speaker)
      const avatar = isPlayer ? (room.playerCharacter.portraitRef || '/assets/default.svg') : (role?.portraitRef || '/assets/default.svg')
      return `<div class="scene scene-msg">${meta}<div class="chat-msg ${isPlayer ? 'me' : ''}"><img class="avatar" src="${escape(avatar)}" onerror="this.onerror=null;this.src='/assets/default.svg'"><div class="bubble"><div class="bubble-name">${escape(name)}</div><div class="bubble-text">${escape(scene.text)}</div></div></div>${tokenNoteHtml('scene', scene.usage)}${stateActions}</div>`
    }
    return `<article class="scene narration">${meta}<div class="scene-text">${escape(scene.text)}</div>${tokenNoteHtml('scene', scene.usage)}${stateActions}</article>`
  }).join('') : ''
  // 收取失败：以导演风格消息卡片插在对话流末尾（带「重新尝试/取消」），不再用居中弹窗
  if (isChat && ['role-speaking', 'director-selecting-roles'].includes(room.phase)) replyFailedDismissed = false
  const failedDecision = isChat ? currentFailedDecision() : null
  $('#scenes').innerHTML += failedDecision ? replyFailedHtml(failedDecision) : ''
  const decisionsDone = room.decisions.length > 0 && room.decisions.every(decision => decision.status !== 'pending')
  // 审批期间：安卓端主输入框（底部输入区）缩回隐藏，批准完毕后重新弹出
  document.body.classList.toggle('approving', ['awaiting-approval', 'world-change-approval'].includes(room.phase))
  const display = $('#turn-display')
  display.hidden = room.phase === 'awaiting-player-input'
  // 群聊模式：审批卡片直接融入故事流，去掉外层「本回合」框
  display.classList.toggle('chat-mode', isChat)
  if (!display.hidden) {
    const reactions = room.reactions ?? []
    const bubbles = reactions.map(reaction => { const role = room.roles.find(item => item.id === reaction.roleId); const locked = reconsideringRoleIds.has(reaction.roleId); const decision = room.decisions.find(item => item.roleId === reaction.roleId); const thinking = decision?.thinking; const identity = decision?.publicIdentity; return `<div class="reaction-wrap ${locked ? 'locked' : ''}">${thinkingBlockHtml(`${role?.name ?? reaction.roleId} 思维链`, thinking)}<button class="reaction-bubble" data-reaction="${escape(reaction.roleId)}" ${locked ? 'disabled' : ''}><b>${escape(role?.name ?? reaction.roleId)}</b>${escape(reaction.text)}${identity ? `<small class="reaction-identity">对外身份：${escape(identity)}</small>` : ''}${tokenNoteHtml('role', decision?.usage)}${locked ? '<small>重新考虑中</small>' : ''}</button><div class="reaction-feedback" id="feedback-${escape(reaction.roleId)}" hidden><textarea placeholder="写下希望 ${escape(role?.name ?? reaction.roleId)} 重新考虑的内容..."></textarea><button data-reconsider="${escape(reaction.roleId)}">发送</button></div></div>` }).join('')
    const allStates = [{ id: 'player', label: `${room.playerCharacter.name} 当前状态`, value: room.draft?.stateUpdates.player ?? room.playerCharacter.currentState }, ...room.roles.map(role => ({ id: role.id, label: `${role.name} 当前状态`, value: room.draft?.stateUpdates[role.id] ?? role.currentState }))]
    const draft = room.draft ? `<article class="director-draft-record"><header><h2>导演草稿记录 <small>待定</small></h2><time>${new Date(room.draft.createdAt).toLocaleString()}</time></header>${thinkingBlockHtml('导演思维链', room.draft.thinking)}${tokenNoteHtml('director', room.draft.usage)}<textarea id="center-draft-text">${escape(room.draft.text)}</textarea><details class="scene-edits"><summary>场景更新</summary><label>时间<input id="scene-time-input" value="${escape(room.draft.sceneUpdates?.time ?? room.sceneTime ?? '')}" placeholder="如：深夜"></label><label>地点<input id="scene-location-input" value="${escape(room.draft.sceneUpdates?.location ?? room.sceneLocation ?? '')}" placeholder="如：祭典主厅门口"></label></details><details class="state-edits"><summary>状态更新</summary>${allStates.map(state => `<label>${escape(state.label)}<textarea data-state-update="${escape(state.id)}">${escape(state.value)}</textarea></label>`).join('')}</details>${(room.draft.roleProposals?.length ?? 0) ? `<div class="role-proposals"><h4 class="section-title">导演提议新人物：批准后将创建</h4><ul>${room.draft.roleProposals.map(proposal => `<li><div class="proposal-heading"><b>${escape(proposal.name)}</b><small>${states[proposal.presence] ?? escape(proposal.presence)}</small></div><p>${escape(proposal.currentState)}</p></li>`).join('')}</ul></div>` : ''}<div class="draft-actions"><button id="center-reconsider">重考</button><button id="center-approve">批准发布</button></div></article>` : ''
    const wcSceneHtml = (wc, timeId, locId) => (wc.sceneTime || wc.sceneLocation) ? `<div class="wc-scene"><label>时间<input id="${timeId}" value="${escape(wc.sceneTime ?? room.sceneTime ?? '')}" placeholder="如：深夜"></label><label>地点<input id="${locId}" value="${escape(wc.sceneLocation ?? room.sceneLocation ?? '')}" placeholder="如：祭典主厅门口"></label></div>` : ''
    const wcRolesHtml = wc => (wc.roleProposals?.length ?? 0) ? `<div class="wc-roles"><h5>提议新人物：批准后将创建</h5><ul>${wc.roleProposals.map(proposal => `<li><div class="proposal-heading"><b>${escape(proposal.name)}</b><small>${states[proposal.presence] ?? escape(proposal.presence)}</small></div><p>${escape(proposal.currentState)}</p></li>`).join('')}</ul></div>` : ''
    const wcPresenceHtml = wc => (wc.rolePresence?.length ?? 0) ? `<div class="wc-presence"><h5>角色进离场</h5><ul>${wc.rolePresence.map(item => { const role = room.roles.find(r => r.id === item.roleId); return `<li><b>${escape(role?.name ?? item.roleId)}</b><small>${states[item.presence] ?? escape(item.presence)}</small></li>` }).join('')}</ul></div>` : ''
    const wcStatesHtml = wc => (wc.roleStates && Object.keys(wc.roleStates).length) ? `<div class="wc-states"><h5>角色状态更新</h5><ul>${Object.entries(wc.roleStates).map(([roleId, state]) => { const role = room.roles.find(r => r.id === roleId); return `<li><b>${escape(role?.name ?? roleId)}</b><p>${escape(state)}</p></li>` }).join('')}</ul></div>` : ''
    const speechApproval = isChat && ['awaiting-approval', 'world-change-approval'].includes(room.phase) && room.speech
      ? (() => {
          const rid = room.speech.roleId
          const role = room.roles.find(item => item.id === rid)
          const name = role?.name ?? rid
          const avatar = role?.portraitRef || '/assets/default.svg'
          const wc = room.pendingWorldChange
          const worldChangeHtml = wc ? `<div class="world-change-proposal"><h4 class="section-title">世界变更申请 <small>（角色随台词提出，批准发布时一并生效）</small></h4>${wc.reason ? `<p class="wc-reason">${escape(wc.reason)}</p>` : ''}${wcSceneHtml(wc, 'wc-time', 'wc-location')}${wcRolesHtml(wc)}${wcPresenceHtml(wc)}${wcStatesHtml(wc)}</div>` : ''
          return `<div class="scene scene-msg speech-approval"><div class="chat-msg"><img class="avatar" src="${escape(avatar)}" onerror="this.onerror=null;this.src='/assets/default.svg'"><div class="bubble"><div class="bubble-name">${escape(name)} <small>台词待审批</small></div></div></div>${thinkingBlockHtml(`${name} 思维链`, room.speech.thinking)}${tokenNoteHtml('speech', room.speech.usage)}<textarea id="speech-text" class="speech-textarea">${escape(room.speech.text)}</textarea>${worldChangeHtml}<textarea id="speech-reconsider-feedback" class="speech-feedback-textarea" placeholder="写下希望角色如何重新考虑这段台词…"></textarea><div class="draft-actions"><button id="speech-reconsider">重考</button><button id="speech-cancel">放弃</button><button id="speech-approve">批准发布</button></div></div>`
        })() : ''
    // 群聊：导演对话产出的世界变更申请（无台词）独立审批
    const worldChangeApproval = isChat && room.phase === 'world-change-approval' && !room.speech && room.pendingWorldChange
      ? `<div class="scene narration world-change-proposal world-change-approval-card"><h4 class="section-title">世界变更申请 <small>（导演建议，批准后生效）</small></h4>${room.pendingWorldChange.reason ? `<p class="wc-reason">${escape(room.pendingWorldChange.reason)}</p>` : ''}${wcSceneHtml(room.pendingWorldChange, 'wc-time', 'wc-location')}${wcRolesHtml(room.pendingWorldChange)}${wcPresenceHtml(room.pendingWorldChange)}${wcStatesHtml(room.pendingWorldChange)}${room.pendingNarration ? `<div class="wc-narration"><h5>将写下的叙述</h5><p>${escape(room.pendingNarration)}</p></div>` : ''}<div class="draft-actions"><button id="world-change-reject">拒绝</button><button id="world-change-approve">批准并生效</button></div></div>`
      : ''
    const heading = isChat ? '' : reactions.length ? '<h2>本回合</h2>' : '<h2>本回合 <small>等待角色回应</small></h2>'
    const proceedBtn = room.phase === 'collecting-decisions' && decisionsDone ? '<div class="draft-actions"><button id="center-proceed-draft">拟定草稿</button></div>' : ''
    display.innerHTML = `${heading}<div class="reaction-list">${bubbles}</div>${proceedBtn}${speechApproval}${worldChangeApproval}${draft}`
  }
  const thinking = ['drafting', 'consulting-director'].includes(room.phase)
  let progressText = ''
  if (room.lastError) progressText = `<p class="error">${escape(room.lastError)}</p>`
  else if (isChat && activeAction === 'director') progressText = `<p class="thinking">导演正在思考你的建议…</p>`
  else if (thinking) progressText = `<p class="thinking">导演正在思考…</p>`
  else if (room.phase === 'role-speaking') progressText = `<p class="thinking">角色正在发言…</p>`
  else if (room.phase === 'director-selecting-roles') progressText = '<p class="thinking">导演正在决定本回合发言角色…</p>'
  else if (room.phase === 'collecting-decisions' && decisionsDone) progressText = `<p>角色反馈已就绪——可点击气泡修改，确认后拟定草稿。</p>`
  else if (room.phase === 'awaiting-player-input') progressText = `<p>${isChat ? `群聊模式：写下你的行动${room.speechMode === 'director' ? '（导演将自动安排发言）' : room.speechMode === 'all' ? '（所有在场角色将自动发言）' : ''}，也可用角色列表上方的按钮手动安排。` : '等待你的行动。'}</p>`
  else if (room.phase === 'awaiting-approval' && room.speech) progressText = '<p>台词待审批——可编辑后批准，或放弃。</p>'
  else if (room.phase === 'world-change-approval' && room.speech) progressText = '<p>台词附带了世界变更申请——批准发布将一并推进时间/地点或引入新人物；放弃则全部取消。</p>'
  else if (room.phase === 'world-change-approval' && !room.speech && room.pendingWorldChange) progressText = '<p>导演建议了世界变更——批准后生效并写一段叙述，或拒绝。</p>'
  else progressText = '<p>当前回合进行中。</p>'
  $('#progress').innerHTML = progressText
  $('#recovery-actions').hidden = !(room.phase === 'drafting' || room.phase === 'role-speaking' || (room.phase === 'collecting-decisions' && decisionsDone))
  $('#retry-director').hidden = room.phase !== 'drafting'
  // 群聊模式发言失败时，在「取消回合」旁显示「重试发言」；
  // 中断/恢复后 phase 可能已回 awaiting-player-input，只要存在失败的决策就保留重试入口
  $('#retry-speak').hidden = !(isChat && room.decisions.some(decision => decision.status === 'unavailable'))
  $('#cancel-turn').hidden = chatReplying
  let consultHtml = (room.consultations ?? []).map(message => `<p class="consultation ${message.role}"><b>${message.role === 'player' ? room.playerCharacter.name : '导演'}</b>${message.thinking ? thinkingBlockHtml('导演思维链', message.thinking) : ''}${tokenNoteHtml('consult', message.usage)}${escape(message.text)}</p>`).join('')
  if (room.draft?.openQuestions?.length) consultHtml += `<p class="consultation director director-extra"><b>导演</b>❓ 待确认：${room.draft.openQuestions.map(escape).join('；')}</p>`
  $('#consultations').innerHTML = consultHtml
  $('#director-chat').hidden = false
  const consultAvailable = room.draft && !['awaiting-player-input', 'drafting'].includes(room.phase)
  $('#consult-send').disabled = isChat ? (activeAction === 'director' ? false : room.phase !== 'awaiting-player-input') : activeAction === 'director' ? false : !consultAvailable
  $('#consult-send').textContent = isChat ? (activeAction === 'director' ? '停止' : '建议') : activeAction === 'director' ? '停止' : room.draft ? '发送' : room.phase === 'awaiting-player-input' ? '设定' : '发送'
  $('#consult-text').disabled = isChat ? activeAction === 'director' : false
  $('#consult-text').placeholder = isChat ? '向导演建议世界变化：推进时间、换场景、人物进出场、引入新人物...' : room.draft ? '与导演讨论、指出问题，或要求调整当前草稿...' : '向导演说明你的设定，将作为后续起草参考...'
  $('#submit').textContent = chatReplying ? '取消回复' : activeAction === 'turn' ? '停止' : skipArmed ? '空过？' : isChat ? '提交行动' : '提交'
  $('#submit').disabled = chatReplying ? false : (activeAction !== 'turn' && room.phase !== 'awaiting-player-input')
  if ($('#center-reconsider')) { $('#center-reconsider').disabled = activeAction === 'director'; $('#center-reconsider').textContent = activeAction === 'director' ? '思考中…' : '重考' }
  renderReplyStatus()
}

// 群聊回复：收到首字前中央短暂提示「xx 正在回复…」；收取失败以导演风格消息卡片插在对话流末尾（带「重新尝试/取消」，由 render() 渲染进 #scenes）；
// 「收到首字 / 失败卡片出现」都把主滚动条拉到最底（同一签名只滚一次）
let lastReplyScrollSig = { scene: '', speech: '', failed: '' }
// 「取消」关闭失败卡片标记：cancel-turn 不会清掉服务端 decisions 里的 unavailable 记录，
// 卡片继续渲染会是错的；每次新回合（进入 role-speaking/选角）自动复位，让新失败重新显示
let replyFailedDismissed = false
function currentFailedDecision() {
  return replyFailedDismissed ? null : (room.decisions ?? []).find(decision => decision.status === 'unavailable') ?? null
}
function replyFailedHtml(decision) {
  const role = room.roles.find(item => item.id === decision.roleId)
  const name = role?.name ?? decision.roleId
  const detail = room.lastError ? `<p>${escape(room.lastError)}</p>` : `<p>${escape(name)} 未能完成回复。</p>`
  return `<div class="scene scene-msg reply-failed-msg"><b class="reply-failed-title">收取回复失败</b>${detail}<div class="reply-failed-actions"><button id="reply-retry">重新尝试</button><button id="reply-cancel">取消</button></div></div>`
}
function renderReplyStatus() {
  const panel = $('#reply-status')
  if (!panel || !room) return
  if (activeAction === 'speak') { panel.hidden = true; panel.innerHTML = '' }
  else {
    const isChat = room.mode === 'chat'
    const failed = isChat ? currentFailedDecision() : null
    const pending = !failed && isChat && room.phase === 'role-speaking' ? (room.decisions ?? []).find(decision => decision.status === 'pending') : null
    if (pending) {
      const role = room.roles.find(item => item.id === pending.roleId)
      panel.hidden = false
      panel.className = 'reply-status typing'
      panel.innerHTML = `<span>${escape(role?.name ?? '角色')} 正在回复<span class="reply-dots"></span></span>`
    } else { panel.hidden = true; panel.innerHTML = '' }
  }
  // 「收到首字 / 失败卡片出现」：把主滚动条拉到最底
  const visibleScenes = room.hidePlayerSpeech ? room.scenes.filter(scene => scene.speaker !== 'player') : room.scenes
  const sceneSig = visibleScenes.length ? visibleScenes[visibleScenes.length - 1].id : ''
  const speechSig = room.speech ? `${room.speech.turnId}:${room.speech.roleId}` : ''
  const failedDecision = currentFailedDecision()
  const failedSig = failedDecision ? `${sceneSig}:${failedDecision.roleId}` : ''
  const sigChanged = sceneSig !== lastReplyScrollSig.scene || (speechSig && speechSig !== lastReplyScrollSig.speech) || (failedSig && failedSig !== lastReplyScrollSig.failed)
  lastReplyScrollSig = { scene: sceneSig, speech: speechSig, failed: failedSig }
  if (sigChanged) { const story = $('#story'); if (story) story.scrollTop = story.scrollHeight }
}
document.addEventListener('click', event => {
  if (event.target.id === 'reply-retry') { $('#retry-speak').click(); return }
  if (event.target.id === 'reply-cancel') { replyFailedDismissed = true; clearThinkingStreams(); api('/api/cancel-turn', {}).finally(() => refreshRoom()); return }
})

async function loadPromptPresets() { const response = await fetch('/api/prompts/presets'); if (response.ok) { const data = await response.json(); promptPresets = data.presets ?? []; promptPresetState = data; promptModes = Array.isArray(data.modes) && data.modes.length ? data.modes : promptModes; promptGameplayScenarios = data.gameplayScenarios ?? promptGameplayScenarios; promptGameplayScenarioForceThinkingOff = promptGameplayScenarios?.[promptPresetScope]?.forceThinkingOff === true; sidebarPromptPresetId = promptPresetState?.activeByScope?.[promptSideScope()] ?? sidebarPromptPresetId; if (room) render(room) } }
function ensurePromptScenario(preset, scope = promptPresetScope) {
  preset.scenarios ??= {}
  if (!preset.scenarios[scope]) preset.scenarios[scope] = { nodes: defaultPromptEditorNodes(scope), regexRules: [] }
  preset.scenarios[scope] = normalizeEditorScenario(preset.scenarios[scope], scope)
  return preset.scenarios[scope]
}
const DEFAULT_PROMPT_PRESET = () => ({ id: "default", name: "默认预设", enabled: true, modes: ["director", "chat"], scenarios: {}, nodes: [], regexRules: [] })

function renderPromptPresetEditor() {
  const preset = editingPromptPreset; if (!preset) return
  // 中栏标题标明正在修改哪一部分预设（预设名 + 当前情景）
  const editorTitle = document.querySelector('#prompt-preset-modal .prompt-preset-editor h3')
  if (editorTitle) editorTitle.textContent = `提示词编排 · 《${preset.name}》 · ${promptScopeLabel(promptPresetScope)}`
  const presetSelect = $('#prompt-preset-select'); if (presetSelect) { presetSelect.innerHTML = [...(promptPresets.some(item => item.id === 'default') ? [] : [DEFAULT_PROMPT_PRESET()]), ...promptPresets].map(item => `<option value="${escape(item.id)}">${escape(item.id === 'default' ? '默认预设' : item.name)}</option>`).join(''); presetSelect.value = preset.id } $('#prompt-preset-name').value = preset.name; const scenario = ensurePromptScenario(preset); const thinkingOverride = scenario.forceThinkingOff === true || promptGameplayScenarioForceThinkingOff; const thinkingToggle = $('#prompt-scenario-thinking-off'); if (thinkingToggle) { thinkingToggle.checked = thinkingOverride; thinkingToggle.disabled = promptGameplayScenarioForceThinkingOff } const modeList = $('#prompt-mode-list'); if (modeList) modeList.innerHTML = promptModes.map(mode => `<label><input type="checkbox" data-prompt-mode="${escape(mode.id)}"${(preset.modes ?? ['director']).includes(mode.id) ? ' checked' : ''}>${escape(mode.name)}</label>`).join(''); const tabs = $('#prompt-scenario-tabs'); if (tabs) { tabs.innerHTML = promptScopeEntries().filter(([id]) => id.startsWith('director.') ? (preset.modes ?? ['director']).includes('director') : (preset.modes ?? []).includes('chat')).map(([id, scenario]) => `<button type="button" class="prompt-scenario-tab${promptPresetScope === id ? ' active' : ''}" data-prompt-scenario="${id}">${escape(String(scenario?.name ?? id))}</button>`).join('') }
  const renderNode = (node, index) => { const content = node.removable === false ? runtimePreview(promptPresetScope, node) : node.content; const nodeLabel = node.removable === false ? (node.type === 'system' ? '玩法系统组件 · 必须启用' : '玩法用户组件 · 必须启用') : ''; return `<details class="prompt-node${node.removable === false ? ' prompt-gameplay-node' : ' prompt-private-node'}${node.type === 'system' ? ' prompt-system-node' : ' prompt-user-node'}${node.enabled ? '' : ' prompt-node-disabled'}" data-node-index="${index}" data-node-role="${node.type}"><summary><span class="prompt-node-handle" draggable="true" data-prompt-drag-handle="${index}" title="拖动调整顺序">☷</span><b>${escape(node.name)}</b><small>${nodeLabel}</small>${node.removable !== false ? `<button type="button" class="prompt-node-delete-icon" data-prompt-node-delete="${index}" title="删除私有提示词" aria-label="删除私有提示词">×</button>` : ''}</summary><div class="prompt-node-fields"><label>名称<input data-node-field="name" value="${escape(node.name)}"${node.type === 'system' ? ' disabled' : ''}></label><label>内容<textarea data-node-field="content"${node.type === 'system' ? ' disabled' : ''}>${escape(content)}</textarea></label><label class="settings-row">启用<input data-node-field="enabled" type="checkbox"${node.enabled ? ' checked' : ''}${node.type === 'system' ? ' disabled' : ''}></label></div></details>` }
  const systemNodes = scenario.nodes.map((node, index) => node.type === 'system' ? renderNode(node, index) : '').join('')
  const userNodes = scenario.nodes.map((node, index) => node.type === 'user' ? renderNode(node, index) : '').join('')
  const nodes = `${systemNodes}<div class="prompt-role-divider" data-prompt-divider="user" role="separator" title="拖动私有提示词到此处可切换为用户消息"><span>system / user</span></div>${userNodes}`
  const rules = scenario.regexRules.map((rule, index) => `<article class="prompt-regex" data-regex-index="${index}"><label>名称<input data-regex-field="name" value="${escape(rule.name)}"></label><label>匹配正则<input data-regex-field="pattern" value="${escape(rule.pattern)}"></label><label>替换文本<input data-regex-field="replacement" value="${escape(rule.replacement)}"></label><label class="settings-row">规则启用<input data-regex-field="enabled" type="checkbox"${rule.enabled ? ' checked' : ''}></label><small>仅用于 ST 导入预设的文本替换。</small><button type="button" data-regex-delete="${index}">删除</button></article>`).join('')
  $('#prompt-preset-nodes').innerHTML = `<h4 class="section-title">提示词节点（拖动排序）</h4>${gameplayComponents(promptPresetScope).length ? '' : '<p class="hint">该玩法暂无可用提示词组件。</p>'}${nodes}<details class="prompt-compatibility" open><summary>ST 正则兼容层</summary><label class="settings-row">启用 ST 正则兼容层<input id="prompt-regex-compatibility" type="checkbox"${preset.compatibility?.regexEnabled === true ? ' checked' : ''}></label><p class="hint">用于兼容导入的 ST 文本替换规则。关闭时规则保留但不会修改发送给模型的提示词。</p>${rules || '<p class="hint">没有兼容规则</p>'}</details>`
  // 默认方案为实体：不可覆盖保存、不可删除；内容可编辑，经「另存为」落盘。
  const presetLocked = preset.id === 'default'
  const saveBtn = $('#prompt-preset-save'); if (saveBtn) { saveBtn.disabled = presetLocked; saveBtn.title = presetLocked ? '默认方案不可覆盖保存，请另存为' : '' }
  const deleteBtn = $('#prompt-preset-delete'); if (deleteBtn) { deleteBtn.disabled = presetLocked; deleteBtn.title = presetLocked ? '默认方案不可删除' : '' }
}
function blankPromptPreset() { return { id: `preset-${Date.now()}`, name: '新预设', enabled: false, modes: [...new Set(promptModes.map(mode => mode.id))], scenarios: {}, nodes: [], regexRules: [] } }
async function openPromptPreset(id) { $('#prompt-preset-nodes').innerHTML = '<p class="hint">加载预设中…</p>'; editingPromptPreset = null; await loadPromptPresets(); editingPromptPreset = id === 'default' ? structuredClone(promptPresets.find(item => item.id === 'default') ?? DEFAULT_PROMPT_PRESET()) : structuredClone(promptPresets.find(item => item.id === id) ?? blankPromptPreset()); $('#prompt-preset-modal').showModal(); renderPromptPresetEditor(); await openPromptAssistantSession() }
function collectPromptPreset() { const preset = editingPromptPreset; const supportedModes = new Set(promptModes.map(mode => mode.id)); const checkedModes = [...document.querySelectorAll('[data-prompt-mode]:checked')].map(input => input.dataset.promptMode); preset.modes = [...new Set([...(preset.modes ?? []).filter(mode => !supportedModes.has(mode)), ...checkedModes])]; if (!preset.modes.length) { alert('至少选择一个已安装模式。'); throw new Error('Preset must declare at least one mode.') } preset.name = $('#prompt-preset-name').value.trim() || '未命名预设'; preset.enabled = false; preset.compatibility = { ...(preset.compatibility ?? {}), source: 'sillytavern', regexEnabled: $('#prompt-regex-compatibility')?.checked === true }; const scenario = ensurePromptScenario(preset); scenario.forceThinkingOff = $('#prompt-scenario-thinking-off')?.checked === true && !promptGameplayScenarioForceThinkingOff; scenario.order = [...document.querySelectorAll('.prompt-node')].map(card => scenario.nodes[Number(card.dataset.nodeIndex)]?.runtimeBinding ?? scenario.nodes[Number(card.dataset.nodeIndex)]?.id); scenario.nodes = [...document.querySelectorAll('.prompt-node')].map(card => { const old = scenario.nodes[Number(card.dataset.nodeIndex)]; const role = card.dataset.nodeRole === 'system' ? 'system' : 'user'; return { ...old, type: old.removable === false ? old.type : role, name: old.type === 'system' ? old.name : card.querySelector('[data-node-field="name"]').value.trim() || '未命名节点', content: old.type === 'system' ? old.content : card.querySelector('[data-node-field="content"]').value, enabled: old.type === 'system' ? true : card.querySelector('[data-node-field="enabled"]').checked } }); scenario.regexRules = [...document.querySelectorAll('.prompt-regex')].map(card => { const old = scenario.regexRules[Number(card.dataset.regexIndex)]; return { ...old, name: card.querySelector('[data-regex-field="name"]').value.trim() || '未命名规则', pattern: card.querySelector('[data-regex-field="pattern"]').value, replacement: card.querySelector('[data-regex-field="replacement"]').value, enabled: card.querySelector('[data-regex-field="enabled"]').checked } }); preset.scenarios = { ...(preset.scenarios ?? {}), [promptPresetScope]: scenario }; return preset }
async function refreshRoom() { const response = await fetch('/api/room'); render(await response.json()) }
function operationErrorMessage(operation, error) {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : error?.message || JSON.stringify(error ?? {})
  return `${operation}失败\n\n${detail || '未知错误'}${window.__STAGECRAFT_LOCAL__ ? '\n\n运行环境：Android 本地运行时' : ''}`
}
function showOperationError(operation, error) { console.error(`[StageCraft] ${operation} failed`, error); alert(operationErrorMessage(operation, error)) }
window.showOperationError = showOperationError
if (window.__STAGECRAFT_LOCAL__) {
  window.addEventListener('unhandledrejection', event => { event.preventDefault(); showOperationError('本地操作', event.reason) })
  window.addEventListener('error', event => { if (event.error) showOperationError('页面脚本', event.error) })
}
async function api(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.ok === false) { const error = data?.error; alert(typeof error === 'string' ? error : error?.message || '请求失败'); return false }
  // 操作成功后刷新房间；Core 重启/数据面切换窗口（重开剧本等会触发）可能瞬时 502——
  // 有限重试（bounded），避免 refreshRoom 拿到错误对象导致 UI 空白/报错。
  await refreshRoomWithRetry()
  return data
}
async function refreshRoomWithRetry() {
  const RETRY_LIMIT = 5
  const RETRY_DELAY_MS = 600
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    try {
      const response = await fetch('/api/room')
      if (response.ok) { render(await response.json()); return }
      if (attempt < RETRY_LIMIT - 1) { await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS)); continue }
      const data = await response.json().catch(() => ({}))
      render(data) // 重试耗尽：render 自身对错误对象容错（显示占位不崩溃）
    } catch (error) {
      if (attempt < RETRY_LIMIT - 1) { await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS)); continue }
      console.error('[StageCraft] refreshRoom failed', error)
      render({ error: { message: error instanceof Error ? error.message : String(error) } })
    }
  }
}
async function loadStories() {
  const response = await fetch('/api/stories')
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || '读取剧本列表失败。')
  const stories = Array.isArray(payload) ? payload : Array.isArray(payload.stories) ? payload.stories : []
  storyCatalog = stories
  const options = stories.map(story => `<option value="${escape(story.id)}">${escape(story.title)}${story.custom ? '' : '（默认）'}</option>`).join('')
  $('#story-select').innerHTML = options
  $('#story-edit-select').innerHTML = options
}
async function loadProviders() { const data = await (await fetch('/api/providers')).json(); providers = data.providers; const usable = providers.filter(provider => provider.hasApiKey); const hasUsable = usable.length > 0; const options = providers.map(provider => `<option value="${escape(provider.id)}">${escape(provider.name)}${provider.hasApiKey ? '（已配置）' : '（无密钥）'}</option>`).join(''); $('#provider-select').innerHTML = options; $('#director-provider-select').innerHTML = options; $('#provider-select').value = data.defaults.defaultRoleProviderId && providers.some(item => item.id === data.defaults.defaultRoleProviderId) ? data.defaults.defaultRoleProviderId : (usable[0]?.id ?? providers[0]?.id ?? ''); $('#director-provider-select').value = data.defaults.directorProviderId && providers.some(item => item.id === data.defaults.directorProviderId) ? data.defaults.directorProviderId : (usable[0]?.id ?? providers[0]?.id ?? ''); updateModels(providers.find(item => item.id === $('#provider-select').value), '#model-select', data.defaults.defaultRoleModel); updateModels(providers.find(item => item.id === $('#director-provider-select').value), '#director-model-select', data.defaults.directorModel); updateThinkingOptions('#director-thinking', $('#director-model-select').value, data.defaults.directorThinkingStrength ?? 'standard'); const selects = ['provider-select', 'model-select', 'director-provider-select', 'director-model-select', 'director-thinking']; selects.forEach(id => { $(`#${id}`).disabled = !hasUsable }); $('#refresh-models').disabled = !hasUsable; $('#provider-unconfigured-hint').hidden = hasUsable; renderProviderList() }
function renderProviderList() {
  const list = $('#provider-list')
  list.innerHTML = providers.length ? providers.map(provider => `<div class="provider-row" data-id="${escape(provider.id)}"><div class="provider-row-info"><b>${escape(provider.name?.trim() || '未命名供应商')}</b><small>${provider.models?.length ?? 0} 个模型 · ${provider.hasApiKey ? '已配置密钥' : '无密钥'}</small></div><div class="provider-row-actions"><button type="button" class="provider-edit" data-id="${escape(provider.id)}">编辑</button><button type="button" class="provider-delete" data-id="${escape(provider.id)}">删除</button></div></div>`).join('') : '<p class="hint">还没有供应商，点上方「新建供应商」添加。</p>'
  list.querySelectorAll('.provider-edit').forEach(button => button.onclick = () => openProviderEdit(button.dataset.id))
  list.querySelectorAll('.provider-delete').forEach(button => button.onclick = () => deleteProvider(button.dataset.id))
}
function openProviderEdit(id) {
  const provider = providers.find(item => item.id === id)
  $('#provider-edit-title').textContent = provider ? `编辑供应商：${provider.name}` : '新建供应商'
  $('#provider-name').value = provider?.name ?? ''
  $('#provider-url').value = provider?.baseUrl ?? ''
  $('#provider-key').value = '' // 密钥不回填（仅展示是否已配置）
  $('#provider-models').value = (provider?.models ?? []).join(',')
  $('#provider-format').value = provider?.responseFormat ?? 'json_object'
  $('#provider-save').dataset.editingId = provider?.id ?? ''
  $('#provider-key').placeholder = provider?.hasApiKey ? '已配置（留空保持不变）' : '输入 API Key'
  $('#provider-edit-modal').showModal()
}
async function deleteProvider(id) {
  const provider = providers.find(item => item.id === id)
  if (!provider || !confirm(`删除供应商「${provider.name}」？`)) return
  const response = await fetch('/api/providers/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
  if (!response.ok) { alert((await response.json()).error || '删除失败'); return }
  await loadProviders(); await refreshRoom()
}
$('#provider-manage').onclick = () => { loadProviders(); $('#connection-modal').close(); $('#provider-manager-modal').showModal() }
$('#provider-manager-back').onclick = () => { $('#provider-manager-modal').close(); $('#connection-modal').showModal() }
$('#provider-create').onclick = () => openProviderEdit('')
function updateModels(provider, selector, selected) { $(selector).innerHTML = (provider?.models ?? []).map(model => `<option>${escape(model)}</option>`).join(''); $(selector).value = selected ?? provider?.selectedModel ?? provider?.models?.[0] ?? '' }
function thinkingChoicesForModel(model) {
  const name = String(model ?? '').toLowerCase()
  if (/deepseek/.test(name)) return [['off', '关闭'], ['standard', 'high'], ['deep', 'max']]
  if (/kimi/.test(name)) return [['brief', '低'], ['standard', '高'], ['deep', '最高']]
  if (/doubao|seed/.test(name)) return [['off', '关闭'], ['brief', '自动'], ['standard', '开启']]
  return [['off', '关闭'], ['brief', '简略'], ['standard', '标准'], ['deep', '深度']]
}
function updateThinkingOptions(selector, model, selected) {
  const choices = thinkingChoicesForModel(model)
  $(selector).innerHTML = choices.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')
  $(selector).value = choices.some(([value]) => value === selected) ? selected : choices[choices.length - 1][0]
}

// ── 移动端呼出式抽屉：窄屏下左右栏滑出、点遮罩关闭（桌面端按钮隐藏，逻辑始终注册无副作用）──
const drawerBackdrop = document.getElementById('drawer-backdrop')
const rolesDrawer = document.getElementById('roles')
const workbenchDrawer = document.getElementById('workbench')
const rolesToggle = document.getElementById('mobile-roles-toggle')
const workbenchToggle = document.getElementById('mobile-workbench-toggle')
const setDrawer = (which, open) => {
  rolesDrawer.classList.toggle('drawer-open', which === 'roles' && open)
  workbenchDrawer.classList.toggle('drawer-open', which === 'workbench' && open)
  if (rolesToggle) rolesToggle.classList.toggle('drawer-open', which === 'roles' && open)
  if (workbenchToggle) workbenchToggle.classList.toggle('drawer-open', which === 'workbench' && open)
  if (drawerBackdrop) drawerBackdrop.hidden = !open
}
document.getElementById('mobile-roles-toggle').onclick = () => setDrawer('roles', !rolesDrawer.classList.contains('drawer-open'))
document.getElementById('mobile-workbench-toggle').onclick = () => setDrawer('workbench', !workbenchDrawer.classList.contains('drawer-open'))
if (drawerBackdrop) drawerBackdrop.onclick = () => setDrawer('roles', false)

$('#connection-settings').onclick = () => $('#connection-modal').showModal()
$('#player-settings').onclick = () => { const player = room.playerCharacter; $('#player-name').value = player.name; $('#player-persona').value = player.persona; $('#player-state').value = player.currentState; $('#player-avatar-preview').src = player.portraitRef || '/assets/default.svg'; $('#player-modal').showModal() }
// ── 主角肖像导入（与角色头像同一套保存逻辑）──
$('#player-avatar-upload').onclick = () => $('#player-avatar-file').click()
$('#player-avatar-file').onchange = event => {
  const file = event.target.files?.[0]
  if (!file) return
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { alert('仅支持 png / jpeg / gif / webp 图片。'); return }
  const reader = new FileReader()
  reader.onload = async () => {
    try {
      const dataUrl = await cropPortraitToRatio(String(reader.result))
      const ok = await api('/api/player/avatar', { dataUrl })
      if (ok) { $('#player-avatar-preview').src = ok.portraitRef ?? $('#player-avatar-preview').src; refreshRoom() }
    } finally { event.target.value = '' }
  }
  reader.readAsDataURL(file)
}
$('#player-avatar-url').onclick = async () => {
  const url = prompt('输入图片 URL（将下载为主角肖像并裁剪为 3:4）：')
  if (!url || !url.trim()) return
  try {
    const trimmed = url.trim()
    const prepared = await preparePortraitUrl(trimmed)
    const ok = prepared.startsWith('data:image/')
      ? await api('/api/player/avatar', { dataUrl: prepared })
      : await api('/api/player/avatar', { url: trimmed })
    if (ok) { $('#player-avatar-preview').src = ok.portraitRef ?? $('#player-avatar-preview').src; refreshRoom() }
  } catch { /* api() 已 alert */ }
}
// ── 关于：版本信息（当前提交编号）与更新检查 ──
async function loadVersionInfo() {
  const el = $('#about-version')
  if (!el) return
  try {
    const data = await (await fetch('/api/version')).json()
    const commitShort = data.commit ? data.commit.slice(0, 7) : ''
    el.textContent = `版本 ${data.version || 'dev'}${data.tag ? `（${data.tag.replace(/^v/, '')}）` : ''}${commitShort ? ` · 提交 ${commitShort}` : ''}${data.platform ? ` · ${data.platform === 'android' ? 'APK' : '桌面'}` : ''}`
  } catch { el.textContent = '版本信息不可用。' }
}
// ── 更新流程：按钮与自动检查共用；APK 走原生下载安装（带进度回调），桌面走流式下载+自更新 ──
window.StageCraftUpdateProgress = result => {
  const status = $('#update-status')
  if (!status || !result) return
  if (result.percent < 0) status.textContent = result.text || '更新失败。'
  else status.textContent = result.text || (result.percent != null ? `下载中 ${result.percent}%…` : '')
}
async function runUpdateFlow(data) {
  const status = $('#update-status')
  if (window.__STAGECRAFT_LOCAL__) {
    try {
      if (!data.apkUrl) throw new Error('该版本没有可用的 Android 安装包。')
      if (!window.StageCraftNative || typeof window.StageCraftNative.updateDownloadAndInstall !== 'function') throw new Error('当前 APK 不支持应用内更新。')
      status.textContent = '正在下载并安装…'
      window.StageCraftNative.updateDownloadAndInstall(data.apkUrl)
    } catch (error) { status.textContent = `更新失败：${error instanceof Error ? error.message : String(error)}` }
  } else {
    status.textContent = '正在下载并准备更新…'
    try {
      const response = await fetch('/api/update/download', { method: 'POST' })
      if (!response.ok || !response.body) { const err = await response.json().catch(() => ({})); throw new Error(err.error || `下载失败（HTTP ${response.status}）。`) }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let failed = null
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value, { stream: true }).split('\n')) {
          if (!line.trim()) continue
          let item
          try { item = JSON.parse(line) } catch { continue }
          if (item.ok === false) { failed = new Error(item.error || '下载失败。'); break }
          if (item.percent != null) status.textContent = item.text || `下载中 ${item.percent}%…`
          if (item.ok) { status.textContent = '下载完成，正在自动重启并打开新版本…'; await new Promise(resolve => setTimeout(resolve, 800)); try { window.close() } catch { /* 忽略 */ } }
        }
        if (failed) break
      }
      if (failed) throw failed
    } catch (error) { status.textContent = `更新失败：${error instanceof Error ? error.message : String(error)}` }
  }
}
$('#check-update').onclick = async () => {  const status = $('#update-status')
  if (!status) return
  const button = $('#check-update')
  button.disabled = true
  status.textContent = '正在检查更新…'
  try {
    const response = await fetch('/api/update/check')
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '检查更新失败。')
    if (!data.updateAvailable) { status.textContent = '当前已是最新版本。'; return }
    status.textContent = `发现新版本 ${data.tag}（${data.version}）。`
    if (!confirm(`发现新版本 ${data.tag}，是否下载并更新？${window.__STAGECRAFT_LOCAL__ ? '' : '更新过程中程序会短暂退出。'}`)) return
    await runUpdateFlow(data)
  } catch (error) { status.textContent = error instanceof Error ? error.message : '检查更新失败。' }
  finally { button.disabled = false }
}
// ── 启动时自动检查更新（默认关闭；桌面 localStorage，APK 走原生 secret 桥）──
function readAutoUpdatePref() {
  if (window.__STAGECRAFT_LOCAL__) {
    try {
      const raw = window.StageCraftNative && window.StageCraftNative.invokeSync('secret.get', JSON.stringify({ key: 'local.auto-update' }))
      const parsed = raw ? JSON.parse(raw) : null
      return Boolean(parsed && parsed.found && parsed.value === 'true')
    } catch { return false }
  }
  try { return localStorage.getItem('stagecraft.autoUpdate') === '1' } catch { return false }
}
function writeAutoUpdatePref(enabled) {
  if (window.__STAGECRAFT_LOCAL__) {
    try { window.StageCraftNative && window.StageCraftNative.invokeSync('secret.set', JSON.stringify({ key: 'local.auto-update', value: enabled ? 'true' : 'false' })) } catch { /* 忽略 */ }
    return
  }
  try { localStorage.setItem('stagecraft.autoUpdate', enabled ? '1' : '0') } catch { /* 忽略 */ }
}
$('#settings-auto-update').onchange = () => writeAutoUpdatePref($('#settings-auto-update').checked)
async function checkForUpdatesSilent() {
  try {
    const response = await fetch('/api/update/check')
    const data = await response.json()
    if (!response.ok || !data.updateAvailable) return
    if (window.__STAGECRAFT_LOCAL__) {
      // 启动自动检测到更新：直接弹窗询问（默认关闭该功能时不会走到这里）
      if (confirm(`发现新版本 ${data.tag}（${data.version}），是否立即更新？`)) await runUpdateFlow(data)
    } else {
      $('#update-status').textContent = `发现新版本 ${data.tag}（${data.version}），可在「设置 → 关于」中更新。`
    }
  } catch { /* 静默失败不打扰 */ }
}
$('#story-settings').onclick = () => { refreshArchiveList(); const storySelect = $('#story-select'); if (room?.storyId && [...storySelect.options].some(option => option.value === room.storyId)) storySelect.value = room.storyId; const modeLabel = room?.mode === 'chat' ? '群聊' : '导演'; $('#archive-name').value = room?.title?.trim() ? `${room.title.trim()}-${modeLabel}` : (room?.storyId ?? ''); $('#room-mode-select').value = room?.mode ?? 'chat'; $('#story-modal').showModal() }
$('#app-settings').onclick = () => { $('#settings-token-count').checked = tokenCountEnabled; $('#settings-debug').checked = !debugWindow.hidden; $('#settings-whale-meme').checked = whaleMemeEnabled; $('#settings-auto-update').checked = readAutoUpdatePref(); $('#settings-modal').showModal(); void loadVersionInfo() }
$('#settings-token-count').onchange = () => { tokenCountEnabled = $('#settings-token-count').checked; try { localStorage.setItem(TOKEN_PREFS_KEY, tokenCountEnabled ? '1' : '0') } catch {} render(room) }
$('#settings-debug').onchange = () => { debugWindow.hidden = !$('#settings-debug').checked }
$('#debug-toggle').onclick = () => { debugDetailsEnabled = !debugDetailsEnabled; $('#debug-toggle').classList.toggle('active', debugDetailsEnabled); debugWindow.classList.toggle('debug-details-on', debugDetailsEnabled) }
$('#debug-window-close').onclick = () => { debugWindow.hidden = true; $('#settings-debug').checked = false }
$('#settings-whale-meme').onchange = () => { whaleMemeEnabled = $('#settings-whale-meme').checked; try { localStorage.setItem(WHALE_MEME_PREFS_KEY, whaleMemeEnabled ? '1' : '0') } catch {}; applyWhaleMeme() }
// 群聊发言模式：侧栏「设置与预设」切换（持久化）——模式只决定提交行动后的自动行为；
// 角色列表上方的两个按钮在三种模式下都可手动触发导演选角/全体依次发言
document.addEventListener('change', event => { const select = event.target.closest?.('#speech-mode-select'); if (select) api('/api/room-config', { speechMode: select.value }).then(ok => ok && refreshRoom()) })
document.addEventListener('change', event => { const toggle = event.target.closest?.('#sidebar-auto-publish'); if (toggle) api('/api/room-config', { autoPublish: toggle.checked }).then(ok => ok && refreshRoom()) })
document.addEventListener('change', event => { const toggle = event.target.closest?.('#sidebar-hide-player-speech'); if (toggle) api('/api/room-config', { hidePlayerSpeech: toggle.checked }).then(ok => ok && refreshRoom()) })
document.addEventListener('click', event => { const director = event.target.closest?.('#chat-mode-trigger-director'); const everyone = event.target.closest?.('#chat-mode-trigger-all'); if (director || everyone) { if (activeAction) return; activeAction = 'speak'; render(room); api(director ? '/api/chat/director-decide' : '/api/chat/speak-all', {}).finally(() => { activeAction = null; refreshRoom() }) } })
$('#remote-pairing-code').onclick = async event => {
  event.preventDefault()
  $('#remote-pairing-result').hidden = true
  $('#remote-pairing-error').textContent = ''
  try {
    const response = await fetch('/api/remote/pairing-code', { method: 'POST', headers: { accept: 'application/json' } })
    const body = await response.json()
    if (!response.ok) throw new Error(response.status === 403 ? '远程访问未开启，或当前页面不是从本机访问。' : '无法生成配对码。')
    $('#remote-pairing-value').textContent = body.code
    $('#remote-pairing-expiry').textContent = `有效期至 ${new Date(body.expiresAt).toLocaleTimeString()}`
    $('#remote-pairing-result').hidden = false
  } catch (error) {
    $('#remote-pairing-error').textContent = error instanceof Error ? error.message : '无法生成配对码。'
  }
}

$('#remote-pairing-revoke').onclick = async event => {
  event.preventDefault()
  if (!confirm('将注销所有已配对的手机会话（手机需重新配对）。继续？')) return
  try {
    const response = await fetch('/api/remote/revoke', { method: 'POST' })
    if (!response.ok) throw new Error('清除失败。')
    alert('已清除所有已配对会话。')
  } catch (error) {
    $('#remote-pairing-error').textContent = error instanceof Error ? error.message : '清除失败。'
  }
}

// ── 手机 APK 与电脑双向同步（仅本地运行时；配对凭据与远端 HTTP 都在原生侧） ──
function describeSyncResult(result) {
  const parts = []
  if (result?.room) parts.push('房间已更新')
  if (result?.providers) parts.push('供应商已更新')
  if (result?.saves != null) parts.push(`存档 ${result.saves}`)
  if (result?.stories != null) parts.push(`剧本 ${result.stories}`)
  if (result?.presets != null) parts.push(`预设 ${result.presets}`)
  return parts.length ? parts.join('，') : '完成'
}
async function refreshSyncRemoteStatus() {
  const statusEl = $('#sync-remote-status')
  if (!statusEl || !window.StageCraftSyncRemote) return
  try {
    const status = await window.StageCraftSyncRemote.status()
    statusEl.textContent = status && status.paired ? `已绑定：${status.address}` : '未绑定电脑。'
  } catch { statusEl.textContent = '未绑定电脑。' }
}
$('#sync-remote-pair').onclick = async () => {
  if (!window.StageCraftSyncRemote) return
  $('#sync-remote-error').textContent = ''
  // 记住上次填过的电脑地址（localStorage 被 WebView 禁用，走原生 secret 桥）
  const savedAddress = (() => {
    try {
      const raw = window.StageCraftNative && window.StageCraftNative.invokeSync('secret.get', JSON.stringify({ key: 'sync.remote.address' }))
      const parsed = raw ? JSON.parse(raw) : null
      return parsed && parsed.found ? String(parsed.value || '') : ''
    } catch { return '' }
  })()
  const address = prompt('电脑地址：如 http://192.168.1.5:8787（与电脑实际监听地址一致；局域网 IP 用 http 即可）', savedAddress || '')
  if (!address || !address.trim()) return
  try { window.StageCraftNative && window.StageCraftNative.invokeSync('secret.set', JSON.stringify({ key: 'sync.remote.address', value: address.trim() })) } catch { /* 记住地址失败不影响绑定 */ }
  const code = prompt('一次性配对码：在电脑「设置 → 手机远程配对 → 生成手机配对码」查看（5 分钟内有效）')
  if (!code || !code.trim()) return
  try {
    const result = await window.StageCraftSyncRemote.pair(address.trim(), code.trim())
    if (result && result.ok) { await refreshSyncRemoteStatus(); alert('已绑定电脑，可以开始同步。') }
    else $('#sync-remote-error').textContent = (result && result.message) || '绑定失败，请检查地址与配对码。'
  } catch (error) { $('#sync-remote-error').textContent = error instanceof Error ? error.message : '绑定失败。' }
}
$('#sync-remote-pull').onclick = async () => {
  const sync = window.StageCraftSyncRemote
  if (!sync) return
  $('#sync-remote-error').textContent = ''
  const status = await sync.status()
  if (!status || !status.paired) { $('#sync-remote-error').textContent = '请先「绑定电脑（配对码）」。'; return }
  if (!confirm('从电脑拉取会用电脑数据覆盖本机的房间、存档、剧本与供应商配置，并导入电脑的提示词预设。确认继续？')) return
  $('#sync-remote-error').textContent = '正在从电脑拉取…'
  try {
    const result = await sync.pull()
    $('#sync-remote-error').textContent = `拉取完成：${describeSyncResult(result)}。`
    await refreshRoom()
    await loadStories()
    await loadPromptPresets()
    if (result.providers) await loadProviders()
  } catch (error) { $('#sync-remote-error').textContent = `拉取失败：${error instanceof Error ? error.message : String(error)}` }
}
$('#sync-remote-push').onclick = async () => {
  const sync = window.StageCraftSyncRemote
  if (!sync) return
  $('#sync-remote-error').textContent = ''
  const status = await sync.status()
  if (!status || !status.paired) { $('#sync-remote-error').textContent = '请先「绑定电脑（配对码）」。'; return }
  if (!confirm('推送到电脑会用本机数据覆盖电脑上的房间、存档、剧本与供应商配置，并上传本机的提示词预设。确认继续？')) return
  $('#sync-remote-error').textContent = '正在推送到电脑…'
  try {
    const result = await sync.push()
    $('#sync-remote-error').textContent = `推送完成：${describeSyncResult(result)}。`
  } catch (error) { $('#sync-remote-error').textContent = `推送失败：${error instanceof Error ? error.message : String(error)}` }
}
if (window.__STAGECRAFT_LOCAL__ && window.StageCraftNative && typeof window.StageCraftNative.syncStatus === 'function') {
  const row = $('#sync-remote-row')
  if (row) row.hidden = false
  // 本地模式下整栏隐藏桌面操作员专属「手机远程配对」（手机上生成配对码/清除配对无意义，本地运行时也没有对应服务端路由）
  const pairing = $('#remote-pairing-section')
  if (pairing) pairing.hidden = true
  $('#app-settings').addEventListener('click', refreshSyncRemoteStatus)
  void refreshSyncRemoteStatus()
}

// ── ST 角色卡导入（兼容旧房间导入与 Creator Workbench 预览） ──
let stImportFile = null
$('#st-import-open').onclick = () => { stImportFile = null; $('#st-import-file').value = ''; $('#st-import-run').disabled = true; $('#st-import-preview').innerHTML = '<p class="hint">选择 JSON 或 PNG 角色卡后显示解析结果。</p>'; $('#st-import-modal').showModal() }
$('#st-import-close').onclick = () => $('#st-import-modal').close()
$('#st-import-file').onchange = async event => {
  const file = event.target.files[0]
  if (!file) return
  const preview = $('#st-import-preview')
  if (!/\.(png|json)$/i.test(file.name)) {
    stImportFile = null
    $('#st-import-run').disabled = true
    preview.innerHTML = '<p class="error">请选择 .json 或 .png 格式的 ST 角色卡。</p>'
    return
  }
  preview.innerHTML = '<p class="hint">读取中…</p>'
  try {
    stImportFile = { content: await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]+,/, '')); reader.onerror = () => reject(reader.error); if (/\.json$/i.test(file.name)) reader.readAsText(file); else reader.readAsDataURL(file) }), filename: file.name }
    preview.innerHTML = `<p>已读取 <b>${escape(file.name)}</b>（${file.size} 字节）——点击「导入为角色」执行服务器解析。</p>`
    $('#st-import-run').disabled = false
  } catch (error) {
    preview.innerHTML = `<p class="error">读取失败：${escape(error.message)}</p>`
    stImportFile = null
    $('#st-import-run').disabled = true
  }
}
$('#st-import-run').onclick = async () => {
  if (!stImportFile) return
  const preview = $('#st-import-preview')
  const button = $('#st-import-run')
  button.disabled = true
  preview.innerHTML = '<p class="hint">解析中…</p>'
  try {
    const workbenchMode = document.querySelector('#story-edit-modal')?.open
    const response = await fetch(workbenchMode ? '/api/creator/preview' : '/api/st-cards/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(workbenchMode ? { ...stImportFile, kind: /\.png$/i.test(stImportFile.filename) ? 'st-card-png' : 'st-card-json' } : stImportFile) })
    const data = await response.json()
    if (!response.ok) { preview.innerHTML = `<p class="error">导入失败：${escape(data.error || response.status)}</p>`; button.disabled = false; return }
    if (workbenchMode) {
      window.creatorPreview = data
      $('#creator-revert').disabled = false
      $('#st-import-modal').close()
      setCreatorStatus('已导入预览', 'ready')
      $('#creator-agent-preview').innerHTML = `<strong>已生成导入预览</strong><p>${escape(data.source?.summary ?? '候选内容已准备')}。如需修改，请直接在 DSH 剧情编辑助手中提出。</p>`
      button.textContent = '已生成预览'
      return
    }
    const mapped = data.mapped ?? {}
    const warnings = (mapped.warnings ?? []).map(warning => `<li>${escape(warning)}</li>`).join('')
    preview.innerHTML = `<p class="st-import-ok">✅ 已导入 <b>${escape(mapped.name)}</b>（${mapped.selfModelChars} 字人设${mapped.loreCount ? `，${mapped.loreCount} 条世界书` : ''}${mapped.spec ? `，${escape(mapped.spec)}` : ''}）</p>${warnings ? `<ul class="st-import-warnings">${warnings}</ul>` : ''}<p class="hint">可在左侧角色列表中查看；世界书条目在「世界书」标签页。</p>`
    const workbench = $('#creator-agent-preview')
    if (workbench !== missingElement) {
      $('#creator-preview-status').textContent = '已完成'
      $('#creator-preview-status').className = 'creator-status ready'
      workbench.innerHTML = `<strong>${escape(mapped.name ?? 'ST 角色卡')}</strong><p>服务器已完成角色映射${mapped.loreCount ? `，包含 ${mapped.loreCount} 条世界书条目` : ''}。</p>`
      $('#creator-agent-preview').innerHTML += warnings ? `<p class="hint">${escape(warnings.replace(/<[^>]+>/g, ''))}</p>` : ''
    }
    button.textContent = '已导入'
  } catch (error) {
    preview.innerHTML = `<p class="error">导入失败：${escape(error.message)}</p>`
    button.disabled = false
  }
}
document.addEventListener('click', event => {
  const decision = event.target.closest?.('[data-creator-decision]')
  if (decision) { const row = decision.closest('[data-creator-path]'); const diff = window.creatorPreview?.diffs?.find(item => item.path === row?.dataset.creatorPath); if (diff) { diff.decision = decision.dataset.creatorDecision; row.classList.toggle('accepted', diff.decision === 'accept'); row.classList.toggle('rejected', diff.decision === 'reject') } }
})
$('#prompt-preset-select').onchange = () => { if ($('#prompt-preset-select').value) openPromptPreset($('#prompt-preset-select').value) }
document.addEventListener('change', async event => { const sideSelect = event.target.closest?.('#prompt-preset-select-sidebar'); if (sideSelect) { sidebarPromptPresetId = sideSelect.value || 'default'; void fetch('/api/prompts/presets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: promptSideScope(), activePresetId: sidebarPromptPresetId }) }).then(response => { if (!response.ok) alert('切换当前预设失败。') }).catch(error => alert(error.message)); render(room); return } const privateToggle = event.target.closest?.('.prompt-private-toggle'); if (!privateToggle) return; try { const response = await fetch('/api/prompts/private-toggles', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ presetId: sidebarPromptPresetId, nodeId: privateToggle.dataset.promptPrivate, enabled: privateToggle.checked }) }); if (!response.ok) throw new Error('save failed') } catch (error) { alert('开关状态保存失败。'); } await loadPromptPresets(); render(room) })
$('#prompt-preset-new-modal').onclick = () => { editingPromptPreset = blankPromptPreset(); renderPromptPresetEditor() }
$('#prompt-stagecraft-import-button').onclick = () => $('#prompt-stagecraft-import-file').click()
$('#prompt-stagecraft-import-file').onchange = async event => { const file = event.target.files?.[0]; if (!file) return; try { const data = JSON.parse(await file.text()); const imported = Array.isArray(data) ? data[0] : Array.isArray(data.presets) ? data.presets[0] : data.preset ?? data; if (!imported || typeof imported !== 'object') throw new Error('文件不是有效的 StageCraft 预设'); editingPromptPreset = structuredClone(imported); editingPromptPreset.id = editingPromptPreset.id || `preset-${Date.now()}`; editingPromptPreset.name = editingPromptPreset.name || file.name.replace(/\.json$/i, ''); renderPromptPresetEditor() } catch (error) { alert(`导入 StageCraft 预设失败：${error.message}`) } finally { event.target.value = '' } }
$('#prompt-st-import-button').onclick = () => $('#prompt-st-import-file').click()
$('#prompt-st-import-file').onchange = async event => { const file = event.target.files?.[0]; if (!file) return; try { const source = await file.text(); const response = await fetch('/api/prompts/import-st', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'ST 预设转换失败'); const result = data.result ?? {}; editingPromptPreset = preparePromptAssistantDraft(result.preset); if (!editingPromptPreset) throw new Error('ST 预设没有可导入的提示词节点'); ensurePromptScenario(editingPromptPreset); renderPromptPresetEditor(); const warnings = Array.isArray(result.warnings) && result.warnings.length ? `\n\n注意：\n${result.warnings.join('\n')}` : ''; alert(`${result.reply ?? `已导入《${file.name}》`} ${warnings}`) } catch (error) { alert(`导入 ST 预设失败：${error.message}`) } finally { event.target.value = '' } }
$('#prompt-preset-add-node').onclick = () => { collectPromptPreset(); const scenario = ensurePromptScenario(editingPromptPreset); scenario.nodes.push({ id: `user-${Date.now()}`, name: '私有提示词', content: '', type: 'user', enabled: true, editable: true, removable: true }); renderPromptPresetEditor() }
$('#prompt-preset-add-regex').onclick = () => { collectPromptPreset(); editingPromptPreset.regexRules.push({ id: `regex-${Date.now()}`, name: 'ST 兼容规则', pattern: '', replacement: '', enabled: false }); renderPromptPresetEditor() }
$('#prompt-preset-save').onclick = async () => {
  if (editingPromptPreset?.id === 'default') { alert('默认方案不可覆盖保存，请用另存为创建新预设。'); return }
  const preset = collectPromptPreset()
  try {
    const response = await fetch('/api/prompts/presets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset }) })
    if (!response.ok) { alert('提示保存失败。'); return }
    const data = await response.json()
    promptPresets = data.presets ?? promptPresets
    // 确认后端已落盘：重新读取并校验预设存在，再提示成功；弹窗保持打开
    await loadPromptPresets()
    if (!promptPresets.some(item => item.id === preset.id)) { alert('提示保存失败：后端未落盘。'); return }
    alert('提示保存成功。')
  } catch (error) {
    alert(`提示保存失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
async function downloadCurrentFile(path, filename, nativeExport) {
  if (window.__STAGECRAFT_LOCAL__ && window.StageCraftNative?.exportDocument && nativeExport) {
    window.StageCraftNative.exportDocument(nativeExport.kind, JSON.stringify(nativeExport.payload ?? {}), filename)
    return
  }
  const response = await fetch(path)
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || '导出失败。') }
  const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function downloadCurrentJson(path, body, filename) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || '导出失败。') }
  const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
$('#prompt-preset-export').onclick = async () => {
  if (!editingPromptPreset) return
  try { const preset = collectPromptPreset(); await downloadCurrentFile(`/api/prompts/presets/export?id=${encodeURIComponent(preset.id)}`, `${preset.name || 'preset'}.json`, { kind: 'preset', payload: { preset } }) } catch (error) { showOperationError('导出预设', error) }
}
$('#story-import-button').onclick = () => {
  if (window.__STAGECRAFT_LOCAL__ && window.StageCraftNative?.chooseStoryArchive) window.StageCraftNative.chooseStoryArchive()
  else $('#story-import-file').click()
}
$('#story-import-file').onchange = async event => {
  const file = event.target.files?.[0]; if (!file) return
  try { const response = await fetch('/api/story/import', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: await file.arrayBuffer() }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || '导入剧本失败。'); await loadStories(); await openStoryEditor(data.id) }
  catch (error) { showOperationError('导入剧本', error) } finally { event.target.value = '' }
}
$('#story-export').onclick = async () => {
  const id = $('#story-edit-id').textContent.trim()
  if (!id) return showOperationError('导出剧本', new Error('没有选择剧本。'))
  try { await downloadCurrentFile(`/api/story/export?id=${encodeURIComponent(id)}`, `${$('#story-edit-title').value.trim() || id}.zip`, { kind: 'story', payload: { storyId: id } }) } catch (error) { showOperationError('导出剧本', error) }
}
$('#prompt-preset-save-as').onclick = async () => {
  if (!editingPromptPreset) return
  let source
  try { source = collectPromptPreset() } catch { return }
  const name = prompt('另存为新预设的名称：', (source.name || '预设') + ' 副本')
  if (!name) return
  const copy = structuredClone(source)
  copy.id = `preset-${Date.now()}`
  copy.name = name.trim() || '未命名预设'
  const response = await fetch('/api/prompts/presets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset: copy }) })
  if (!response.ok) { alert('另存为预设失败。'); return }
  const data = await response.json()
  promptPresets = data.presets ?? promptPresets
  editingPromptPreset = structuredClone(promptPresets.find(item => item.id === copy.id) ?? blankPromptPreset())
  renderPromptPresetEditor()
  render(room)
}
$('#prompt-preset-delete').onclick = async () => {
  if (!editingPromptPreset || editingPromptPreset.id === 'default') return
  if (!confirm(`删除预设《${editingPromptPreset.name}》？`)) return
  const response = await fetch(`/api/prompts/presets?id=${encodeURIComponent(editingPromptPreset.id)}`, { method: 'DELETE' })
  if (!response.ok) { alert('删除预设失败。'); return }
  const data = await response.json()
  promptPresets = data.presets ?? promptPresets
  if (!promptPresets.some(item => item.id === sidebarPromptPresetId)) sidebarPromptPresetId = 'default'
  editingPromptPreset = DEFAULT_PROMPT_PRESET()
  renderPromptPresetEditor()
  render(room)
}
document.addEventListener('click', event => { const tab = event.target.closest?.('[data-prompt-scenario]'); if (tab) { collectPromptPreset(); promptPresetScope = tab.dataset.promptScenario; promptGameplayScenarioForceThinkingOff = promptGameplayScenarios?.[promptPresetScope]?.forceThinkingOff === true; renderPromptPresetEditor() } })
document.addEventListener('change', event => { const mode = event.target.closest?.('[data-prompt-mode]'); if (!mode || !editingPromptPreset) return; const enabled = [...document.querySelectorAll('[data-prompt-mode]:checked')].map(input => input.dataset.promptMode); if (!enabled.length) { mode.checked = true; return } editingPromptPreset.modes = [...new Set(enabled)]; const hidden = promptPresetScope.startsWith('director.') ? !enabled.includes('director') : !enabled.includes('chat'); if (hidden) { const next = promptScopeEntries().find(([id]) => (id.startsWith('director.') ? enabled.includes('director') : enabled.includes('chat')))?.[0]; if (next) promptPresetScope = next } renderPromptPresetEditor() })
document.addEventListener('change', event => { const input = event.target.closest?.('[data-panel-input]'); if (!input) return; const card = input.closest('.panel-card'); const actionId = input.dataset.panelInput; if (!actionId) return; const owner = card?.dataset.panelOwner ?? ''; const value = input.value ?? ''; fetch('/api/core/ui/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId, owner, input: { value } }) }).then(response => response.json()).then(data => { if (!data.ok) alert(data.error || '面板操作失败'); if (workbenchTab === 'panels') renderPanelDock() }).catch(error => alert(error.message)) })
let draggingPromptNode = null
let promptAssistantDraft = null
function appendPromptAssistant(role, text) { const list = $('#prompt-assistant-messages'); if (!list) return; $('#prompt-assistant-welcome')?.remove(); list.insertAdjacentHTML('beforeend', `<p class="prompt-assistant-message ${role}"><b>${role === 'user' ? '你' : 'AI'}</b>${escape(text)}</p>`); list.scrollTop = list.scrollHeight }
function preparePromptAssistantDraft(raw) {
  const draft = structuredClone(raw)
  if (!draft || typeof draft !== 'object') return null
  draft.id = draft.id || `preset-${Date.now()}`
  draft.name = draft.name || 'AI助手草案'
  draft.enabled = false
  draft.modes = Array.isArray(draft.modes) && draft.modes.length ? draft.modes : ['director']
  draft.scenarios ??= {}
  if (!draft.scenarios[promptPresetScope]) {
    const legacyNodes = Array.isArray(draft.nodes) ? draft.nodes : []
    draft.scenarios[promptPresetScope] = { nodes: legacyNodes, regexRules: Array.isArray(draft.regexRules) ? draft.regexRules : [] }
  }
  return draft
}
function importPromptAssistantDraft() {
  if (!promptAssistantDraft) return
  editingPromptPreset = preparePromptAssistantDraft(promptAssistantDraft)
  ensurePromptScenario(editingPromptPreset)
  renderPromptPresetEditor()
  $('#prompt-preset-nodes')?.scrollTo({ top: 0, behavior: 'smooth' })
}
function promptAssistantContext() { return `你是 StageCraft 的提示词预设编辑助手。你只能分析和提出预设变更建议，不要修改剧本文件，不要声称已经保存任何预设。用户会在中栏预览并明确点击保存。

编辑规则（完整版见 docs/st-preset-mapping-manual.md）：
- 固定玩法节点（removable=false）不可改名、不可删、不可改 role，只能调顺序和启用状态。
- 每个独立信息来源保持独立节点；不合并、不改写内容。
- role 为 system 的节点保持在 system 段，role 为 user 的保持在 user 段；调整顺序不跨段。
- enabled=false 的节点保留，以暗色显示；不要删除用户已关闭的节点。
- 正则规则是 ST 兼容层，默认总开关关闭；不要建议默认开启。
- 采样参数、prefill、squash_system_messages 不在此预设中体现（导入时已过滤），不讨论。
- 只输出节点级 diff 和理由，不直接改预设、不伪造已保存、不返回空对象。

当前预设：
${JSON.stringify(editingPromptPreset, null, 2)}

当前情景：${promptPresetScope}
先按手册标注每个 ST 条目为 保留/跳过/警告，再输出节点级 diff 和理由，不要返回空对象。` }
async function syncPromptAssistantContext() { if (!promptAssistantSession) return; await agentSessionRequest('/api/agent/context', { owner: promptAssistantOwner, sessionId: promptAssistantSession.id, context: promptAssistantContext() }) }
async function renderPromptAssistantSession(session) { promptAssistantSession = session; try { session.messages = await agentSessionRequest('/api/agent/history', { owner: promptAssistantOwner, sessionId: session.id }) } catch {} $('#prompt-assistant-session-label').textContent = session ? `会话 · ${String(session.id).slice(-8)}` : '尚未选择会话'; $('#prompt-assistant-session-model').disabled = !session; renderPromptAssistantMessages(session?.messages ?? []) }
async function openPromptAssistantSession() { try { await loadPromptAssistantSessions(); $('#prompt-assistant-session-modal').showModal() } catch (error) { $('#prompt-assistant-messages').innerHTML = `<p class="error">DSH 预设编辑助手不可用：${escape(error instanceof Error ? error.message : String(error))}<br>仍可使用左栏的本地 ST 导入。</p>` } }
async function loadPromptAssistantSessions() { const response = await fetch(`/api/agent/session?owner=${encodeURIComponent(promptAssistantOwner)}&storyId=eldoria`); if (!response.ok) throw new Error('无法读取 DSH 会话。'); const sessions = await response.json(); const list = $('#prompt-assistant-session-list'); list.innerHTML = sessions.length ? sessions.map(session => `<div class="creator-session-row"><button type="button" class="creator-session-choice" data-prompt-session-id="${escape(session.id)}">${escape(String(session.id).slice(-8))}</button><button type="button" class="creator-session-archive" data-prompt-archive-id="${escape(session.id)}" title="归档此会话">归档</button></div>`).join('') : '<p class="hint">当前没有预设助手会话。</p>'; list.querySelectorAll('[data-prompt-session-id]').forEach(button => button.onclick = async () => { const session = sessions.find(item => item.id === button.dataset.promptSessionId); await renderPromptAssistantSession(session); await syncPromptAssistantContext(); $('#prompt-assistant-session-modal').close() }); list.querySelectorAll('[data-prompt-archive-id]').forEach(button => button.onclick = async event => { event.stopPropagation(); const id = button.dataset.promptArchiveId; if (!confirm(`归档会话 ${String(id).slice(-8)}？`)) return; await agentSessionRequest('/api/agent/archive', { owner: promptAssistantOwner, sessionId: id }); await loadPromptAssistantSessions() }) }
async function agentSessionRequest(path, body) { const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'DSH 会话请求失败'); return data }

async function waitForPromptAssistantReply(sessionId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!promptAssistantSession || promptAssistantSession.id !== sessionId) return;
    try { const messages = await agentSessionRequest('/api/agent/history', { owner: promptAssistantOwner, sessionId }); renderPromptAssistantMessages(messages); if (messages.some(message => message.role === 'system')) return } catch { return }
  }
}
function renderPromptAssistantMessages(messages) { const list = $('#prompt-assistant-messages'); if (!list) return; list.innerHTML = messages?.length ? messages.map(message => `<div class="prompt-assistant-message ${message.role}"><b>${message.role === 'user' ? '你' : 'DSH'}</b><p>${escape(message.text)}</p></div>`).join('') : '<p class="hint">暂无消息。</p>'; list.scrollTop = list.scrollHeight }
async function requestPromptAssistant(message) {
  const input = $('#prompt-assistant-input'); const send = $('#prompt-assistant-send'); if (!promptAssistantSession) { await openPromptAssistantSession(); if (!promptAssistantSession) return }
  appendPromptAssistant('user', message); if (input) { input.value = ''; input.disabled = true }; if (send) send.disabled = true;
  try { const data = await agentSessionRequest('/api/agent/message', { owner: promptAssistantOwner, sessionId: promptAssistantSession.id, storyId: 'eldoria', text: message }); await renderPromptAssistantSession(data); $('#prompt-assistant-messages').insertAdjacentHTML('beforeend', '<p class="hint">DSH 正在分析当前预设…</p>'); void waitForPromptAssistantReply(promptAssistantSession.id) } catch (error) { appendPromptAssistant('assistant', `DSH 请求失败：${error instanceof Error ? error.message : String(error)}`) } finally { if (input) input.disabled = false; if (send) send.disabled = false }
}
$('#prompt-assistant-session-open').onclick = () => openPromptAssistantSession()
$('#prompt-assistant-session-new').onclick = async () => { try { const session = await agentSessionRequest('/api/agent/session', { owner: promptAssistantOwner, storyId: 'eldoria' }); await renderPromptAssistantSession(session); await syncPromptAssistantContext(); $('#prompt-assistant-session-modal').close() } catch (error) { alert(error instanceof Error ? error.message : String(error)) } }
$('#prompt-assistant-session-model').onclick = async () => { if (!promptAssistantSession) return; try { const data = await agentSessionRequest('/api/agent/models', { owner: promptAssistantOwner, sessionId: promptAssistantSession.id }); const providers = Array.isArray(data.groups) ? data.groups : Array.isArray(data.providers) ? data.providers : []; const current = data.current ?? {}; $('#prompt-assistant-session-provider').innerHTML = providers.map(provider => `<option value="${escape(provider.id ?? provider.provider ?? '')}">${escape(provider.name ?? provider.id ?? provider.provider ?? '供应商')}</option>`).join(''); const updateModels = () => { const provider = providers.find(item => String(item.id ?? item.provider) === $('#prompt-assistant-session-provider').value); $('#prompt-assistant-session-model-select').innerHTML = (provider?.models ?? []).map(model => `<option value="${escape(typeof model === 'string' ? model : model.id)}">${escape(typeof model === 'string' ? model : model.name ?? model.id)}</option>`).join('') }; $('#prompt-assistant-session-provider').onchange = updateModels; updateModels(); $('#prompt-assistant-session-reasoning').value = current.reasoningEffort ?? ''; $('#prompt-assistant-session-model-modal').showModal() } catch (error) { const message = error instanceof Error ? error.message : String(error); if (/模型目录|model/i.test(message)) { $('#prompt-assistant-session-model').disabled = true; $('#prompt-assistant-session-model-label').hidden = false; $('#prompt-assistant-session-model-label').textContent = '当前 sandboxed worker 未暴露宿主模型目录，使用 DSH 默认模型。' } else alert(message) } }
$('#prompt-assistant-session-model-save').onclick = async () => { if (!promptAssistantSession) return; try { await agentSessionRequest('/api/agent/model', { owner: promptAssistantOwner, sessionId: promptAssistantSession.id, provider: $('#prompt-assistant-session-provider').value, model: $('#prompt-assistant-session-model-select').value, reasoningEffort: $('#prompt-assistant-session-reasoning').value.trim() || undefined }); $('#prompt-assistant-session-model-modal').close() } catch (error) { alert(error instanceof Error ? error.message : String(error)) } }
$('#prompt-assistant-send').onclick = async () => { const input = $('#prompt-assistant-input'); if (!input?.value.trim()) return; await requestPromptAssistant(input.value.trim()) }
document.addEventListener('dragstart', event => { const handle = event.target.closest?.('[data-prompt-drag-handle]'); if (!handle) return; const node = handle.closest('.prompt-node'); if (!node) return; draggingPromptNode = Number(node.dataset.nodeIndex); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(draggingPromptNode)); node.classList.add('prompt-node-dragging') })
document.addEventListener('dragend', event => { const node = event.target.closest?.('.prompt-node'); node?.classList.remove('prompt-node-dragging'); draggingPromptNode = null })
document.addEventListener('dragover', event => { const target = event.target.closest?.('.prompt-node, .prompt-role-divider'); if (target && draggingPromptNode !== null) { event.preventDefault(); target.classList.add('prompt-node-drag-over') } })
document.addEventListener('dragleave', event => { event.target.closest?.('.prompt-node, .prompt-role-divider')?.classList.remove('prompt-node-drag-over') })
document.addEventListener('drop', event => { const target = event.target.closest?.('.prompt-node'); const divider = event.target.closest?.('.prompt-role-divider'); if ((!target && !divider) || draggingPromptNode === null) return; event.preventDefault(); target?.classList.remove('prompt-node-drag-over'); divider?.classList.remove('prompt-node-drag-over'); collectPromptPreset(); const scenario = ensurePromptScenario(editingPromptPreset); const from = draggingPromptNode; const dragged = scenario.nodes[from]; if (!dragged) return; const targetRole = divider ? 'user' : target.dataset.nodeRole; if (dragged.removable === false && targetRole !== dragged.type) { draggingPromptNode = null; renderPromptPresetEditor(); return } if (dragged.removable !== false) dragged.type = targetRole; const orderedCards = [...document.querySelectorAll('.prompt-node')].map(card => Number(card.dataset.nodeIndex)); const systemCount = orderedCards.filter(index => scenario.nodes[index]?.type === 'system').length; const targetIndex = divider ? systemCount : orderedCards.indexOf(Number(target.dataset.nodeIndex)); scenario.nodes.splice(from, 1); const adjusted = targetIndex < 0 ? scenario.nodes.length : targetIndex - (from < targetIndex ? 1 : 0); scenario.nodes.splice(Math.max(0, adjusted), 0, dragged); editingPromptPreset.scenarios = { ...(editingPromptPreset.scenarios ?? {}), [promptPresetScope]: scenario }; draggingPromptNode = null; renderPromptPresetEditor() })
document.addEventListener('click', event => { const deleteNode = event.target.closest?.('[data-prompt-node-delete]'); if (deleteNode) { collectPromptPreset(); const scenario = ensurePromptScenario(editingPromptPreset); scenario.nodes.splice(Number(deleteNode.dataset.promptNodeDelete), 1); renderPromptPresetEditor(); return } const target = event.target.closest?.('[data-tab]'); if (target) { sidebarTab = target.dataset.tab; render(room) } if (event.target.closest?.('[data-workbench-tab]')) { workbenchTab = event.target.closest('[data-workbench-tab]').dataset.workbenchTab; if (workbenchTab === 'panels') { panelDockView = null; panelDockFetchFailed = false; void refreshPanelDockView() }; applyWorkbenchTab() } const panelAction = event.target.closest?.('[data-panel-action]'); if (panelAction) { const card = panelAction.closest('.panel-card'); const actionId = panelAction.dataset.panelAction; const owner = card?.dataset.panelOwner ?? ''; const confirmText = panelAction.dataset.panelConfirm; if (confirmText && !confirm(confirmText)) return; renderPanelDock(); fetch('/api/core/ui/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId, owner, input: {} }) }).then(response => response.json()).then(data => { if (!data.ok) alert(data.error || '面板操作失败'); refreshRoom() }).catch(error => alert(error.message)) } const preset = event.target.closest?.('[data-prompt-preset]'); if (preset) openPromptPreset(preset.dataset.promptPreset); if (event.target.closest?.('#prompt-preset-new')) openPromptPreset(sidebarPromptPresetId); const copy = event.target.closest?.('[data-prompt-copy]'); if (copy) { let source = promptPresets.find(item => item.id === copy.dataset.promptCopy); if (!source && copy.dataset.promptCopy === 'default') source = DEFAULT_PROMPT_PRESET(); if (source) { editingPromptPreset = structuredClone(source); editingPromptPreset.id = `preset-${Date.now()}`; editingPromptPreset.name = `${source.name} 副本`; editingPromptPreset.enabled = false; $('#prompt-preset-modal').showModal(); renderPromptPresetEditor() } } const remove = event.target.closest?.('[data-prompt-delete]'); if (remove && confirm('删除该提示词预设？')) fetch('/api/prompts/presets?id=' + encodeURIComponent(remove.dataset.promptDelete), { method: 'DELETE' }).then(response => response.json()).then(data => { promptPresets = data.presets ?? promptPresets; render(room) }); const del = event.target.closest?.('[data-regex-delete]'); if (del) { collectPromptPreset(); editingPromptPreset.regexRules.splice(Number(del.dataset.regexDelete), 1); renderPromptPresetEditor() } })
$('#provider-select').onchange = () => { updateModels(providers.find(item => item.id === $('#provider-select').value), '#model-select'); api('/api/providers/default-role', { id: $('#provider-select').value, model: $('#model-select').value }) }
$('#model-select').onchange = () => api('/api/providers/default-role', { id: $('#provider-select').value, model: $('#model-select').value })
$('#director-provider-select').onchange = () => { updateModels(providers.find(item => item.id === $('#director-provider-select').value), '#director-model-select'); updateThinkingOptions('#director-thinking', $('#director-model-select').value, $('#director-thinking').value); api('/api/providers/director', { id: $('#director-provider-select').value, model: $('#director-model-select').value }) }
$('#director-model-select').onchange = () => { updateThinkingOptions('#director-thinking', $('#director-model-select').value, $('#director-thinking').value); api('/api/providers/director', { id: $('#director-provider-select').value, model: $('#director-model-select').value }) }
$('#director-thinking').onchange = () => api('/api/providers/director-thinking', { thinking: $('#director-thinking').value })
$('#refresh-models').onclick = event => { event.preventDefault(); api('/api/providers/discover', { id: $('#provider-select').value }).then(loadProviders) }
$('#provider-save').onclick = event => { event.preventDefault(); const name = $('#provider-name').value.trim(); const baseUrl = $('#provider-url').value.trim(); if (!name || !baseUrl) { alert('请填写配置名称和接口地址。'); return }; api('/api/providers/save', { id: $('#provider-save').dataset.editingId || `provider-${Date.now()}`, name, baseUrl, apiKey: $('#provider-key').value, models: $('#provider-models').value.split(',').map(value => value.trim()).filter(Boolean), responseFormat: $('#provider-format').value }).then(ok => { if (ok) { $('#provider-edit-modal').close(); loadProviders(); refreshRoom() } }) }
$('#player-save').onclick = event => { event.preventDefault(); api('/api/player-character', { name: $('#player-name').value, persona: $('#player-persona').value, currentState: $('#player-state').value }).then(ok => { if (ok) $('#player-modal').close() }) }
$('#restart').onclick = event => { event.preventDefault(); if (confirm('重开将清除当前剧本的回合、草稿和已批准正文。继续吗？')) api('/api/restart', { storyId: $('#story-select').value, mode: $('#room-mode-select').value }).then(ok => { if (ok) $('#story-modal').close() }) }
$('#save-archive').onclick = event => { event.preventDefault(); api('/api/archive/save', { name: $('#archive-name').value.trim() }).then(ok => { if (ok) { $('#archive-name').value = ''; refreshArchiveList() } }) }
$('#export-archive').onclick = async event => { event.preventDefault(); try { await downloadCurrentFile('/api/archive/export', `${$('#archive-name').value.trim() || room?.storyId || 'stagecraft-save'}.json`, { kind: 'archive', payload: { archive: room } }) } catch (error) { showOperationError('导出存档', error) } }
$('#edit-story').onclick = async event => {
  event.preventDefault()
  const button = event.currentTarget
  button.disabled = true
  try {
    if (!$('#story-select').value) await loadStories()
    await openStoryEditor()
  } catch (error) {
    console.error('[StageCraft] Creator Workbench open failed', error)
    alert(`打开 Creator Workbench 失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    button.disabled = false
  }
}
$('#story-new').onclick = async event => {
  event.preventDefault()
  const title = prompt('新剧本标题（留空 = 未命名剧本）：')
  if (title === null) return
  const button = event.currentTarget
  button.disabled = true
  try {
    const response = await fetch('/api/stories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || '新建剧本失败。')
    if (!data.id) throw new Error('新建接口未返回剧本 ID。')
    await loadStories()
    if (!storyCatalog.some(item => item.id === data.id)) throw new Error('剧本已创建，但未能从本地数据目录重新读取。')
    await openStoryEditor(data.id)
  } catch (error) {
    showOperationError('新建剧本', error)
  } finally {
    button.disabled = false
  }
}

// ── 存档管理（任务 A）──
async function refreshArchiveList() {
  const listEl = $('#archive-list')
  if (!listEl) return
  try {
    const response = await fetch('/api/archive/list')
    if (!response.ok) throw new Error('读取存档列表失败')
    const data = await response.json()
    const files = data.files ?? []
    listEl.innerHTML = files.length
      ? `<ul class="archive-list">${files.map(name => `<li><span class="archive-name">${escape(name)}</span><span class="archive-actions"><button type="button" data-archive-load="${escape(name)}">读档</button><button type="button" class="danger" data-archive-delete="${escape(name)}">删除</button></span></li>`).join('')}</ul>`
      : '<p class="hint">暂无存档。</p>'
  } catch (error) {
    listEl.innerHTML = `<p class="error">${escape(error.message)}</p>`
  }
}
async function loadArchive(name) { const ok = await api('/api/archive/load', { name }); if (ok) refreshArchiveList() }
async function deleteArchive(name) { if (!confirm(`删除存档「${name}」？`)) return; const response = await fetch('/api/archive/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }); const data = await response.json().catch(() => ({})); if (!response.ok || data?.ok === false) { const error = data?.error; alert(typeof error === 'string' ? error : error?.message || '删除失败'); return } await refreshArchiveList() }

// ── 世界书条目编辑（任务 B）──
function openLoreEditor(index) {
  if (!room) return
  const entry = index >= 0 && index < room.lore.length ? room.lore[index] : null
  $('#lore-modal-title').textContent = entry ? '编辑世界书条目' : '新增世界书条目'
  $('#lore-index').value = entry ? index : -1
  $('#lore-name').value = entry?.name ?? ''
  $('#lore-content').value = entry?.content ?? ''
  $('#lore-roles').value = (entry?.roles ?? []).join(', ')
  $('#lore-modal').showModal()
}
$('#lore-save').onclick = event => {
  event.preventDefault()
  const name = $('#lore-name').value.trim()
  const content = $('#lore-content').value
  if (!name || !content.trim()) { alert('名称和内容不能为空。'); return }
  const roles = $('#lore-roles').value.split(/[,，、]/).map(value => value.trim()).filter(Boolean)
  const entry = { name, content, ...(roles.length ? { roles } : {}) }
  const index = Number($('#lore-index').value)
  const lore = (room.lore ?? []).map(item => ({ ...item }))
  if (index >= 0 && index < lore.length) lore[index] = entry
  else lore.push(entry)
  api('/api/lore', { lore }).then(ok => { if (ok) $('#lore-modal').close() })
}

// ── 原始剧本编辑（角色网格 + 世界书列表，不直接编辑 JSON）──
let storyEditRoles = []
let storyEditLore = []
let storyEditRoleIndex = null // null = live 模式（openInspector）；数字 = 正在编辑剧本中的第 N 个角色

function setCreatorStatus(text, kind = 'empty') {
  const status = $('#creator-preview-status')
  status.textContent = text
  status.className = `creator-status ${kind}`
}
function creatorErrorText(error, fallback = '操作失败。') {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/expired|过期/i.test(message)) return '预览已过期，请重新导入生成预览。'
  if (/conflict|changed since preview|冲突|发生变化/i.test(message)) return '剧本已发生变化，无法安全应用；请重新加载后生成预览。'
  return message || fallback
}
function updateStoryEditorFromPackage(story) {
  if (!story) return
  storyEditRoles = story.roles ?? []
  storyEditLore = story.lore ?? []
  $('#story-edit-title').value = story.title ?? ''
  $('#story-edit-opening').value = story.opening ?? ''
  $('#story-edit-scene-time').value = story.sceneTime ?? ''
  $('#story-edit-scene-location').value = story.sceneLocation ?? ''
  $('#story-edit-player-name').value = story.playerCharacter?.name ?? ''
  $('#story-edit-player-persona').value = story.playerCharacter?.persona ?? ''
  $('#story-edit-player-state').value = story.playerCharacter?.currentState ?? ''
  storyEditRoleIndex = null
  renderStoryRoles(); renderStoryLore()
}
function resetCreatorPreview() {
  window.creatorPreview = null
  $('#creator-apply').disabled = true
  $('#creator-revert').disabled = true
  setCreatorStatus('空', 'empty')
  $('#creator-agent-preview').innerHTML = '<strong>尚未连接 DSH 会话</strong><p>选择或新建会话后，可以直接让 DSH 协助编辑当前剧本。</p>'
  $('#creator-session-label').textContent = '尚未选择会话'
  $('#creator-session-close').disabled = true
  $('#creator-session-messages').innerHTML = ''
  $('#creator-warnings').innerHTML = '<li class="hint">暂无警告</li>'
  $('#creator-field-diffs').innerHTML = '<p class="hint">暂无字段差异。导入或提取后显示真实结果。</p>'
}
async function creatorRequest(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let data = {}
  try { data = await response.json() } catch {}
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}
async function applyCreatorPreview() {
  const preview = window.creatorPreview
  if (!preview?.id) return
  const button = $('#creator-apply'); button.disabled = true; $('#creator-revert').disabled = true
  setCreatorStatus('应用中…', 'ready')
  try {
    const accept = (preview.diffs ?? []).filter(diff => diff.decision === 'accept' || diff.decision === 'reject').map(diff => ({ path: diff.path, decision: diff.decision }))
    const result = await creatorRequest('/api/creator/apply', { previewId: preview.id, requestedAt: new Date().toISOString(), accept })
    if (result.story) updateStoryEditorFromPackage(result.story)
    window.creatorPreview = null
    setCreatorStatus(result.applied ? '已应用' : '未应用', result.applied ? 'ready' : 'empty')
    $('#creator-save-state').textContent = result.applied ? '已应用 Creator 预览' : '无接受字段'
    $('#creator-agent-preview').innerHTML = `<strong>${result.applied ? '已应用 Creator 预览' : '没有应用任何字段'}</strong><p>${escape((result.warnings ?? []).join(' ') || '可继续编辑；普通保存仍使用 /api/story/save。')}</p>`
    $('#creator-field-diffs').innerHTML = '<p class="hint">本次预览已结束。</p>'
    await loadStories()
  } catch (error) {
    setCreatorStatus(/expired|过期/i.test(String(error)) ? '已过期' : /conflict|冲突|changed since preview/i.test(String(error)) ? '冲突' : '错误', 'error')
    $('#creator-agent-preview').innerHTML = `<strong class="error">${escape(creatorErrorText(error, '应用预览失败。'))}</strong>`
    button.disabled = false
  }
}
async function revertCreatorPreview() {
  const preview = window.creatorPreview
  if (!preview?.id) return
  const button = $('#creator-revert'); button.disabled = true; $('#creator-apply').disabled = true
  setCreatorStatus('恢复中…', 'ready')
  try {
    const result = await creatorRequest('/api/creator/revert', { previewId: preview.id })
    updateStoryEditorFromPackage(result.story)
    window.creatorPreview = null
    setCreatorStatus('已恢复', 'ready')
    $('#creator-save-state').textContent = '已恢复预览基线'
    $('#creator-agent-preview').innerHTML = '<strong>已恢复预览基线</strong><p>候选内容未自动应用；普通保存仍可继续使用。</p>'
    $('#creator-field-diffs').innerHTML = '<p class="hint">本次预览已结束。</p>'
    await loadStories()
  } catch (error) {
    setCreatorStatus(/expired|过期/i.test(String(error)) ? '已过期' : /conflict|冲突|changed since preview/i.test(String(error)) ? '冲突' : '错误', 'error')
    $('#creator-agent-preview').innerHTML = `<strong class="error">${escape(creatorErrorText(error, '恢复预览失败。'))}</strong>`
    button.disabled = false
  }
}
$('#creator-apply').onclick = applyCreatorPreview
$('#creator-revert').onclick = revertCreatorPreview

async function renderCreatorSession(session) {
  creatorSession = session
  if (session) {
    try { session.messages = await creatorRequest('/api/agent/history', { owner: creatorOwner, sessionId: session.id }) } catch (error) { $('#creator-agent-preview').innerHTML = `<strong class="error">${escape(error instanceof Error ? error.message : String(error))}</strong>` }
  }
  $('#creator-session-label').textContent = session ? `${session.storyTitle} · ${String(session.id).slice(-8)}` : '尚未选择会话'
  $('#creator-session-close').disabled = !session
  $('#creator-session-model').disabled = !session
  $('#creator-preview-status').textContent = session ? '已连接' : '未连接'
  $('#creator-preview-status').className = `creator-status ${session ? 'ready' : 'empty'}`
  const modelLabel = $('#creator-session-model-label')
  if (session) {
    try {
      const data = await creatorRequest('/api/agent/models', { owner: creatorOwner, sessionId: session.id })
      const current = data.current ?? {}
      modelLabel.hidden = false
      modelLabel.textContent = `当前模型：${current.provider ?? '?'} / ${current.model ?? '?'}`
    } catch (error) {
      modelLabel.hidden = true
    }
  } else {
    modelLabel.hidden = true
  }
  renderCreatorSessionMessages(session)
}
async function loadCreatorSessions() {
  const storyId = $('#story-edit-id').textContent
  const response = await fetch(`/api/agent/session?owner=${encodeURIComponent(creatorOwner)}&storyId=${encodeURIComponent(storyId)}`)
  if (!response.ok) throw new Error('无法读取 DSH 会话。')
  const sessions = await response.json(); const list = $('#creator-session-list')
  list.innerHTML = sessions.length ? sessions.map(session => `<div class="creator-session-row"><button type="button" class="creator-session-choice" data-session-id="${escape(session.id)}">${escape(session.storyTitle)} · ${escape(String(session.id).slice(-8))}</button><button type="button" class="creator-session-archive" data-archive-id="${escape(session.id)}" title="归档此会话">归档</button></div>`).join('') : '<p class="hint">当前剧本没有已有会话。</p>'
  list.querySelectorAll('[data-session-id]').forEach(button => button.onclick = () => { const session = sessions.find(item => item.id === button.dataset.sessionId); void renderCreatorSession(session); $('#creator-session-modal').close() })
  list.querySelectorAll('[data-archive-id]').forEach(button => button.onclick = async event => { event.stopPropagation(); const id = button.dataset.archiveId; if (!confirm(`归档会话 ${String(id).slice(-8)}？归档后从列表中隐藏。`)) return; try { await creatorRequest('/api/agent/archive', { owner: creatorOwner, sessionId: id }); if (creatorSession?.id === id) renderCreatorSession(null); button.closest('.creator-session-row')?.remove(); if (!list.querySelector('.creator-session-row')) list.innerHTML = '<p class="hint">当前剧本没有已有会话。</p>' } catch (error) { alert(error instanceof Error ? error.message : String(error)) } })
}
$('#creator-session-open').onclick = async () => { try { await loadCreatorSessions(); $('#creator-session-modal').showModal() } catch (error) { alert(error instanceof Error ? error.message : String(error)) } }
$('#creator-session-model').onclick = async () => {
  if (!creatorSession) return
  try {
    const data = await creatorRequest('/api/agent/models', { owner: creatorOwner, sessionId: creatorSession.id })
    const providers = Array.isArray(data.groups) ? data.groups : Array.isArray(data.providers) ? data.providers : Array.isArray(data.items) ? data.items : []
    const current = data.current ?? {}
    const providerId = id => id ?? ''
    $('#creator-session-provider').innerHTML = providers.map(provider => `<option value="${escape(providerId(provider.id ?? provider.provider))}">${escape(provider.name ?? provider.id ?? provider.provider ?? '供应商')}</option>`).join('')
    const updateModels = () => {
      const provider = providers.find(item => providerId(item.id ?? item.provider) === $('#creator-session-provider').value)
      const models = provider?.models ?? provider?.availableModels ?? []
      $('#creator-session-model-select').innerHTML = models.map(model => `<option value="${escape(typeof model === 'string' ? model : model.id)}">${escape(typeof model === 'string' ? model : model.name ?? model.id)}</option>`).join('')
      if (current.provider && current.model && provider && providerId(provider.id ?? provider.provider) === current.provider) $('#creator-session-model-select').value = String(current.model)
    }
    if (current.provider && providers.some(item => providerId(item.id ?? item.provider) === current.provider)) $('#creator-session-provider').value = String(current.provider)
    $('#creator-session-provider').onchange = updateModels; updateModels()
    $('#creator-session-reasoning').value = current.reasoningEffort ?? ''
    if (!providers.length) { const failures = Array.isArray(data.failures) ? data.failures.map(item => `${item.name ?? item.id}: ${item.message ?? '目录读取失败'}`).join('；') : ''; throw new Error(failures || 'DSH 当前没有返回可用模型。') }
    $('#creator-session-model-modal').showModal()
  } catch (error) { alert(error instanceof Error ? error.message : String(error)) }
}
$('#creator-session-model-save').onclick = async () => {
  if (!creatorSession) return
  const provider = $('#creator-session-provider').value; const model = $('#creator-session-model-select').value
  if (!provider || !model) return
  const button = $('#creator-session-model-save'); button.disabled = true
  try {
    const result = await creatorRequest('/api/agent/model', { owner: creatorOwner, sessionId: creatorSession.id, provider, model, reasoningEffort: $('#creator-session-reasoning').value.trim() || undefined })
    $('#creator-session-model-modal').close(); $('#creator-agent-preview').innerHTML = `<strong>会话模型已更新</strong><p>${escape(result.selected?.provider ?? provider)} / ${escape(result.selected?.model ?? model)}</p>`
    const verify = await creatorRequest('/api/agent/models', { owner: creatorOwner, sessionId: creatorSession.id })
    const now = verify.current ?? {}
    $('#creator-agent-preview').innerHTML = `<strong>会话模型已保存</strong><p>${escape(now.provider ?? provider)} / ${escape(now.model ?? model)}（DSH 已确认）</p>`
    const modelLabel = $('#creator-session-model-label')
    if (now.provider || now.model) { modelLabel.hidden = false; modelLabel.textContent = `当前模型：${now.provider ?? '?'} / ${now.model ?? '?'}` }
  } catch (error) { $('#creator-agent-preview').innerHTML = `<strong class="error">模型保存失败：${escape(error instanceof Error ? error.message : String(error))}</strong>` } finally { button.disabled = false }
}
$('#creator-session-new').onclick = async () => { try { const session = await creatorRequest('/api/agent/session', { owner: creatorOwner, storyId: $('#story-edit-id').textContent }); void renderCreatorSession(session); $('#creator-session-modal').close() } catch (error) { alert(error instanceof Error ? error.message : String(error)) } }
$('#creator-session-close').onclick = async () => { if (!creatorSession) return; await fetch('/api/agent/session', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: creatorOwner, sessionId: creatorSession.id }) }).catch(() => {}); renderCreatorSession(null) }
async function waitForCreatorReply(sessionId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (!creatorSession || creatorSession.id !== sessionId) return
    try {
      const messages = await creatorRequest('/api/agent/history', { owner: creatorOwner, sessionId })
      creatorSession.messages = messages; renderCreatorSessionMessages(creatorSession)
      if (messages.some(message => message.role === 'system')) return
    } catch { return }
  }
}
function renderCreatorSessionMessages(session) {
  const messages = (session?.messages ?? [])
  $('#creator-session-messages').innerHTML = messages.length ? messages.map(message => `<div class="creator-session-message ${message.role}"><span class="creator-session-message-author">${message.role === 'user' ? '你' : 'DSH'}</span><p>${escape(message.text)}</p></div>`).join('') : '<p class="creator-session-empty">暂无消息，向 DSH 描述你想如何修改剧本。</p>'
  const el = $('#creator-session-messages'); el.scrollTop = el.scrollHeight
}
async function sendCreatorMessage(inputSelector, buttonSelector) {
  if (!creatorSession) return
  const input = $(inputSelector); const text = input.value.trim(); if (!text) return
  const button = $(buttonSelector); const before = await refreshCreatorStory(false); button.disabled = true
  try { const session = await creatorRequest('/api/agent/message', { owner: creatorOwner, sessionId: creatorSession.id, storyId: $('#story-edit-id').textContent, text }); input.value = ''; await renderCreatorSession(session); $('#creator-agent-preview').innerHTML = '已发送给 DSH：正在回复，剧本文件变化会自动同步。'; void waitForCreatorReply(creatorSession.id); void waitForCreatorAgentFileChange(before) } catch (error) { $('#creator-agent-preview').innerHTML = `<strong class="error">${escape(error instanceof Error ? error.message : String(error))}</strong>` } finally { button.disabled = false }
}
$('#creator-session-send').onclick = () => sendCreatorMessage('#creator-session-input', '#creator-session-send')
$('#creator-session-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#creator-session-send').click() } })
async function refreshCreatorStory(notify = true) {
  const storyId = $('#story-edit-id').textContent
  if (!storyId) return null
  const response = await fetch(`/api/story/get?id=${encodeURIComponent(storyId)}&refresh=${Date.now()}`, { cache: 'no-store' })
  if (!response.ok) throw new Error('刷新剧本失败。')
  const story = await response.json()
  updateStoryEditorFromPackage(story)
  $('#creator-save-state').textContent = '已从磁盘刷新'
  if (notify && creatorSession) $('#creator-agent-preview').innerHTML = '<strong>已刷新剧本</strong><p>已重新读取 DSH 可能修改的最新剧本文件。</p>'
  return story
}
async function waitForCreatorAgentFileChange(before) {
  if (!before) return
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    try {
      const current = await refreshCreatorStory(false)
      if (JSON.stringify(current) !== JSON.stringify(before)) {
        $('#creator-save-state').textContent = '已同步 DSH 修改'
        $('#creator-agent-preview').innerHTML = '已收到 DSH 修改：剧本文件已更新，工作台已自动读取。'
        return
      }
    } catch { /* DSH 回合尚未结束，继续等待 */ }
  }
  $('#creator-agent-preview').innerHTML = '等待 DSH 修改：消息已发送，暂未检测到剧本文件变化，可稍后用「刷新剧本」。'
}
$('#creator-session-refresh').onclick = async () => {
  const button = $('#creator-session-refresh'); button.disabled = true
  try { await refreshCreatorStory() } catch (error) { alert(error instanceof Error ? error.message : String(error)) } finally { button.disabled = false }
}
async function openStoryEditor(storyId) {
  storyId ??= $('#story-select').value
  if (!storyId) { alert('请先选择剧本。'); return }
  try {
    const response = await fetch(`/api/story/get?id=${encodeURIComponent(storyId)}`)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || '读取剧本失败。')
    const story = payload
  updateStoryEditorFromPackage(story)
  $('#story-edit-id').textContent = storyId
  $('#story-select').value = [...$('#story-select').options].some(option => option.value === storyId) ? storyId : ''
  $('#story-edit-select').value = [...$('#story-edit-select').options].some(option => option.value === storyId) ? storyId : ''
  const isDefault = !storyCatalog.find(item => item.id === storyId)?.custom
  $('#story-edit-save').disabled = isDefault
  $('#story-delete').disabled = isDefault
  $('#creator-save-state').textContent = isDefault ? '已加载（默认只读，可另存为）' : '已加载'
  resetCreatorPreview()
  document.querySelectorAll('#creator-story-tree .tree-item').forEach(item => item.classList.toggle('active', item.dataset.workbenchTarget === 'story-package'))
  document.querySelectorAll('.creator-section').forEach(section => { section.hidden = false })
  if (!$('#story-edit-modal').open) $('#story-edit-modal').showModal()
  } catch (error) {
    showOperationError('读取剧本', error)
    return false
  }
}
$('#story-edit-select').onchange = () => { void openStoryEditor($('#story-edit-select').value) }
function renderCreatorRoleSummary() {

}
document.addEventListener('click', event => {
  const target = event.target.closest?.('[data-workbench-target]')
  if (target) {
    document.querySelectorAll('#creator-story-tree .tree-item').forEach(item => item.classList.toggle('active', item === target))
    const section = document.querySelector(`#creator-section-${target.dataset.workbenchTarget}`)
    const editor = document.querySelector('.creator-editor')
    if (section && editor) editor.scrollTo({ top: Math.max(0, section.offsetTop - 12), behavior: 'smooth' })
  }
  if (event.target.closest?.('#creator-import-card')) { $('#st-import-open').click() }
})
function renderStoryRoles() {
  const grid = $('#story-roles-grid')
  grid.innerHTML = storyEditRoles.map((role, index) => `<div class="story-role-card" draggable="true" data-index="${index}" title="点击编辑，拖拽调整顺序"><img src="${escape(role.portraitRef ?? '/assets/default.svg')}" onerror="this.onerror=null;this.src='/assets/default.svg'"><div class="story-role-meta"><span class="story-role-name">${escape(role.name)}</span><span class="story-role-presence ${role.presence === 'present' ? 'on' : ''}">${role.presence === 'present' ? '在场' : role.presence === 'unavailable' ? '不可用' : '不在场'}</span><span class="story-role-state" title="当前状态">${escape((role.currentState ?? '').slice(0, 26))}</span></div><button type="button" class="story-role-del" title="删除角色">✕</button></div>`).join('')
  grid.querySelectorAll('.story-role-card').forEach(card => {
    const index = () => Number(card.dataset.index)
    card.querySelector('.story-role-del').addEventListener('click', event => { event.stopPropagation(); storyEditRoles.splice(index(), 1); renderStoryRoles() })
    card.addEventListener('click', event => { if (event.target.closest('.story-role-del')) return; openStoryRoleEditor(index()) })
    card.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', String(index())); card.classList.add('dragging') })
    card.addEventListener('dragend', () => card.classList.remove('dragging'))
    card.addEventListener('dragover', event => { event.preventDefault(); card.classList.add('drag-over') })
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'))
    card.addEventListener('drop', event => {
      event.preventDefault(); card.classList.remove('drag-over')
      const from = Number(event.dataTransfer.getData('text/plain'))
      const to = index()
      if (from !== to && storyEditRoles[from]) { const [moved] = storyEditRoles.splice(from, 1); storyEditRoles.splice(to, 0, moved); renderStoryRoles() }
    })
  })
}
const storyInitialMemories = role => role.memories ?? []
function syncStoryExpandedMemory(role) {
  const editor = document.querySelector('[data-story-memory-expanded]')
  if (!editor || expandedStoryMemoryIndex === null) return
  const entry = role.memories?.[expandedStoryMemoryIndex]
  if (entry) {
    entry.text = editor.querySelector('[data-story-memory-text]').value.trim()
    entry.occurredAt = editor.querySelector('[data-story-memory-time]').value.trim() || '过去'
  }
  expandedStoryMemoryIndex = null
}
function renderStoryInitialMemories(role) {
  const list = $('#inspector-memory-structured')
  if (!list || list === missingElement) return
  const memories = role.memories ?? []
  list.innerHTML = `${memories.length ? `<div class="memory-list-rows">${memories.map((memory, index) => index === expandedStoryMemoryIndex
    ? `<article class="memory-list-row memory-list-row-expanded" data-story-memory-row="${index}" data-story-memory-expanded="${index}"><button type="button" class="memory-delete memory-expanded-delete" data-story-memory-delete="${index}" title="删除记忆">×</button><div class="memory-expanded-table"><label>时间<input data-story-memory-time value="${escape(memory.occurredAt ?? '过去')}"></label><label>记忆<textarea data-story-memory-text>${escape(memory.text ?? '')}</textarea></label></div></article>`
    : `<article class="memory-list-row story-memory-record" draggable="true" data-story-memory-row="${index}"><span class="memory-drag-handle" title="拖动调整位置">⠿</span><button type="button" class="memory-summary" data-story-memory-expand="${index}"><time>${escape(memory.occurredAt ?? '过去')}</time><span title="${escape(memory.text ?? '')}">${escape(memory.text ?? '')}</span></button><button type="button" class="memory-delete" data-story-memory-delete="${index}" title="删除记忆">×</button></article>`
  ).join('')}</div>` : '<p class="hint">暂无记忆</p>'}<button type="button" class="small-btn" id="story-memory-add">＋ 添加记忆</button>`
  list.querySelectorAll('[data-story-memory-row]').forEach(row => {
    row.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', row.dataset.storyMemoryRow); row.classList.add('dragging') })
    row.addEventListener('dragend', () => row.classList.remove('dragging'))
    row.addEventListener('dragover', event => { event.preventDefault(); row.classList.add('drag-over') })
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'))
    row.addEventListener('drop', event => { event.preventDefault(); row.classList.remove('drag-over'); const from = Number(event.dataTransfer.getData('text/plain')); const to = Number(row.dataset.storyMemoryRow); syncStoryExpandedMemory(role); if (from !== to && role.memories?.[from]) { const [moved] = role.memories.splice(from, 1); role.memories.splice(to, 0, moved); renderStoryInitialMemories(role) } })
  })
}
function collectStoryInitialMemories() { const role = storyEditRoles[storyEditRoleIndex]; if (role) syncStoryExpandedMemory(role); return (role?.memories ?? []).filter(memory => memory.text?.trim()).map(memory => ({ text: memory.text.trim(), occurredAt: memory.occurredAt?.trim() || '过去' })) }
document.addEventListener('click', event => { const target = event.target.closest?.('#story-memory-add,[data-story-memory-delete],[data-story-memory-expand]'); if (!target) return; const role = storyEditRoles[storyEditRoleIndex]; if (!role) return; syncStoryExpandedMemory(role); if (target.id === 'story-memory-add') { role.memories.push({ text: '', occurredAt: '过去' }); expandedStoryMemoryIndex = role.memories.length - 1 } else if (target.dataset.storyMemoryExpand !== undefined) expandedStoryMemoryIndex = Number(target.dataset.storyMemoryExpand); else role.memories.splice(Number(target.dataset.storyMemoryDelete), 1); renderStoryInitialMemories(role); document.querySelector('[data-story-memory-text]')?.focus() })
document.addEventListener('focusout', event => { const editor = event.target.closest?.('[data-story-memory-expanded]'); if (editor) setTimeout(() => { if (!editor.contains(document.activeElement)) { const role = storyEditRoles[storyEditRoleIndex]; if (role) { syncStoryExpandedMemory(role); renderStoryInitialMemories(role) } } }) })
$('#story-role-add').onclick = () => { storyEditRoles.push({ id: `new-role-${Date.now()}`, name: '新角色', portraitRef: '/assets/default.svg', currentState: '尚未进入具体场景，等待剧情展开。', presence: 'absent', memories: [], impressions: {}, selfModel: '待补充的角色设定。' }); renderStoryRoles() }
function openStoryRoleEditor(index) {
  const role = storyEditRoles[index]
  if (!role) return
  storyEditRoleIndex = index
  expandedStoryMemoryIndex = null
  role.memories = storyInitialMemories(role).slice().sort((left, right) => Number((left.occurredAt ?? '过去') !== '过去') - Number((right.occurredAt ?? '过去') !== '过去'))
  // 剧本编辑模式只显示初始记忆：清空 live 模式（openInspector）残留的当前记忆渲染，
  // 避免「当前记忆 + 初始记忆」叠加显示在同一容器里。
  const structured = $('#inspector-memory-structured')
  if (structured && structured !== missingElement) structured.innerHTML = ''
  $('#story-initial-memories')?.remove()
  $('#role-modal-title').textContent = `${role.name} 角色设置（剧本）`
  $('#inspector-role-id').value = role.id
  $('#inspector-provider').innerHTML = '<option value="">使用默认</option>'
  $('#inspector-model').innerHTML = '<option value="">使用默认</option>'
  $('#inspector-self-model').value = role.selfModel ?? ''
  $('#inspector-goals').value = (role.goals ?? []).join('\n')
  renderStoryInitialMemories(role)
  renderImpressionsFrom(role.impressions ?? {})
  $('#inspector-story-fields').hidden = false
  $('#inspector-story-name').value = role.name ?? ''
  $('#inspector-story-presence').value = role.presence ?? 'absent'
  $('#inspector-story-state').value = role.currentState ?? ''
  $('#inspector-avatar-preview').src = role.portraitRef ?? '/assets/default.svg'
  $('#inspector-avatar-preview').onerror = function () { this.onerror = null; this.src = '/assets/default.svg' }
  setInspectorTab('basic')
  positionInspectorModals()
}
function renderStoryLore() {
  const list = $('#story-lore-list')
  list.innerHTML = storyEditLore.map((entry, index) => {
    const roleChecks = storyEditRoles.map(role => `<label class="lore-role-check"><input type="checkbox" data-role="${role.id}" ${(entry.roles ?? []).includes(role.id) ? 'checked' : ''}>${escape(role.name)}</label>`).join('')
    const visible = (entry.roles ?? []).length ? storyEditRoles.filter(r => entry.roles.includes(r.id)).map(r => r.name).join('、') : '常开'
    return `<div class="story-lore-item" draggable="true" data-index="${index}"><details><summary><span class="lore-handle">≡</span><b>${escape(entry.name)}</b><small class="lore-visible">${escape(visible)}</small><button type="button" class="story-lore-del" title="删除条目">✕</button></summary><div class="lore-edit"><label>条目名<input class="lore-name" value="${escape(entry.name)}"></label><label>内容<textarea class="lore-content" spellcheck="false">${escape(entry.content)}</textarea></label><div class="lore-roles"><span class="lore-roles-label">对谁可见（不勾选 = 常开）</span><div class="lore-roles-grid">${roleChecks}</div></div></div></details></div>`
  }).join('')
  list.querySelectorAll('.story-lore-item').forEach(item => {
    const index = () => Number(item.dataset.index)
    item.querySelector('.story-lore-del').addEventListener('click', event => { event.stopPropagation(); storyEditLore.splice(index(), 1); renderStoryLore() })
    item.querySelector('summary').addEventListener('click', event => { if (event.target.closest('.story-lore-del')) event.stopPropagation() })
    item.querySelector('.lore-name').addEventListener('change', event => { storyEditLore[index()].name = event.target.value.trim() })
    item.querySelector('.lore-content').addEventListener('change', event => { storyEditLore[index()].content = event.target.value })
    item.querySelectorAll('.lore-role-check input').forEach(checkbox => checkbox.addEventListener('change', () => {
      const roles = [...item.querySelectorAll('.lore-role-check input:checked')].map(cb => cb.dataset.role)
      const entry = storyEditLore[index()]
      if (roles.length) entry.roles = roles; else delete entry.roles
      item.querySelector('.lore-visible').textContent = roles.length ? storyEditRoles.filter(r => roles.includes(r.id)).map(r => r.name).join('、') : '常开'
    }))
    item.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', String(index())); item.classList.add('dragging') })
    item.addEventListener('dragend', () => item.classList.remove('dragging'))
    item.addEventListener('dragover', event => { event.preventDefault(); item.classList.add('drag-over') })
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'))
    item.addEventListener('drop', event => {
      event.preventDefault(); item.classList.remove('drag-over')
      const from = Number(event.dataTransfer.getData('text/plain'))
      const to = index()
      if (from !== to && storyEditLore[from]) { const [moved] = storyEditLore.splice(from, 1); storyEditLore.splice(to, 0, moved); renderStoryLore() }
    })
  })
}
$('#story-lore-add').onclick = () => { storyEditLore.push({ name: '新条目', content: '内容。' }); renderStoryLore() }
$('#story-edit-save').onclick = async event => {
  event.preventDefault()
  const storyId = $('#story-edit-id').textContent
  if (!storyCatalog.find(item => item.id === storyId)?.custom) { alert('默认剧本只读：修改请用「另存为」保存为新剧本。'); return }
  const button = event.currentTarget
  button.disabled = true
  try {
    const story = collectStoryEditorPackage(storyId)
    const response = await fetch('/api/story/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ story }) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data?.ok === false) { const error = data?.error; throw new Error(typeof error === 'string' ? error : error?.message || '保存失败。') }
    const selected = $('#story-select').value
    await loadStories()
    $('#story-select').value = selected
    $('#creator-save-state').textContent = '已保存'
  } catch (error) {
    showOperationError('保存剧本', error)
  } finally {
    button.disabled = false
  }
}
function collectStoryEditorPackage(storyId) {
  storyEditLore = [...document.querySelectorAll('#story-lore-list .story-lore-item')].map(item => {
    const name = item.querySelector('.lore-name').value.trim() || '未命名条目'
    const content = item.querySelector('.lore-content').value
    const roles = [...item.querySelectorAll('.lore-role-check input:checked')].map(cb => cb.dataset.role)
    return roles.length ? { name, content, roles } : { name, content }
  })
  const sceneTime = $('#story-edit-scene-time').value.trim()
  const sceneLocation = $('#story-edit-scene-location').value.trim()
  return {
    id: storyId,
    title: $('#story-edit-title').value.trim(),
    opening: $('#story-edit-opening').value,
    ...(sceneTime ? { sceneTime } : {}),
    ...(sceneLocation ? { sceneLocation } : {}),
    playerCharacter: {
      name: $('#story-edit-player-name').value.trim(),
      persona: $('#story-edit-player-persona').value,
      currentState: $('#story-edit-player-state').value,
    },
    roles: storyEditRoles,
    lore: storyEditLore,
  }
}
$('#story-save-as').onclick = async event => {
  event.preventDefault()
  const title = $('#story-edit-title').value.trim() || '未命名剧本'
  const newTitle = prompt(`另存为新剧本（输入新标题，默认「${title}」）：`, title)
  if (newTitle === null) return
  const button = event.currentTarget
  button.disabled = true
  try {
    const story = collectStoryEditorPackage($('#story-edit-id').textContent)
    const response = await fetch('/api/story/save-as', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ story, title: newTitle }) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || '另存为失败。')
    await loadStories()
    await openStoryEditor(data.id)
  } catch (error) { showOperationError('另存为剧本', error) } finally { button.disabled = false }
}
$('#story-delete').onclick = async event => {
  event.preventDefault()
  const storyId = $('#story-edit-id').textContent
  const meta = storyCatalog.find(item => item.id === storyId)
  if (!meta?.custom) { alert('默认剧本只读，不可删除；只能删除玩家自建剧本。'); return }
  if (!confirm(`确定删除剧本「${meta.title}」？\n删除后将连同其立绘资产一起移除，不可恢复。`)) return
  const button = event.currentTarget
  button.disabled = true
  try {
    const response = await fetch(`/api/stories?id=${encodeURIComponent(storyId)}`, { method: 'DELETE' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || '删除失败。')
    await loadStories()
    $('#story-edit-modal').close()
    alert(`剧本「${meta.title}」已删除。`)
  } catch (error) { alert(`删除失败：${error instanceof Error ? error.message : String(error)}`) } finally { button.disabled = false }
}
// 对话框关闭键统一委托（type=button + data-dialog-close，不依赖 form 提交）
document.addEventListener('click', event => { const closer = event.target.closest('[data-dialog-close]'); if (closer) { const dialog = closer.closest('dialog'); if (dialog?.open) dialog.close() } })
$('#submit').onclick = async () => {
  if (activeAction) { await api('/api/cancel-turn', {}); activeAction = null; skipArmed = false; clearThinkingStreams(); await refreshRoom(); return }
  // 群聊回复中（未收到首字/正在回复）：主输入框按钮即「取消回复」
  if (room.mode === 'chat' && ['role-speaking', 'director-selecting-roles'].includes(room.phase)) { clearThinkingStreams(); api('/api/cancel-turn', {}); return }
  const text = $('#contribution').value
  if (!text.trim()) {
    if (!skipArmed) { skipArmed = true; render(room); return }
    skipArmed = false
  }
  clearThinkingStreams()
  activeAction = 'turn'; render(room); $('#contribution').value = ''; try { await api('/api/turn', { text, requiredRoleIds: [...focalRoleIds] }) } finally { activeAction = null; skipArmed = false; await refreshRoom() }
}
function directorContext() { return `当前玩家编辑草稿：\n${currentDraftText()}\n\n本回合 NPC 临时反应：\n${(room.reactions ?? []).map(item => `${item.roleId}: ${item.text}`).join('\n')}\n\n导演对话记录：\n${(room.consultations ?? []).map(item => `${item.role}: ${item.text}`).join('\n')}` }
async function directorReconsider() { if (!room.draft || activeAction) return; activeAction = 'director'; render(room); try { await api('/api/consult', { draftId: room.draft.id, text: '请根据本回合信息重新审视并重写草稿。', context: directorContext() }); await api('/api/redraft', { draftId: room.draft.id }) } finally { activeAction = null; await refreshRoom() } }
$('#consult-send').onclick = async () => { if (activeAction) { await api('/api/cancel-turn', {}); activeAction = null; clearThinkingStreams(); await refreshRoom(); return }; const text = $('#consult-text').value.trim(); if (!text) return; if (room.mode === 'chat') { activeAction = 'director'; render(room); try { await api('/api/chat/director-chat', { text }); $('#consult-text').value = '' } finally { activeAction = null; await refreshRoom() } return }; if (!room.draft) { const ok = await api('/api/director/setting', { text }); if (ok) $('#consult-text').value = ''; return }; activeAction = 'director'; render(room); try { await api('/api/consult', { draftId: room.draft.id, text }); $('#consult-text').value = ''; await api('/api/redraft', { draftId: room.draft.id }) } finally { activeAction = null; await refreshRoom() } }
$('#retry-director').onclick = async () => { if (activeAction) return; thinkingStreams.delete('director'); renderThinkingPanel(); activeAction = 'director'; render(room); try { await api('/api/director/retry', {}) } finally { activeAction = null; await refreshRoom() } }
$('#retry-speak').onclick = async () => { if (activeAction) return; for (const key of [...thinkingStreams.keys()]) if (key.startsWith('role:')) thinkingStreams.delete(key); renderThinkingPanel(); activeAction = 'speak'; render(room); try { await api('/api/chat/retry', {}) } finally { activeAction = null; await refreshRoom() } }
$('#cancel-turn').onclick = () => { clearThinkingStreams(); api('/api/cancel-turn', {}) }
document.addEventListener('click', event => { const target = event.target instanceof Element ? event.target : null; const speakId = target?.dataset.speak; if (speakId) { if (activeAction) return; activeAction = 'speak'; render(room); const interaction = coreClient.view?.interactions?.find(item => item.kind === 'role-select'); const command = interaction ? coreClient.dispatch({ id: `role-select-${Date.now()}`, actor: 'player', interactionId: interaction.id, type: 'select-role', payload: { roleId: speakId } }) : Promise.reject(new Error('Core role-select interaction unavailable')); command.catch(() => api('/api/chat/speak', { roleId: speakId })).finally(() => { activeAction = null; refreshRoom() }) }; if (event.target.id === 'speech-approve' && room.speech) { const text = $('#speech-text').value; const wcTime = $('#wc-time')?.value; const wcLocation = $('#wc-location')?.value; const worldChange = room.pendingWorldChange ? { ...room.pendingWorldChange, ...(wcTime !== undefined ? { sceneTime: wcTime.trim() } : {}), ...(wcLocation !== undefined ? { sceneLocation: wcLocation.trim() } : {}) } : null; activeAction = 'speech-approve'; render(room); api('/api/chat/approve-speech', { text, ...(worldChange ? { worldChange } : {}) }).then(ok => { if (ok) $('#contribution').value = '' }).finally(() => { activeAction = null; refreshRoom() }) }; if (event.target.id === 'speech-reconsider' && room.speech) { const roleId = room.speech.roleId; const feedback = $('#speech-reconsider-feedback').value.trim(); activeAction = 'speech-reconsider'; render(room); api('/api/chat/reject-speech', {}).then(ok => ok && api('/api/chat/speak', { roleId, feedback })).finally(() => { activeAction = null; refreshRoom() }) }; if (event.target.id === 'speech-cancel' && room.speech) { activeAction = 'speech-cancel'; api('/api/chat/reject-speech', {}).finally(() => { activeAction = null; refreshRoom() }) }; if (event.target.id === 'world-change-approve' && room.pendingWorldChange) { const wcTime = $('#wc-time')?.value; const wcLocation = $('#wc-location')?.value; const override = { ...room.pendingWorldChange, ...(wcTime !== undefined ? { sceneTime: wcTime.trim() } : {}), ...(wcLocation !== undefined ? { sceneLocation: wcLocation.trim() } : {}) }; activeAction = 'world-change-approve'; render(room); api('/api/world-change/approve', { worldChange: override }).finally(() => { activeAction = null; refreshRoom() }) }; if (event.target.id === 'world-change-reject') { activeAction = 'world-change-reject'; api('/api/world-change/reject').finally(() => { activeAction = null; refreshRoom() }) }; const roleId = event.target.dataset.inspect; if (roleId) { try { openInspector(roleId) } catch (error) { console.error('打开角色面板失败：', error) } } const focusId = event.target.dataset.focus; if (focusId) { focalRoleIds.has(focusId) ? focalRoleIds.delete(focusId) : focalRoleIds.add(focusId); render(room) }; const presenceId = event.target.dataset.presence; if (presenceId) { const presenceRole = room.roles.find(item => item.id === presenceId); if (presenceRole) api('/api/roles/presence', { roleId: presenceId, presence: presenceRole.presence === 'present' ? 'absent' : 'present' }) }; if (event.target.id === 'role-add') openCreateRoleModal(); const reactionId = event.target.dataset.reaction; if (reactionId) { const panel = $(`#feedback-${reactionId}`); panel.hidden = !panel.hidden; panel.querySelector('textarea').focus() }; const reconsiderId = event.target.dataset.reconsider; if (reconsiderId) { const panel = $(`#feedback-${reconsiderId}`); const feedback = panel.querySelector('textarea').value.trim(); if (feedback) { panel.hidden = true; reconsideringRoleIds.add(reconsiderId); render(room); api('/api/reactions/reconsider', { roleId: reconsiderId, feedback }).finally(() => { reconsideringRoleIds.delete(reconsiderId); refreshRoom() }) } }; if (event.target.id === 'center-proceed-draft') { if (activeAction) return; activeAction = 'director'; render(room); api('/api/director/proceed', {}).finally(() => { activeAction = null; refreshRoom() }) }; if (event.target.id === 'center-reconsider' && room.draft) directorReconsider(); if (event.target.id === 'center-approve' && room.draft) { const updates = {}; document.querySelectorAll('[data-state-update]').forEach(input => { const id = input.dataset.stateUpdate; const current = id === 'player' ? room.playerCharacter.currentState : room.roles.find(role => role.id === id)?.currentState; if (input.value !== current) updates[id] = input.value }); const sceneUpdates = {}; const timeInput = $('#scene-time-input'); const locationInput = $('#scene-location-input'); if (timeInput && timeInput.value.trim() !== (room.sceneTime ?? '')) sceneUpdates.time = timeInput.value.trim(); if (locationInput && locationInput.value.trim() !== (room.sceneLocation ?? '')) sceneUpdates.location = locationInput.value.trim(); api('/api/approve', { draftId: room.draft.id, text: currentDraftText(), stateUpdates: updates, sceneUpdates: Object.keys(sceneUpdates).length ? sceneUpdates : undefined }).then(ok => { if (ok) $('#contribution').value = '' }) }; const tabId = event.target.closest('[data-tab]')?.dataset.tab; if (tabId) { sidebarTab = tabId; render(room) }; const loreEntry = event.target.closest('.lore-entry'); if (loreEntry) openLoreEditor(Number(loreEntry.dataset.lore)); if (event.target.id === 'lore-add') openLoreEditor(-1); const archiveLoad = event.target.closest('[data-archive-load]')?.dataset.archiveLoad; if (archiveLoad) loadArchive(archiveLoad); const archiveDelete = event.target.closest('[data-archive-delete]')?.dataset.archiveDelete; if (archiveDelete) deleteArchive(archiveDelete) })
document.addEventListener('click', event => { const target = event.target.closest?.('.scene-rollback, .scene-branch'); if (!target || !room) return; const sceneId = target.dataset.sceneId; if (!sceneId) return; const isRollback = target.classList.contains('scene-rollback'); const action = isRollback ? '回滚到此处' : '分支（先存档当前，再回滚到此处）'; const endpoint = isRollback ? '/api/state/rollback' : '/api/state/branch'; if (!confirm(`${action}？${isRollback ? '将删除此记录之后的所有正文、回合与记忆。' : '当前状态会先存为分支存档，可随时读档恢复。'}`)) return; api(endpoint, { sceneId }).then(ok => { if (ok) refreshRoom() }) })
document.addEventListener('click', event => { const stateEditId = event.target.dataset?.stateEdit; if (!stateEditId) return; const role = room.roles.find(item => item.id === stateEditId); const textarea = document.createElement('textarea'); textarea.className = 'role-state-edit'; textarea.value = role?.currentState ?? ''; textarea.dataset.stateSave = stateEditId; textarea.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textarea.blur() } }); event.target.replaceWith(textarea); textarea.focus() })
document.addEventListener('focusout', event => { const el = event.target; if (!el || !el.dataset) return; const sceneField = el.dataset.sceneSave; if (sceneField) { const value = el.value.trim(); api('/api/scene', sceneField === 'time' ? { time: value } : { location: value }); return } const stateRoleId = el.dataset.stateSave; if (stateRoleId) { const value = el.value.trim(); const current = room.roles.find(role => role.id === stateRoleId)?.currentState; if (value !== current) api('/api/roles/state', { roleId: stateRoleId, currentState: value }) } })
// 单次绑定：Enter 提交，Shift+Enter 换行。重复绑定会导致一次回车先提交、再误触发“停止”。
$('#contribution').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#submit').click() } })
// 人物拖拽排序：拖到另一张卡上/下方即交换并保存顺序
let draggingRoleId = null
document.addEventListener('dragstart', event => { const id = event.target.closest('[data-role-drag]')?.dataset.roleDrag; if (id) { draggingRoleId = id; event.dataTransfer.effectAllowed = 'move' } })
document.addEventListener('dragover', event => { const card = event.target.closest('[data-role-drag]'); if (card && draggingRoleId) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } })
document.addEventListener('drop', event => { const target = event.target.closest('[data-role-drag]'); if (!target || !draggingRoleId) return; event.preventDefault(); const targetId = target.dataset.roleDrag; if (targetId === draggingRoleId) return; const ids = room.roles.map(role => role.id); const from = ids.indexOf(draggingRoleId); const to = ids.indexOf(targetId); if (from < 0 || to < 0) return; ids.splice(from, 1); ids.splice(to, 0, draggingRoleId); draggingRoleId = null; render({ ...room, roles: ids.map(id => room.roles.find(role => role.id === id)).filter(Boolean) }); api('/api/roles/reorder', { roleIds: ids }) })
$('#contribution').addEventListener('input', () => { if (skipArmed && $('#contribution').value.trim()) { skipArmed = false; render(room) } })
let inspectedRole
function setInspectorTab(tab) { if (tab !== 'memory' && expandedMemoryId) collapseExpandedMemory(); document.querySelectorAll('[data-inspector-tab]').forEach(button => button.classList.toggle('active', button.dataset.inspectorTab === tab)); document.querySelectorAll('[data-inspector-panel]').forEach(panel => { panel.hidden = panel.dataset.inspectorPanel !== tab }) }
document.addEventListener('click', event => { const button = event.target.closest('[data-inspector-tab]'); if (button) setInspectorTab(button.dataset.inspectorTab) })
function updateInspectorModels() { const provider = providers.find(item => item.id === $('#inspector-provider').value); $('#inspector-model').innerHTML = `<option value="">使用默认模型</option>${(provider?.models ?? []).map(model => `<option value="${escape(model)}">${escape(model)}</option>`).join('')}` }
function inspectorEffectiveModel() { const provider = providers.find(item => item.id === $('#inspector-provider').value); return $('#inspector-model').value || provider?.selectedModel || provider?.models?.[0] || providers[0]?.selectedModel || providers[0]?.models?.[0] || '' }
function updateInspectorThinkingOptions(selected) { updateThinkingOptions('#inspector-thinking', inspectorEffectiveModel(), selected) }
$('#inspector-provider').onchange = () => { updateInspectorModels(); updateInspectorThinkingOptions($('#inspector-thinking').value) }
$('#inspector-model').onchange = () => updateInspectorThinkingOptions($('#inspector-thinking').value)
/** 从 textarea 按行收集长期目标（去空行）；允许留空 */
function collectGoalsInput(selector) {
  return String($(selector)?.value ?? '').split('\n').map(line => line.trim()).filter(Boolean)
}
function collectGoalsFromEdit() { return collectGoalsInput('#inspector-goals') }
function parseTimelineFromEdit(text) {
  const timeline = {}
  const ensure = label => { if (!timeline[label]) timeline[label] = []; return timeline[label] }
  let current = null
  for (const line of String(text).split('\n')) {
    const match = line.match(/^【(.+?)】$/)
    if (match) { current = match[1].trim(); ensure(current); continue }
    const trimmed = line.trim()
    if (!trimmed) continue
    // 不符合「【时间标签】」格式的行（如没有分桶头就直接写记忆）一律归入「过去」桶，避免被静默丢弃
    ensure(current ?? '过去').push(trimmed.replace(/^-\s*/, ''))
  }
  return timeline
}
function closeInspectorModals() { const info = $('#role-modal'); if (info?.open) info.close() }
function positionInspectorModals() {
  const info = $('#role-modal')
  // 重复打开（点击第二个角色等）时先关闭再打开，避免对已打开的 dialog 调用 showModal 抛 InvalidStateError
  if (info.open) info.close()
  info.showModal()
}
function renderImpressionsFrom(impressions) {
  const list = $('#inspector-impressions-list')
  const entries = Object.entries(impressions ?? {})
  if (!entries.length) { list.innerHTML = '<p class="hint">暂无印象</p>'; return }
  list.innerHTML = entries.map(([name, text]) => `<div class="impression-row"><input class="impression-name" value="${escape(name)}" placeholder="姓名"><input class="impression-text" value="${escape(text)}" placeholder="对该角色的印象"><button type="button" class="impression-del" title="删除">✕</button></div>`).join('')
}
function renderImpressionsList() { renderImpressionsFrom(inspectedRole?.impressions ?? {}) }
function collectImpressions() {
  const result = {}
  document.querySelectorAll('#inspector-impressions-list .impression-row').forEach(row => {
    const name = row.querySelector('.impression-name').value.trim()
    const text = row.querySelector('.impression-text').value.trim()
    if (name && text) result[name] = text
  })
  return result
}
$('#inspector-impression-add').onclick = () => { const list = $('#inspector-impressions-list'); const hint = list.querySelector('.hint'); if (hint) hint.remove(); const row = document.createElement('div'); row.className = 'impression-row'; row.innerHTML = '<input class="impression-name" placeholder="姓名"><input class="impression-text" placeholder="对该角色的印象"><button type="button" class="impression-del" title="删除">✕</button>'; list.appendChild(row); row.querySelector('.impression-name').focus() }
document.addEventListener('click', event => { if (event.target.classList.contains('impression-del')) event.target.closest('.impression-row')?.remove() })
function setInspectorReadOnly(on) {
  // 沉浸模式只读：除上述运行/剧情字段外，供应商与模型（#inspector-provider / #inspector-model）属运行配置，
  // 允许在沉浸模式下调整；保存按钮（#inspector-save）保留可用以提交这些改动。其余人设/记忆/头像等保持只读。
  ['#inspector-self-model', '#inspector-goals', '#inspector-memory', '#inspector-delete', '#inspector-impression-add', '#inspector-avatar-upload', '#inspector-avatar-url'].forEach(selector => { const el = $(selector); if (el) el.disabled = on })
  document.querySelectorAll('#role-modal .impression-row input').forEach(input => { input.disabled = on })
  document.querySelectorAll('#role-modal .impression-row .impression-del').forEach(button => { button.disabled = on })
}
function renderStructuredMemories(role) {
  const list = $('#inspector-memory-structured')
  if (!list || !role) return
  const memories = role.memories ?? []
  const isNew = expandedMemoryId === '__new__'
  const visible = isNew ? [...memories, { id: '__new__', text: '', occurredAt: room?.sceneTime ?? '过去' }] : memories
  const rows = visible.map(memory => {
    const expanded = memory.id === expandedMemoryId
    if (expanded) return `<article class="memory-list-row memory-list-row-expanded" data-memory-row="${escape(memory.id)}" data-memory-expanded="${escape(memory.id)}">${isNew ? '' : `<button type="button" class="memory-delete memory-expanded-delete" data-memory-retract="${escape(memory.id)}" title="删除记忆">×</button>`}<div class="memory-expanded-table"><label>时间<input data-memory-expanded-time value="${escape(memory.occurredAt ?? '过去')}"></label><label>记忆<textarea data-memory-expanded-text>${escape(memory.text)}</textarea></label></div></article>`
    return `<article class="memory-list-row" data-memory-row="${escape(memory.id)}"><button type="button" class="memory-drag-handle" draggable="true" data-memory-drag="${escape(memory.id)}" title="拖动调整位置">⠿</button><button type="button" class="memory-summary" data-memory-expand="${escape(memory.id)}"><time>${escape(memory.occurredAt ?? '过去')}</time><span title="${escape(memory.text)}">${escape(memory.text)}</span></button><button type="button" class="memory-delete" data-memory-retract="${escape(memory.id)}" title="删除记忆">×</button></article>`
  }).join('')
  list.innerHTML = `${visible.length ? `<div class="memory-list-rows">${rows}</div>` : '<p class="hint">暂无记忆</p>'}<button type="button" class="small-btn" data-memory-add="${escape(role.id)}">＋ 新增记忆</button>`
}
function collapseExpandedMemory(save = true) {
  const editor = document.querySelector('[data-memory-expanded]')
  if (!editor) return
  const memoryId = editor.dataset.memoryExpanded
  const text = editor.querySelector('[data-memory-expanded-text]').value.trim()
  const occurredAt = editor.querySelector('[data-memory-expanded-time]').value.trim() || '过去'
  const isNew = memoryId === '__new__'
  expandedMemoryId = null
  if (!save || !text) { renderStructuredMemories(inspectedRole); return }
  const endpoint = isNew ? '/api/roles/memories' : '/api/roles/memories/update'
  const payload = isNew ? { roleId: inspectedRole.id, entries: [{ text, occurredAt }] } : { memoryId, entry: { text, occurredAt } }
  api(endpoint, payload).then(refreshInspectedMemories)
}
function refreshInspectedMemories(ok) { if (!ok || !inspectedRole) return; inspectedRole = room?.roles.find(role => role.id === inspectedRole.id); renderStructuredMemories(inspectedRole) }
document.addEventListener('click', event => {
  const target = event.target.closest('[data-memory-retract],[data-memory-add],[data-memory-expand],[data-memory-collapse]')
  if (!target) return
  const memoryId = target.dataset.memoryRetract
  const role = room?.roles.find(item => item.id === (target.dataset.memoryAdd || inspectedRole?.id))
  if (target.dataset.memoryExpand) { expandedMemoryId = target.dataset.memoryExpand; renderStructuredMemories(role); document.querySelector('[data-memory-expanded-text]')?.focus(); return }
  if (!role) return
  if (target.dataset.memoryAdd) { expandedMemoryId = '__new__'; renderStructuredMemories(role); document.querySelector('[data-memory-expanded-text]')?.focus(); return }
  if (memoryId) { expandedMemoryId = null; return api('/api/roles/memories/retract', { memoryId }).then(refreshInspectedMemories) }
})
document.addEventListener('focusout', event => { const editor = event.target.closest?.('[data-memory-expanded]'); if (editor) setTimeout(() => { if (!editor.contains(document.activeElement)) collapseExpandedMemory() }) })
document.addEventListener('dragstart', event => { const handle = event.target.closest?.('[data-memory-drag]'); if (!handle || handle.dataset.memoryDrag === '__new__') return; draggingMemoryId = handle.dataset.memoryDrag; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', draggingMemoryId) })
document.addEventListener('dragover', event => { const row = event.target.closest?.('[data-memory-row]'); if (row && draggingMemoryId && row.dataset.memoryRow !== '__new__') { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over') } })
document.addEventListener('dragleave', event => event.target.closest?.('[data-memory-row]')?.classList.remove('drag-over'))
document.addEventListener('drop', event => { const target = event.target.closest?.('[data-memory-row]'); if (!target || !draggingMemoryId || target.dataset.memoryRow === '__new__') return; event.preventDefault(); target.classList.remove('drag-over'); const movedId = draggingMemoryId; const ids = [...document.querySelectorAll('[data-memory-row]')].map(row => row.dataset.memoryRow).filter(id => id !== '__new__'); const from = ids.indexOf(movedId); const to = ids.indexOf(target.dataset.memoryRow); draggingMemoryId = null; if (from < 0 || to < 0 || from === to) return; ids.splice(from, 1); ids.splice(to, 0, movedId); api('/api/roles/memories/reorder', { roleId: inspectedRole.id, memoryIds: ids }).then(refreshInspectedMemories) })
function openInspector(roleId) { inspectedRole = room.roles.find(role => role.id === roleId); if (!inspectedRole) return; expandedMemoryId = null; storyEditRoleIndex = null; $('#inspector-story-fields').hidden = true; $('#story-initial-memories')?.remove(); $('#role-modal-title').textContent = `${inspectedRole.name} 角色设置`; $('#inspector-role-id').value = roleId; $('#inspector-provider').innerHTML = `<option value="">使用默认</option>${providers.map(provider => `<option value="${escape(provider.id)}">${escape(provider.name)}</option>`).join('')}`; $('#inspector-provider').value = inspectedRole.providerId ?? ''; updateInspectorModels(); $('#inspector-model').value = inspectedRole.modelOverride ?? ''; updateInspectorThinkingOptions(inspectedRole.thinkingStrength ?? 'standard'); $('#inspector-self-model').value = inspectedRole.selfModel; $('#inspector-goals').value = (inspectedRole.goals ?? []).join('\n'); renderStructuredMemories(inspectedRole); renderImpressionsList(); $('#inspector-avatar-preview').src = inspectedRole.portraitRef; $('#inspector-avatar-preview').onerror = function () { this.onerror = null; this.src = '/assets/default.svg' }; // 沉浸模式：角色面板只读
  setInspectorReadOnly(!!room?.autoPublish && storyEditRoleIndex === null);
  setInspectorTab('basic')
  positionInspectorModals() }
$('#inspector-save').onclick = event => {
  event.preventDefault()
  const impressions = collectImpressions()
  if (storyEditRoleIndex !== null) {
    // 剧本模式：写回 storyEditRoles[index]
    const role = storyEditRoles[storyEditRoleIndex]
    if (role) {
      role.name = $('#inspector-story-name').value.trim() || role.name
      role.presence = $('#inspector-story-presence').value
      role.portraitRef = role.portraitRef || '/assets/default.svg'
      role.currentState = $('#inspector-story-state').value
      role.selfModel = $('#inspector-self-model').value
      role.goals = collectGoalsFromEdit()
      role.memories = collectStoryInitialMemories()
      role.impressions = impressions
    }
    storyEditRoleIndex = null
    closeInspectorModals()
    renderStoryRoles()
    return
  }
  api('/api/roles/intervene', { roleId: $('#inspector-role-id').value, selfModel: $('#inspector-self-model').value, providerId: $('#inspector-provider').value, modelOverride: $('#inspector-model').value, impressions: JSON.stringify(impressions), goals: JSON.stringify(collectGoalsFromEdit()), thinkingStrength: $('#inspector-thinking').value }).then(ok => { if (ok) closeInspectorModals() })
}
$('#inspector-close').onclick = () => closeInspectorModals()
// 左侧肖像面板已并入 #role-modal，单独关闭按钮已移除
// ── 头像导入（ST 风格：上传文件 / 从 URL 导入）──
$('#inspector-avatar-upload').onclick = () => $('#inspector-avatar-file').click()
$('#inspector-avatar-file').onchange = event => {
  const file = event.target.files?.[0]
  if (!file) return
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { alert('仅支持 png / jpeg / gif / webp 图片。'); return }
  const reader = new FileReader()
  reader.onload = async () => {
    const roleId = $('#inspector-role-id').value
    try {
      const editing = storyEditRoleIndex !== null
      const storyId = editing ? ($('#story-edit-id').textContent || '').trim() : ''
      const dataUrl = await cropPortraitToRatio(String(reader.result))
      const ok = await api('/api/roles/avatar', { roleId, dataUrl, ...(editing ? { skipDispatch: true, ...(storyId ? { storyId } : {}) } : {}) })
      if (ok) {
        $('#inspector-avatar-preview').src = ok.portraitRef ?? $('#inspector-avatar-preview').src
        // 剧本编辑模式：头像写入正在编辑的剧本角色（自包含资产，保存时随剧本包分发）
        if (editing && storyEditRoles[storyEditRoleIndex]) storyEditRoles[storyEditRoleIndex].portraitRef = ok.portraitRef
        refreshRoom()
      }
    } finally { event.target.value = '' }
  }
  reader.readAsDataURL(file)
}
$('#inspector-avatar-url').onclick = async () => {
  const url = prompt('输入图片 URL（将下载为角色头像并裁剪为 3:4）：')
  if (!url || !url.trim()) return
  const roleId = $('#inspector-role-id').value
  try {
    const editing = storyEditRoleIndex !== null
    const storyId = editing ? ($('#story-edit-id').textContent || '').trim() : ''
    const trimmed = url.trim()
    const prepared = await preparePortraitUrl(trimmed)
    const ok = prepared.startsWith('data:image/')
      ? await api('/api/roles/avatar', { roleId, dataUrl: prepared, ...(editing ? { skipDispatch: true, ...(storyId ? { storyId } : {}) } : {}) })
      : await api('/api/roles/avatar', { roleId, url: trimmed, ...(editing ? { skipDispatch: true, ...(storyId ? { storyId } : {}) } : {}) })
    if (ok) {
      $('#inspector-avatar-preview').src = ok.portraitRef ?? $('#inspector-avatar-preview').src
      if (editing && storyEditRoles[storyEditRoleIndex]) storyEditRoles[storyEditRoleIndex].portraitRef = ok.portraitRef
      refreshRoom()
    }
  } catch { /* api() 已 alert */ }
}

// ── 人物管理（第二轮：新建 / 删除 / 在场 / 同步初始剧本）──
$('#inspector-delete').onclick = event => {
  event.preventDefault()
  const roleId = $('#inspector-role-id').value
  if (!roleId || !confirm('确定删除该角色？此操作不可恢复。')) return
  // 无论删除成功与否（含角色已被程序外删除的情况），都关闭窗口，避免卡死
  api('/api/roles/delete', { roleId }).finally(() => closeInspectorModals())
}
let pendingCreateAvatar = null // 新建角色时暂存的肖像（data URL 或 URL）
function openCreateRoleModal() {
  pendingCreateAvatar = null
  $('#new-role-avatar-preview').src = '/assets/default.svg'
  $('#new-role-avatar-file').value = ''
  $('#new-role-name').value = ''
  $('#new-role-self-model').value = ''
  $('#new-role-goals').value = ''
  $('#new-role-state').value = ''
  $('#new-role-presence').value = 'present'
  $('#new-role-memory').value = ''
  $('#create-role-modal').showModal()
}
$('#new-role-avatar-upload').onclick = () => $('#new-role-avatar-file').click()
$('#new-role-avatar-file').onchange = async event => {
  const file = event.target.files?.[0]
  if (!file) return
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { alert('仅支持 png / jpeg / gif / webp 图片。'); event.target.value = ''; return }
  const reader = new FileReader()
  reader.onload = async () => {
    pendingCreateAvatar = await cropPortraitToRatio(String(reader.result))
    $('#new-role-avatar-preview').src = pendingCreateAvatar
    event.target.value = ''
  }
  reader.readAsDataURL(file)
}
$('#new-role-avatar-url').onclick = async () => {
  const url = prompt('输入图片 URL（将下载为角色肖像并裁剪为 3:4）：')
  if (!url || !url.trim()) return
  const trimmed = url.trim()
  const prepared = await preparePortraitUrl(trimmed)
  if (prepared.startsWith('data:image/')) { pendingCreateAvatar = prepared; $('#new-role-avatar-preview').src = prepared }
  else { pendingCreateAvatar = trimmed; $('#new-role-avatar-preview').src = trimmed }
}
$('#create-role-save').onclick = event => {
  event.preventDefault()
  const name = $('#new-role-name').value.trim()
  const selfModel = $('#new-role-self-model').value.trim()
  if (!name) { alert('名称不能为空。'); return }
  if (!selfModel) { alert('人设不能为空。'); return }
  const payload = { name, selfModel, presence: $('#new-role-presence').value, portraitRef: pendingCreateAvatar ?? '/assets/default.svg', goals: JSON.stringify(collectGoalsInput('#new-role-goals')) }
  const currentState = $('#new-role-state').value.trim()
  if (currentState) payload.currentState = currentState
  api('/api/roles/create', payload).then(ok => { if (ok) $('#create-role-modal').close() })
}
$('#sync-roles').onclick = event => { event.preventDefault(); api('/api/story/sync-roles', { storyId: $('#story-select').value }).then(ok => { if (ok) alert('已同步到初始剧本') }) }
// ── 合并 SSE 单通道（room/thinking/summary 一个连接，避免 HTTP/1.1 每源 6 连接限制导致多窗口拿不到数据）──
const eventStream = new EventSource('/api/stream')
eventStream.addEventListener('room', event => { try { render(JSON.parse(event.data)) } catch (error) { console.error('[StageCraft] room event render failed', error) } })
eventStream.addEventListener('thinking', event => { try { applyThinkingEvent(JSON.parse(event.data)) } catch (error) { console.error('[StageCraft] thinking event failed', error) } })
eventStream.addEventListener('summary', event => { const item = JSON.parse(event.data); const stream = $('#debug-stream'); const detail = item.text.startsWith('模型完整返回') || item.text.startsWith('模型提交提示词'); if (!detail || debugDetailsEnabled) stream.textContent += `[${new Date(item.at).toLocaleTimeString()}] ${item.text}\n` })
async function bootApp() {
  // 启动竞态（Core 进程启动窗口）：/api/room 可能瞬时 503——有限重试等待 Core 就绪，
  // 避免"默认剧本不显示/页面空白"（Gate D 真机发现：首次启动 room 503 → bootApp 直接
  // return，story-select/roles/room-title 全空）。
  // 加载提示（两端复用：public/index.html 的 #boot-loading，桌面 DSH 与安卓 local 同源）
  const bootLoading = document.getElementById('boot-loading')
  const bootLoadingText = document.getElementById('boot-loading-text')
  const showBootLoading = (text) => { if (bootLoading) { bootLoading.hidden = false; if (bootLoadingText) bootLoadingText.textContent = text } }
  const hideBootLoading = () => { if (bootLoading) bootLoading.hidden = true }
  const BOOT_RETRY_LIMIT = 6
  const BOOT_RETRY_DELAY_MS = 800
  showBootLoading('正在加载…')
  for (let attempt = 0; attempt < BOOT_RETRY_LIMIT; attempt++) {
    try {
      const roomResponse = await fetch('/api/room')
      if (roomResponse.status === 401 && !/^(127\.0\.0\.1|localhost|::1)$/i.test(location.hostname)) { location.replace('/pair'); return }
      if (!roomResponse.ok) {
        if (roomResponse.status === 503 && attempt < BOOT_RETRY_LIMIT - 1) {
          // Core 尚未就绪：显示加载反馈并等待后重试（bounded；不无限阻塞）
          showBootLoading('正在加载…（等待核心就绪 ' + (attempt + 1) + '/' + BOOT_RETRY_LIMIT + '）')
          await new Promise(resolve => setTimeout(resolve, BOOT_RETRY_DELAY_MS))
          continue
        }
        throw new Error(`Room request failed: ${roomResponse.status}`)
      }
      render(await roomResponse.json())
      hideBootLoading()
      break
    } catch (error) {
      if (attempt >= BOOT_RETRY_LIMIT - 1) {
        console.error('[StageCraft] initial room load failed', error)
        showBootLoading('加载失败，请检查核心服务后刷新页面。')
        return
      }
      // 网络瞬时失败（gateway 重连窗口）同样有限重试
      showBootLoading('正在加载…（连接重试 ' + (attempt + 1) + '/' + BOOT_RETRY_LIMIT + '）')
      await new Promise(resolve => setTimeout(resolve, BOOT_RETRY_DELAY_MS))
    }
  }
  // 非核心辅助接口失败不应阻断旧 UI 的操作能力。
  await Promise.allSettled([loadStories(), loadProviders(), loadPromptPresets(), coreInteractionPanel.start()])
  // 启动自动检查更新（默认关闭，需在设置 → 关于中开启）
  if (readAutoUpdatePref()) void checkForUpdatesSilent()
}
bootApp()
// Core Event 通道先只更新客户端缓存；RoomSnapshot SSE 由上方合并的 /api/stream 驱动。
coreClient.subscribe(event => {
  if (event.revision == null || !coreClient.view) return
  if (event.type === 'state.changed' || event.type === 'workflow.changed' || event.type === 'interaction.created') {
    coreClient.getView().catch(() => {})
  }
})

// ── 思维链订阅与设置（thinking 事件已并入 /api/stream）──
$('#show-thinking').checked = thinkingPrefs.show
$('#auto-expand-thinking').checked = thinkingPrefs.autoExpand
$('#show-thinking').addEventListener('change', event => { thinkingPrefs.show = event.target.checked; localStorage.setItem(THINKING_PREFS_KEY, JSON.stringify(thinkingPrefs)); renderThinkingPanel(); if (room) render(room) })
$('#auto-expand-thinking').addEventListener('change', event => { thinkingPrefs.autoExpand = event.target.checked; localStorage.setItem(THINKING_PREFS_KEY, JSON.stringify(thinkingPrefs)); renderThinkingPanel(); if (room) render(room) })

// ── 标题栏中部横幅：八股文循环播放（15s 一换，八股三词加粗换色）──
let renderWhaleTagline = () => {}
function applyWhaleMeme() {
  document.title = whaleMemeEnabled ? 'DeepPlugin HARNESS' : 'StageCraft'
  const brandTitle = document.querySelector('.brand strong')
  if (brandTitle) brandTitle.textContent = whaleMemeEnabled ? 'DeepPlugin HARNESS' : 'StageCraft'
  const logo = document.querySelector('.brand-logo')
  if (logo) logo.hidden = !whaleMemeEnabled
  const tagline = $('#tagline')
  tagline.hidden = !whaleMemeEnabled
  if (!whaleMemeEnabled) { tagline.innerHTML = ''; tagline.title = '' } else renderWhaleTagline()
}
;(function initTagline() {
  const el = document.getElementById('tagline')
  if (!el) return
  const TAGLINES = [
    '<span class="obagu">不是</span>代码里的轮子，<span class="obagu">而是</span> Cordis 理念本身才是 DSH 的魂。',
    '<span class="obagu">我不拦</span>你把 DSH 生态硬塞进角色扮演，但别怪它处处拧巴。',
    '抓住那份理念，<span class="obagu">就够了</span>，何必抱着别人的轮子赶自己的路。',
    '眼看你为融入生态而削足适履，我<span class="obagu">指节泛白</span>，却知劝也无用。'
  ]
  let idx = 0
  const swap = () => {
    if (!whaleMemeEnabled) return
    el.style.opacity = '0'
    setTimeout(() => {
      if (!whaleMemeEnabled) return
      const html = TAGLINES[idx % TAGLINES.length]
      el.innerHTML = html
      el.title = html.replace(/<[^>]+>/g, '')
      el.style.opacity = '1'
      idx++
    }, 350)
  }
  renderWhaleTagline = swap
  applyWhaleMeme()
  setInterval(swap, 15000)
})()
