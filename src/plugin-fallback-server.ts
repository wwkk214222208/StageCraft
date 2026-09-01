/**
 * 桌面恢复模式兜底服务器（§3.5 / D2）：startTavern 整体失败时，server.ts 用本模块
 * 起一个极简 HTTP 服务，让人仍能进插件管理（查看隔离原因、停用问题插件、重启恢复）。
 *
 * 边界（契约测试强制）：本文件及其依赖只允许 node:http / plugin-admin / plugin-config-store /
 * plugin-manifests——不得 import 主运行时（app-boot / store / core runtime / room-runtime）。
 */

import { createServer, type Server } from 'node:http'
import { PluginAdminService, desktopPluginConfigFilePath, handlePluginAdminApi } from './plugin-admin.ts'
import { createNodeFilePluginConfigStore } from './plugin-config-store.ts'
import { DESKTOP_BUILTIN_PLUGIN_MANIFESTS } from './plugin-manifests.ts'

export interface PluginFallbackServerOptions {
  root: string
  userDataRoot?: string
  dataDir?: string
  port: number
  host?: string
}

export async function startPluginFallbackServer(options: PluginFallbackServerOptions): Promise<Server> {
  const configStore = createNodeFilePluginConfigStore(desktopPluginConfigFilePath(options))
  const admin = new PluginAdminService(configStore, DESKTOP_BUILTIN_PLUGIN_MANIFESTS)
  const host = options.host ?? '127.0.0.1'
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    try {
      if (url.pathname === '/' && request.method === 'GET') {
        response.writeHead(302, { Location: '/admin/plugins' })
        response.end()
        return
      }
      let body: unknown
      if (url.pathname === '/api/plugins/enable' && request.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { body = undefined }
      }
      const matched = handlePluginAdminApi(admin, { method: request.method ?? 'GET', pathname: url.pathname, body })
      if (!matched) {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: 'Not found' }))
        return
      }
      if (typeof matched.body === 'string') {
        response.writeHead(matched.status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(matched.body)
        return
      }
      response.writeHead(matched.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(matched.body))
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, host, () => resolve())
  })
  return server
}
