/**
 * StageCraft 独立入口（npm run dev / npm start）。
 * 启动逻辑与 dsh-rp（Cordis 插件壳）共用：见 src/app-boot.ts 的 startTavern()。
 */
import os from 'node:os'
import { join } from 'node:path'
import { startTavern } from './app-boot.ts'

const userDataRoot = process.env.STAGECRAFT_USER_DATA || (() => {
  const base = process.env.APPDATA || (process.platform === 'darwin' ? join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'))
  return join(base, 'stagecraft')
})()

await startTavern({ userDataRoot })
