/**
 * DeepPlugin Harness 独立入口（npm run dev / npm start）。
 * 启动逻辑与 dsh-rp（Cordis 插件壳）共用：见 src/app-boot.ts 的 startTavern()。
 */
import { startTavern } from './app-boot.ts'

startTavern()
