import { randomUUID } from 'node:crypto'
import type { StoryPackage } from './story-packages.ts'

const MAX_REQUEST = 12_000
const MAX_MESSAGES = 80

function sessionIdOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  for (const key of ['sessionId', 'id', 'value', 'result']) {
    const candidate = record[key]
    const nested = sessionIdOf(candidate)
    if (nested) return nested
  }
  return undefined
}

type NativeSession = {
  id?: unknown
  prompt?: (content: readonly unknown[], mode: 'queue') => Promise<unknown>
  models?: () => Promise<unknown>
  selectModel?: (selection: { provider: string; model: string; reasoningEffort?: string }) => Promise<unknown>
  getSnapshot?: () => unknown
}
type NativeSessions = {
  create?: (id?: string, options?: Record<string, unknown>) => NativeSession | { sessionId?: unknown; id?: unknown }
  binding?: (id: unknown) => { session?: NativeSession } | undefined
}
type RpcResponse = { result?: { ok: boolean; value?: unknown; error?: { message?: string } } }
type NativeApiProxy = {
  workspace?: {
    create?: (request: { rpcId: string; payload: { path: string } }) => Promise<RpcResponse>
    list?: (request: { rpcId: string; payload: Record<string, never> }) => Promise<RpcResponse>
    archiveSession?: (request: { rpcId: string; payload: { sessionId: string } }) => Promise<RpcResponse>
  }
  sessions?: {
    create?: (request: { rpcId: string; payload: { workspaceId?: string; sessionId?: string } }) => Promise<RpcResponse>
    list?: (request: { rpcId: string; payload: { cursor?: string } }) => Promise<RpcResponse>
    models?: (request: { rpcId: string; payload: { sessionId: string } }) => Promise<RpcResponse>
    selectModel?: (request: { rpcId: string; payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string } }) => Promise<RpcResponse>
    history?: (request: { rpcId: string; payload: { sessionId: string; maxMessages?: number } }) => Promise<RpcResponse>
    prompt?: (request: { rpcId: string; payload: { sessionId: string; mode: 'queue' | 'steer'; content: unknown[] } }) => Promise<RpcResponse>
  }
}

function clone<T>(value: T): T { return structuredClone(value) }
function publicSession(session: DshStorySession): DshStorySession { const { nativeHandle: _nativeHandle, ...safe } = session; return clone(safe as DshStorySession) }
function bounded(value: string): string { return value.slice(0, MAX_REQUEST) }
/** DSH 的 user/message 里包含注入的剧本上下文；聊天只显示「用户请求：」之后的正文。非我们发送的注入消息返回 undefined。 */
function stripSystemContext(text: string): string | undefined {
  const marker = '用户请求：'
  const index = text.lastIndexOf(marker)
  return index >= 0 ? text.slice(index + marker.length).trim() : undefined
}

export interface DshStorySession { id: string; owner: string; storyId: string; storyTitle: string; createdAt: string; updatedAt: string; nativeId?: string; nativeHandle?: NativeSession; messages: DshStoryMessage[] }
export interface DshStoryMessage { role: 'user' | 'system'; text: string; createdAt: string }
export interface DshStoryCapability { available: boolean; native: boolean; modelSelection: boolean; reason?: string }

/** Thin bridge to DSH's native session service. It never edits StoryPackage itself. */
export class DshStorySessionService {
  private readonly sessions = new Map<string, DshStorySession>()
  private readonly readStory: (id: string) => StoryPackage
  private readonly native?: NativeSessions
  private readonly apiProxy?: NativeApiProxy | (() => NativeApiProxy | undefined)
  private readonly workspacePath?: string
  private readonly now: () => Date
  private workspaceId?: string
  constructor(readStory: (id: string) => StoryPackage, native?: NativeSessions, apiProxy?: NativeApiProxy | (() => NativeApiProxy | undefined), workspacePath?: string, now = () => new Date()) { this.readStory = readStory; this.native = native; this.apiProxy = apiProxy; this.workspacePath = workspacePath; this.now = now }
  private currentApiProxy(): NativeApiProxy | undefined { return typeof this.apiProxy === 'function' ? this.apiProxy() : this.apiProxy }
  private async resolveWorkspace(apiProxy: NativeApiProxy): Promise<string | undefined> {
    if (this.workspaceId) return this.workspaceId
    if (!this.workspacePath || !apiProxy.workspace?.create) return undefined
    const response = await apiProxy.workspace.create({ rpcId: `creator-workspace-${randomUUID()}`, payload: { path: this.workspacePath } })
    const value = this.unwrapRpc(response) as { workspace?: { workspaceId?: unknown } }
    const id = sessionIdOf(value.workspace?.workspaceId ?? value)
    if (id) this.workspaceId = id
    return this.workspaceId
  }
  capability(): DshStoryCapability { const apiProxy = this.currentApiProxy(); return this.native?.create || this.native?.binding ? { available: true, native: true, modelSelection: Boolean(apiProxy?.sessions?.models && apiProxy?.sessions?.selectModel), ...(!apiProxy?.sessions?.models ? { reason: '当前 DSH 宿主未暴露模型目录 API。' } : {}) } : { available: false, native: false, modelSelection: false, reason: '当前 DSH 宿主没有暴露原生会话服务。' } }
  close(owner: string, id: string): void { this.sessions.delete(this.require(owner, id).id) }
  get(owner: string, id: string): DshStorySession { return publicSession(this.require(owner, id)) }
  async archive(owner: string, id: string): Promise<void> {
    const session = this.require(owner, id); const apiProxy = this.currentApiProxy()
    if (!apiProxy?.workspace?.archiveSession) throw new Error('当前 DSH 宿主未提供会话归档 API。')
    await this.unwrapRpc(await apiProxy.workspace.archiveSession({ rpcId: `creator-archive-${randomUUID()}`, payload: { sessionId: session.nativeId ?? id } }))
    this.sessions.delete(session.id)
  }
  async list(owner: string, storyId?: string): Promise<DshStorySession[]> {
    const local = [...this.sessions.values()].filter(session => session.owner === owner && (!storyId || session.storyId === storyId))
    const apiProxy = this.currentApiProxy()
    if (!apiProxy?.sessions?.list) return local.map(publicSession)
    const response = await apiProxy.sessions.list({ rpcId: `creator-list-sessions-${randomUUID()}`, payload: {} })
    const result = this.unwrapRpc(response) as { items?: Array<{ sessionId?: unknown; updatedAt?: number }> }
    let archived = new Set<string>()
    if (apiProxy.workspace?.list) {
      try {
        const ws = this.unwrapRpc(await apiProxy.workspace.list({ rpcId: `creator-workspaces-${randomUUID()}`, payload: {} })) as { archivedSessionIds?: unknown[] }
        archived = new Set((ws.archivedSessionIds ?? []).map(id => sessionIdOf(id)).filter((id): id is string => Boolean(id)))
      } catch { /* 归档集读取失败时保留本地列表 */ }
    }
    const known = new Set(local.map(session => session.id))
    for (const item of result.items ?? []) {
      const id = sessionIdOf(item.sessionId)
      if (!id || known.has(id) || archived.has(id)) continue
      if (!id.startsWith('creator-')) continue
      const timestamp = new Date(item.updatedAt ?? Date.now()).toISOString()
      const restored = { id, owner, storyId: storyId ?? 'eldoria', storyTitle: storyId ?? 'DSH 会话', createdAt: timestamp, updatedAt: timestamp, nativeId: id, messages: [] }
      this.sessions.set(id, restored)
      local.push(restored)
    }
    return local.map(publicSession)
  }
  async open(owner: string, storyId: string): Promise<DshStorySession> {
    if (!owner.trim()) throw new Error('会话所有者不能为空。')
    const story = this.readStory(storyId); const timestamp = this.now().toISOString()
    const apiProxy = this.currentApiProxy()
    let nativeSession: NativeSession | undefined
    let nativeId: string | undefined
    if (apiProxy?.sessions?.create) {
      const requestedId = `creator-${randomUUID()}`
      const workspaceId = await this.resolveWorkspace(apiProxy)
      const response = await apiProxy.sessions.create({ rpcId: `creator-create-session-${randomUUID()}`, payload: { sessionId: requestedId, ...(workspaceId ? { workspaceId } : {}) } })
      const created = this.unwrapRpc(response) as { sessionId?: unknown }
      nativeId = sessionIdOf(created) ?? requestedId
      nativeSession = nativeId ? this.native?.binding?.(nativeId)?.session : undefined
    } else {
      nativeSession = this.native?.create?.(undefined, {}) as NativeSession | undefined
      nativeId = sessionIdOf(nativeSession)
    }
    if (!nativeId) throw new Error('DSH 创建会话未返回有效的 sessionId。')
    const session: DshStorySession = { id: nativeId, owner: owner.slice(0, 128), storyId, storyTitle: story.title, createdAt: timestamp, updatedAt: timestamp, nativeId, ...(nativeSession ? { nativeHandle: nativeSession } : {}), messages: [] }
    this.sessions.set(session.id, session); return publicSession(session)
  }
  async history(owner: string, id: string): Promise<DshStoryMessage[]> {
    const session = this.require(owner, id); const apiProxy = this.currentApiProxy()
    if (!apiProxy?.sessions?.history) return session.messages.slice(-MAX_MESSAGES)
    const response = await apiProxy.sessions.history({ rpcId: `creator-history-${randomUUID()}`, payload: { sessionId: session.nativeId ?? id, maxMessages: MAX_MESSAGES } })
    const value = this.unwrapRpc(response) as { events?: Array<{ event?: { type?: string; data?: Record<string, unknown> } }> }
    const messages: DshStoryMessage[] = []
    for (const entry of value.events ?? []) {
      const event = entry.event ?? (entry as unknown as { type?: string; data?: Record<string, unknown> })
      const type = event.type ?? ''; const data = event.data ?? {}
      if (type !== 'user/message' && type !== 'assistant/message') continue
      const content = data.content
      const text = Array.isArray(content) ? content.map(item => typeof item === 'string' ? item : (item as Record<string, unknown>)?.type === 'text' ? String((item as Record<string, unknown>)?.text ?? '') : '').join('') : typeof content === 'string' ? content : ''
      if (!text) continue
      if (type === 'user/message') {
        const cleaned = stripSystemContext(text)
        if (cleaned) messages.push({ role: 'user', text: cleaned, createdAt: this.now().toISOString() })
      } else {
        messages.push({ role: 'system', text, createdAt: this.now().toISOString() })
      }
    }
    session.messages = messages.slice(-MAX_MESSAGES); return clone(session.messages)
  }
  async models(owner: string, id: string): Promise<unknown> {
    const apiProxy = this.currentApiProxy()
    if (!apiProxy?.sessions?.models) throw new Error('当前 DSH 宿主未提供模型目录 API。')
    const response = await apiProxy.sessions.models({ rpcId: `creator-models-${randomUUID()}`, payload: { sessionId: this.require(owner, id).nativeId ?? id } })
    return this.unwrapRpc(response)
  }
  async selectModel(owner: string, id: string, selection: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown> {
    const apiProxy = this.currentApiProxy()
    if (!apiProxy?.sessions?.selectModel) throw new Error('当前 DSH 宿主未提供模型选择 API。')
    const response = await apiProxy.sessions.selectModel({ rpcId: `creator-select-model-${randomUUID()}`, payload: { sessionId: this.require(owner, id).nativeId ?? id, ...selection } })
    return this.unwrapRpc(response)
  }
  private unwrapRpc(response: { result?: { ok: boolean; value?: unknown; error?: { message?: string } } }): unknown {
    const result = response?.result
    if (!result?.ok) throw new Error(result?.error?.message ?? 'DSH 模型请求失败。')
    return clone(result.value)
  }
  async prompt(owner: string, id: string, text: string, storyId?: string): Promise<DshStorySession> {
    const session = this.require(owner, id); const message = bounded(text.trim()); if (!message) throw new Error('请输入要发送给 DSH 的内容。')
    const story = this.readStory(session.storyId)
    const context = `你正在协助编辑剧本文件。当前剧本 ID：${session.storyId}\n当前剧本标题：${story.title}\n剧本文件由 DSH 原生工作区工具负责读写。请直接使用 DSH 原生机制完成用户请求，不要伪造已完成的修改。\n\n用户请求：${message}`
    const apiProxy = this.currentApiProxy()
    if (apiProxy?.sessions?.prompt) {
      const response = await apiProxy.sessions.prompt({ rpcId: `creator-prompt-${randomUUID()}`, payload: { sessionId: session.nativeId ?? id, mode: 'queue', content: [{ type: 'text', text: context }] } })
      this.unwrapRpc(response)
    } else {
      const native = this.nativeFor(session)
      if (!native?.prompt) throw new Error('当前 DSH 会话不可用。')
      await native.prompt([{ type: 'text', text: context }], 'queue')
    }
    const timestamp = this.now().toISOString(); session.messages.push({ role: 'user', text: message, createdAt: timestamp }); session.messages = session.messages.slice(-MAX_MESSAGES); session.updatedAt = timestamp
    return publicSession(session)
  }
  private nativeFor(session: DshStorySession): NativeSession | undefined { return session.nativeHandle ?? (session.nativeId ? this.native?.binding?.(session.nativeId)?.session : undefined) }
  private require(owner: string, id: string): DshStorySession { const session = this.sessions.get(id); if (!session || session.owner !== owner) throw new Error('未知或不属于当前用户的 DSH 会话。'); return session }
}
