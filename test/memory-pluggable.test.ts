import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.ts'
import { RoomRuntime } from '../src/room-runtime.ts'
import type { MemoryStore } from '../src/memory-store.ts'
import type { InitialMemory, MemorySource, NpcMemory } from '../src/types.ts'

/** 内存记忆实现：验证 MemoryStore 端口可插拔（不落 SQLite npc_memories 表） */
class InMemoryMemoryStore implements MemoryStore {
  memories = new Map<string, NpcMemory[]>()
  key(roomId: string, roleId: string) { return `${roomId}:${roleId}` }
  listNpcMemories(roomId: string, roleId: string, includeInactive = false): NpcMemory[] {
    return (this.memories.get(this.key(roomId, roleId)) ?? []).filter(m => includeInactive || m.status === 'active')
  }
  insertNpcMemories(roomId: string, roleId: string, entries: Array<{ id: string; sceneId?: string; turnId?: string; worldChangeId?: string; occurredAt: string; occurredLocation?: string; source: MemorySource; text: string }>): void {
    const now = new Date().toISOString()
    const list = this.memories.get(this.key(roomId, roleId)) ?? []
    for (const entry of entries) {
      if (!entry.text.trim()) continue
      list.push({ id: entry.id, roomId, roleId, occurredAt: entry.occurredAt, source: entry.source, text: entry.text, visibility: 'private', status: 'active', supersedes: [], dedupeKey: `${entry.sceneId ?? 'manual'}:${entry.text}`, createdAt: now, updatedAt: now, sortOrder: list.length })
    }
    this.memories.set(this.key(roomId, roleId), list)
  }
  retractNpcMemory(roomId: string, memoryId: string): void {
    for (const list of this.memories.values()) { const t = list.find(m => m.id === memoryId); if (t) { t.status = 'retracted'; return } }
  }
  updateNpcMemory(roomId: string, memoryId: string, entry: { text?: string; occurredAt?: string }): void {
    for (const list of this.memories.values()) { const t = list.find(m => m.id === memoryId); if (t) { if (entry.text) t.text = entry.text; if (entry.occurredAt) t.occurredAt = entry.occurredAt; return } }
    throw new Error('记忆不存在。')
  }
  reorderNpcMemories(roomId: string, roleId: string, memoryIds: string[]): void {
    const list = this.memories.get(this.key(roomId, roleId)) ?? []
    const byId = new Map(list.map(m => [m.id, m]))
    list.length = 0
    for (const id of memoryIds) { const m = byId.get(id); if (m) list.push(m) }
  }
  supersedeNpcMemory(roomId: string, memoryId: string, replacement: { id: string; text: string; occurredAt: string }): void {
    for (const list of this.memories.values()) {
      const prior = list.find(m => m.id === memoryId && m.status === 'active')
      if (prior) {
        prior.status = 'superseded'; prior.supersededBy = replacement.id
        this.insertNpcMemories(roomId, prior.roleId, [{ ...replacement, source: 'manual' }])
        return
      }
    }
    throw new Error('可替代的记忆不存在。')
  }
  seedNpcMemories(roomId: string, roleId: string, memories?: InitialMemory[]): void {
    this.insertNpcMemories(roomId, roleId, (memories ?? []).map((memory, index) => ({ id: `story-${roomId}-${roleId}-${index}`, occurredAt: memory.occurredAt, source: 'story', text: memory.text })))
  }
}

test('memory store is pluggable: in-memory store backs room memories', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-pluggable-memory-'))
  const memory = new InMemoryMemoryStore()
  const store = new Store(join(root, 'app.sqlite'), { memoryStore: memory })
  const roomId = store.seed()
  const runtime = new RoomRuntime(store, {
    decide: async (role) => ({ roleId: role.id, participation: 'required', status: 'completed', brief: 'b', privateReaction: 'r' }),
    draft: async (turnId) => ({ id: 'd', turnId, text: 't', stateUpdates: {}, settingProposals: [], intentHandling: [], openQuestions: [], createdAt: new Date().toISOString() }),
  })
  // 写一条记忆（走注入的 memoryStore，不落 SQLite）
  runtime.storeNpcMemories(roomId, 'aria', [{ text: '内存记忆一。', occurredAt: '过去' }])
  // getRoom 应从注入 store 读（RoomSnapshot.role.memories）
  const room = runtime.get(roomId)
  const aria = room.roles.find(r => r.id === 'aria')!
  assert.ok(aria.memories?.some(m => m.text === '内存记忆一。'), '记忆应从注入的 memoryStore 读出')
  // 再次读取仍一致（内存 store 持续可用，含 seed 初始记忆 + 手动新增）
  const again = runtime.get(roomId)
  assert.ok(again.roles.find(r => r.id === 'aria')!.memories?.some(m => m.text === '内存记忆一。'), '再次读取仍能读到内存记忆')
  // 撤回走注入 store
  const memoryId = aria.memories!.find(m => m.text === '内存记忆一。')!.id
  runtime.retractNpcMemory(roomId, memoryId)
  assert.ok(!runtime.get(roomId).roles.find(r => r.id === 'aria')!.memories?.some(m => m.text === '内存记忆一。'), '撤回后该记忆应不可见')
})

