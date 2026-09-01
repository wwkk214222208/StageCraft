/**
 * Desktop v2 recovery server (`/admin/v2`).
 *
 * When the v2 Host fails to boot (bad Core, invalid plan, handshake failure)
 * the desktop entry falls back here instead of the v1 plugin fallback: the v1
 * page cannot manage v2 components. This server deliberately imports only the
 * pure v2 contract/plan modules — never the v1 runtime or the v2 Host — so it
 * stays available no matter how broken the plan is. It repairs the persisted
 * plan only: disable a plugin, or clear the plan entirely (next start selects
 * the v1 composition root, which acts as the desktop rescue path).
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { componentManifestHash, validateComponentManifest } from './component-validation.ts'
import { buildComponentLaunchPlan, validateComponentLaunchPlan } from './launch-plan.ts'
import type { ComponentLaunchPlan, ComponentManifest } from './component-contract.ts'
import { isLoopbackHost } from '../remote-access.ts'

export interface V2DesktopRecoveryOptions {
  userDataRoot: string
  planPath?: string
  componentsRoot?: string
  host?: string
  port?: number
  /** Startup failure message surfaced on the recovery page. */
  failure?: string
}

export interface V2DesktopRecoveryServer {
  readonly server: Server
  readonly planPath: string
  close(): Promise<void>
}

const MAX_BODY_BYTES = 64 * 1024

export async function startV2DesktopRecoveryServer(options: V2DesktopRecoveryOptions): Promise<V2DesktopRecoveryServer> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 8787
  if (!isLoopbackHost(host)) throw new Error(`v2 recovery server only permits loopback host (received ${host})`)
  const planPath = resolve(options.planPath ?? join(options.userDataRoot, 'data', 'component-launch-plan.v2.json'))
  const componentsRoot = resolve(options.componentsRoot ?? join(options.userDataRoot, 'components'))

  const readPlan = (): ComponentLaunchPlan | undefined => {
    if (!existsSync(planPath)) return undefined
    try { return JSON.parse(readFileSync(planPath, 'utf8')) as ComponentLaunchPlan } catch { return undefined }
  }
  const readManifest = (id: string, version: string): ComponentManifest | undefined => {
    const manifestPath = safeJoin(componentsRoot, join(id, version), 'manifest.json')
    if (!manifestPath || !existsSync(manifestPath)) return undefined
    try { return JSON.parse(readFileSync(manifestPath, 'utf8')) as ComponentManifest } catch { return undefined }
  }
  const writePlan = (plan: ComponentLaunchPlan): void => {
    mkdirSync(dirname(planPath), { recursive: true })
    const temporary = `${planPath}.tmp`
    writeFileSync(temporary, JSON.stringify(plan, null, 2), 'utf8')
    renameSync(temporary, planPath)
  }
  /** Rebuild a valid plan (fresh hashes) from the manifests on disk. */
  const rebuildPlan = (current: ComponentLaunchPlan, keep: (id: string) => boolean): ComponentLaunchPlan => {
    const core = readManifest(current.core.id, current.core.version)
    if (!core) throw new Error(`core manifest is missing: ${current.core.id}@${current.core.version}`)
    const plugins: ComponentManifest[] = []
    for (const selection of current.plugins) {
      if (!keep(selection.id)) continue
      const manifest = readManifest(selection.id, selection.version)
      if (!manifest) throw new Error(`plugin manifest is missing: ${selection.id}@${selection.version}`)
      plugins.push(manifest)
    }
    const plan = buildComponentLaunchPlan({ core, plugins, hostApiVersion: current.hostApiVersion, stateSchemaVersion: current.stateSchemaVersion })
    const errors = validateComponentLaunchPlan(plan, [core, ...plugins])
    if (errors.length) throw new Error(`rebuilt plan is invalid: ${errors.join('; ')}`)
    return plan
  }

  const page = (): string => {
    const plan = readPlan()
    const rows = plan ? [plan.core, ...plan.plugins].map(selection => {
      const manifest = readManifest(selection.id, selection.version)
      const errors = manifest ? validateComponentManifest(manifest) : ['manifest missing on disk']
      const isCore = selection.id === plan.core.id
      const disable = isCore ? '' : `<form method="post" action="/admin/v2/disable-plugin" style="display:inline"><input type="hidden" name="id" value="${escapeHtml(selection.id)}"><button>停用</button></form>`
      return `<tr><td>${escapeHtml(selection.id)}</td><td>${escapeHtml(selection.version)}</td><td>${isCore ? 'core（不可停用）' : 'plugin'}</td><td>${manifest ? (errors.length ? escapeHtml(errors.join('; ')) : 'ok') : escapeHtml('manifest missing on disk')}</td><td>${disable}</td></tr>`
    }).join('') : '<tr><td colspan="5">launch plan 不存在（清除后下次启动将回到 v1）</td></tr>'
    return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>StageCraft v2 恢复模式</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; max-width: 48rem">
<h1>v2 恢复模式</h1>
<p>v2 Core 启动失败，计划保持原样未被修改。修复后需重启应用。</p>
${options.failure ? `<pre style="background:#fdd;padding:0.5rem;white-space:pre-wrap">${escapeHtml(options.failure)}</pre>` : ''}
<h2>当前计划（<code>${escapeHtml(planPath)}</code>）</h2>
<table border="1" cellpadding="4" cellspacing="0"><tr><th>id</th><th>version</th><th>类型</th><th>manifest 校验</th><th>操作</th></tr>${rows}</table>
<form method="post" action="/admin/v2/clear-plan" onsubmit="return confirm('清除 v2 计划并回到 v1 启动链？')"><button>清除 v2 计划（回到 v1 / rescue）</button></form>
<p style="color:#555">停用插件 = 从计划移除该组件并重算 planHash；清除计划 = 删除计划文件，下次启动按无计划处理（v1 组合根）。</p>
</body></html>`
  }

  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1`)
      if (request.method === 'GET' && url.pathname === '/admin/v2') { respond(response, 200, 'text/html; charset=utf-8', page()); return }
      const body = request.method === 'POST' ? await readFormBody(request) : undefined
      if (request.method === 'POST' && url.pathname === '/admin/v2/disable-plugin') {
        const id = String(body?.get('id') ?? '')
        const plan = readPlan()
        if (!plan) throw new Error('launch plan is missing')
        if (!id || id === plan.core.id) throw new Error('a valid plugin id is required')
        writePlan(rebuildPlan(plan, pluginId => pluginId !== id))
        respond(response, 303, 'text/plain; charset=utf-8', 'plugin disabled'); return
      }
      if (request.method === 'POST' && url.pathname === '/admin/v2/clear-plan') {
        rmSync(planPath, { force: true })
        respond(response, 303, 'text/plain; charset=utf-8', 'plan cleared'); return
      }
      respond(response, 404, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: { code: 'not_found' } }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      respond(response, 400, 'text/plain; charset=utf-8', `recovery action failed: ${message}`)
    }
  })
  await new Promise<void>((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(port, host, () => resolveListen()) })
  return {
    server, planPath,
    close: () => new Promise(resolveClose => { server.close(() => resolveClose()) }),
  }
}

function respond(response: import('node:http').ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  response.end(body)
}

async function readFormBody(request: import('node:http').IncomingMessage): Promise<URLSearchParams | undefined> {
  const chunks: Buffer[] = []; let total = 0
  for await (const chunk of request) { total += chunk.length; if (total > MAX_BODY_BYTES) throw new Error('request body too large'); chunks.push(Buffer.from(chunk)) }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? new URLSearchParams(raw) : undefined
}

function safeJoin(root: string, child: string, file: string): string | undefined {
  if (isAbsolute(child)) return undefined
  const candidate = resolve(root, child, file)
  const rel = relative(resolve(root), candidate)
  if (rel.startsWith(`..${sep}`)) return undefined
  return candidate
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}

// componentManifestHash is re-exported for parity checks in tests without
// importing anything beyond the pure validation layer.
export { componentManifestHash }
