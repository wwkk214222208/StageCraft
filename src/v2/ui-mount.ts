/**
 * Reference UI mount page for the desktop v2 Host (`GET /api/v2/ui`).
 *
 * The page imports a selected UI entry as a browser ESM module, drives its
 * `render({ surface, view }, context)` with a minimal DOM surface (text /
 * stack / button views), and dispatches button `action`s back through
 * `/api/v2/core/invoke` with the injected loopback token. It is a developer
 * reference, not the final UI framework integration.
 */
export function renderUiMountPage(authToken: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>StageCraft v2 UI mount</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 42rem; }
  header { display: flex; gap: 1rem; align-items: center; margin-bottom: 1rem; }
  #surface { border: 1px solid #ccc; border-radius: 6px; padding: 1rem; min-height: 3rem; }
  .error { color: #b00020; white-space: pre-wrap; }
  button { margin: 0.25rem 0.5rem 0.25rem 0; }
</style>
</head>
<body>
<header>
  <h1 style="margin:0;font-size:1.2rem">v2 UI mount</h1>
  <select id="entry"></select>
  <button id="mount">Mount</button>
  <button id="unmount" disabled>Dispose</button>
</header>
<div id="surface"></div>
<pre id="log"></pre>
<script>
(function () {
  'use strict'
  var TOKEN = ${JSON.stringify(authToken)}
  var mounted = null
  var surfaceId = 'v2-ui-mount'

  function log(message, isError) {
    var line = document.createElement('div')
    if (isError) line.className = 'error'
    line.textContent = message
    document.getElementById('log').textContent = ''
    document.getElementById('log').appendChild(line)
  }

  function renderView(view, container) {
    if (!view) return
    if (view.type === 'text') { container.appendChild(document.createTextNode(String(view.text ?? ''))) ; return }
    if (view.type === 'stack') { (view.children || []).forEach(function (child) { var wrapper = document.createElement('div'); renderView(child, wrapper); container.appendChild(wrapper) }); return }
    if (view.type === 'button') {
      var button = document.createElement('button')
      button.textContent = String(view.label ?? view.action ?? '')
      button.addEventListener('click', function () { dispatchAction(view.action) })
      container.appendChild(button)
      return
    }
    log('unsupported view type: ' + JSON.stringify(view), true)
  }

  function paint(view) {
    var surface = document.getElementById('surface')
    surface.textContent = ''
    renderView(view, surface)
  }

  function dispatchAction(action) {
    if (!action) return
    fetch('/api/v2/core/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-stagecraft-token': TOKEN },
      body: JSON.stringify({ operation: String(action), input: {} }),
    }).then(function (response) { return response.json() }).then(function (body) {
      if (!body || body.ok !== true) throw new Error((body && body.error && body.error.message) || 'invoke failed')
      if (body.result && body.result.type) paint(body.result)
      else log('action result: ' + JSON.stringify(body.result))
    }).catch(function (error) { log('action failed: ' + (error.message || error), true) })
  }

  function makeSurface() {
    return {
      id: surfaceId,
      render: function (view) { paint(view); return { surfaceId: surfaceId, view: view } },
    }
  }

  function makeContext(entry) {
    return {
      apiVersion: '0.1',
      pluginId: entry.id,
      config: {},
      log: function (level, message, details) { log('[' + level + '] ' + message + ' ' + JSON.stringify(details || null)) },
    }
  }

  async function mount() {
    var selector = document.getElementById('entry')
    var entry = JSON.parse(selector.value)
    var surface = document.getElementById('surface')
    surface.textContent = 'loading…'
    try {
      if (mounted && mounted.plugin && typeof mounted.plugin.dispose === 'function') {
        try { await mounted.plugin.dispose(makeContext(mounted.entry)) } catch (disposeError) { /* keep mounting */ }
      }
      var module = await import(entry.url)
      var plugin = module.default
      if (!plugin || typeof plugin.render !== 'function') throw new Error('UI entry has no render() default export')
      var result = await plugin.render({ surface: makeSurface() }, makeContext(entry))
      paint(result && result.view)
      mounted = { entry: entry, plugin: plugin }
      document.getElementById('unmount').disabled = false
      log('mounted ' + entry.id + '@' + entry.version)
    } catch (error) {
      surface.textContent = ''
      log('mount failed: ' + (error.message || error), true)
    }
  }

  async function unmount() {
    if (!mounted) return
    try {
      if (typeof mounted.plugin.dispose === 'function') await mounted.plugin.dispose(makeContext(mounted.entry))
      document.getElementById('surface').textContent = ''
      log('disposed ' + mounted.entry.id)
    } catch (error) { log('dispose failed: ' + (error.message || error), true) }
    mounted = null
    document.getElementById('unmount').disabled = true
  }

  fetch('/api/v2/core/status').then(function (response) { return response.json() }).then(function (status) {
    var selector = document.getElementById('entry')
    var entries = status.uiEntries || []
    if (!entries.length) { log('no UI entries in the current launch plan', true); return }
    entries.forEach(function (entry) {
      var option = document.createElement('option')
      option.value = JSON.stringify(entry)
      option.textContent = entry.id + '@' + entry.version
      selector.appendChild(option)
    })
  }).catch(function (error) { log('status failed: ' + (error.message || error), true) })

  document.getElementById('mount').addEventListener('click', mount)
  document.getElementById('unmount').addEventListener('click', unmount)
})()
</script>
</body>
</html>
`
}
