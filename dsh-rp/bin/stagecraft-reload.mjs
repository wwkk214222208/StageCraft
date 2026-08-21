#!/usr/bin/env node
/**
 * stagecraft-reload —— 触发 StageCraft worker 热重载（不重启 DSH）。
 *
 * 构建完 dsh-rp（node dsh-rp/scripts/build.mjs 并同步 dist）后执行：
 *   node dsh-rp/bin/stagecraft-reload.mjs [--port 8899] [reason]
 *
 * 通过 DSH 主进程（webServer，默认 8899）的 POST /api/stagecraft/reload
 * 调用 stagecraftDebug.restart()，重建 sandboxed worker 加载新代码。
 */
const port = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : Number(process.env.DSH_PORT ?? 8899)
const reason = process.argv.filter(arg => !arg.startsWith('-') && !/^\d+$/.test(arg))[0] ?? 'cli-reload'
const base = `http://127.0.0.1:${port}`

async function main() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(`${base}/api/stagecraft/reload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
      signal: controller.signal,
    })
    const text = await response.text()
    let data = {}
    try { data = text ? JSON.parse(text) : {} } catch { /* keep {} */ }
    if (!response.ok) {
      console.error(`stagecraft reload failed (HTTP ${response.status}): ${data.error ?? text}`)
      process.exitCode = 1
      return
    }
    console.log(`stagecraft reloaded: ${JSON.stringify(data)}`)
  } catch (error) {
    console.error(`stagecraft reload request failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
}

main()
