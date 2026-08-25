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
import { join } from 'node:path'
import { startTavern } from './app-boot.ts'

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

await startTavern({ userDataRoot, ...(host ? { host } : {}), ...(remoteAccess ? { remoteAccess } : {}) })
