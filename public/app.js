import { CoreClient } from './core-client.js'
import { CoreInteractionPanel } from './core-interactions.js'

const coreClient = new CoreClient()
const coreInteractionPanel = new CoreInteractionPanel({ client: coreClient })
window.stagecraftCore = coreClient

let room
let providers = []
let focalRoleIds = new Set()
let reconsideringRoleIds = new Set()
let activeAction = null
let skipArmed = false
let sidebarTab = 'roles' // 左侧栏标签：roles | lore
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
    const open = true
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
  room = next
  window.stagecraftRoom = next
  focalRoleIds = new Set([...focalRoleIds].filter(id => room.roles.some(role => role.id === id && role.presence === 'present')))
  if (room.phase === 'awaiting-player-input') clearThinkingStreams()
  const states = { present: '在场', absent: '离场', unavailable: '离场' }
  $('#room-title').textContent = room.title
  const isChat = room.mode === 'chat'
  $('#mode-badge').textContent = `${isChat ? '群聊' : '导演'}${room.autoPublish ? ' · 沉浸' : ''}`
  $('#mode-badge').classList.toggle('chat', isChat)
  const readOnly = !!room.autoPublish // 沉浸模式：场景/角色状态/角色面板只读
  const sceneBar = $('#scene-bar')
  const sceneParts = readOnly
    ? [room.sceneTime ? `🕐 ${escape(room.sceneTime)}` : '', room.sceneLocation ? `📍 ${escape(room.sceneLocation)}` : ''].filter(Boolean)
    : [room.sceneTime ? `🕐 <button class="scene-edit" data-scene-field="time" title="点击修改场景时间">${escape(room.sceneTime)}</button>` : `<button class="scene-edit" data-scene-field="time">＋ 设置时间</button>`, room.sceneLocation ? `📍 <button class="scene-edit" data-scene-field="location" title="点击修改场景地点">${escape(room.sceneLocation)}</button>` : `<button class="scene-edit" data-scene-field="location">＋ 设置地点</button>`]
  sceneBar.hidden = false
  sceneBar.innerHTML = `<div class="scene-bar-inner">${sceneParts.join('　')}</div>`
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
  const roleCards = room.roles.map(role => {
    const focused = focalRoleIds.has(role.id)
    const decision = room.decisions.find(item => item.roleId === role.id)
    const status = focused ? '焦点' : states[role.presence]
    const activity = decision?.status === 'pending' ? '正在回应' : decision?.status === 'completed' ? '已回应' : decision?.status === 'unavailable' ? '回应失败' : ''
    const speakActionable = isChat && role.presence === 'present' && room.phase === 'awaiting-player-input' && !activeAction
    // 始终为在场角色保留「发言」占位按钮：可点时正常点击，不可点（发言中/非空闲/有动作进行）时置灰而非移除，
    // 避免按钮消失后「在场」按钮补位移位造成误触
    const speakBtn = isChat && role.presence === 'present'
      ? `<button class="speak-toggle"${speakActionable ? ` data-speak="${escape(role.id)}"` : ' disabled'}>发言</button>`
      : ''
    return `<article class="role ${focused ? 'focal' : ''} ${role.presence !== 'present' ? 'away' : ''}" draggable="true" data-role-drag="${escape(role.id)}"><img src="${escape(role.portraitRef)}" onerror="this.onerror=null;this.src='/assets/default.svg'"><div><div class="role-heading"><button class="role-name" data-inspect="${escape(role.id)}">${escape(role.name)}</button>${speakBtn}${!isChat && role.presence === 'present' ? `<button class="focus-toggle" data-focus="${escape(role.id)}">焦</button>` : ''}<button class="presence-toggle" data-presence="${escape(role.id)}" title="点击切换在场/离场">${role.presence === 'present' ? '在场' : '离场'}</button></div><small>${status}${activity ? ` · ${activity}` : ''}</small></div><p>${readOnly ? `<span class="role-state">${escape(role.currentState)}</span>` : `<span class="role-state" data-state-edit="${escape(role.id)}" title="点击修改当前状态">${escape(role.currentState)}</span>`}</p>${decision?.error ? `<small class="error">${escape(decision.error)}</small>` : ''}</article>`
  }).join('')
  const loreCards = (room.lore ?? []).map((entry, index) => {
    const tags = entry.roles && entry.roles.length ? entry.roles.map(id => room.roles.find(role => role.id === id)?.name ?? id).join('、') : '常开'
    return `<article class="lore-entry"${readOnly ? '' : ` data-lore="${index}"`}><div class="lore-heading"><b>${escape(entry.name)}</b><small>${escape(tags)}</small></div><p>${escape(entry.content)}</p></article>`
  }).join('')
  $('#roles').innerHTML = `<div class="sidebar-tabs"><button data-tab="roles" class="${sidebarTab === 'roles' ? 'active' : ''}">角色</button><button data-tab="lore" class="${sidebarTab === 'lore' ? 'active' : ''}">世界书</button></div><div id="roles-list" ${sidebarTab === 'roles' ? '' : 'hidden'}>${roleCards || '<p class="hint">暂无角色</p>'}<button id="role-add" class="role-add" ${readOnly ? 'disabled title="沉浸模式只读"' : ''}>＋ 新建人物</button></div><div id="lore-list" ${sidebarTab === 'lore' ? '' : 'hidden'}><button id="lore-add" class="lore-add" ${readOnly ? 'disabled title="沉浸模式只读"' : ''}>＋ 新增条目</button>${loreCards || '<p class="hint">暂无世界书条目</p>'}</div>`
  $('#scenes').innerHTML = room.scenes.length ? room.scenes.map(scene => {
    const snapshot = [scene.sceneTime ? `🕐 ${escape(scene.sceneTime)}` : '', scene.sceneLocation ? `📍 ${escape(scene.sceneLocation)}` : ''].filter(Boolean).join('　')
    const meta = snapshot ? `<time class="scene-snapshot">${snapshot}</time>` : `<time>${new Date(scene.createdAt).toLocaleString()}</time>`
    if (scene.speaker) {
      const isPlayer = scene.speaker === 'player'
      const role = isPlayer ? null : room.roles.find(item => item.id === scene.speaker)
      const name = isPlayer ? room.playerCharacter.name : (role?.name ?? scene.speaker)
      const avatar = isPlayer ? (room.playerCharacter.portraitRef || '/assets/default.svg') : (role?.portraitRef || '/assets/default.svg')
      return `<div class="scene scene-msg">${meta}<div class="chat-msg ${isPlayer ? 'me' : ''}"><img class="avatar" src="${escape(avatar)}" onerror="this.onerror=null;this.src='/assets/default.svg'"><div class="bubble"><div class="bubble-name">${escape(name)}</div><div class="bubble-text">${escape(scene.text)}</div></div></div>${tokenNoteHtml('scene', scene.usage)}</div>`
    }
    return `<article class="scene narration">${meta}<div class="scene-text">${escape(scene.text)}</div>${tokenNoteHtml('scene', scene.usage)}</article>`
  }).join('') : ''
  const decisionsDone = room.decisions.length > 0 && room.decisions.every(decision => decision.status !== 'pending')
  const display = $('#turn-display')
  display.hidden = room.phase === 'awaiting-player-input'
  if (!display.hidden) {
    const reactions = room.reactions ?? []
    const bubbles = reactions.map(reaction => { const role = room.roles.find(item => item.id === reaction.roleId); const locked = reconsideringRoleIds.has(reaction.roleId); const decision = room.decisions.find(item => item.roleId === reaction.roleId); const thinking = decision?.thinking; const identity = decision?.publicIdentity; return `<div class="reaction-wrap ${locked ? 'locked' : ''}">${thinkingBlockHtml(`${role?.name ?? reaction.roleId} 思维链`, thinking)}<button class="reaction-bubble" data-reaction="${escape(reaction.roleId)}" ${locked ? 'disabled' : ''}><b>${escape(role?.name ?? reaction.roleId)}</b>${escape(reaction.text)}${identity ? `<small class="reaction-identity">对外身份：${escape(identity)}</small>` : ''}${tokenNoteHtml('role', decision?.usage)}${locked ? '<small>重新考虑中</small>' : ''}</button><div class="reaction-feedback" id="feedback-${escape(reaction.roleId)}" hidden><textarea placeholder="写下希望 ${escape(role?.name ?? reaction.roleId)} 重新考虑的内容..."></textarea><button data-reconsider="${escape(reaction.roleId)}">发送</button></div></div>` }).join('')
    const allStates = [{ id: 'player', label: `${room.playerCharacter.name} 当前状态`, value: room.draft?.stateUpdates.player ?? room.playerCharacter.currentState }, ...room.roles.map(role => ({ id: role.id, label: `${role.name} 当前状态`, value: room.draft?.stateUpdates[role.id] ?? role.currentState }))]
    const draft = room.draft ? `<article class="director-draft-record"><header><h2>导演草稿记录 <small>待定</small></h2><time>${new Date(room.draft.createdAt).toLocaleString()}</time></header>${thinkingBlockHtml('导演思维链', room.draft.thinking)}${tokenNoteHtml('director', room.draft.usage)}<textarea id="center-draft-text">${escape(room.draft.text)}</textarea><details class="scene-edits"><summary>场景更新</summary><label>时间<input id="scene-time-input" value="${escape(room.draft.sceneUpdates?.time ?? room.sceneTime ?? '')}" placeholder="如：深夜"></label><label>地点<input id="scene-location-input" value="${escape(room.draft.sceneUpdates?.location ?? room.sceneLocation ?? '')}" placeholder="如：祭典主厅门口"></label></details><details class="state-edits"><summary>状态更新</summary>${allStates.map(state => `<label>${escape(state.label)}<textarea data-state-update="${escape(state.id)}">${escape(state.value)}</textarea></label>`).join('')}</details>${(room.draft.roleProposals?.length ?? 0) ? `<div class="role-proposals"><h4 class="section-title">导演提议新人物：批准后将创建</h4><ul>${room.draft.roleProposals.map(proposal => `<li><div class="proposal-heading"><b>${escape(proposal.name)}</b><small>${states[proposal.presence] ?? escape(proposal.presence)}</small></div><p>${escape(proposal.currentState)}</p></li>`).join('')}</ul></div>` : ''}<div class="draft-actions"><button id="center-reconsider">重考</button><button id="center-approve">批准发布</button></div></article>` : ''
    const wcSceneHtml = (wc, timeId, locId) => (wc.sceneTime || wc.sceneLocation) ? `<div class="wc-scene"><label>时间<input id="${timeId}" value="${escape(wc.sceneTime ?? room.sceneTime ?? '')}" placeholder="如：深夜"></label><label>地点<input id="${locId}" value="${escape(wc.sceneLocation ?? room.sceneLocation ?? '')}" placeholder="如：祭典主厅门口"></label></div>` : ''
    const wcRolesHtml = wc => (wc.roleProposals?.length ?? 0) ? `<div class="wc-roles"><h5>提议新人物：批准后将创建</h5><ul>${wc.roleProposals.map(proposal => `<li><div class="proposal-heading"><b>${escape(proposal.name)}</b><small>${states[proposal.presence] ?? escape(proposal.presence)}</small></div><p>${escape(proposal.currentState)}</p></li>`).join('')}</ul></div>` : ''
    const wcPresenceHtml = wc => (wc.rolePresence?.length ?? 0) ? `<div class="wc-presence"><h5>角色进离场</h5><ul>${wc.rolePresence.map(item => { const role = room.roles.find(r => r.id === item.roleId); return `<li><b>${escape(role?.name ?? item.roleId)}</b><small>${states[item.presence] ?? escape(item.presence)}</small></li>` }).join('')}</ul></div>` : ''
    const speechApproval = isChat && ['awaiting-approval', 'world-change-approval'].includes(room.phase) && room.speech
      ? (() => {
          const rid = room.speech.roleId
          const role = room.roles.find(item => item.id === rid)
          const name = role?.name ?? rid
          const avatar = role?.portraitRef || '/assets/default.svg'
          const wc = room.pendingWorldChange
          const worldChangeHtml = wc ? `<div class="world-change-proposal"><h4 class="section-title">世界变更申请 <small>（角色随台词提出，批准发布时一并生效）</small></h4>${wc.reason ? `<p class="wc-reason">${escape(wc.reason)}</p>` : ''}${wcSceneHtml(wc, 'wc-time', 'wc-location')}${wcRolesHtml(wc)}${wcPresenceHtml(wc)}</div>` : ''
          return `<div class="scene scene-msg speech-approval"><div class="chat-msg"><img class="avatar" src="${escape(avatar)}" onerror="this.onerror=null;this.src='/assets/default.svg'"><div class="bubble"><div class="bubble-name">${escape(name)} <small>台词待审批</small></div></div></div>${thinkingBlockHtml(`${name} 思维链`, room.speech.thinking)}${tokenNoteHtml('speech', room.speech.usage)}<textarea id="speech-text" class="speech-textarea">${escape(room.speech.text)}</textarea><textarea id="speech-reconsider-feedback" class="speech-feedback-textarea" placeholder="写下希望角色如何重新考虑这句台词…"></textarea>${worldChangeHtml}<div class="draft-actions"><button id="speech-reconsider">带意见重考</button><button id="speech-cancel">放弃</button><button id="speech-approve">批准发布</button></div></div>`
        })() : ''
    // 群聊：导演对话产出的世界变更申请（无台词）独立审批
    const worldChangeApproval = isChat && room.phase === 'world-change-approval' && !room.speech && room.pendingWorldChange
      ? `<div class="scene narration world-change-proposal world-change-approval-card"><h4 class="section-title">世界变更申请 <small>（导演建议，批准后生效）</small></h4>${room.pendingWorldChange.reason ? `<p class="wc-reason">${escape(room.pendingWorldChange.reason)}</p>` : ''}${wcSceneHtml(room.pendingWorldChange, 'wc-time', 'wc-location')}${wcRolesHtml(room.pendingWorldChange)}${wcPresenceHtml(room.pendingWorldChange)}${room.pendingNarration ? `<div class="wc-narration"><h5>将写下的叙述</h5><p>${escape(room.pendingNarration)}</p></div>` : ''}<div class="draft-actions"><button id="world-change-reject">拒绝</button><button id="world-change-approve">批准并生效</button></div></div>`
      : ''
    const heading = isChat ? '<h2>本回合</h2>' : reactions.length ? '<h2>本回合</h2>' : '<h2>本回合 <small>等待角色回应</small></h2>'
    const proceedBtn = room.phase === 'collecting-decisions' && decisionsDone ? '<div class="draft-actions"><button id="center-proceed-draft">拟定草稿</button></div>' : ''
    display.innerHTML = `${heading}<div class="reaction-list">${bubbles}</div>${proceedBtn}${speechApproval}${worldChangeApproval}${draft}`
  }
  const thinking = ['drafting', 'consulting-director'].includes(room.phase)
  let progressText = ''
  if (room.lastError) progressText = `<p class="error">${escape(room.lastError)}</p>`
  else if (thinking) progressText = `<p class="thinking">导演正在思考…</p>`
  else if (room.phase === 'role-speaking') progressText = `<p class="thinking">角色正在发言…</p>`
  else if (room.phase === 'collecting-decisions' && decisionsDone) progressText = `<p>角色反馈已就绪——可点击气泡修改，确认后拟定草稿。</p>`
  else if (room.phase === 'awaiting-player-input') progressText = `<p>${isChat ? '群聊模式：写下你的行动，再点左侧角色的「发言」。' : '等待你的行动。'}</p>`
  else if (room.phase === 'awaiting-approval' && room.speech) progressText = '<p>台词待审批——可编辑后批准，或放弃。</p>'
  else if (room.phase === 'world-change-approval' && room.speech) progressText = '<p>台词附带了世界变更申请——批准发布将一并推进时间/地点或引入新人物；放弃则全部取消。</p>'
  else if (room.phase === 'world-change-approval' && !room.speech && room.pendingWorldChange) progressText = '<p>导演建议了世界变更——批准后生效并写一段叙述，或拒绝。</p>'
  else progressText = '<p>当前回合进行中。</p>'
  $('#progress').innerHTML = progressText
  $('#recovery-actions').hidden = !(room.phase === 'drafting' || room.phase === 'role-speaking' || (room.phase === 'collecting-decisions' && decisionsDone))
  $('#retry-director').hidden = room.phase !== 'drafting'
  // 群聊模式发言失败时，在「取消回合」旁显示「重试发言」
  $('#retry-speak').hidden = !(isChat && room.phase === 'role-speaking' && room.lastError)
  let consultHtml = (room.consultations ?? []).map(message => `<p class="consultation ${message.role}"><b>${message.role === 'player' ? room.playerCharacter.name : '导演'}</b>${escape(message.text)}${message.thinking ? thinkingBlockHtml('导演思维链', message.thinking) : ''}${tokenNoteHtml('consult', message.usage)}</p>`).join('')
  if (room.draft?.openQuestions?.length) consultHtml += `<p class="consultation director director-extra"><b>导演</b>❓ 待确认：${room.draft.openQuestions.map(escape).join('；')}</p>`
  $('#consultations').innerHTML = consultHtml
  $('#director-chat').hidden = false
  const consultAvailable = room.draft && !['awaiting-player-input', 'drafting'].includes(room.phase)
  $('#consult-send').disabled = isChat ? (activeAction === 'director' ? false : room.phase !== 'awaiting-player-input') : activeAction === 'director' ? false : !consultAvailable
  $('#consult-send').textContent = isChat ? (activeAction === 'director' ? '停止' : '建议') : activeAction === 'director' ? '停止' : room.draft ? '发送' : room.phase === 'awaiting-player-input' ? '设定' : '发送'
  $('#consult-text').disabled = isChat ? activeAction === 'director' : false
  $('#consult-text').placeholder = isChat ? '向导演建议世界变化：推进时间、换场景、人物进出场、引入新人物...' : room.draft ? '与导演讨论、指出问题，或要求调整当前草稿...' : '向导演说明你的设定，将作为后续起草参考...'
  $('#submit').textContent = activeAction === 'turn' ? '停止' : skipArmed ? '空过？' : isChat ? '提交行动' : '提交'
  $('#submit').disabled = activeAction !== 'turn' && room.phase !== 'awaiting-player-input'
  if ($('#center-reconsider')) { $('#center-reconsider').disabled = activeAction === 'director'; $('#center-reconsider').textContent = activeAction === 'director' ? '思考中…' : '重考' }
}

async function refreshRoom() { const response = await fetch('/api/room'); render(await response.json()) }
async function api(path, body) { const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) { alert((await response.json()).error || '请求失败'); return false }; const data = await response.json(); await refreshRoom(); return data }
async function loadStories() { const response = await fetch('/api/stories'); const stories = await response.json(); $('#story-select').innerHTML = stories.map(story => `<option value="${escape(story.id)}">${escape(story.title)}${story.custom ? '' : '（默认）'}</option>`).join('') }
async function loadProviders() { const data = await (await fetch('/api/providers')).json(); providers = data.providers; const options = providers.map(provider => `<option value="${escape(provider.id)}">${escape(provider.name)}${provider.hasApiKey ? '（已配置）' : '（无密钥）'}</option>`).join(''); $('#provider-select').innerHTML = options; $('#director-provider-select').innerHTML = options; $('#provider-select').value = data.defaults.defaultRoleProviderId ?? providers[0]?.id ?? ''; $('#director-provider-select').value = data.defaults.directorProviderId ?? providers[0]?.id ?? ''; updateModels(providers.find(item => item.id === $('#provider-select').value), '#model-select', data.defaults.defaultRoleModel); updateModels(providers.find(item => item.id === $('#director-provider-select').value), '#director-model-select', data.defaults.directorModel); $('#director-thinking').value = data.defaults.directorThinkingStrength ?? 'standard'; const usage = await (await fetch('/api/usage')).json(); $('#model-mode').textContent = usage.route === '模拟' ? '模拟' : `${usage.route} / ${usage.model}` }
function updateModels(provider, selector, selected) { $(selector).innerHTML = (provider?.models ?? []).map(model => `<option>${escape(model)}</option>`).join(''); $(selector).value = selected ?? provider?.selectedModel ?? provider?.models?.[0] ?? '' }

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
      const ok = await api('/api/player/avatar', { dataUrl: String(reader.result) })
      if (ok) { $('#player-avatar-preview').src = ok.portraitRef ?? $('#player-avatar-preview').src; refreshRoom() }
    } finally { event.target.value = '' }
  }
  reader.readAsDataURL(file)
}
$('#player-avatar-url').onclick = async () => {
  const url = prompt('输入图片 URL（将下载为主角肖像）：')
  if (!url || !url.trim()) return
  try {
    const ok = await api('/api/player/avatar', { url: url.trim() })
    if (ok) { $('#player-avatar-preview').src = ok.portraitRef ?? $('#player-avatar-preview').src; refreshRoom() }
  } catch { /* api() 已 alert */ }
}
$('#story-settings').onclick = () => { refreshArchiveList(); const storySelect = $('#story-select'); if (room?.storyId && [...storySelect.options].some(option => option.value === room.storyId)) storySelect.value = room.storyId; const modeLabel = room?.mode === 'chat' ? '群聊' : '导演'; $('#archive-name').value = room?.title?.trim() ? `${room.title.trim()}-${modeLabel}` : (room?.storyId ?? ''); $('#room-mode-select').value = room?.mode ?? 'director'; $('#room-auto-publish').checked = !!room?.autoPublish; $('#story-modal').showModal() }
$('#app-settings').onclick = () => { $('#settings-auto-publish').checked = !!room?.autoPublish; $('#settings-token-count').checked = tokenCountEnabled; $('#settings-debug').checked = !$('#debug-stream').hidden; $('#settings-modal').showModal() }
$('#settings-auto-publish').onchange = () => api('/api/room-config', { autoPublish: $('#settings-auto-publish').checked })
$('#settings-token-count').onchange = () => { tokenCountEnabled = $('#settings-token-count').checked; try { localStorage.setItem(TOKEN_PREFS_KEY, tokenCountEnabled ? '1' : '0') } catch {} render(room) }
$('#settings-debug').onchange = () => { const stream = $('#debug-stream'); stream.hidden = !$('#settings-debug').checked }

// ── ST 角色卡导入（坯子） ──
let stImportFile = null
$('#st-import-open').onclick = () => { stImportFile = null; $('#st-import-file').value = ''; $('#st-import-run').disabled = true; $('#st-import-preview').innerHTML = '<p class="hint">选择文件后显示解析结果。</p>'; $('#st-import-modal').showModal() }
$('#st-import-close').onclick = () => $('#st-import-modal').close()
$('#st-import-file').onchange = async event => {
  const file = event.target.files[0]
  if (!file) return
  const preview = $('#st-import-preview')
  preview.innerHTML = '<p class="hint">读取中…</p>'
  try {
    if (/\.png$/i.test(file.name)) {
      stImportFile = { content: await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file) }), filename: file.name }
    } else {
      stImportFile = { content: await file.text(), filename: file.name }
    }
    preview.innerHTML = `<p>已读取 <b>${escape(file.name)}</b>（${file.size} 字节）——点击「导入为角色」执行解析。</p>`
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
    const response = await fetch('/api/st-cards/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(stImportFile) })
    const data = await response.json()
    if (!response.ok) { preview.innerHTML = `<p class="error">导入失败：${escape(data.error || response.status)}</p>`; button.disabled = false; return }
    const mapped = data.mapped ?? {}
    const warnings = (mapped.warnings ?? []).map(warning => `<li>${escape(warning)}</li>`).join('')
    preview.innerHTML = `<p class="st-import-ok">✅ 已导入 <b>${escape(mapped.name)}</b>（${mapped.selfModelChars} 字人设${mapped.loreCount ? `，${mapped.loreCount} 条世界书` : ''}${mapped.spec ? `，${escape(mapped.spec)}` : ''}）</p>${warnings ? `<ul class="st-import-warnings">${warnings}</ul>` : ''}<p class="hint">可在左侧角色列表中查看；世界书条目在「世界书」标签页。</p>`
    button.textContent = '已导入'
  } catch (error) {
    preview.innerHTML = `<p class="error">导入失败：${escape(error.message)}</p>`
    button.disabled = false
  }
}
$('#prompts-edit').onclick = async () => {
  $('#prompts-modal').showModal()
  try {
    const response = await fetch('/api/prompts')
    const data = await response.json()
    if (!response.ok || !data.files) { alert('加载提示词失败：' + (data.error || response.status)); return }
    promptFiles = data.files
    renderPromptFileSelect('')
  } catch { alert('加载提示词失败：无法连接服务器。') }
}
let promptFiles = []
function renderPromptFileSelect(selectedName = '') {
  const select = $('#prompt-file-select')
  const selected = selectedName && promptFiles.some(file => file.name === selectedName) ? selectedName : ''
  select.innerHTML = '<option value="">core prompts（默认）</option>' + promptFiles.map(file => '<option value="' + escape(file.name) + '">' + escape(file.name) + '</option>').join('')
  select.value = selected
  applyPromptFileSelection(selected)
}
function applyPromptFileSelection(name) {
  const file = promptFiles.find(item => item.name === name)
  const core = !file
  $('#prompt-core-note').hidden = !core
  const role = $('#prompt-role'), director = $('#prompt-director'), save = $('#prompts-save')
  role.disabled = core; director.disabled = core; save.disabled = core
  role.value = file?.roleIdeals ?? ''; director.value = file?.directorIdeals ?? ''
}
$('#prompt-file-select').onchange = () => applyPromptFileSelection($('#prompt-file-select').value)
$('#prompt-new').onclick = () => {
  const name = prompt('新建提示词文件名（存于 prompts/custom/）：').trim()
  if (!name) return
  if (!/^[\w\u4e00-\u9fff-]+\.json$/i.test(name) && !/^[\w\u4e00-\u9fff-]+$/.test(name)) { alert('文件名仅支持中英文、数字、下划线与连字符。'); return }
  const final = name.endsWith('.json') ? name : name + '.json'
  if (promptFiles.some(file => file.name === final)) { alert('同名文件已存在。'); return }
  api('/api/prompts', { name: final, role: '', director: '', activate: false }).then(ok => {
    if (ok) { promptFiles.push({ name: final, roleIdeals: '', directorIdeals: '' }); renderPromptFileSelect(final) }
  })
}
$('#prompt-rename').onclick = () => {
  const current = $('#prompt-file-select').value
  if (!current) return
  const next = prompt('重命名「' + current + '」为：', current.replace(/\.json$/i, '')).trim()
  if (!next || next.replace(/\.json$/i, '') === current.replace(/\.json$/i, '')) return
  if (!/^[\w\u4e00-\u9fff-]+\.json$/i.test(next) && !/^[\w\u4e00-\u9fff-]+$/.test(next)) { alert('文件名仅支持中英文、数字、下划线与连字符。'); return }
  const final = next.endsWith('.json') ? next : next + '.json'
  fetch('/api/prompts/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: current, to: final }) }).then(response => response.json()).then(data => {
    if (!data.ok) { alert('重命名失败（受保护文件或同名冲突）。'); return }
    promptFiles = data.files
    renderPromptFileSelect(final)
  })
}
$('#prompt-delete').onclick = () => {
  const current = $('#prompt-file-select').value
  if (!current) return
  if (!confirm('删除「' + current + '」？该操作不可恢复。')) return
  fetch('/api/prompts?name=' + encodeURIComponent(current), { method: 'DELETE' }).then(response => response.json()).then(data => {
    if (!data.ok) { alert('删除失败（受保护文件）。'); return }
    promptFiles = data.files
    renderPromptFileSelect('')
    alert('已删除「' + current + '」。')
  })
}
$('#prompts-save').onclick = event => {
  event.preventDefault()
  const name = $('#prompt-file-select').value
  if (!name) return
  api('/api/prompts', { name, role: $('#prompt-role').value, director: $('#prompt-director').value }).then(ok => { if (ok) { alert('提示词已保存并生效'); $('#prompts-modal').close() } })
}
$('#prompts-close').onclick = () => $('#prompts-modal').close()
$('#provider-select').onchange = () => { updateModels(providers.find(item => item.id === $('#provider-select').value), '#model-select'); api('/api/providers/default-role', { id: $('#provider-select').value, model: $('#model-select').value }) }
$('#model-select').onchange = () => api('/api/providers/default-role', { id: $('#provider-select').value, model: $('#model-select').value })
$('#director-provider-select').onchange = () => { updateModels(providers.find(item => item.id === $('#director-provider-select').value), '#director-model-select'); api('/api/providers/director', { id: $('#director-provider-select').value, model: $('#director-model-select').value }) }
$('#director-model-select').onchange = () => api('/api/providers/director', { id: $('#director-provider-select').value, model: $('#director-model-select').value })
$('#director-thinking').onchange = () => api('/api/providers/director-thinking', { thinking: $('#director-thinking').value })
$('#refresh-models').onclick = event => { event.preventDefault(); api('/api/providers/discover', { id: $('#provider-select').value }).then(loadProviders) }
$('#provider-save').onclick = event => { event.preventDefault(); api('/api/providers/save', { id: `provider-${Date.now()}`, name: $('#provider-name').value, baseUrl: $('#provider-url').value, apiKey: $('#provider-key').value, models: $('#provider-models').value.split(',').map(value => value.trim()).filter(Boolean), responseFormat: $('#provider-format').value }).then(ok => { if (ok) { $('#connection-modal').close(); loadProviders() } }) }
$('#player-save').onclick = event => { event.preventDefault(); api('/api/player-character', { name: $('#player-name').value, persona: $('#player-persona').value, currentState: $('#player-state').value }).then(ok => { if (ok) $('#player-modal').close() }) }
$('#restart').onclick = event => { event.preventDefault(); if (confirm('重开将清除当前剧本的回合、草稿和已批准正文。继续吗？')) api('/api/restart', { storyId: $('#story-select').value, mode: $('#room-mode-select').value, autoPublish: $('#room-auto-publish').checked }).then(ok => { if (ok) $('#story-modal').close() }) }
$('#save-archive').onclick = event => { event.preventDefault(); api('/api/archive/save', { name: $('#archive-name').value.trim() }).then(ok => { if (ok) { $('#archive-name').value = ''; refreshArchiveList() } }) }
$('#edit-story').onclick = event => { event.preventDefault(); openStoryEditor() }
$('#load-archive').onchange = async event => { const file = event.target.files[0]; if (file) await api('/api/archive/import', JSON.parse(await file.text())) }

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
      ? `<ul class="archive-list">${files.map(name => `<li><span class="archive-name">${escape(name)}</span><span class="archive-actions"><button data-archive-load="${escape(name)}">读档</button><button class="danger" data-archive-delete="${escape(name)}">删除</button></span></li>`).join('')}</ul>`
      : '<p class="hint">暂无存档。</p>'
  } catch (error) {
    listEl.innerHTML = `<p class="error">${escape(error.message)}</p>`
  }
}
async function loadArchive(name) { const ok = await api('/api/archive/load', { name }); if (ok) refreshArchiveList() }
async function deleteArchive(name) { if (!confirm(`删除存档「${name}」？`)) return; const response = await fetch('/api/archive/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }); if (!response.ok) { alert((await response.json()).error || '删除失败'); return } refreshArchiveList() }

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

async function openStoryEditor() {
  const storyId = $('#story-select').value
  if (!storyId) { alert('请先在剧本弹窗中选择剧本。'); return }
  const response = await fetch(`/api/story/get?id=${encodeURIComponent(storyId)}`)
  if (!response.ok) { alert((await response.json()).error || '读取剧本失败。'); return }
  const story = await response.json()
  storyEditRoles = story.roles ?? []
  storyEditLore = story.lore ?? []
  storyEditRoleIndex = null
  $('#story-edit-id').textContent = storyId
  $('#story-edit-title').value = story.title ?? ''
  $('#story-edit-opening').value = story.opening ?? ''
  $('#story-edit-scene-time').value = story.sceneTime ?? ''
  $('#story-edit-scene-location').value = story.sceneLocation ?? ''
  $('#story-edit-player-name').value = story.playerCharacter?.name ?? ''
  $('#story-edit-player-persona').value = story.playerCharacter?.persona ?? ''
  $('#story-edit-player-state').value = story.playerCharacter?.currentState ?? ''
  renderStoryRoles()
  renderStoryLore()
  $('#story-edit-modal').showModal()
}
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
$('#story-role-add').onclick = () => { storyEditRoles.push({ id: `new-role-${Date.now()}`, name: '新角色', portraitRef: '/assets/default.svg', currentState: '尚未进入具体场景，等待剧情展开。', presence: 'absent', memoryTimeline: { '未标注时间': [] }, impressions: {}, selfModel: '待补充的角色设定。' }); renderStoryRoles() }
function openStoryRoleEditor(index) {
  const role = storyEditRoles[index]
  if (!role) return
  storyEditRoleIndex = index
  $('#role-modal-title').textContent = `${role.name} 角色设置（剧本）`
  $('#inspector-role-id').value = role.id
  $('#inspector-provider').innerHTML = '<option value="">使用默认</option>'
  $('#inspector-model').innerHTML = '<option value="">使用默认</option>'
  $('#inspector-self-model').value = role.selfModel ?? ''
  $('#inspector-goals').value = (role.goals ?? []).join('\n')
  $('#inspector-memory').value = formatTimelineForEdit(role)
  renderImpressionsFrom(role.impressions ?? {})
  $('#inspector-story-fields').hidden = false
  $('#inspector-story-name').value = role.name ?? ''
  $('#inspector-story-presence').value = role.presence ?? 'absent'
  $('#inspector-story-avatar').value = role.portraitRef ?? '/assets/default.svg'
  $('#inspector-story-state').value = role.currentState ?? ''
  $('#inspector-avatar-preview').src = role.portraitRef ?? '/assets/default.svg'
  $('#inspector-avatar-preview').onerror = function () { this.onerror = null; this.src = '/assets/default.svg' }
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
$('#story-edit-save').onclick = event => {
  event.preventDefault()
  const storyId = $('#story-edit-id').textContent
  storyEditLore = [...document.querySelectorAll('#story-lore-list .story-lore-item')].map(item => {
    const name = item.querySelector('.lore-name').value.trim() || '未命名条目'
    const content = item.querySelector('.lore-content').value
    const roles = [...item.querySelectorAll('.lore-role-check input:checked')].map(cb => cb.dataset.role)
    return roles.length ? { name, content, roles } : { name, content }
  })
  const sceneTime = $('#story-edit-scene-time').value.trim()
  const sceneLocation = $('#story-edit-scene-location').value.trim()
  const story = {
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
  fetch('/api/story/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ story }) }).then(async response => {
    if (!response.ok) { alert((await response.json()).error || '保存失败。'); return }
    $('#story-edit-modal').close()
    const selected = $('#story-select').value
    loadStories().then(() => { $('#story-select').value = selected })
  })
}
// 对话框关闭键统一委托（type=button + data-dialog-close，不依赖 form 提交）
document.addEventListener('click', event => { const closer = event.target.closest('[data-dialog-close]'); if (closer) { const dialog = closer.closest('dialog'); if (dialog?.open) dialog.close() } })
$('#submit').onclick = async () => {
  if (activeAction) { await api('/api/cancel-turn', {}); activeAction = null; skipArmed = false; clearThinkingStreams(); await refreshRoom(); return }
  const text = $('#contribution').value
  if (!text.trim()) {
    if (!skipArmed) { skipArmed = true; render(room); return }
    skipArmed = false
  }
  clearThinkingStreams()
  activeAction = 'turn'; render(room); try { await api('/api/turn', { text, requiredRoleIds: [...focalRoleIds] }) } finally { activeAction = null; skipArmed = false; await refreshRoom() }
}
function directorContext() { return `当前玩家编辑草稿：\n${currentDraftText()}\n\n本回合 NPC 临时反应：\n${(room.reactions ?? []).map(item => `${item.roleId}: ${item.text}`).join('\n')}\n\n导演对话记录：\n${(room.consultations ?? []).map(item => `${item.role}: ${item.text}`).join('\n')}` }
async function directorReconsider() { if (!room.draft || activeAction) return; activeAction = 'director'; render(room); try { await api('/api/consult', { draftId: room.draft.id, text: '请根据本回合信息重新审视并重写草稿。', context: directorContext() }); await api('/api/redraft', { draftId: room.draft.id }) } finally { activeAction = null; await refreshRoom() } }
$('#consult-send').onclick = async () => { if (activeAction) { await api('/api/cancel-turn', {}); activeAction = null; clearThinkingStreams(); await refreshRoom(); return }; const text = $('#consult-text').value.trim(); if (!text) return; if (room.mode === 'chat') { activeAction = 'director'; render(room); try { await api('/api/chat/director-chat', { text }); $('#consult-text').value = '' } finally { activeAction = null; await refreshRoom() } return }; if (!room.draft) { const ok = await api('/api/director/setting', { text }); if (ok) $('#consult-text').value = ''; return }; activeAction = 'director'; render(room); try { await api('/api/consult', { draftId: room.draft.id, text }); $('#consult-text').value = ''; await api('/api/redraft', { draftId: room.draft.id }) } finally { activeAction = null; await refreshRoom() } }
$('#retry-director').onclick = async () => { if (activeAction) return; thinkingStreams.delete('director'); renderThinkingPanel(); activeAction = 'director'; render(room); try { await api('/api/director/retry', {}) } finally { activeAction = null; await refreshRoom() } }
$('#retry-speak').onclick = async () => { if (activeAction) return; for (const key of [...thinkingStreams.keys()]) if (key.startsWith('role:')) thinkingStreams.delete(key); renderThinkingPanel(); activeAction = 'speak'; render(room); try { await api('/api/chat/retry', {}) } finally { activeAction = null; await refreshRoom() } }
$('#cancel-turn').onclick = () => { clearThinkingStreams(); api('/api/cancel-turn', {}) }
document.addEventListener('click', event => { const target = event.target instanceof Element ? event.target : null; const speakId = target?.dataset.speak; if (speakId) { if (activeAction) return; activeAction = 'speak'; render(room); const interaction = coreClient.view?.interactions?.find(item => item.kind === 'role-select'); const command = interaction ? coreClient.dispatch({ id: `role-select-${Date.now()}`, actor: 'player', interactionId: interaction.id, type: 'select-role', payload: { roleId: speakId } }) : Promise.reject(new Error('Core role-select interaction unavailable')); command.catch(() => api('/api/chat/speak', { roleId: speakId })).finally(() => { activeAction = null; refreshRoom() }) }; if (event.target.id === 'speech-approve' && room.speech) { const text = $('#speech-text').value; const wcTime = $('#wc-time')?.value; const wcLocation = $('#wc-location')?.value; const worldChange = room.pendingWorldChange ? { ...room.pendingWorldChange, ...(wcTime !== undefined ? { sceneTime: wcTime.trim() } : {}), ...(wcLocation !== undefined ? { sceneLocation: wcLocation.trim() } : {}) } : null; activeAction = 'speech-approve'; render(room); api('/api/chat/approve-speech', { text, ...(worldChange ? { worldChange } : {}) }).then(ok => { if (ok) $('#contribution').value = '' }).finally(() => { activeAction = null; refreshRoom() }) }; if (event.target.id === 'speech-reconsider' && room.speech) { const feedback = $('#speech-reconsider-feedback').value.trim(); if (!feedback) { alert('请先填写重考意见。'); return }; activeAction = 'speech-reconsider'; render(room); api('/api/chat/reject-speech', {}).then(() => api('/api/chat/speak', { roleId: room.speech.roleId, feedback })).finally(() => { activeAction = null; refreshRoom() }) }; if (event.target.id === 'speech-cancel' && room.speech) { activeAction = 'speech-cancel'; api('/api/chat/reject-speech', {}).finally(() => { activeAction = null; refreshRoom() }) }; if (event.target.id === 'world-change-approve' && room.pendingWorldChange) { const wcTime = $('#wc-time')?.value; const wcLocation = $('#wc-location')?.value; const override = { ...room.pendingWorldChange, ...(wcTime !== undefined ? { sceneTime: wcTime.trim() } : {}), ...(wcLocation !== undefined ? { sceneLocation: wcLocation.trim() } : {}) }; activeAction = 'world-change-approve'; render(room); api('/api/world-change/approve', { worldChange: override }).finally(() => { activeAction = null; refreshRoom() }) }; if (event.target.id === 'world-change-reject') { activeAction = 'world-change-reject'; api('/api/world-change/reject').finally(() => { activeAction = null; refreshRoom() }) }; const roleId = event.target.dataset.inspect; if (roleId) { try { openInspector(roleId) } catch (error) { console.error('打开角色面板失败：', error) } } const focusId = event.target.dataset.focus; if (focusId) { focalRoleIds.has(focusId) ? focalRoleIds.delete(focusId) : focalRoleIds.add(focusId); render(room) }; const presenceId = event.target.dataset.presence; if (presenceId) { const presenceRole = room.roles.find(item => item.id === presenceId); if (presenceRole) api('/api/roles/presence', { roleId: presenceId, presence: presenceRole.presence === 'present' ? 'absent' : 'present' }) }; if (event.target.id === 'role-add') openCreateRoleModal(); const reactionId = event.target.dataset.reaction; if (reactionId) { const panel = $(`#feedback-${reactionId}`); panel.hidden = !panel.hidden; panel.querySelector('textarea').focus() }; const reconsiderId = event.target.dataset.reconsider; if (reconsiderId) { const panel = $(`#feedback-${reconsiderId}`); const feedback = panel.querySelector('textarea').value.trim(); if (feedback) { panel.hidden = true; reconsideringRoleIds.add(reconsiderId); render(room); api('/api/reactions/reconsider', { roleId: reconsiderId, feedback }).finally(() => { reconsideringRoleIds.delete(reconsiderId); refreshRoom() }) } }; if (event.target.id === 'center-proceed-draft') { if (activeAction) return; activeAction = 'director'; render(room); api('/api/director/proceed', {}).finally(() => { activeAction = null; refreshRoom() }) }; if (event.target.id === 'center-reconsider' && room.draft) directorReconsider(); if (event.target.id === 'center-approve' && room.draft) { const updates = {}; document.querySelectorAll('[data-state-update]').forEach(input => { const id = input.dataset.stateUpdate; const current = id === 'player' ? room.playerCharacter.currentState : room.roles.find(role => role.id === id)?.currentState; if (input.value !== current) updates[id] = input.value }); const sceneUpdates = {}; const timeInput = $('#scene-time-input'); const locationInput = $('#scene-location-input'); if (timeInput && timeInput.value.trim() !== (room.sceneTime ?? '')) sceneUpdates.time = timeInput.value.trim(); if (locationInput && locationInput.value.trim() !== (room.sceneLocation ?? '')) sceneUpdates.location = locationInput.value.trim(); api('/api/approve', { draftId: room.draft.id, text: currentDraftText(), stateUpdates: updates, sceneUpdates: Object.keys(sceneUpdates).length ? sceneUpdates : undefined }).then(ok => { if (ok) $('#contribution').value = '' }) }; const tabId = event.target.closest('[data-tab]')?.dataset.tab; if (tabId) { sidebarTab = tabId; render(room) }; const loreEntry = event.target.closest('.lore-entry'); if (loreEntry) openLoreEditor(Number(loreEntry.dataset.lore)); if (event.target.id === 'lore-add') openLoreEditor(-1); const archiveLoad = event.target.closest('[data-archive-load]')?.dataset.archiveLoad; if (archiveLoad) loadArchive(archiveLoad); const archiveDelete = event.target.closest('[data-archive-delete]')?.dataset.archiveDelete; if (archiveDelete) deleteArchive(archiveDelete) })
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
function setInspectorTab(tab) { document.querySelectorAll('[data-inspector-tab]').forEach(button => button.classList.toggle('active', button.dataset.inspectorTab === tab)); document.querySelectorAll('[data-inspector-panel]').forEach(panel => { panel.hidden = panel.dataset.inspectorPanel !== tab }) }
document.addEventListener('click', event => { const button = event.target.closest('[data-inspector-tab]'); if (button) setInspectorTab(button.dataset.inspectorTab) })
function updateInspectorModels() { const provider = providers.find(item => item.id === $('#inspector-provider').value); $('#inspector-model').innerHTML = `<option value="">使用默认模型</option>${(provider?.models ?? []).map(model => `<option value="${escape(model)}">${escape(model)}</option>`).join('')}` }
$('#inspector-provider').onchange = updateInspectorModels
function formatTimelineForEdit(role) {
  const blocks = []
  for (const [label, events] of Object.entries(role.memoryTimeline ?? {})) {
    if (!events?.length) continue
    blocks.push(`【${label}】\n${events.map(event => `- ${event}`).join('\n')}`)
  }
  return blocks.join('\n')
}
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
    // 不符合「【时间标签】」格式的行（如没有分桶头就直接写记忆）一律归入「未标注时间」桶，避免被静默丢弃
    ensure(current ?? '未标注时间').push(trimmed.replace(/^-\s*/, ''))
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
  ['#inspector-self-model', '#inspector-goals', '#inspector-memory', '#inspector-delete', '#inspector-sync-story', '#inspector-impression-add', '#inspector-avatar-upload', '#inspector-avatar-url'].forEach(selector => { const el = $(selector); if (el) el.disabled = on })
  document.querySelectorAll('#role-modal .impression-row input').forEach(input => { input.disabled = on })
  document.querySelectorAll('#role-modal .impression-row .impression-del').forEach(button => { button.disabled = on })
}
function openInspector(roleId) { inspectedRole = room.roles.find(role => role.id === roleId); if (!inspectedRole) return; storyEditRoleIndex = null; $('#inspector-story-fields').hidden = true; $('#role-modal-title').textContent = `${inspectedRole.name} 角色设置`; $('#inspector-role-id').value = roleId; $('#inspector-provider').innerHTML = `<option value="">使用默认</option>${providers.map(provider => `<option value="${escape(provider.id)}">${escape(provider.name)}</option>`).join('')}`; $('#inspector-provider').value = inspectedRole.providerId ?? ''; updateInspectorModels(); $('#inspector-model').value = inspectedRole.modelOverride ?? ''; $('#inspector-thinking').value = inspectedRole.thinkingStrength ?? 'standard'; $('#inspector-self-model').value = inspectedRole.selfModel; $('#inspector-goals').value = (inspectedRole.goals ?? []).join('\n'); $('#inspector-memory').value = formatTimelineForEdit(inspectedRole); renderImpressionsList(); $('#inspector-avatar-preview').src = inspectedRole.portraitRef; $('#inspector-avatar-preview').onerror = function () { this.onerror = null; this.src = '/assets/default.svg' }; // 沉浸模式：角色面板只读
  setInspectorReadOnly(!!room?.autoPublish && storyEditRoleIndex === null);
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
      role.portraitRef = $('#inspector-story-avatar').value.trim() || '/assets/default.svg'
      role.currentState = $('#inspector-story-state').value
      role.selfModel = $('#inspector-self-model').value
      role.goals = collectGoalsFromEdit()
      role.memoryTimeline = parseTimelineFromEdit($('#inspector-memory').value)
      role.impressions = impressions
    }
    storyEditRoleIndex = null
    closeInspectorModals()
    renderStoryRoles()
    return
  }
  const parsed = parseTimelineFromEdit($('#inspector-memory').value)
  api('/api/roles/intervene', { roleId: $('#inspector-role-id').value, selfModel: $('#inspector-self-model').value, memoryTimeline: JSON.stringify(parsed), providerId: $('#inspector-provider').value, modelOverride: $('#inspector-model').value, impressions: JSON.stringify(impressions), goals: JSON.stringify(collectGoalsFromEdit()), thinkingStrength: $('#inspector-thinking').value }).then(ok => { if (ok) closeInspectorModals() })
}
$('#inspector-close').onclick = () => closeInspectorModals()
// 左侧肖像面板已并入 #role-modal，单独关闭按钮已移除
$('#inspector-sync-story').onclick = event => {
  event.preventDefault()
  const roleId = $('#inspector-role-id').value
  const storyId = room?.storyId
  if (!storyId) { alert('未知当前剧本'); return }
  const role = room.roles.find(item => item.id === roleId)
  if (!role) return
  if (!confirm(`把「${role.name}」的角色卡（人设/记忆/在场/头像/模型）写回初始剧本「${storyId}」？`)) return
  api('/api/story/sync-role', { storyId, roleId }).then(ok => { if (ok) alert('已同步该角色到初始剧本') })
}
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
      const ok = await api('/api/roles/avatar', { roleId, dataUrl: String(reader.result) })
      if (ok) { $('#inspector-avatar-preview').src = ok.portraitRef ?? $('#inspector-avatar-preview').src; refreshRoom() }
    } finally { event.target.value = '' }
  }
  reader.readAsDataURL(file)
}
$('#inspector-avatar-url').onclick = async () => {
  const url = prompt('输入图片 URL（将下载为角色头像）：')
  if (!url || !url.trim()) return
  const roleId = $('#inspector-role-id').value
  try {
    const ok = await api('/api/roles/avatar', { roleId, url: url.trim() })
    if (ok) { $('#inspector-avatar-preview').src = ok.portraitRef ?? $('#inspector-avatar-preview').src; refreshRoom() }
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
$('#new-role-avatar-file').onchange = event => {
  const file = event.target.files?.[0]
  if (!file) return
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { alert('仅支持 png / jpeg / gif / webp 图片。'); event.target.value = ''; return }
  const reader = new FileReader()
  reader.onload = () => {
    pendingCreateAvatar = String(reader.result)
    $('#new-role-avatar-preview').src = pendingCreateAvatar
    event.target.value = ''
  }
  reader.readAsDataURL(file)
}
$('#new-role-avatar-url').onclick = () => {
  const url = prompt('输入图片 URL（将直接作为该角色的肖像地址）：')
  if (!url || !url.trim()) return
  pendingCreateAvatar = url.trim()
  $('#new-role-avatar-preview').src = pendingCreateAvatar
}
$('#create-role-save').onclick = event => {
  event.preventDefault()
  const name = $('#new-role-name').value.trim()
  const selfModel = $('#new-role-self-model').value.trim()
  if (!name) { alert('名称不能为空。'); return }
  if (!selfModel) { alert('人设不能为空。'); return }
  const payload = { name, selfModel, presence: $('#new-role-presence').value, memoryTimeline: JSON.stringify(parseTimelineFromEdit($('#new-role-memory').value)), portraitRef: pendingCreateAvatar ?? '/assets/default.svg', goals: JSON.stringify(collectGoalsInput('#new-role-goals')) }
  const currentState = $('#new-role-state').value.trim()
  if (currentState) payload.currentState = currentState
  api('/api/roles/create', payload).then(ok => { if (ok) $('#create-role-modal').close() })
}
$('#sync-roles').onclick = event => { event.preventDefault(); api('/api/story/sync-roles', { storyId: $('#story-select').value }).then(ok => { if (ok) alert('已同步到初始剧本') }) }
const debugEvents = new EventSource('/api/debug-events'); debugEvents.addEventListener('summary', event => { const item = JSON.parse(event.data); const stream = $('#debug-stream'); stream.textContent += `[${new Date(item.at).toLocaleTimeString()}] ${item.text}\n` })
async function bootApp() {
  try {
    const roomResponse = await fetch('/api/room')
    if (!roomResponse.ok) throw new Error(`Room request failed: ${roomResponse.status}`)
    render(await roomResponse.json())
  } catch (error) {
    console.error('[StageCraft] initial room load failed', error)
    return
  }
  // 非核心辅助接口失败不应阻断旧 UI 的操作能力。
  await Promise.allSettled([loadStories(), loadProviders(), coreInteractionPanel.start()])
}
bootApp()
const events = new EventSource('/api/events'); events.addEventListener('room', event => { try { render(JSON.parse(event.data)) } catch (error) { console.error('[StageCraft] room event render failed', error) } })
// Core Event 通道先只更新客户端缓存；旧 RoomSnapshot SSE 继续驱动现有页面，保证兼容。
coreClient.subscribe(event => {
  if (event.revision == null || !coreClient.view) return
  if (event.type === 'state.changed' || event.type === 'workflow.changed' || event.type === 'interaction.created') {
    coreClient.getView().catch(() => {})
  }
})

// ── 思维链 SSE 订阅与设置 ──
const thinkingEvents = new EventSource('/api/thinking-events')
thinkingEvents.addEventListener('thinking', event => { try { applyThinkingEvent(JSON.parse(event.data)) } catch (error) { console.error('[StageCraft] thinking event failed', error) } })
$('#show-thinking').checked = thinkingPrefs.show
$('#auto-expand-thinking').checked = thinkingPrefs.autoExpand
$('#show-thinking').addEventListener('change', event => { thinkingPrefs.show = event.target.checked; localStorage.setItem(THINKING_PREFS_KEY, JSON.stringify(thinkingPrefs)); renderThinkingPanel(); if (room) render(room) })
$('#auto-expand-thinking').addEventListener('change', event => { thinkingPrefs.autoExpand = event.target.checked; localStorage.setItem(THINKING_PREFS_KEY, JSON.stringify(thinkingPrefs)); renderThinkingPanel(); if (room) render(room) })

// ── 标题栏中部横幅：八股文循环播放（15s 一换，八股三词加粗换色）──
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
    el.style.opacity = '0'
    setTimeout(() => {
      const html = TAGLINES[idx % TAGLINES.length]
      el.innerHTML = html
      el.title = html.replace(/<[^>]+>/g, '')
      el.style.opacity = '1'
      idx++
    }, 350)
  }
  swap()
  setInterval(swap, 15000)
})()
