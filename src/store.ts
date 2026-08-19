import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { ConsultationMessage, Decision, Draft, PendingMindUpdate, Role, RoomPhase, RoomSnapshot, Scene } from './types.ts'
import type { StoryPackage } from './story-packages.ts'
import { normalizeStateUpdateKeys } from './model-gateway.ts'
import type { StateEvent } from './core/protocol.ts'
import { isDomainEvent, type DomainEvent } from './core/domain-events.ts'
import type { WorkflowInstance } from './core/protocol.ts'

const normalizeMemoryTimeLabel = (value: string | undefined): string => {
  const label = String(value ?? '').trim()
  return !label || label === '未标注时间' ? '过去' : label
}

const normalizeMemoryTimeline = (timeline: Record<string, string[]> | undefined): Record<string, string[]> => {
  const normalized: Record<string, string[]> = {}
  for (const [when, entries] of Object.entries(timeline ?? {})) {
    const label = normalizeMemoryTimeLabel(when)
    const bucket = normalized[label] ??= []
    for (const entry of Array.isArray(entries) ? entries : []) if (!bucket.includes(entry)) bucket.push(entry)
  }
  return normalized
}

export class Store {
  private readonly db: DatabaseSync
  private closed = false

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        player_name TEXT NOT NULL DEFAULT '玩家',
        player_persona TEXT NOT NULL DEFAULT '由玩家自由定义的参与者。',
        player_state TEXT NOT NULL DEFAULT '刚刚进入当前场景。',
        scene_time TEXT,
        scene_location TEXT,
        phase TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        player_contribution TEXT,
        last_error TEXT,
        lore TEXT NOT NULL DEFAULT '[]',
        mode TEXT NOT NULL DEFAULT 'director',
        auto_publish INTEGER NOT NULL DEFAULT 0,
        speech TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS roles (
        room_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        portrait_ref TEXT NOT NULL,
        current_state TEXT NOT NULL,
        presence TEXT NOT NULL,
        memory_timeline TEXT NOT NULL DEFAULT '{}',
        goals TEXT NOT NULL DEFAULT '[]',
        self_model TEXT NOT NULL,
        provider_id TEXT,
        model_override TEXT,
        model_route TEXT,
        model_base_url TEXT,
        model_name TEXT,
        model_api_key TEXT,
        PRIMARY KEY (room_id, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS npc_memories (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, role_id TEXT NOT NULL, scene_id TEXT, turn_id TEXT, world_change_id TEXT, occurred_at TEXT NOT NULL, occurred_location TEXT, source TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, subjects TEXT NOT NULL DEFAULT '[]', visibility TEXT NOT NULL DEFAULT 'private', salience INTEGER NOT NULL DEFAULT 3, confidence REAL NOT NULL DEFAULT 1.0, status TEXT NOT NULL DEFAULT 'active', supersedes TEXT NOT NULL DEFAULT '[]', superseded_by TEXT, dedupe_key TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (room_id, role_id, dedupe_key)) STRICT;
      CREATE INDEX IF NOT EXISTS npc_memories_role_active ON npc_memories(room_id, role_id, status, sort_order);
      CREATE INDEX IF NOT EXISTS npc_memories_world_change ON npc_memories(room_id, world_change_id);
      CREATE TABLE IF NOT EXISTS reaction_previews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (turn_id, role_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        contribution TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS decisions (
        turn_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        participation TEXT NOT NULL,
        status TEXT NOT NULL,
        brief TEXT,
        private_reaction TEXT,
        thinking TEXT,
        usage TEXT,
        error TEXT,
        PRIMARY KEY (turn_id, role_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        text TEXT NOT NULL,
        state_updates TEXT NOT NULL,
        setting_proposals TEXT NOT NULL DEFAULT '[]',
        intent_handling TEXT NOT NULL DEFAULT '[]',
        open_questions TEXT NOT NULL DEFAULT '[]',
        scene_updates TEXT NOT NULL DEFAULT '{}',
        thinking TEXT,
        usage TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS scenes (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        text TEXT NOT NULL,
        scene_time TEXT,
        scene_location TEXT,
        usage TEXT,
        scene_kind TEXT NOT NULL DEFAULT 'system',
        world_change_id TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS world_changes (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        turn_id TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        request TEXT NOT NULL,
        approved_request TEXT,
        before_scene_time TEXT,
        after_scene_time TEXT,
        before_scene_location TEXT,
        after_scene_location TEXT,
        narration_scene_id TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        rejected_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS world_changes_room_created ON world_changes(room_id, created_at);
      CREATE TABLE IF NOT EXISTS consultations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        draft_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        usage TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS pending_mind_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        private_reaction TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS core_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_source TEXT NOT NULL,
        caused_by TEXT,
        workflow_id TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(room_id, event_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS core_events_room_sequence ON core_events(room_id, sequence DESC);
      CREATE TABLE IF NOT EXISTS workflow_instances (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        definition_id TEXT NOT NULL,
        definition_version TEXT NOT NULL,
        step TEXT NOT NULL,
        status TEXT NOT NULL,
        locals TEXT NOT NULL,
        pending_interactions TEXT NOT NULL,
        pending_model_requests TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS workflow_instances_room ON workflow_instances(room_id);
    `)
    this.ensureDraftColumns()
    this.ensureRoleConfigColumns()
    this.ensurePlayerColumns()
    this.ensureThinkingColumns()
    this.ensureDecisionIdentityColumn()
    this.ensureSceneColumns()
    this.ensureMemoryTimelineColumns()
    this.ensureLoreColumns()
    this.ensureDraftRoleProposals()
    this.ensureRoleSortOrder()
    this.ensureStoryIdColumn()
    this.ensureRoleImpressions()
    this.ensureRoleGoals()
    this.ensureRoomModeColumns()
    this.ensureUsageColumns()
    this.ensureWorldChangeColumn()
    this.ensureSceneWorldChangeColumns()
    this.ensureMemorySortOrder()
    this.normalizePastMemoryLabels()
  }

  /** 关闭数据库连接（幂等；供宿主卸载/退出前的资源回收） */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  saveWorkflowInstance(roomId: string, instance: WorkflowInstance): void {
    this.db.prepare(`INSERT INTO workflow_instances (id, room_id, definition_id, definition_version, step, status, locals, pending_interactions, pending_model_requests, retry_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET definition_version = excluded.definition_version, step = excluded.step, status = excluded.status, locals = excluded.locals, pending_interactions = excluded.pending_interactions, pending_model_requests = excluded.pending_model_requests, retry_count = excluded.retry_count, updated_at = excluded.updated_at`)
      .run(instance.id, roomId, instance.definitionId, instance.definitionVersion, instance.step, instance.status, JSON.stringify(instance.locals), JSON.stringify(instance.pendingInteractionIds), JSON.stringify(instance.pendingModelRequestIds), instance.retryCount, instance.createdAt, instance.updatedAt)
  }

  listWorkflowInstances(roomId: string): WorkflowInstance[] {
    const rows = this.db.prepare('SELECT id, definition_id, definition_version, step, status, locals, pending_interactions, pending_model_requests, retry_count, created_at, updated_at FROM workflow_instances WHERE room_id = ? ORDER BY id').all(roomId) as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: String(row.id), definitionId: String(row.definition_id), definitionVersion: String(row.definition_version), step: String(row.step), status: row.status as WorkflowInstance['status'],
      locals: JSON.parse(String(row.locals)), pendingInteractionIds: JSON.parse(String(row.pending_interactions)), pendingModelRequestIds: JSON.parse(String(row.pending_model_requests)), retryCount: Number(row.retry_count), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }))
  }

  appendCoreEvent(roomId: string, revision: number, event: StateEvent): void {
    this.db.prepare('INSERT OR IGNORE INTO core_events (room_id, revision, event_id, event_type, event_source, caused_by, workflow_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(roomId, revision, event.id, event.type, event.source, event.causedBy ?? null, event.workflowId ?? null, JSON.stringify(event.payload), event.createdAt)
  }

  listCoreEvents(roomId: string, limit = 100): StateEvent[] {
    const rows = this.db.prepare('SELECT event_id, event_type, event_source, caused_by, workflow_id, payload, created_at FROM core_events WHERE room_id = ? ORDER BY sequence ASC LIMIT ?').all(roomId, Math.max(1, limit)) as Array<{ event_id: string; event_type: string; event_source: StateEvent['source']; caused_by: string | null; workflow_id: string | null; payload: string; created_at: string }>
    return rows.map(row => ({ id: row.event_id, type: row.event_type, source: row.event_source, payload: JSON.parse(row.payload), ...(row.caused_by ? { causedBy: row.caused_by } : {}), ...(row.workflow_id ? { workflowId: row.workflow_id } : {}), createdAt: row.created_at }))
  }

  appendCoreDomainEvent(roomId: string, revision: number, event: DomainEvent): void {
    this.appendCoreEvent(roomId, revision, event)
  }

  listCoreDomainEvents(roomId: string, limit = 100): DomainEvent[] {
    return this.listCoreEvents(roomId, limit).filter(isDomainEvent)
  }

  /** 旧库迁移：roles.impressions（该角色对他人的印象，姓名 → 文字） */
  private ensureRoleImpressions(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(roles)').all().map((row: any) => row.name as string))
    if (!columns.has('impressions')) this.db.exec("ALTER TABLE roles ADD COLUMN impressions TEXT NOT NULL DEFAULT '{}'")
  }

  /** 旧库迁移：roles.goals（长期目标独立字段，允许空） */
  private ensureRoleGoals(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(roles)').all().map((row: any) => row.name as string))
    if (!columns.has('goals')) this.db.exec("ALTER TABLE roles ADD COLUMN goals TEXT NOT NULL DEFAULT '[]'")
  }

  /** 旧库迁移：rooms.mode / auto_publish / speech（群聊模式 + 沉浸模式） */
  private ensureRoomModeColumns(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(rooms)').all().map((row: any) => row.name as string))
    if (!columns.has('mode')) this.db.exec("ALTER TABLE rooms ADD COLUMN mode TEXT NOT NULL DEFAULT 'director'")
    if (!columns.has('auto_publish')) this.db.exec('ALTER TABLE rooms ADD COLUMN auto_publish INTEGER NOT NULL DEFAULT 0')
    if (!columns.has('speech')) this.db.exec('ALTER TABLE rooms ADD COLUMN speech TEXT')
  }

  /** 旧库迁移：rooms.pending_world_change（群聊模式待确认的世界变更申请 JSON） */
  private ensureWorldChangeColumn(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(rooms)').all().map((row: any) => row.name as string))
    if (!columns.has('pending_world_change')) this.db.exec('ALTER TABLE rooms ADD COLUMN pending_world_change TEXT')
    if (!columns.has('pending_narration')) this.db.exec('ALTER TABLE rooms ADD COLUMN pending_narration TEXT')
    if (!columns.has('pending_world_change_id')) this.db.exec('ALTER TABLE rooms ADD COLUMN pending_world_change_id TEXT')
  }

  private ensureSceneWorldChangeColumns(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(scenes)').all().map((row: any) => row.name as string))
    if (!columns.has('scene_kind')) this.db.exec("ALTER TABLE scenes ADD COLUMN scene_kind TEXT NOT NULL DEFAULT 'system'")
    if (!columns.has('world_change_id')) this.db.exec('ALTER TABLE scenes ADD COLUMN world_change_id TEXT')
  }

  /** 旧库迁移：decisions/drafts/scenes/consultations.usage（单次调用的 token 用量，前端小字展示） */
  private ensureUsageColumns(): void {
    for (const [table, column] of [['decisions', 'usage'], ['drafts', 'usage'], ['scenes', 'usage'], ['consultations', 'usage']] as const) {
      const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((row: any) => row.name as string))
      if (!columns.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
    }
  }

  /** 旧库迁移：rooms.story_id（当前剧本 id，供前端默认选择/存档命名） */
  private ensureStoryIdColumn(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(rooms)').all().map((row: any) => row.name as string))
    if (!columns.has('story_id')) this.db.exec('ALTER TABLE rooms ADD COLUMN story_id TEXT')
  }

  /** 旧库迁移：roles.sort_order（人物排序，供拖拽调整） */
  private ensureRoleSortOrder(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(roles)').all().map((row: any) => row.name as string))
    if (!columns.has('sort_order')) this.db.exec('ALTER TABLE roles ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
  }

  /** 记忆顺序可由用户拖动维护；迁移旧数据时先放无具体时间的旧记忆，再保留时间顺序。 */
  private ensureMemorySortOrder(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(npc_memories)').all().map((row: any) => row.name as string))
    if (columns.has('sort_order')) return
    this.db.exec('ALTER TABLE npc_memories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
    const rows = this.db.prepare("SELECT id, room_id, role_id FROM npc_memories ORDER BY room_id, role_id, CASE WHEN occurred_at = '未标注时间' THEN 0 ELSE 1 END, occurred_at, created_at").all() as Array<{ id: string; room_id: string; role_id: string }>
    const update = this.db.prepare('UPDATE npc_memories SET sort_order = ? WHERE id = ?')
    let group = ''
    let index = 0
    for (const row of rows) {
      const nextGroup = `${row.room_id}:${row.role_id}`
      if (nextGroup !== group) { group = nextGroup; index = 0 }
      update.run(index++, row.id)
    }
  }

  /** 兼容旧存档：将旧的「未标注时间」统一迁移为更自然的「过去」。 */
  private normalizePastMemoryLabels(): void {
    this.db.prepare("UPDATE npc_memories SET occurred_at = '过去' WHERE occurred_at = '未标注时间'").run()
    const rows = this.db.prepare("SELECT room_id, id, memory_timeline FROM roles WHERE memory_timeline LIKE '%未标注时间%'").all() as Array<{ room_id: string; id: string; memory_timeline: string }>
    const update = this.db.prepare('UPDATE roles SET memory_timeline = ? WHERE room_id = ? AND id = ?')
    for (const row of rows) {
      const timeline = JSON.parse(row.memory_timeline || '{}') as Record<string, string[]>
      const legacy = Array.isArray(timeline['未标注时间']) ? timeline['未标注时间'] : []
      if (!legacy.length) { delete timeline['未标注时间']; update.run(JSON.stringify(timeline), row.room_id, row.id); continue }
      const past = Array.isArray(timeline['过去']) ? timeline['过去'] : []
      timeline['过去'] = [...legacy, ...past.filter(item => !legacy.includes(item))]
      delete timeline['未标注时间']
      update.run(JSON.stringify(timeline), row.room_id, row.id)
    }
  }

  /** 旧库迁移：drafts.role_proposals（导演提议新建人物） */
  private ensureDraftRoleProposals(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(drafts)').all().map((row: any) => row.name as string))
    if (!columns.has('role_proposals')) this.db.exec("ALTER TABLE drafts ADD COLUMN role_proposals TEXT NOT NULL DEFAULT '[]'")
  }

  /** 旧库迁移：rooms.lore（世界书） */
  private ensureLoreColumns(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(rooms)').all().map((row: any) => row.name as string))
    if (!columns.has('lore')) this.db.exec("ALTER TABLE rooms ADD COLUMN lore TEXT NOT NULL DEFAULT '[]'")
  }

  /** 旧库迁移：rooms.scene_time / scene_location（旧列名 current_time/current_location 与 SQLite 内置 CURRENT_TIME 冲突）；scenes.speaker 为群聊气泡发言者标记 */
  private ensureSceneColumns(): void {
    const roomColumns = new Set(this.db.prepare('PRAGMA table_info(rooms)').all().map((row: any) => row.name as string))
    for (const name of ['scene_time', 'scene_location']) {
      if (!roomColumns.has(name)) this.db.exec(`ALTER TABLE rooms ADD COLUMN ${name} TEXT`)
    }
    if (roomColumns.has('current_time')) {
      this.db.prepare('UPDATE rooms SET scene_time = "current_time" WHERE scene_time IS NULL').run()
      this.db.exec('ALTER TABLE rooms DROP COLUMN current_time')
    }
    if (roomColumns.has('current_location')) {
      this.db.prepare('UPDATE rooms SET scene_location = "current_location" WHERE scene_location IS NULL').run()
      this.db.exec('ALTER TABLE rooms DROP COLUMN current_location')
    }
    const sceneColumns = new Set(this.db.prepare('PRAGMA table_info(scenes)').all().map((row: any) => row.name as string))
    if (!sceneColumns.has('speaker')) this.db.exec('ALTER TABLE scenes ADD COLUMN speaker TEXT')
  }

  /** 旧库迁移：roles.memory_timeline、drafts.scene_updates；旧 private_memory 列并入「过去」桶后删列 */
  private ensureMemoryTimelineColumns(): void {
    const roleColumns = new Set(this.db.prepare('PRAGMA table_info(roles)').all().map((row: any) => row.name as string))
    if (!roleColumns.has('memory_timeline')) this.db.exec("ALTER TABLE roles ADD COLUMN memory_timeline TEXT NOT NULL DEFAULT '{}'")
    if (roleColumns.has('private_memory')) {
      const rows = this.db.prepare('SELECT id, private_memory, memory_timeline FROM roles').all() as Array<{ id: string; private_memory: string | null; memory_timeline: string }>
      const update = this.db.prepare('UPDATE roles SET memory_timeline = ? WHERE id = ?')
      for (const row of rows) {
        const text = (row.private_memory ?? '').trim()
        if (!text) continue
        const timeline = JSON.parse(row.memory_timeline ?? '{}') as Record<string, string[]>
        const bucket = timeline['过去'] ?? []
        for (const event of text.split('\n').map(line => line.trim()).filter(Boolean)) {
          if (!bucket.some(existing => existing === event || existing.includes(event) || event.includes(existing))) bucket.push(event)
        }
        timeline['过去'] = bucket
        update.run(JSON.stringify(timeline), row.id)
      }
      this.db.exec('ALTER TABLE roles DROP COLUMN private_memory')
    }
    const draftColumns = new Set(this.db.prepare('PRAGMA table_info(drafts)').all().map((row: any) => row.name as string))
    if (!draftColumns.has('scene_updates')) this.db.exec("ALTER TABLE drafts ADD COLUMN scene_updates TEXT NOT NULL DEFAULT '{}'")
    const sceneColumns = new Set(this.db.prepare('PRAGMA table_info(scenes)').all().map((row: any) => row.name as string))
    for (const name of ['scene_time', 'scene_location']) {
      if (!sceneColumns.has(name)) this.db.exec(`ALTER TABLE scenes ADD COLUMN ${name} TEXT`)
    }
  }

  private ensureRoleConfigColumns(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(roles)').all().map((row: any) => row.name as string))
    for (const [name, sql] of [['provider_id', 'TEXT'], ['model_override', 'TEXT'], ['model_route', 'TEXT'], ['model_base_url', 'TEXT'], ['model_name', 'TEXT'], ['model_api_key', 'TEXT']] as const) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE roles ADD COLUMN ${name} ${sql}`)
    }
  }

  private ensurePlayerColumns(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(rooms)').all().map((row: any) => row.name as string))
    for (const [name, sql] of [['player_name', "TEXT NOT NULL DEFAULT '玩家'"], ['player_persona', "TEXT NOT NULL DEFAULT '由玩家自由定义的参与者。'"], ['player_state', "TEXT NOT NULL DEFAULT '刚刚进入当前场景。'"], ['player_portrait_ref', "TEXT NOT NULL DEFAULT '/assets/default.svg'"]] as const) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE rooms ADD COLUMN ${name} ${sql}`)
    }
  }

  private ensureDraftColumns(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(drafts)').all().map((row: any) => row.name as string))
    for (const [name, sql] of [
      ['setting_proposals', "TEXT NOT NULL DEFAULT '[]'"],
      ['intent_handling', "TEXT NOT NULL DEFAULT '[]'"],
      ['open_questions', "TEXT NOT NULL DEFAULT '[]'"],
    ] as const) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE drafts ADD COLUMN ${name} ${sql}`)
    }
  }

  private ensureThinkingColumns(): void {
    const draftColumns = new Set(this.db.prepare('PRAGMA table_info(drafts)').all().map((row: any) => row.name as string))
    if (!draftColumns.has('thinking')) this.db.exec('ALTER TABLE drafts ADD COLUMN thinking TEXT')
    const decisionColumns = new Set(this.db.prepare('PRAGMA table_info(decisions)').all().map((row: any) => row.name as string))
    if (!decisionColumns.has('thinking')) this.db.exec('ALTER TABLE decisions ADD COLUMN thinking TEXT')
    const roleColumns = new Set(this.db.prepare('PRAGMA table_info(roles)').all().map((row: any) => row.name as string))
    if (!roleColumns.has('thinking_strength')) this.db.exec('ALTER TABLE roles ADD COLUMN thinking_strength TEXT')
    const consultationColumns = new Set(this.db.prepare('PRAGMA table_info(consultations)').all().map((row: any) => row.name as string))
    if (!consultationColumns.has('thinking')) this.db.exec('ALTER TABLE consultations ADD COLUMN thinking TEXT')
  }

  /** 旧库迁移：decisions.public_identity（角色本回合对外展示的身份/形象） */
  private ensureDecisionIdentityColumn(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(decisions)').all().map((row: any) => row.name as string))
    if (!columns.has('public_identity')) this.db.exec('ALTER TABLE decisions ADD COLUMN public_identity TEXT')
  }

  recoverInterruptedRooms(): number {
    const result = this.db.prepare(`
      UPDATE rooms
      SET phase = 'awaiting-player-input', revision = revision + 1, speech = NULL, pending_world_change = NULL, pending_narration = NULL,
          last_error = '上一次运行在角色决策/导演起草/角色发言期间中断；请重新提交本轮。'
      WHERE phase IN ('collecting-decisions', 'drafting', 'role-speaking', 'world-change-approval')
    `).run()
    return Number(result.changes)
  }

  seed(story?: StoryPackage): string {
    const existing = this.db.prepare('SELECT id, story_id FROM rooms LIMIT 1').get() as { id: string; story_id: string | null } | undefined
    if (story) {
      const match = this.db.prepare('SELECT id FROM rooms WHERE story_id = ? ORDER BY rowid LIMIT 1').get(story.id) as { id: string } | undefined
      if (match) return match.id
      const isPlaceholderFestival = existing?.id === 'festival-room' && (existing.story_id === 'royal-festival' || existing.story_id === null)
      if (existing && !isPlaceholderFestival) return existing.id
      return this.createRoomFromPackage(story, `${story.id}-room`)
    }
    if (existing) return existing.id
    return this.createRoomFromPackage({
      id: 'royal-festival', title: '皇家祭典', opening: '皇家祭典主厅的乐声透过高窗流入夜色。', sceneTime: '夜晚', sceneLocation: '皇家祭典主厅', playerCharacter: { name: '玩家', persona: '谨慎而善于观察的来访者。', currentState: '刚刚进入当前场景。' },
      roles: [
        { id: 'aria', name: 'Aria', portraitRef: '/assets/aria.svg', currentState: '位于皇家祭典主厅，在场。身着深蓝色礼服，右手仍有轻微伤势；未携带武器。', presence: 'present', memoryTimeline: { '过去': ['玩家的举动值得留意。'] }, selfModel: '克制、敏锐，习惯将情绪藏在礼貌之后。' },
        { id: 'mira', name: 'Mira', portraitRef: '/assets/mira.svg', currentState: '位于皇家祭典主厅，在场。带着一箱啤酒，神态轻松，正观察人群。', presence: 'present', memoryTimeline: { '过去': ['Aria 今晚比平时紧张。'] }, selfModel: '直率、好奇，擅长用玩笑缓和紧张气氛。' },
        { id: 'noel', name: 'Noel', portraitRef: '/assets/noel.svg', currentState: '不在祭典主厅，暂时不可见。', presence: 'absent', memoryTimeline: { '过去': ['尚未参与本轮。'] }, selfModel: '谨慎、寡言，优先观察。' },
      ],
    }, 'festival-room')
  }

  createRoomFromPackage(story: StoryPackage, roomId = `${story.id}-${Date.now()}`, options: { mode?: import('./types.ts').RoomMode; autoPublish?: boolean } = {}): string {
    this.withTransaction(() => {
      this.db.prepare('INSERT INTO rooms (id, title, player_name, player_persona, player_state, scene_time, scene_location, phase, lore, story_id, mode, auto_publish) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(roomId, story.title, story.playerCharacter?.name ?? '玩家', story.playerCharacter?.persona ?? '由玩家自由定义的参与者。', story.playerCharacter?.currentState ?? '刚刚进入当前场景。', story.sceneTime ?? '第一日黄昏', story.sceneLocation ?? null, 'awaiting-player-input', JSON.stringify(story.lore ?? []), story.id, options.mode ?? 'director', options.autoPublish ? 1 : 0)
      const insertRole = this.db.prepare('INSERT INTO roles (room_id, id, name, portrait_ref, current_state, presence, memory_timeline, goals, self_model, impressions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const role of story.roles) { insertRole.run(roomId, role.id, role.name, role.portraitRef, role.currentState, role.presence, JSON.stringify(normalizeMemoryTimeline(role.memoryTimeline)), JSON.stringify(role.goals ?? []), role.selfModel, JSON.stringify(role.impressions ?? {})); this.seedNpcMemories(roomId, role.id, role.memoryTimeline, 'import', role.initialMemories) }
      if (story.opening) this.db.prepare('INSERT INTO scenes (id, room_id, turn_id, text, scene_time, scene_location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`opening-${roomId}`, roomId, 'opening', story.opening, story.sceneTime ?? null, story.sceneLocation ?? null, new Date().toISOString())
    })
    return roomId
  }

  exportRoom(roomId: string): Record<string, unknown> {
    const room = this.getRoom(roomId)
    if (!room) throw new Error('Room not found.')
    return { version: 1, exportedAt: new Date().toISOString(), room }
  }

  importRoom(roomId: string, archive: { room?: RoomSnapshot }): void {
    if (!archive.room) throw new Error('存档格式无效。')
    const source = archive.room
    this.withTransaction(() => {
      this.db.prepare('DELETE FROM decisions WHERE turn_id IN (SELECT id FROM turns WHERE room_id = ?)').run(roomId)
      for (const table of ['turns', 'drafts', 'scenes', 'consultations', 'pending_mind_updates', 'reaction_previews', 'roles']) this.db.prepare(`DELETE FROM ${table} WHERE room_id = ?`).run(roomId)
      this.db.prepare('UPDATE rooms SET title = ?, player_name = ?, player_persona = ?, player_state = ?, player_portrait_ref = ?, scene_time = ?, scene_location = ?, phase = ?, revision = ?, player_contribution = ?, last_error = ?, lore = ?, story_id = ?, speech = NULL, pending_world_change = NULL, pending_narration = NULL WHERE id = ?').run(source.title, source.playerCharacter?.name ?? '玩家', source.playerCharacter?.persona ?? '由玩家自由定义的参与者。', source.playerCharacter?.currentState ?? '刚刚进入当前场景。', source.playerCharacter?.portraitRef ?? '/assets/default.svg', source.sceneTime ?? null, source.sceneLocation ?? null, source.phase, source.revision, source.playerContribution ?? null, source.lastError ?? null, JSON.stringify(source.lore ?? []), source.storyId ?? null, roomId)
      const insertRole = this.db.prepare('INSERT INTO roles (room_id, id, name, portrait_ref, current_state, presence, memory_timeline, goals, self_model, impressions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const role of source.roles) insertRole.run(roomId, role.id, role.name, role.portraitRef, role.currentState, role.presence, JSON.stringify(normalizeMemoryTimeline(role.memoryTimeline)), JSON.stringify(role.goals ?? []), role.selfModel, JSON.stringify(role.impressions ?? {}))
      for (const scene of source.scenes) this.db.prepare('INSERT INTO scenes (id, room_id, turn_id, text, scene_time, scene_location, created_at, speaker) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(scene.id, roomId, scene.turnId, scene.text, scene.sceneTime ?? null, scene.sceneLocation ?? null, scene.createdAt, scene.speaker ?? null)
    })
  }

  restartRoom(roomId: string, story: StoryPackage, options: { mode?: import('./types.ts').RoomMode; autoPublish?: boolean } = {}): void {
    this.withTransaction(() => {
      const room = this.db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId)
      if (!room) throw new Error('Room not found.')
      this.db.prepare('DELETE FROM decisions WHERE turn_id IN (SELECT id FROM turns WHERE room_id = ?)').run(roomId)
      this.db.prepare('DELETE FROM turns WHERE room_id = ?').run(roomId)
      this.db.prepare('DELETE FROM drafts WHERE room_id = ?').run(roomId)
      this.db.prepare('DELETE FROM scenes WHERE room_id = ?').run(roomId)
      this.db.prepare('DELETE FROM consultations WHERE room_id = ?').run(roomId)
      this.db.prepare('DELETE FROM pending_mind_updates WHERE room_id = ?').run(roomId)
      this.db.prepare('DELETE FROM reaction_previews WHERE room_id = ?').run(roomId)
      this.db.prepare('DELETE FROM roles WHERE room_id = ?').run(roomId)
      const insertRole = this.db.prepare('INSERT INTO roles (room_id, id, name, portrait_ref, current_state, presence, memory_timeline, goals, self_model, impressions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const role of story.roles) { insertRole.run(roomId, role.id, role.name, role.portraitRef, role.currentState, role.presence, JSON.stringify(normalizeMemoryTimeline(role.memoryTimeline)), JSON.stringify(role.goals ?? []), role.selfModel, JSON.stringify(role.impressions ?? {})); this.seedNpcMemories(roomId, role.id, role.memoryTimeline, 'import', role.initialMemories) }
      if (story.opening) this.db.prepare('INSERT INTO scenes (id, room_id, turn_id, text, scene_time, scene_location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`opening-${roomId}-${Date.now()}`, roomId, 'opening', story.opening, story.sceneTime ?? '第一日黄昏', story.sceneLocation ?? null, new Date().toISOString())
      this.db.prepare("UPDATE rooms SET title = ?, player_name = ?, player_persona = ?, player_state = ?, scene_time = ?, scene_location = ?, phase = 'awaiting-player-input', revision = revision + 1, player_contribution = NULL, last_error = NULL, lore = ?, story_id = ?, mode = ?, auto_publish = ?, speech = NULL, pending_world_change = NULL, pending_narration = NULL WHERE id = ?").run(story.title, story.playerCharacter?.name ?? '玩家', story.playerCharacter?.persona ?? '由玩家自由定义的参与者。', story.playerCharacter?.currentState ?? '刚刚进入当前场景。', story.sceneTime ?? '第一日黄昏', story.sceneLocation ?? null, JSON.stringify(story.lore ?? []), story.id, options.mode ?? 'director', options.autoPublish ? 1 : 0, roomId)
    })
  }

  listNpcMemories(roomId: string, roleId: string, includeInactive = false): import('./types.ts').NpcMemory[] {
    const rows = this.db.prepare(`SELECT * FROM npc_memories WHERE room_id = ? AND role_id = ?${includeInactive ? '' : " AND status = 'active'"} ORDER BY sort_order, created_at`).all(roomId, roleId) as any[]
    return rows.map(rowToNpcMemory)
  }

  insertNpcMemories(roomId: string, roleId: string, entries: Array<{ id: string; sceneId?: string; turnId?: string; worldChangeId?: string; occurredAt: string; occurredLocation?: string; source: import('./types.ts').MemorySource; text: string }>): void {
    const now = new Date().toISOString()
    const insert = this.db.prepare(`INSERT OR IGNORE INTO npc_memories (id, room_id, role_id, scene_id, turn_id, world_change_id, occurred_at, occurred_location, source, kind, text, subjects, salience, confidence, dedupe_key, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    let sortOrder = Number((this.db.prepare('SELECT MAX(sort_order) AS value FROM npc_memories WHERE room_id = ? AND role_id = ?').get(roomId, roleId) as { value?: number | null }).value ?? -1) + 1
    for (const entry of entries) { const text = entry.text.trim(); if (!text) continue; const dedupe = `${entry.sceneId ?? entry.turnId ?? 'manual'}:${text}`; insert.run(entry.id, roomId, roleId, entry.sceneId ?? null, entry.turnId ?? null, entry.worldChangeId ?? null, normalizeMemoryTimeLabel(entry.occurredAt), entry.occurredLocation ?? null, entry.source, 'fact', text, '[]', 3, 1, dedupe, sortOrder++, now, now) }
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  retractNpcMemory(roomId: string, memoryId: string): void { this.db.prepare("UPDATE npc_memories SET status = 'retracted', updated_at = ? WHERE room_id = ? AND id = ?").run(new Date().toISOString(), roomId, memoryId) }

  updateNpcMemory(roomId: string, memoryId: string, entry: { text?: string; occurredAt?: string }): void {
    const current = this.db.prepare('SELECT id FROM npc_memories WHERE room_id = ? AND id = ?').get(roomId, memoryId)
    if (!current) throw new Error('记忆不存在。')
    const text = String(entry.text ?? '').trim()
    if (!text) throw new Error('记忆内容不能为空。')
    this.db.prepare('UPDATE npc_memories SET text = ?, occurred_at = ?, updated_at = ? WHERE room_id = ? AND id = ?')
      .run(text, normalizeMemoryTimeLabel(entry.occurredAt), new Date().toISOString(), roomId, memoryId)
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  /** 调整同一角色所有有效记忆的顺序（memoryIds 必须是完整列表）。 */
  reorderNpcMemories(roomId: string, roleId: string, memoryIds: string[]): void {
    const known = new Set(this.db.prepare("SELECT id FROM npc_memories WHERE room_id = ? AND role_id = ? AND status = 'active'").all(roomId, roleId).map((row: any) => row.id as string))
    if (memoryIds.length !== known.size || new Set(memoryIds).size !== known.size || memoryIds.some(id => !known.has(id))) throw new Error('记忆顺序列表与现有记忆不一致。')
    const update = this.db.prepare('UPDATE npc_memories SET sort_order = ?, updated_at = ? WHERE room_id = ? AND id = ?')
    const now = new Date().toISOString()
    this.withTransaction(() => memoryIds.forEach((memoryId, index) => update.run(index, now, roomId, memoryId)))
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  seedNpcMemories(roomId: string, roleId: string, timeline: Record<string, string[]> | undefined, source: import('./types.ts').MemorySource = 'import', initialMemories?: import('./types.ts').InitialMemory[]): void {
    const entries = initialMemories?.length
      ? initialMemories.map((memory, index) => ({ id: `story-${roomId}-${roleId}-${index}`, occurredAt: normalizeMemoryTimeLabel(memory.occurredAt), source: 'story' as const, text: String(memory.text ?? '') })).sort((left, right) => Number(left.occurredAt !== '过去') - Number(right.occurredAt !== '过去'))
      : Object.entries(normalizeMemoryTimeline(timeline)).flatMap(([occurredAt, items], index) => items.map((text, itemIndex) => ({ id: `import-${roomId}-${roleId}-${index}-${itemIndex}`, occurredAt, source, text: String(text ?? '') })))
    this.insertNpcMemories(roomId, roleId, entries)
  }

  supersedeNpcMemory(roomId: string, memoryId: string, replacement: { id: string; text: string; occurredAt: string }): void {
    const prior = this.db.prepare("SELECT role_id FROM npc_memories WHERE room_id = ? AND id = ? AND status = 'active'").get(roomId, memoryId) as { role_id: string } | undefined
    if (!prior) throw new Error('可替代的记忆不存在。')
    this.insertNpcMemories(roomId, prior.role_id, [{ ...replacement, source: 'manual' }])
    this.db.prepare("UPDATE npc_memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE room_id = ? AND id = ?").run(replacement.id, new Date().toISOString(), roomId, memoryId)
  }

  getRoom(roomId: string): RoomSnapshot | undefined {
    const room = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as {
      id: string; title: string; player_name: string; player_persona: string; player_state: string; player_portrait_ref: string; scene_time: string | null; scene_location: string | null; phase: RoomPhase; revision: number; player_contribution: string | null; last_error: string | null; mode: string; auto_publish: number; speech: string | null; pending_world_change: string | null; pending_narration: string | null
    } | undefined
    if (!room) return undefined
    const roles = this.db.prepare('SELECT * FROM roles WHERE room_id = ? ORDER BY sort_order, rowid').all(roomId).map((row: any) => ({ ...rowToRole(row), memories: this.listNpcMemories(roomId, String(row.id)) }))
    const turn = this.db.prepare('SELECT id FROM turns WHERE room_id = ? ORDER BY created_at DESC LIMIT 1').get(roomId) as { id: string } | undefined
    const decisions = turn ? this.db.prepare('SELECT * FROM decisions WHERE turn_id = ? ORDER BY rowid').all(turn.id).map(rowToDecision) : []
    const reactions = turn ? this.db.prepare('SELECT turn_id, role_id, text, created_at FROM reaction_previews WHERE turn_id = ? ORDER BY id').all(turn.id).map((row: any) => ({ turnId: row.turn_id, roleId: row.role_id, text: row.text, createdAt: row.created_at })) : []
    const draftRow = this.db.prepare('SELECT * FROM drafts WHERE room_id = ? ORDER BY created_at DESC LIMIT 1').get(roomId)
    const scenes = this.db.prepare('SELECT * FROM scenes WHERE room_id = ? ORDER BY created_at').all(roomId).map(rowToScene)
    const consultations = this.db.prepare('SELECT role, text, usage, thinking, created_at FROM consultations WHERE room_id = ? ORDER BY id').all(roomId).map(rowToConsultation)
    const speech = room.speech ? JSON.parse(room.speech) as import('./types.ts').ChatSpeech : undefined
    const pendingWorldChange = room.pending_world_change ? JSON.parse(room.pending_world_change) as import('./types.ts').WorldChangeRequest : undefined
    return {
      id: room.id,
      title: room.title,
      ...(room.story_id ? { storyId: room.story_id } : {}),
      mode: room.mode === 'chat' ? 'chat' : 'director',
      autoPublish: room.auto_publish === 1,
      ...(speech ? { speech } : {}),
      ...(pendingWorldChange ? { pendingWorldChange } : {}),
      ...(room.pending_narration ? { pendingNarration: room.pending_narration } : {}),
      playerCharacter: { name: room.player_name, persona: room.player_persona, currentState: room.player_state, ...(room.player_portrait_ref && room.player_portrait_ref !== '/assets/default.svg' ? { portraitRef: room.player_portrait_ref } : {}) },
      phase: room.phase,
      revision: room.revision,
      ...(room.player_contribution ? { playerContribution: room.player_contribution } : {}),
      ...(room.scene_time ? { sceneTime: room.scene_time } : {}),
      ...(room.scene_location ? { sceneLocation: room.scene_location } : {}),
      consultations,
      roles,
      reactions,
      decisions,
      ...(draftRow ? { draft: rowToDraft(draftRow) } : {}),
      scenes,
      ...(room.last_error ? { lastError: room.last_error } : {}),
      lore: JSON.parse(room.lore ?? '[]') as import('./types.ts').LoreEntry[],
    }
  }

  updatePlayerCharacter(roomId: string, player: { name: string; persona: string; currentState: string }): void {
    const room = this.db.prepare('SELECT phase FROM rooms WHERE id = ?').get(roomId) as { phase: RoomPhase } | undefined
    if (!room) throw new Error('Room not found.')
    if (room.phase !== 'awaiting-player-input') throw new Error('玩家角色只能在空闲阶段修改。')
    if (!player.name.trim() || !player.persona.trim() || !player.currentState.trim()) throw new Error('玩家角色字段不能为空。')
    this.db.prepare('UPDATE rooms SET player_name = ?, player_persona = ?, player_state = ?, revision = revision + 1 WHERE id = ?').run(player.name.trim(), player.persona.trim(), player.currentState.trim(), roomId)
  }

  getLatestTurnId(roomId: string): string | undefined {
    return (this.db.prepare('SELECT id FROM turns WHERE room_id = ? ORDER BY created_at DESC LIMIT 1').get(roomId) as { id: string } | undefined)?.id
  }

  /**
   * 当前回合相关的导演咨询/设定记录（避免全房间历史无限膨胀导演提示词）：
   * - 本回合草稿（turn_id 匹配）下挂的咨询消息；
   * - 最近一次已批准 Scene 之后新增的无草稿设定（draft_id IS NULL）。
   * 上一回合的咨询与设定不会进入本回合的导演上下文。
   */
  listConsultationsForTurn(roomId: string, turnId: string): ConsultationMessage[] {
    const turn = this.db.prepare('SELECT created_at FROM turns WHERE id = ?').get(turnId) as { created_at: string } | undefined
    if (!turn) return []
    const lastScene = this.db.prepare('SELECT created_at FROM scenes WHERE room_id = ? ORDER BY created_at DESC LIMIT 1').get(roomId) as { created_at: string } | undefined
    const anchor = lastScene?.created_at ?? '1970-01-01T00:00:00.000Z'
    const rows = this.db.prepare(`
      SELECT role, text, usage, thinking, created_at FROM consultations
      WHERE room_id = ? AND created_at >= ?
        AND (draft_id IS NULL OR draft_id IN (SELECT id FROM drafts WHERE room_id = ? AND turn_id = ?))
      ORDER BY id
    `).all(roomId, anchor, roomId, turnId)
    return rows.map(rowToConsultation)
  }

  createTurn(roomId: string, turnId: string, contribution: string, decisions: Decision[], phase: RoomPhase = 'collecting-decisions'): void {
    this.withTransaction(() => {
      this.db.prepare('UPDATE rooms SET phase = ?, revision = revision + 1, player_contribution = ?, last_error = NULL WHERE id = ?')
        .run(phase, contribution, roomId)
      this.db.prepare('INSERT INTO turns (id, room_id, contribution, created_at) VALUES (?, ?, ?, ?)')
        .run(turnId, roomId, contribution, new Date().toISOString())
      const insert = this.db.prepare('INSERT INTO decisions (turn_id, role_id, participation, status) VALUES (?, ?, ?, ?)')
      for (const decision of decisions) insert.run(turnId, decision.roleId, decision.participation, decision.status)
    })
  }

  /** 群聊模式：暂存玩家贡献作为上下文（不进入决策流程），等待点选角色发言 */
  setContribution(roomId: string, text: string): void {
    const room = this.db.prepare('SELECT phase FROM rooms WHERE id = ?').get(roomId) as { phase: string } | undefined
    if (!room) throw new Error('Room not found.')
    if (room.phase !== 'awaiting-player-input') throw new Error('当前无法提交贡献。')
    this.db.prepare('UPDATE rooms SET player_contribution = ?, revision = revision + 1 WHERE id = ?').run(String(text ?? ''), roomId)
  }

  /** 群聊模式：设置待审批台词（rooms.speech），房间进入 awaiting-approval；若附带世界变更申请则进入 world-change-approval */
  saveSpeech(roomId: string, speech: import('./types.ts').ChatSpeech): void {
    const hasWorldChange = !!(speech.worldChange && Object.keys(speech.worldChange).some(key => key !== 'reason' && (speech.worldChange as Record<string, unknown>)[key] !== undefined && (speech.worldChange as Record<string, unknown>)[key] !== ''))
    const pending = hasWorldChange ? JSON.stringify(speech.worldChange) : null
    let worldChangeId: string | undefined
    if (hasWorldChange && speech.worldChange) worldChangeId = this.createWorldChange(roomId, speech.worldChange, 'speech', speech.turnId)
    this.db.prepare("UPDATE rooms SET speech = ?, pending_world_change = ?, pending_world_change_id = ?, pending_narration = NULL, phase = ?, last_error = NULL, revision = revision + 1 WHERE id = ?")
      .run(JSON.stringify({ ...speech, ...(worldChangeId ? { worldChangeId } : {}) }), pending, worldChangeId ?? null, hasWorldChange ? 'world-change-approval' : 'awaiting-approval', roomId)
    // 该角色已产出台词 → 决策标记完成，避免左侧栏停留在「正在回应」
    if (speech.turnId && speech.roleId) {
      this.db.prepare("UPDATE decisions SET status = 'completed' WHERE turn_id = ? AND role_id = ?").run(speech.turnId, speech.roleId)
    }
  }

  /**
   * 群聊模式：把玩家提交的行动作为一条气泡插入对话流（speaker = 'player'）。
   * 类似酒馆——玩家发送的信息立即显示在屏幕上，而非仅存为隐藏的 player_contribution。
   */
  addPlayerScene(roomId: string, text: string): void {
    const room = this.db.prepare('SELECT phase, scene_time, scene_location FROM rooms WHERE id = ?').get(roomId) as { phase: string; scene_time: string | null; scene_location: string | null } | undefined
    if (!room) throw new Error('Room not found.')
    if (room.phase !== 'awaiting-player-input') throw new Error('当前无法提交玩家消息。')
    const trimmed = String(text ?? '').trim()
    if (!trimmed) return
    const turnId = randomUUID()
    const effectiveTime = room.scene_time?.trim() || '过去'
    const effectiveLocation = room.scene_location?.trim() || ''
    this.db.prepare('INSERT INTO scenes (id, room_id, turn_id, text, scene_time, scene_location, usage, created_at, speaker) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(`scene-${Date.now()}`, roomId, turnId, trimmed, effectiveTime || null, effectiveLocation || null, new Date().toISOString(), 'player')
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  /**
   * 群聊模式：批准台词并发布为 Scene（玩家可在批准前编辑正文）。
   * 发布后清空 speech 与玩家贡献；记忆同步由调用方触发 digest（在场角色并行消化）。
   */
  approveSpeech(roomId: string, text: string, usage?: import('./types.ts').TokenUsage, worldChangeOverride?: import('./types.ts').WorldChangeRequest | null): string | undefined {
    const room = this.db.prepare('SELECT speech, phase, scene_time, scene_location, pending_world_change, pending_world_change_id FROM rooms WHERE id = ?').get(roomId) as { speech: string | null; phase: string; scene_time: string | null; scene_location: string | null; pending_world_change: string | null; pending_world_change_id: string | null } | undefined
    if (!room) throw new Error('Room not found.')
    if (!['awaiting-approval', 'world-change-approval'].includes(room.phase) || !room.speech) throw new Error('当前没有待审批的台词。')
    const speech = JSON.parse(room.speech) as import('./types.ts').ChatSpeech
    const trimmed = text.trim()
    if (!trimmed) throw new Error('台词内容为空。')
    return this.withTransaction(() => {
      // 绑定审批：批准台词时一并落地随台词附带的世界变更申请（更新场景时间/地点、创建新人物、切换进离场）
      let worldChangeId = room.pending_world_change_id ?? (speech as import('./types.ts').ChatSpeech & { worldChangeId?: string }).worldChangeId
      if (room.phase === 'world-change-approval' && room.pending_world_change) {
        const stored = JSON.parse(room.pending_world_change) as import('./types.ts').WorldChangeRequest
        // 前端可提交编辑后的覆盖值；未覆盖的字段沿用角色原本的申请（合并而非整体替换）
        const change: import('./types.ts').WorldChangeRequest = {
          ...(stored.sceneTime ? { sceneTime: stored.sceneTime } : {}),
          ...(stored.sceneLocation ? { sceneLocation: stored.sceneLocation } : {}),
          ...(stored.roleProposals ? { roleProposals: stored.roleProposals } : {}),
          ...(stored.rolePresence ? { rolePresence: stored.rolePresence } : {}),
          ...(stored.reason ? { reason: stored.reason } : {}),
          ...(worldChangeOverride?.sceneTime ? { sceneTime: worldChangeOverride.sceneTime } : {}),
          ...(worldChangeOverride?.sceneLocation ? { sceneLocation: worldChangeOverride.sceneLocation } : {}),
        }
        this.applyWorldChangeLocked(roomId, change)
        if (!worldChangeId) worldChangeId = this.createWorldChange(roomId, stored, 'speech', speech.turnId)
        this.approveWorldChangeRecord(worldChangeId, roomId, change)
      }
      const current = this.db.prepare('SELECT scene_time, scene_location FROM rooms WHERE id = ?').get(roomId) as { scene_time: string | null; scene_location: string | null }
      const effectiveTime = current.scene_time?.trim() || '过去'
      const effectiveLocation = current.scene_location?.trim() || ''
      const sceneId = `scene-${randomUUID()}`
      this.db.prepare('INSERT INTO scenes (id, room_id, turn_id, text, scene_time, scene_location, usage, scene_kind, world_change_id, created_at, speaker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(sceneId, roomId, speech.turnId, trimmed, effectiveTime || null, effectiveLocation || null, JSON.stringify(usage ?? speech.usage ?? { promptTokens: 0, completionTokens: 0 }), 'dialogue', worldChangeId ?? null, new Date().toISOString(), speech.roleId)
      this.db.prepare("UPDATE rooms SET speech = NULL, pending_world_change = NULL, pending_world_change_id = NULL, phase = 'awaiting-player-input', revision = revision + 1, player_contribution = NULL WHERE id = ?").run(roomId)
      return worldChangeId ?? undefined
    })
  }

  rejectSpeech(roomId: string): import('./types.ts').ChatSpeech {
    const room = this.db.prepare('SELECT speech, phase, pending_world_change_id FROM rooms WHERE id = ?').get(roomId) as { speech: string | null; phase: string; pending_world_change_id: string | null } | undefined
    if (!room) throw new Error('Room not found.')
    if (!['awaiting-approval', 'world-change-approval'].includes(room.phase) || !room.speech) throw new Error('当前没有待拒绝的台词。')
    const speech = JSON.parse(room.speech) as import('./types.ts').ChatSpeech
    if (room.pending_world_change_id) this.rejectWorldChangeRecord(room.pending_world_change_id, roomId)
    this.db.prepare("UPDATE rooms SET speech = NULL, pending_world_change = NULL, pending_world_change_id = NULL, pending_narration = NULL, phase = 'awaiting-player-input', revision = revision + 1 WHERE id = ?").run(roomId)
    return speech
  }

  /**
   * 在已有事务内落地一条世界变更申请（改场景时间/地点、创建新人物）。
   * 仅在 approveSpeech 的 withTransaction 内调用；不自行开启事务。
   */
  private applyWorldChangeLocked(roomId: string, change: import('./types.ts').WorldChangeRequest): void {
    if (change.sceneTime !== undefined || change.sceneLocation !== undefined) {
      const sets: string[] = []
      const params: Array<string | null> = []
      if (change.sceneTime !== undefined && change.sceneTime.trim()) { sets.push('scene_time = ?'); params.push(change.sceneTime.trim()) }
      if (change.sceneLocation !== undefined && change.sceneLocation.trim()) { sets.push('scene_location = ?'); params.push(change.sceneLocation.trim()) }
      if (sets.length > 0) { params.push(roomId); this.db.prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`).run(...params) }
    }
    const proposals = (change.roleProposals ?? []).filter(proposal => proposal?.id && proposal?.name && proposal?.currentState && proposal?.selfModel)
    if (proposals.length > 0) {
      const existing = new Set(this.db.prepare('SELECT id FROM roles WHERE room_id = ?').all(roomId).map((row: any) => row.id as string))
      const insert = this.db.prepare('INSERT INTO roles (room_id, id, name, portrait_ref, current_state, presence, memory_timeline, goals, self_model, impressions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const proposal of proposals) {
        if (existing.has(proposal.id)) continue
        insert.run(roomId, proposal.id, proposal.name, proposal.portraitRef ?? '/assets/default.svg', proposal.currentState, proposal.presence ?? 'present', JSON.stringify(normalizeMemoryTimeline(proposal.memoryTimeline)), JSON.stringify(proposal.goals ?? []), proposal.selfModel, '{}')
        this.seedNpcMemories(roomId, proposal.id, proposal.memoryTimeline)
        existing.add(proposal.id)
      }
    }
    // 人物进/离场切换：presence 只能是合法值之一
    const presenceChanges = (change.rolePresence ?? []).filter(item => item && item.roleId && ['present', 'absent', 'unavailable'].includes(item.presence))
    if (presenceChanges.length > 0) {
      const update = this.db.prepare('UPDATE roles SET presence = ? WHERE room_id = ? AND id = ?')
      for (const item of presenceChanges) update.run(item.presence, roomId, item.roleId)
    }
  }

  private createWorldChange(roomId: string, request: import('./types.ts').WorldChangeRequest, source: 'speech' | 'director', turnId?: string): string {
    const before = this.db.prepare('SELECT scene_time, scene_location FROM rooms WHERE id = ?').get(roomId) as { scene_time: string | null; scene_location: string | null } | undefined
    const id = `world-change-${randomUUID()}`
    this.db.prepare('INSERT INTO world_changes (id, room_id, turn_id, source, status, request, before_scene_time, before_scene_location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, roomId, turnId ?? null, source, 'proposed', JSON.stringify(request), before?.scene_time ?? null, before?.scene_location ?? null, new Date().toISOString())
    return id
  }

  private approveWorldChangeRecord(id: string, roomId: string, request: import('./types.ts').WorldChangeRequest): void {
    const after = this.db.prepare('SELECT scene_time, scene_location FROM rooms WHERE id = ?').get(roomId) as { scene_time: string | null; scene_location: string | null } | undefined
    this.db.prepare("UPDATE world_changes SET status = 'approved', approved_request = ?, after_scene_time = ?, after_scene_location = ?, approved_at = ? WHERE id = ? AND room_id = ?")
      .run(JSON.stringify(request), after?.scene_time ?? null, after?.scene_location ?? null, new Date().toISOString(), id, roomId)
  }

  private rejectWorldChangeRecord(id: string, roomId: string): void {
    this.db.prepare("UPDATE world_changes SET status = 'rejected', rejected_at = ? WHERE id = ? AND room_id = ? AND status = 'proposed'").run(new Date().toISOString(), id, roomId)
  }

  listWorldChanges(roomId: string): import('./types.ts').WorldChangeRecord[] {
    return this.db.prepare('SELECT * FROM world_changes WHERE room_id = ? ORDER BY created_at').all(roomId).map(rowToWorldChange)
  }

  /**
   * 群聊模式：导演对话产出的世界变更申请（无台词），房间进入 world-change-approval。
   * narration 为导演同一次调用预产的叙述文本，玩家批准后写为 narration scene。
   */
  saveWorldChange(roomId: string, change: import('./types.ts').WorldChangeRequest, narration?: string): string {
    const id = this.createWorldChange(roomId, change, 'director')
    this.db.prepare("UPDATE rooms SET speech = NULL, pending_world_change = ?, pending_world_change_id = ?, pending_narration = ?, phase = 'world-change-approval', last_error = NULL, revision = revision + 1 WHERE id = ?")
      .run(JSON.stringify(change), id, narration?.trim() || null, roomId)
    return id
  }

  /** 群聊模式：玩家批准导演对话产出的世界变更申请（无台词）→ 落地变更并清空申请 */
  approveWorldChange(roomId: string, override?: import('./types.ts').WorldChangeRequest | null): string {
    const room = this.db.prepare('SELECT phase, pending_world_change, pending_world_change_id, scene_time, scene_location FROM rooms WHERE id = ?').get(roomId) as { phase: string; pending_world_change: string | null; pending_world_change_id: string | null; scene_time: string | null; scene_location: string | null } | undefined
    if (!room) throw new Error('Room not found.')
    if (room.phase !== 'world-change-approval' || !room.pending_world_change) throw new Error('当前没有待确认的世界变更申请。')
    return this.withTransaction(() => {
      const stored = JSON.parse(room.pending_world_change) as import('./types.ts').WorldChangeRequest
      const change: import('./types.ts').WorldChangeRequest = {
        ...(stored.sceneTime ? { sceneTime: stored.sceneTime } : {}),
        ...(stored.sceneLocation ? { sceneLocation: stored.sceneLocation } : {}),
        ...(stored.roleProposals ? { roleProposals: stored.roleProposals } : {}),
        ...(stored.rolePresence ? { rolePresence: stored.rolePresence } : {}),
        ...(stored.reason ? { reason: stored.reason } : {}),
        ...(override?.sceneTime ? { sceneTime: override.sceneTime } : {}),
        ...(override?.sceneLocation ? { sceneLocation: override.sceneLocation } : {}),
      }
      this.applyWorldChangeLocked(roomId, change)
      const id = room.pending_world_change_id ?? this.createWorldChange(roomId, stored, 'director')
      this.approveWorldChangeRecord(id, roomId, change)
      this.db.prepare("UPDATE rooms SET pending_world_change = NULL, pending_world_change_id = NULL, pending_narration = NULL, phase = 'awaiting-player-input', revision = revision + 1, player_contribution = NULL, last_error = NULL WHERE id = ?").run(roomId)
      return id
    })
  }

  /** 群聊模式：玩家拒绝导演对话产出的世界变更申请 → 清空申请，回到空闲态 */
  rejectWorldChange(roomId: string): void {
    const room = this.db.prepare('SELECT phase, pending_world_change_id FROM rooms WHERE id = ?').get(roomId) as { phase: string; pending_world_change_id: string | null } | undefined
    if (!room || room.phase !== 'world-change-approval') throw new Error('当前没有待确认的世界变更申请。')
    if (room.pending_world_change_id) this.rejectWorldChangeRecord(room.pending_world_change_id, roomId)
    this.db.prepare("UPDATE rooms SET pending_world_change = NULL, pending_world_change_id = NULL, pending_narration = NULL, phase = 'awaiting-player-input', revision = revision + 1, last_error = NULL WHERE id = ?").run(roomId)
  }

  /** 群聊模式：把导演写的一段叙述（世界变更落地后的世界变化描写）发布为 narration scene（无 speaker，非对话气泡） */
  addNarrationScene(roomId: string, text: string, usage?: import('./types.ts').TokenUsage, worldChangeId?: string): string | undefined {
    const room = this.db.prepare('SELECT scene_time, scene_location FROM rooms WHERE id = ?').get(roomId) as { scene_time: string | null; scene_location: string | null } | undefined
    if (!room) throw new Error('Room not found.')
    const trimmed = String(text ?? '').trim()
    if (!trimmed) return undefined
    const effectiveTime = room.scene_time?.trim() || '过去'
    const effectiveLocation = room.scene_location?.trim() || ''
    const sceneId = `narration-${randomUUID()}`
    this.db.prepare('INSERT INTO scenes (id, room_id, turn_id, text, scene_time, scene_location, usage, scene_kind, world_change_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sceneId, roomId, 'world-change', trimmed, effectiveTime || null, effectiveLocation || null, usage ? JSON.stringify(usage) : null, 'narration', worldChangeId ?? null, new Date().toISOString())
    if (worldChangeId) this.db.prepare('UPDATE world_changes SET narration_scene_id = ? WHERE id = ? AND room_id = ?').run(sceneId, worldChangeId, roomId)
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
    return sceneId
  }

  /** 群聊模式：把角色消化结果并入记忆时间线（parse 事件并入对应时间桶，带去重） */
  appendMemoryEvents(roomId: string, roleId: string, events: Record<string, string[]>, options: { fuzzy?: boolean } = {}): void {
    if (!events || Object.keys(events).length === 0) return
    const row = this.db.prepare('SELECT memory_timeline FROM roles WHERE room_id = ? AND id = ?').get(roomId, roleId) as { memory_timeline: string } | undefined
    if (!row) return
    const timeline = JSON.parse(row.memory_timeline ?? '{}') as Record<string, string[]>
    let changed = false
    for (const [when, items] of Object.entries(events)) {
      if (!Array.isArray(items)) continue
      for (const item of items) {
        const text = String(item ?? '').trim()
        if (!text) continue
        if (mergeTimelineEvent(timeline, when.trim() || '过去', text, options)) changed = true
      }
    }
    if (!changed) return
    this.db.prepare('UPDATE roles SET memory_timeline = ? WHERE room_id = ? AND id = ?').run(JSON.stringify(timeline), roomId, roleId)
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  /** 更新房间游玩配置：模式（导演/群聊）与沉浸模式开关（autoPublish） */
  setRoomConfig(roomId: string, config: { mode?: import('./types.ts').RoomMode; autoPublish?: boolean }): void {
    const room = this.db.prepare('SELECT phase, mode FROM rooms WHERE id = ?').get(roomId) as { phase: string; mode: string } | undefined
    if (!room) throw new Error('Room not found.')
    const sets: string[] = []
    const params: Array<string | number> = []
    if (config.mode !== undefined) {
      if (room.phase !== 'awaiting-player-input') throw new Error('切换模式需要在空闲时进行。')
      if (config.mode !== 'director' && config.mode !== 'chat') throw new Error('无效的游玩模式。')
      sets.push('mode = ?'); params.push(config.mode)
      if (config.mode === 'chat') { sets.push('speech = NULL') }
    }
    if (config.autoPublish !== undefined) { sets.push('auto_publish = ?'); params.push(config.autoPublish ? 1 : 0) }
    if (sets.length === 0) return
    params.push(roomId)
    this.db.prepare(`UPDATE rooms SET ${sets.join(', ')}, revision = revision + 1 WHERE id = ?`).run(...params)
  }

  saveReactionPreview(roomId: string, turnId: string, roleId: string, text: string): void {
    this.db.prepare('INSERT OR REPLACE INTO reaction_previews (room_id, turn_id, role_id, text, created_at) VALUES (?, ?, ?, ?, ?)').run(roomId, turnId, roleId, text, new Date().toISOString())
  }

  saveDecision(turnId: string, decision: Decision): void {
    this.db.prepare(`UPDATE decisions SET status = ?, brief = ?, private_reaction = ?, public_identity = ?, thinking = ?, usage = ?, error = ? WHERE turn_id = ? AND role_id = ?`)
      .run(decision.status, decision.brief ?? null, decision.privateReaction ?? null, decision.publicIdentity ?? null, decision.thinking ?? null, decision.usage ? JSON.stringify(decision.usage) : null, decision.error ?? null, turnId, decision.roleId)
    if (decision.privateReaction && decision.status === 'completed') {
      const room = this.db.prepare('SELECT room_id FROM turns WHERE id = ?').get(turnId) as { room_id: string } | undefined
      if (room) this.db.prepare('INSERT INTO pending_mind_updates (room_id, turn_id, role_id, private_reaction, created_at) VALUES (?, ?, ?, ?, ?)').run(room.room_id, turnId, decision.roleId, decision.privateReaction, new Date().toISOString())
    }
  }

  listPendingMindUpdates(roomId: string, turnId: string): PendingMindUpdate[] {
    return this.db.prepare('SELECT role_id, turn_id, private_reaction, created_at FROM pending_mind_updates WHERE room_id = ? AND turn_id = ? ORDER BY id').all(roomId, turnId).map((row: any) => ({ roleId: row.role_id, turnId: row.turn_id, privateReaction: row.private_reaction, createdAt: row.created_at }))
  }

  transitionToDrafting(roomId: string): void {
    this.db.prepare('UPDATE rooms SET phase = ?, revision = revision + 1 WHERE id = ?').run('drafting', roomId)
  }

  saveDraft(roomId: string, draft: Draft): void {
    this.withTransaction(() => {
      this.db.prepare('DELETE FROM drafts WHERE room_id = ?').run(roomId)
      this.db.prepare('INSERT INTO drafts (id, room_id, turn_id, text, state_updates, setting_proposals, intent_handling, open_questions, scene_updates, thinking, usage, role_proposals, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(draft.id, roomId, draft.turnId, draft.text, JSON.stringify(draft.stateUpdates), JSON.stringify(draft.settingProposals), JSON.stringify(draft.intentHandling), JSON.stringify(draft.openQuestions), JSON.stringify(draft.sceneUpdates ?? {}), draft.thinking ?? null, draft.usage ? JSON.stringify(draft.usage) : null, JSON.stringify(draft.roleProposals ?? []), draft.createdAt)
      this.db.prepare('UPDATE rooms SET phase = ?, last_error = NULL, revision = revision + 1 WHERE id = ?').run('awaiting-approval', roomId)
    })
  }

  publish(roomId: string, draftId: string, text: string, stateUpdates: Record<string, string>, sceneUpdates: { time?: string; location?: string } = {}): void {
    const draft = this.db.prepare('SELECT * FROM drafts WHERE id = ? AND room_id = ?').get(draftId, roomId) as { id: string; turn_id: string; scene_updates: string; role_proposals: string; usage: string | null } | undefined
    if (!draft) throw new Error('Draft is no longer available.')
    const roleRows = this.db.prepare('SELECT id, name FROM roles WHERE room_id = ?').all(roomId) as Array<{ id: string; name: string }>
    const roleIds = new Set(roleRows.map(row => row.id))
    const playerRow = this.db.prepare('SELECT player_name FROM rooms WHERE id = ?').get(roomId) as { player_name: string | null } | undefined
    // 接受中文显示名与玩家名作为键（导演常用角色名而非 id），归一化后再校验
    stateUpdates = normalizeStateUpdateKeys(stateUpdates, { roleNames: new Map(roleRows.map(row => [row.name, row.id])), playerName: playerRow?.player_name ?? undefined })
    const unknownRoles = Object.keys(stateUpdates).filter(roleId => roleId !== 'player' && !roleIds.has(roleId))
    if (unknownRoles.length > 0) throw new Error(`Unknown role state updates: ${unknownRoles.join(', ')}`)
    const mergedScene: { time?: string; location?: string } = { ...JSON.parse(draft.scene_updates ?? '{}'), ...sceneUpdates }
    const roleProposals = JSON.parse(draft.role_proposals ?? '[]') as Array<import('./types.ts').RoleProposal>
    const proposedIds = new Set(roleProposals.map(proposal => proposal.id))
    const unknownProposed = Object.keys(stateUpdates).filter(roleId => roleId !== 'player' && proposedIds.has(roleId))
    if (unknownProposed.length > 0) throw new Error(`Role proposals conflict with existing state updates: ${unknownProposed.join(', ')}`)
    this.withTransaction(() => {
      const insertRole = this.db.prepare('INSERT INTO roles (room_id, id, name, portrait_ref, current_state, presence, memory_timeline, goals, self_model, impressions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const proposal of roleProposals) {
        if (roleIds.has(proposal.id) || this.db.prepare('SELECT 1 FROM roles WHERE room_id = ? AND id = ?').get(roomId, proposal.id)) throw new Error(`Role already exists: ${proposal.id}`)
        insertRole.run(roomId, proposal.id, proposal.name, proposal.portraitRef, proposal.currentState, proposal.presence, JSON.stringify(normalizeMemoryTimeline(proposal.memoryTimeline)), JSON.stringify(proposal.goals ?? []), proposal.selfModel, '{}')
        this.seedNpcMemories(roomId, proposal.id, proposal.memoryTimeline)
      }
      for (const [roleId, currentState] of Object.entries(stateUpdates)) {
        if (roleId === 'player') this.db.prepare('UPDATE rooms SET player_state = ? WHERE id = ?').run(currentState, roomId)
        else this.db.prepare('UPDATE roles SET current_state = ? WHERE room_id = ? AND id = ?').run(currentState, roomId, roleId)
      }
      if (mergedScene.time !== undefined || mergedScene.location !== undefined) {
        const updates: string[] = []
        const params: Array<string | null> = []
        if (mergedScene.time !== undefined) { updates.push('scene_time = ?'); params.push(mergedScene.time) }
        if (mergedScene.location !== undefined) { updates.push('scene_location = ?'); params.push(mergedScene.location) }
        params.push(roomId)
        this.db.prepare(`UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`).run(...params)
      }
      const roomRow = this.db.prepare('SELECT scene_time, scene_location FROM rooms WHERE id = ?').get(roomId) as { scene_time: string | null; scene_location: string | null } | undefined
      const effectiveTime = (mergedScene.time?.trim() || roomRow?.scene_time?.trim()) || '过去'
      const effectiveLocation = (mergedScene.location?.trim() || roomRow?.scene_location?.trim()) || ''
      const sceneId = `scene-${randomUUID()}`
      const mindUpdates = this.db.prepare('SELECT role_id, private_reaction FROM pending_mind_updates WHERE room_id = ? AND turn_id = ? ORDER BY id').all(roomId, draft.turn_id) as Array<{ role_id: string; private_reaction: string }>
      for (const update of mindUpdates) {
        if (!update.private_reaction?.trim()) continue
        this.insertNpcMemories(roomId, update.role_id, [{ id: `reaction-${sceneId}-${update.role_id}`, sceneId, turnId: draft.turn_id, occurredAt: effectiveTime, occurredLocation: effectiveLocation || undefined, source: 'role_reaction', text: update.private_reaction.trim() }])
      }
      this.db.prepare('DELETE FROM pending_mind_updates WHERE room_id = ? AND turn_id = ?').run(roomId, draft.turn_id)
      this.db.prepare('DELETE FROM reaction_previews WHERE room_id = ? AND turn_id = ?').run(roomId, draft.turn_id)
      this.db.prepare('INSERT INTO scenes (id, room_id, turn_id, text, scene_time, scene_location, usage, scene_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(sceneId, roomId, draft.turn_id, text, effectiveTime || null, effectiveLocation || null, draft.usage ?? null, 'narration', new Date().toISOString())
      this.db.prepare('DELETE FROM drafts WHERE room_id = ?').run(roomId)
      this.db.prepare('UPDATE rooms SET phase = ?, revision = revision + 1, player_contribution = NULL WHERE id = ?')
        .run('awaiting-player-input', roomId)
    })
  }

  failRoom(roomId: string, message: string): void {
    this.db.prepare('UPDATE rooms SET last_error = ?, revision = revision + 1 WHERE id = ?').run(message, roomId)
  }

  cancelTurn(roomId: string): void {
    const phase = this.db.prepare('SELECT phase, pending_world_change_id FROM rooms WHERE id = ?').get(roomId) as { phase: RoomPhase; pending_world_change_id: string | null } | undefined
    if (!phase || !['collecting-decisions', 'drafting', 'consulting-director', 'role-speaking', 'world-change-approval'].includes(phase.phase)) throw new Error('No cancellable request is active.')
    return this.withTransaction(() => {
      this.db.prepare('DELETE FROM reaction_previews WHERE room_id = ?').run(roomId)
      if (phase.pending_world_change_id) this.rejectWorldChangeRecord(phase.pending_world_change_id, roomId)
      this.db.prepare(`UPDATE rooms SET phase = 'awaiting-player-input', revision = revision + 1, player_contribution = NULL, last_error = NULL, speech = NULL, pending_world_change = NULL, pending_world_change_id = NULL, pending_narration = NULL WHERE id = ?`).run(roomId)
    })
  }

  updateRolePrivateState(roomId: string, roleId: string, selfModel: string, memoryTimeline: Record<string, string[]> | undefined, config: { providerId?: string; modelOverride?: string; impressions?: Record<string, string>; goals?: string[]; thinkingStrength?: import('./types.ts').ThinkingStrength } = {}): void {
    const withTimeline = memoryTimeline !== undefined
    const sql = withTimeline
      ? 'UPDATE roles SET self_model = ?, memory_timeline = ?, provider_id = ?, model_override = ?, impressions = ?, goals = ?, thinking_strength = ? WHERE room_id = ? AND id = ?'
      : 'UPDATE roles SET self_model = ?, provider_id = ?, model_override = ?, impressions = ?, goals = ?, thinking_strength = ? WHERE room_id = ? AND id = ?'
    const values = withTimeline
      ? [selfModel, JSON.stringify(normalizeMemoryTimeline(memoryTimeline)), config.providerId || null, config.modelOverride || null, JSON.stringify(config.impressions ?? {}), JSON.stringify(config.goals ?? []), config.thinkingStrength || null, roomId, roleId]
      : [selfModel, config.providerId || null, config.modelOverride || null, JSON.stringify(config.impressions ?? {}), JSON.stringify(config.goals ?? []), config.thinkingStrength || null, roomId, roleId]
    const result = this.db.prepare(sql).run(...values)
    if (Number(result.changes) !== 1) throw new Error('Role not found.')
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  setRoleThinking(roomId: string, roleId: string, thinkingStrength: import('./types.ts').ThinkingStrength): void {
    if (!['off', 'brief', 'standard', 'deep'].includes(thinkingStrength)) throw new Error('无效的思维链强度。')
    const result = this.db.prepare('UPDATE roles SET thinking_strength = ? WHERE room_id = ? AND id = ?').run(thinkingStrength, roomId, roleId)
    if (Number(result.changes) !== 1) throw new Error('Role not found.')
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  /** 合并角色通过工具调用更新/删除的他人印象（null 值删除对应印象） */
  applyRoleImpressions(roomId: string, roleId: string, updates: Record<string, string | null>): void {
    if (!updates || Object.keys(updates).length === 0) return
    const row = this.db.prepare('SELECT impressions FROM roles WHERE room_id = ? AND id = ?').get(roomId, roleId) as { impressions: string } | undefined
    if (!row) return
    const impressions = JSON.parse(row.impressions ?? '{}') as Record<string, string>
    let changed = false
    for (const [name, text] of Object.entries(updates)) {
      if (text === null || text === undefined || String(text).trim() === '') { if (name in impressions) { delete impressions[name]; changed = true } }
      else { const trimmed = String(text).trim(); if (impressions[name] !== trimmed) { impressions[name] = trimmed; changed = true } }
    }
    if (!changed) return
    this.db.prepare('UPDATE roles SET impressions = ? WHERE room_id = ? AND id = ?').run(JSON.stringify(impressions), roomId, roleId)
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  /** 玩家新建角色（id 由调用方生成） */
  createRole(roomId: string, role: { id: string; name: string; portraitRef: string; currentState: string; presence: 'present' | 'absent' | 'unavailable'; selfModel: string; memoryTimeline?: Record<string, string[]>; initialMemories?: import('./types.ts').InitialMemory[]; impressions?: Record<string, string>; goals?: string[] }): void {
    const existing = this.db.prepare('SELECT 1 FROM roles WHERE room_id = ? AND id = ?').get(roomId, role.id)
    if (existing) throw new Error(`角色已存在：${role.id}`)
    this.db.prepare('INSERT INTO roles (room_id, id, name, portrait_ref, current_state, presence, memory_timeline, goals, self_model, impressions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(roomId, role.id, role.name, role.portraitRef, role.currentState, role.presence, JSON.stringify(normalizeMemoryTimeline(role.memoryTimeline)), JSON.stringify(role.goals ?? []), role.selfModel, JSON.stringify(role.impressions ?? {}))
    this.seedNpcMemories(roomId, role.id, role.memoryTimeline, 'import', role.initialMemories)
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  /** 玩家删除角色（至少保留一个角色） */
  deleteRole(roomId: string, roleId: string): void {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM roles WHERE room_id = ?').get(roomId) as { n: number }
    if (Number(count.n) <= 1) throw new Error('至少保留一个角色。')
    const result = this.db.prepare('DELETE FROM roles WHERE room_id = ? AND id = ?').run(roomId, roleId)
    if (Number(result.changes) !== 1) throw new Error('Role not found.')
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  /** 切换角色在场状态 */
  setRolePresence(roomId: string, roleId: string, presence: 'present' | 'absent' | 'unavailable'): void {
    const result = this.db.prepare('UPDATE roles SET presence = ? WHERE room_id = ? AND id = ?').run(presence, roomId, roleId)
    if (Number(result.changes) !== 1) throw new Error('Role not found.')
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  /** 更新角色头像引用 */
  setRoleAvatar(roomId: string, roleId: string, portraitRef: string): void {
    const result = this.db.prepare('UPDATE roles SET portrait_ref = ? WHERE room_id = ? AND id = ?').run(portraitRef, roomId, roleId)
    if (Number(result.changes) !== 1) throw new Error('Role not found.')
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  /** 更新主角（玩家角色）肖像引用 */
  setPlayerAvatar(roomId: string, portraitRef: string): void {
    const result = this.db.prepare('UPDATE rooms SET player_portrait_ref = ?, revision = revision + 1 WHERE id = ?').run(portraitRef, roomId)
    if (Number(result.changes) !== 1) throw new Error('Room not found.')
  }

  /** 直接修改角色当前状态（玩家点击角色状态失焦确认） */
  setRoleCurrentState(roomId: string, roleId: string, currentState: string): void {
    const result = this.db.prepare('UPDATE roles SET current_state = ? WHERE room_id = ? AND id = ?').run(currentState, roomId, roleId)
    if (Number(result.changes) !== 1) throw new Error('Role not found.')
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  /** 更新当前场景时间/地点（玩家点击修改） */
  updateScene(roomId: string, updates: { time?: string; location?: string }): void {
    const set: string[] = []
    const params: unknown[] = []
    if (updates.time !== undefined) { set.push('scene_time = ?'); params.push(updates.time) }
    if (updates.location !== undefined) { set.push('scene_location = ?'); params.push(updates.location) }
    if (set.length === 0) return
    params.push(roomId)
    this.db.prepare(`UPDATE rooms SET ${set.join(', ')}, revision = revision + 1 WHERE id = ?`).run(...params)
  }

  /** 调整角色显示顺序（roleIds 为完整排序列表） */
  reorderRoles(roomId: string, roleIds: string[]): void {
    const known = new Set(this.db.prepare('SELECT id FROM roles WHERE room_id = ?').all(roomId).map((row: any) => row.id as string))
    for (const roleId of roleIds) {
      if (!known.has(roleId)) throw new Error(`Unknown role: ${roleId}`)
    }
    if (roleIds.length !== known.size) throw new Error('Role list does not match room roles.')
    this.withTransaction(() => {
      const update = this.db.prepare('UPDATE roles SET sort_order = ? WHERE room_id = ? AND id = ?')
      roleIds.forEach((roleId, index) => update.run(index, roomId, roleId))
    })
    this.db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId)
  }

  /** 保存世界书（运行期覆盖；重开剧本回剧本文件的 lore） */
  saveLore(roomId: string, lore: import('./types.ts').LoreEntry[]): void {
    this.db.prepare('UPDATE rooms SET lore = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify(lore), roomId)
  }

  startConsultation(roomId: string, draftId: string): void {
    const draft = this.db.prepare('SELECT id FROM drafts WHERE id = ? AND room_id = ?').get(draftId, roomId)
    if (!draft) throw new Error('Draft is no longer available.')
    this.db.prepare("UPDATE rooms SET phase = 'consulting-director', revision = revision + 1 WHERE id = ?").run(roomId)
  }

  addConsultation(roomId: string, draftId: string | null, role: ConsultationMessage['role'], text: string, usage?: import('./types.ts').TokenUsage, thinking?: string): void {
    this.db.prepare('INSERT INTO consultations (room_id, draft_id, role, text, usage, thinking, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(roomId, draftId, role, text, usage ? JSON.stringify(usage) : null, thinking || null, new Date().toISOString())
  }

  finishConsultation(roomId: string): void {
    const phase = this.db.prepare('SELECT phase FROM rooms WHERE id = ?').get(roomId) as { phase: RoomPhase } | undefined
    if (!phase || phase.phase !== 'consulting-director') throw new Error('No director consultation is active.')
    this.db.prepare("UPDATE rooms SET phase = 'awaiting-approval', revision = revision + 1 WHERE id = ?").run(roomId)
  }

  private withTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

/**
 * 把事件并入角色记忆时间线桶，带去重（Heptalon 风格：包含判断 + 短文本字符重叠率）。
 * 返回 true 表示实际写入，false 表示与既有记忆重复。
 */
export function mergeTimelineEvent(timeline: Record<string, string[]>, when: string, event: string, options: { fuzzy?: boolean } = {}): boolean {
  const fuzzy = options.fuzzy !== false
  const bucket = timeline[when] ?? []
  for (const existing of bucket) {
    if (event === existing || event.includes(existing) || existing.includes(event)) return false
    if (!fuzzy) continue
    const shorter = event.length <= existing.length ? event : existing
    const longer = event.length <= existing.length ? existing : event
    if (shorter.length > 8) {
      let overlap = 0
      for (const char of shorter) if (longer.includes(char)) overlap++
      if (overlap / shorter.length > 0.55) return false
    }
  }
  bucket.push(event)
  timeline[when] = bucket
  return true
}

function rowToNpcMemory(row: any): import('./types.ts').NpcMemory { return { id: row.id, roomId: row.room_id, roleId: row.role_id, ...(row.scene_id ? { sceneId: row.scene_id } : {}), ...(row.turn_id ? { turnId: row.turn_id } : {}), ...(row.world_change_id ? { worldChangeId: row.world_change_id } : {}), occurredAt: row.occurred_at, ...(row.occurred_location ? { occurredLocation: row.occurred_location } : {}), source: row.source, text: row.text, visibility: 'private', status: row.status, supersedes: JSON.parse(row.supersedes ?? '[]'), ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}), dedupeKey: row.dedupe_key, createdAt: row.created_at, updatedAt: row.updated_at } }

function rowToRole(row: any): Role {
  const impressions = JSON.parse(row.impressions ?? '{}') as Record<string, string>
  const goals = JSON.parse(row.goals ?? '[]') as string[]
  return {
    id: row.id, name: row.name, portraitRef: row.portrait_ref, currentState: row.current_state,
    presence: row.presence, memoryTimeline: JSON.parse(row.memory_timeline ?? '{}') as Record<string, string[]>, selfModel: row.self_model,
    ...(Object.keys(impressions).length > 0 ? { impressions } : {}),
    ...(goals.length > 0 ? { goals } : {}),
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    ...(row.model_override ? { modelOverride: row.model_override } : {}),
    ...(row.thinking_strength && ['off', 'brief', 'standard', 'deep'].includes(row.thinking_strength) ? { thinkingStrength: row.thinking_strength } : {}),
  }
}
function rowToDecision(row: any): Decision {
  return { roleId: row.role_id, participation: row.participation, status: row.status, ...(row.brief ? { brief: row.brief } : {}), ...(row.private_reaction ? { privateReaction: row.private_reaction } : {}), ...(row.public_identity ? { publicIdentity: row.public_identity } : {}), ...(row.thinking ? { thinking: row.thinking } : {}), ...(row.usage ? { usage: JSON.parse(row.usage) } : {}), ...(row.error ? { error: row.error } : {}) }
}
function rowToDraft(row: any): Draft {
  return {
    id: row.id,
    turnId: row.turn_id,
    text: row.text,
    stateUpdates: JSON.parse(row.state_updates),
    settingProposals: JSON.parse(row.setting_proposals ?? '[]'),
    intentHandling: JSON.parse(row.intent_handling ?? '[]'),
    openQuestions: JSON.parse(row.open_questions ?? '[]'),
    ...(row.scene_updates && row.scene_updates !== '{}' ? { sceneUpdates: JSON.parse(row.scene_updates) } : {}),
    ...(row.role_proposals && row.role_proposals !== '[]' ? { roleProposals: JSON.parse(row.role_proposals) } : {}),
    ...(row.thinking ? { thinking: row.thinking } : {}),
    ...(row.usage ? { usage: JSON.parse(row.usage) } : {}),
    createdAt: row.created_at,
  }
}
function rowToScene(row: any): Scene {
  return { id: row.id, turnId: row.turn_id, text: row.text, ...(row.speaker ? { speaker: row.speaker } : {}), ...(row.scene_kind ? { kind: row.scene_kind } : {}), ...(row.world_change_id ? { worldChangeId: row.world_change_id } : {}), ...(row.scene_time ? { sceneTime: row.scene_time } : {}), ...(row.scene_location ? { sceneLocation: row.scene_location } : {}), ...(row.usage ? { usage: JSON.parse(row.usage) } : {}), createdAt: row.created_at }
}
function rowToWorldChange(row: any): import('./types.ts').WorldChangeRecord {
  return { id: row.id, roomId: row.room_id, ...(row.turn_id ? { turnId: row.turn_id } : {}), source: row.source, status: row.status, request: JSON.parse(row.request), ...(row.approved_request ? { approvedRequest: JSON.parse(row.approved_request) } : {}), ...(row.before_scene_time ? { beforeSceneTime: row.before_scene_time } : {}), ...(row.after_scene_time ? { afterSceneTime: row.after_scene_time } : {}), ...(row.before_scene_location ? { beforeSceneLocation: row.before_scene_location } : {}), ...(row.after_scene_location ? { afterSceneLocation: row.after_scene_location } : {}), ...(row.narration_scene_id ? { narrationSceneId: row.narration_scene_id } : {}), createdAt: row.created_at, ...(row.approved_at ? { approvedAt: row.approved_at } : {}), ...(row.rejected_at ? { rejectedAt: row.rejected_at } : {}) }
}
function rowToConsultation(row: any): ConsultationMessage {
  return { role: row.role, text: row.text, ...(row.usage ? { usage: JSON.parse(row.usage) } : {}), ...(row.thinking ? { thinking: row.thinking } : {}), createdAt: row.created_at }
}
