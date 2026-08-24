import { startTavern } from '../app-boot.ts'
import { runWorkerRpcServer } from './worker-rpc.ts'

const root = process.env.STAGECRAFT_ROOT
const userDataRoot = process.env.STAGECRAFT_USER_DATA
const port = Number(process.env.RP_PORT ?? 8799)
const host = process.env.HOST || '127.0.0.1'
const server = await runWorkerRpcServer({
  input: process.stdin,
  output: process.stdout,
  pid: process.pid,
  createComposition: async hostRpc => {
    const ctx = new (await import('@deepseek-ai/cordis')).Context()
    const proxy = { sessions: Object.fromEntries(['create', 'list', 'history', 'models', 'selectModel', 'prompt'].map(method => [method, (request: any) => hostRpc(`sessions.${method}` as any, request)])), workspace: Object.fromEntries(['create', 'list', 'archiveSession'].map(method => [method, (request: any) => hostRpc(`workspace.${method}` as any, request)])) }
    ctx.provide('apiProxy', proxy)
    ctx.provide('sessions', { create: () => undefined, binding: () => undefined })
    const app = await startTavern({ root, userDataRoot, host, port, ctx, remoteAccess: false })
    return { core: app.core, close: app.close }
  },
})

const shutdown = (reason: string): void => { void server.stop(reason).catch(error => { console.error(error); process.exitCode = 1 }) }
process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('uncaughtException', error => { console.error(error); shutdown('uncaughtException') })
process.once('unhandledRejection', error => { console.error(error); shutdown('unhandledRejection') })
