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

function clone<T>(value: T): T { return structuredClone(value) }
function publicSession(session: DshStorySession): DshStorySession { const { nativeHandle: _nativeHandle, ...safe } = session; return clone(safe as DshStorySession) }
function bounded(value: string): string { return value.slice(0, MAX_REQUEST) }

export interface DshStorySession { id: string; owner: string; storyId: string; storyTitle: string; createdAt: string; updatedAt: string; nativeId?: string; nativeHandle?: NativeSession; messages: DshStoryMessage[] }
export interface DshStoryMessage { role: 'user' | 'system'; text: string; createdAt: string }
export interface DshStoryCapability { available: boolean; native: boolean; modelSelection: boolean; reason?: string }

/** Thin bridge to DSH's native session service. It never edits StoryPackage itself. */
export class DshStorySessionService {
  private readonly sessions = new Map<string, DshStorySession>()
  private readonly readStory: (id: string) => StoryPackage
  private readonly native?: NativeSessions
  private readonly now: () => Date
  constructor(readStory: (id: string) => StoryPackage, native?: NativeSessions, now = () => new Date()) { this.readStory = readStory; this.native = native; this.now = now }
  capability(): DshStoryCapability { return this.native?.create || this.native?.binding ? { available: true, native: true, modelSelection: true } : { available: false, native: false, modelSelection: false, reason: '当前 DSH 宿主没有暴露原生会话服务。' } }
  open(owner: string, storyId: string): DshStorySession {
    if (!owner.trim()) throw new Error('会话所有者不能为空。')
    const story = this.readStory(storyId); const timestamp = this.now().toISOString()
    const nativeSession = this.native?.create?.(undefined, {})
    const nativeId = sessionIdOf(nativeSession)
    if (!nativeId) throw new Error('DSH 创建会话未返回有效的 sessionId。')
    const nativeHandle = nativeSession && typeof nativeSession === 'object' ? nativeSession as NativeSession : undefined
    const session: DshStorySession = { id: nativeId, owner: owner.slice(0, 128), storyId, storyTitle: story.title, createdAt: timestamp, updatedAt: timestamp, nativeId, ...(nativeHandle ? { nativeHandle } : {}), messages: [] }
    this.sessions.set(session.id, session); return publicSession(session)
  }
  close(owner: string, id: string): void { this.sessions.delete(this.require(owner, id).id) }
  get(owner: string, id: string): DshStorySession { return publicSession(this.require(owner, id)) }
  list(owner: string, storyId?: string): DshStorySession[] { return [...this.sessions.values()].filter(session => session.owner === owner && (!storyId || session.storyId === storyId)).map(publicSession) }
  async models(owner: string, id: string): Promise<unknown> {
    const native = this.nativeFor(this.require(owner, id))
    if (!native?.models) throw new Error('当前 DSH 宿主未提供模型目录。')
    return clone(await native.models())
  }
  async selectModel(owner: string, id: string, selection: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown> {
    const native = this.nativeFor(this.require(owner, id))
    if (!native?.selectModel) throw new Error('当前 DSH 宿主未提供模型选择。')
    return clone(await native.selectModel(selection))
  }
  async prompt(owner: string, id: string, text: string, storyId?: string): Promise<DshStorySession> {
    const session = this.require(owner, id); const message = bounded(text.trim()); if (!message) throw new Error('请输入要发送给 DSH 的内容。')
    const story = this.readStory(session.storyId)
    const context = `你正在协助编辑剧本文件。当前剧本 ID：${session.storyId}\n当前剧本标题：${story.title}\n剧本文件由 DSH 原生工作区工具负责读写。请直接使用 DSH 原生机制完成用户请求，不要伪造已完成的修改。\n\n用户请求：${message}`
    const native = this.nativeFor(session)
    if (!native?.prompt) throw new Error('当前 DSH 会话不可用。')
    await native.prompt([{ type: 'text', text: context }], 'queue')
    const timestamp = this.now().toISOString(); session.messages.push({ role: 'user', text: message, createdAt: timestamp }); session.messages = session.messages.slice(-MAX_MESSAGES); session.updatedAt = timestamp
    return publicSession(session)
  }
  private nativeFor(session: DshStorySession): NativeSession | undefined { return session.nativeHandle ?? (session.nativeId ? this.native?.binding?.(session.nativeId)?.session : undefined) }
  private require(owner: string, id: string): DshStorySession { const session = this.sessions.get(id); if (!session || session.owner !== owner) throw new Error('未知或不属于当前用户的 DSH 会话。'); return session }
}
