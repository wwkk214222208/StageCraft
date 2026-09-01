// 真机插件面板验证（CDP 驱动主 WebView，FOA-AL00 / API 31）
// 用法：node scripts/device-plugin-verify.mjs <wsUrl>
const wsUrl = process.argv[2]
if (!wsUrl) { console.error('usage: node scripts/device-plugin-verify.mjs <wsUrl>'); process.exit(1) }

const ws = new WebSocket(wsUrl)
let seq = 0
const pending = new Map()
const evaluate = (expression) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

ws.onmessage = event => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.exception?.description ?? 'evaluate exception'))
    else resolve(msg.result?.result?.value)
  }
}
ws.onerror = error => { console.error('WS error:', error.message ?? error); process.exit(1) }

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' —— ' + detail : ''}`) }

ws.onopen = async () => {
  try {
    // ① native 桥存在 + catalog 形状（含本次新增 kind/title 透传）
    const bridge = await evaluate(`typeof StageCraftNative !== 'undefined' && typeof StageCraftNative.getPluginState === 'function'`)
    check('① StageCraftNative.getPluginState 可用', bridge === true)

    const state = await evaluate(`JSON.parse(StageCraftNative.getPluginState())`)
    const catalog = Array.isArray(state.catalog) ? state.catalog : []
    check('② catalog 4 条（构建期 manifest）', catalog.length === 4, `got ${catalog.length}`)
    check('③ catalog 携带 kind/title（本次透传）', catalog.every(p => p.kind && p.title), catalog.map(p => p.id + '/' + p.kind).join(', '))
    check('④ 初始全启用（desired 缺省 enabled）', catalog.every(p => state.desired?.[p.id] !== false), JSON.stringify(state.desired ?? {}))
    check('⑤ effective 与 desired 一致', Array.isArray(state.effective) && state.effective.length === 4, JSON.stringify(state.effective))

    // ② 前端面板 DOM + 渲染（走 app.js 的 native 通道代码路径）
    const hasModal = await evaluate(`!!document.getElementById('plugin-modal') && !!document.getElementById('plugin-settings')`)
    check('⑥ 插件面板 DOM（index.html 生成进 local.html）', hasModal === true)
    await evaluate(`document.getElementById('plugin-settings').click()`)
    await sleep(1200)
    const listHtml = await evaluate(`document.getElementById('plugin-list')?.innerHTML ?? ''`)
    const rendered = /stagecraft\.solution/.test(listHtml) && /启用|停用/.test(listHtml)
    check('⑦ 面板渲染出插件列表（native 通道）', rendered === true, `${listHtml.length} chars`)

    // ③ 停用 solution → 持久化 → 重启 Core → 新 plan 生效（health 字段名见 CoreHealth.pluginSetHash）
    const hashBefore = await evaluate(`fetch('/api/core/health').then(r => r.json()).then(h => h.pluginSetHash)`)
    const disable = await evaluate(`JSON.parse(StageCraftNative.setPluginEnabled('stagecraft.solution', false))`)
    check('⑧ setPluginEnabled 返回 restartRequired', disable.ok === true && disable.restartRequired === true, JSON.stringify(disable))
    const desiredOff = await evaluate(`JSON.parse(StageCraftNative.getPluginState()).desired['stagecraft.solution']`)
    check('⑨ 停用意图已持久化（主进程存储）', desiredOff === false)

    await evaluate(`fetch('/api/host/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })`)
    // 等待 Core 重启 + 页面可用（health 轮询最多 30s）
    let hashAfter = null
    for (let i = 0; i < 30; i++) {
      await sleep(1000)
      try { hashAfter = await evaluate(`fetch('/api/core/health').then(r => r.json()).then(h => h.pluginSetHash).catch(() => null)`) } catch { /* restart window */ }
      if (hashAfter && hashAfter !== hashBefore) break
    }
    check('⑩ 重启后 health 可达且 pluginSet 变化（新 launch plan 生效）', typeof hashAfter === 'string' && hashAfter !== hashBefore, `${hashBefore} → ${hashAfter}`)
    const effectiveAfter = await evaluate(`JSON.parse(StageCraftNative.getPluginState()).effective`)
    check('⑪ 重启后 effective 不含已停用插件', Array.isArray(effectiveAfter) && !effectiveAfter.includes('stagecraft.solution'), JSON.stringify(effectiveAfter))

    // ④ 恢复启用 → 再重启 → 回到全启用
    await evaluate(`StageCraftNative.setPluginEnabled('stagecraft.solution', true)`)
    await evaluate(`fetch('/api/host/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })`)
    let restored = null
    for (let i = 0; i < 30; i++) {
      await sleep(1000)
      try { restored = await evaluate(`JSON.parse(StageCraftNative.getPluginState()).effective`) } catch { /* restart window */ }
      if (Array.isArray(restored) && restored.includes('stagecraft.solution')) {
        try { const h = await evaluate(`fetch('/api/core/health').then(r => r.json()).then(h => h.status)`) ; if (h === 'ready') break } catch { /* wait */ }
      }
    }
    check('⑫ 恢复启用并重启后 effective 含 solution', Array.isArray(restored) && restored.includes('stagecraft.solution'), JSON.stringify(restored))
    await evaluate(`document.getElementById('plugin-modal')?.close()`)

    const failed = results.filter(r => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
    process.exit(failed.length ? 1 : 0)
  } catch (error) {
    console.error('验证中断:', error.message)
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} 项通过（中断前）`)
    process.exit(1)
  }
}
