/**
 * StageCraft 独立入口（npm run dev / npm start）。
 * 启动逻辑与 dsh-rp（Cordis 插件壳）共用：见 src/app-boot.ts 的 startTavern()。
 *
 * 手机远程访问（安卓配对）：
 *   RP_REMOTE=1            启用远程访问（配对码 / 非本机授权）
 *   HOST                   监听地址；启用远程时缺省为 0.0.0.0（否则保持 127.0.0.1）
 *   RP_REMOTE_PAIRING_TTL_MS  配对码有效期（毫秒，缺省 5 分钟）
 *   RP_REMOTE_SESSION_TTL_MS  会话 token 有效期（毫秒，缺省 12 小时）
 */
import os from 'node:os'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { startTavern } from './app-boot.ts'
import { startPluginFallbackServer } from './plugin-fallback-server.ts'
import { startV2DesktopHost } from './v2/desktop-host.ts'
import { startDesktopEntry } from './v2/desktop-entry.ts'
import { startV2DesktopRecoveryServer } from './v2/desktop-recovery.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const userDataRoot = process.env.STAGECRAFT_USER_DATA || (() => {
  const base = process.env.APPDATA || (process.platform === 'darwin' ? join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'))
  return join(base, 'stagecraft')
})()

const remoteEnabled = ['1', 'true', 'yes'].includes(String(process.env.RP_REMOTE ?? '').trim().toLowerCase())
const parseTtl = (value: string | undefined): number | undefined => {
  const parsed = Number(value ?? '')
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
const host = process.env.HOST ?? (remoteEnabled ? '0.0.0.0' : undefined)
const remoteAccess = remoteEnabled
  ? {
      enabled: true,
      ...(parseTtl(process.env.RP_REMOTE_PAIRING_TTL_MS) ? { pairingTtlMs: parseTtl(process.env.RP_REMOTE_PAIRING_TTL_MS)! } : {}),
      ...(parseTtl(process.env.RP_REMOTE_SESSION_TTL_MS) ? { sessionTtlMs: parseTtl(process.env.RP_REMOTE_SESSION_TTL_MS)! } : {}),
    }
  : undefined
const port = Number(process.env.PORT ?? '8787')

try {
  await startDesktopEntry({
    planPath: join(userDataRoot, 'data', 'component-launch-plan.v2.json'),
    legacyOptions: { userDataRoot, ...(host ? { host } : {}), ...(remoteAccess ? { remoteAccess } : {}) },
    v2Options: { userDataRoot, ...(host ? { host } : {}), port },
    hasPlan: existsSync,
    startLegacy: startTavern,
    startV2: startV2DesktopHost,
  })
} catch (error) {
  // D2 兜底（§3.5）：主运行时失败也必须能进插件管理（查看隔离原因 / 停用问题插件），
  // 否则"坏插件 → 起不来 → 进不去管理关掉它"死锁。兜底服务器只依赖 PluginConfigStore。
  console.error('[StageCraft] 主运行时启动失败：', error instanceof Error ? error.stack ?? error.message : error)
  try {
    const fallbackPort = Number.isInteger(port) && port > 0 ? port : 8787
    const v2PlanPath = join(userDataRoot, 'data', 'component-launch-plan.v2.json')
    if (existsSync(v2PlanPath)) {
      // v2 计划存在时走 v2 恢复入口：v1 兜底页不认识 v2 组件，修不了 v2 计划。
      const recovery = await startV2DesktopRecoveryServer({ userDataRoot, port: fallbackPort, failure: error instanceof Error ? error.message : String(error) })
      const address = recovery.server.address()
      const actualPort = typeof address === 'object' && address ? address.port : fallbackPort
      console.error(`[StageCraft] 已进入 v2 恢复模式：打开 http://127.0.0.1:${actualPort}/admin/v2 查看启动失败原因、停用问题插件或清除 v2 计划，修改后重启应用。`)
      return
    }
    const server = await startPluginFallbackServer({ root, userDataRoot, port: fallbackPort, ...(host && !remoteEnabled ? { host: '127.0.0.1' } : {}) })
    const address = server.address()
    const actualPort = typeof address === 'object' && address ? address.port : fallbackPort
    console.error(`[StageCraft] 已进入恢复模式：打开 http://127.0.0.1:${actualPort}/admin/plugins 查看插件状态并停用问题插件，修改后重启应用。`)
  } catch (fallbackError) {
    console.error('[StageCraft] 恢复模式服务器启动失败：', fallbackError instanceof Error ? fallbackError.message : fallbackError)
    process.exitCode = 1
  }
}
