/**
 * PluginAdminService —— 插件管理层（D2：独立于 Core）。
 *
 * 只操作"清单 + 配置 + 隔离记录"三样（都存 PluginConfigStore，Core 从未启动时仍可读写）；
 * 不得 import CoreRuntimeSkeleton / Store / HTTP 服务器（契约测试强制）。
 * HTTP 处理用纯请求/响应对象：桌面 server 与 server.ts 兜底入口共用，调用方各自适配 node:http。
 *
 * D1：无热加载——setEnabled 只写启用意图并重生成 launch plan，改动重启后生效。
 * 存档依赖判定（§7.4）按 2026-09-01 拍板：只产出提示信息，不做放行阻断。
 */

import { join } from 'node:path'
import type { PluginConfigStore, PluginDependencySnapshot, PluginLaunchPlan, PluginLoadReport, PluginManifest, PluginState, QuarantineRecord } from './plugin-contract.ts'
import { buildPluginLaunchPlan, validateArchiveDependencies } from './plugin-bootstrap.ts'

/**
 * 桌面插件配置文件路径（与 app-boot 的 dataDir 解析完全一致；server.ts 兜底入口用同一
 * helper 定位同一份 plugins.json，避免两处路径漂移）。
 */
export function desktopPluginConfigFilePath(options: { root: string; userDataRoot?: string; dataDir?: string }): string {
  const dataDir = options.userDataRoot ? join(options.userDataRoot, 'data') : options.dataDir ?? join(options.root, 'data')
  return join(dataDir, 'plugins.json')
}

export interface PluginAdminRecord {
  id: string
  version: string
  kind: PluginManifest['kind']
  title: string
  description?: string
  author?: string
  capabilities?: string[]
  state: PluginState
  config?: unknown
  quarantine?: QuarantineRecord
}

export interface PluginAdminState {
  plugins: PluginAdminRecord[]
  /** 本次启动的装载报告（兜底入口无 bootstrap 时为 null）。 */
  report: PluginLoadReport | null
  pluginSetHash: string
}

export interface ArchiveDependencyAdvice {
  recorded: boolean
  missing: string[]
  incompatible: string[]
  message: string
}

export class PluginAdminService {
  private report: PluginLoadReport | null = null
  private readonly configStore: PluginConfigStore
  private readonly manifests: readonly PluginManifest[]
  private readonly stateSchemaVersion: string

  constructor(configStore: PluginConfigStore, manifests: readonly PluginManifest[], stateSchemaVersion = 'unknown') {
    this.configStore = configStore
    this.manifests = manifests
    this.stateSchemaVersion = stateSchemaVersion
  }

  /** 引导层装载完成后回报（兜底入口不调用：只展示持久化状态）。 */
  attachLoadReport(report: PluginLoadReport): void {
    this.report = report
  }

  /** 按 manifest + 持久化配置聚合插件状态（quarantined > disabled > enabled）。 */
  list(): PluginAdminRecord[] {
    const desired = this.configStore.readEnabled()
    const quarantine = new Map(this.configStore.readQuarantine().map(record => [record.pluginId, record]))
    const config = this.configStore.readConfig()
    return [...this.manifests]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(manifest => {
        const record = quarantine.get(manifest.id)
        return {
          id: manifest.id,
          version: manifest.version,
          kind: manifest.kind,
          title: manifest.title,
          ...(manifest.description ? { description: manifest.description } : {}),
          ...(manifest.author ? { author: manifest.author } : {}),
          ...(manifest.capabilities?.length ? { capabilities: manifest.capabilities } : {}),
          state: record ? 'quarantined' : desired[manifest.id] === false ? 'disabled' : 'enabled',
          ...(config[manifest.id] !== undefined ? { config: config[manifest.id] } : {}),
          ...(record ? { quarantine: record } : {}),
        }
      })
  }

  state(): PluginAdminState {
    return {
      plugins: this.list(),
      report: this.report,
      pluginSetHash: this.configStore.readLaunchPlan()?.pluginSetHash ?? '',
    }
  }

  /** 修改启用意图：校验 id 在候选集内；重生成并持久化 launch plan；重启生效。 */
  setEnabled(id: string, enabled: boolean): { ok: true; restartRequired: true } {
    if (!this.manifests.some(manifest => manifest.id === id)) throw new Error(`插件不在候选集内：${id}`)
    this.configStore.writeEnabled(id, enabled)
    this.regenerateLaunchPlan()
    return { ok: true, restartRequired: true }
  }

  /** 重新生成 launch plan 并持久化（desired − quarantined）。 */
  regenerateLaunchPlan(): PluginLaunchPlan {
    const plan = buildPluginLaunchPlan({
      manifests: this.manifests,
      desiredEnabled: this.configStore.readEnabled(),
      config: this.configStore.readConfig(),
      quarantinedIds: this.configStore.readQuarantine().map(record => record.pluginId),
      stateSchemaVersion: this.stateSchemaVersion,
    })
    this.configStore.writeLaunchPlan(plan)
    return plan
  }

  /**
   * 存档插件依赖建议（§7.4，提示不阻断）：缺失/不兼容都进 message，由 UI 在加载前展示。
   * 存档没有 plugins 字段（旧存档）→ recorded: false，不产生警告。
   */
  archiveDependencyAdvice(snapshot: readonly PluginDependencySnapshot[] | undefined): ArchiveDependencyAdvice {
    if (!Array.isArray(snapshot) || snapshot.length === 0) return { recorded: false, missing: [], incompatible: [], message: '' }
    const verdict = validateArchiveDependencies(snapshot, this.manifests)
    if (verdict.verdict === 'ok') return { recorded: true, missing: [], incompatible: [], message: '' }
    const missing = [...verdict.missing]
    const incompatible = verdict.verdict === 'degraded' ? [] : [...verdict.incompatible]
    const parts: string[] = []
    if (missing.length) parts.push(`本存档依赖的插件在当前环境缺失：${missing.join('、')}`)
    if (incompatible.length) parts.push(`插件版本不兼容：${incompatible.join('；')}`)
    if (verdict.verdict === 'degraded') parts.push('缺失的是可选插件，剧情可能以降级方式继续。')
    else parts.push('继续加载后剧情走向可能与存档产出时不同。')
    return { recorded: true, missing, incompatible, message: parts.join('。') }
  }
}

export interface PluginAdminRequest {
  method: string
  pathname: string
  /** 已解析的 JSON body（无 body 时为 undefined）。 */
  body?: unknown
}

export interface PluginAdminResponse {
  status: number
  body: unknown
}

/** 兜底管理页（不依赖主运行时渲染；Core 挂掉时仍可用）。 */
export const PLUGIN_ADMIN_PAGE_PATH = '/admin/plugins'

export function pluginAdminPageHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StageCraft 插件管理（恢复模式）</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#222}h1{font-size:1.2rem}.plugin{border:1px solid #ddd;border-radius:8px;padding:.75rem 1rem;margin:.5rem 0}.plugin header{display:flex;justify-content:space-between;gap:1rem;align-items:baseline}.state-enabled{color:#166534}.state-disabled{color:#6b7280}.state-quarantined{color:#b91c1c}.meta{color:#6b7280;font-size:.85rem}.quarantine{background:#fef2f2;border-radius:6px;padding:.5rem;margin-top:.5rem;font-size:.85rem}button{padding:.25rem .75rem}.hint{color:#6b7280;font-size:.85rem}</style></head><body><h1>StageCraft 插件管理（恢复模式）</h1><p class="hint">主运行时未能启动；此页面只依赖插件配置存储，可查看装载失败原因并停用问题插件。修改后请重启应用生效。</p><div id="plugins">加载中…</div><script>
async function refresh(){try{const r=await fetch('/api/plugins');const d=await r.json();const box=document.getElementById('plugins');box.innerHTML='';for(const p of d.plugins||[]){const el=document.createElement('div');el.className='plugin';const state=p.state;const btn=state==='enabled'?'停用':'启用';el.innerHTML='<header><strong>'+p.title+'</strong><span class="state-'+state+'">'+({enabled:'启用',disabled:'已停用',quarantined:'被隔离'})[state]+'</span></header><div class="meta">'+p.id+' · v'+p.version+' · '+p.kind+'</div>'+(p.description?'<div class="meta">'+p.description+'</div>':'')+(p.quarantine?'<div class="quarantine">隔离原因：'+p.quarantine.reason+'（阶段 '+p.quarantine.stage+'，'+p.quarantine.at+'）</div>':'')+'<button data-id="'+p.id+'" data-enabled="'+(state==='enabled'?'false':'true')+'">'+btn+'</button>';box.append(el)}}catch(e){document.getElementById('plugins').textContent='读取插件状态失败：'+e.message}}
document.addEventListener('click',async e=>{const b=e.target.closest('button[data-id]');if(!b)return;await fetch('/api/plugins/enable',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:b.dataset.id,enabled:b.dataset.enabled==='true'})});refresh()});
refresh();
</script></body></html>`
}

/** 纯请求/响应对象路由；不匹配返回 undefined（调用方继续自己的分派）。 */
export function handlePluginAdminApi(service: PluginAdminService, request: PluginAdminRequest): PluginAdminResponse | undefined {
  if (request.pathname === PLUGIN_ADMIN_PAGE_PATH && request.method === 'GET') {
    return { status: 200, body: pluginAdminPageHtml() }
  }
  if (request.pathname === '/api/plugins' && request.method === 'GET') {
    return { status: 200, body: service.state() }
  }
  if (request.pathname === '/api/plugins/enable' && request.method === 'POST') {
    const body = (request.body ?? {}) as Record<string, unknown>
    try {
      const id = String(body.id ?? '')
      const result = service.setEnabled(id, body.enabled !== false)
      return { status: 200, body: result }
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
    }
  }
  return undefined
}
