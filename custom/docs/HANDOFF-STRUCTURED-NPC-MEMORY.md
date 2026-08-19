# Character Tavern / StageCraft 待做工作交接文档

> 交接目标：把 NPC 记忆从旧的 `memoryTimeline: Record<string, string[]>` 增量文本桶，迁移为按 Scene / World Change 关联的结构化私有记忆系统，并完成角色管理器的结构化记忆编辑 UI。
>
> 项目路径：`D:\AI\AIRP\character-tavern`
>
> 这份文档给下一工作环境使用。先读完本文件，再开始修改代码。

---

## 1. 当前工作区状态

当前工作区已经提交，最近提交如下：

```text
6788776 feat(memory): expose structured NPC memory management
3cc10b2 feat(ui): add tabbed NPC role editor layout
c387421 feat(memory): add structured NPC memory storage foundation
24062d9 fix(chat): reject speech and regenerate with feedback
a36ef86 fix(ui): keep existing controls as interaction surfaces
8420f16 fix(server): serve Core frontend module assets
aab4a7c fix(ui): prevent missing optional controls from aborting app startup
f724ca7 fix(ui): keep legacy app boot alive when Core helpers fail
```

基线测试：

```text
pnpm test
153 passed
0 failed
```

工作区交接前应先运行：

```powershell
cd D:\AI\AIRP\character-tavern
pnpm test
```

不要直接用没有文件范围的：

```text
node --experimental-strip-types --test
```

它可能扫描不该扫描的测试目录。

---

## 2. 重要边界和已确认决策

用户已经明确：

```text
只考虑当前新存档
已有存档不必兼容
```

因此最终目标不是长期维护两套记忆数据，而是：

```text
新存档直接采用 npc_memories
memoryTimeline 不再作为 canonical 数据源
```

可以在过渡阶段保留旧字段用于：

- 旧测试夹具暂时运行；
- 旧剧本 JSON 输入解析；
- 临时 UI 显示投影；

但新场景、新世界变更、新 NPC 记忆不得继续写入旧 `roles.memory_timeline` 作为真实来源。

最终应删除或停用：

```text
roles.memory_timeline
private_memory 迁移逻辑
appendMemoryEvents 作为主写入路径
整块 memoryTimeline 覆盖式编辑
```

不要重新设计成动态 Workflow、剧本迁移、Author Pack 或 Workflow Patch。这些不在当前任务范围。

---

## 3. 已完成的部分

### 3.1 结构化记忆类型基础

`src/types.ts` 已增加：

```ts
MemorySource
MemoryKind
MemoryStatus
MemoryDigestEntry
MemoryDigest
NpcMemory
```

目标类型大致为：

```ts
export type MemorySource =
  | 'story'
  | 'world_change'
  | 'role_reaction'
  | 'manual'
  | 'import'

export type MemoryKind =
  | 'fact'
  | 'observation'
  | 'interaction'
  | 'promise'
  | 'relationship'
  | 'belief'
  | 'emotion'
  | 'goal_update'

export type MemoryStatus =
  | 'active'
  | 'superseded'
  | 'retracted'
  | 'archived'

export interface MemoryDigestEntry {
  kind: MemoryKind
  text: string
  subjects: string[]
  salience: 1 | 2 | 3 | 4 | 5
  confidence: 0 | 0.25 | 0.5 | 0.75 | 1
}
```

`MemoryDigest` 当前是：

```ts
{
  entries?: MemoryDigestEntry[]
  events?: Record<string, string[]>
}
```

注意：`events` 只是过渡字段，目前代码里自动 digest 还没有完全切换到 `entries`。

### 3.2 `npc_memories` 表

`src/store.ts` 的初始化 SQL 已创建：

```text
npc_memories
```

字段包括：

```text
id
room_id
role_id
scene_id
turn_id
world_change_id
occurred_at
occurred_location
source
kind
text
subjects
visibility
salience
confidence
status
supersedes
superseded_by
dedupe_key
created_at
updated_at
```

已有索引：

```text
(room_id, role_id, status, occurred_at)
(room_id, world_change_id)
```

当前表是新建表，不提供旧数据迁移。

### 3.3 Store 记忆 API

`src/store.ts` 已有：

```ts
listNpcMemories(roomId, roleId, includeInactive?)
insertNpcMemories(roomId, roleId, entries)
retractNpcMemory(roomId, memoryId)
```

`insertNpcMemories()` 已做：

- 文本 trim；
- salience 限制在 1-5；
- confidence 限制在 0-1；
- `INSERT OR IGNORE`；
- 根据 scene/turn/kind/text 生成 dedupe key；
- 写入时间。

### 3.4 角色快照

`Store.getRoom()` 已把 active `npc_memories` 挂到角色对象：

```ts
role.memories
```

但当前 `Role` 仍然保留旧 `memoryTimeline`，因为自动 digest 和现有测试尚未完全迁移。

### 3.5 记忆管理 API

`src/app-boot.ts` 已增加：

```text
GET  /api/roles/memories?roleId=<roleId>
POST /api/roles/memories
POST /api/roles/memories/retract
```

当前手动写入 payload 大致为：

```json
{
  "roleId": "aria",
  "entries": [
    {
      "text": "玩家承认曾经隐瞒伤势。",
      "kind": "fact",
      "subjects": ["player"],
      "occurredAt": "夜晚",
      "salience": 4,
      "confidence": 1
    }
  ]
}
```

运行时方法位于 `src/room-runtime.ts`：

```ts
storeNpcMemories(roomId, roleId, entries)
retractNpcMemory(roomId, memoryId)
```

手动修改要求房间处于：

```text
awaiting-player-input
```

### 3.6 角色管理 UI 标签页

已修改：

```text
public/index.html
public/app.js
public/style.css
```

`#role-modal` 现在有：

```text
基础
记忆
关系
模型
```

记忆区域已有：

```text
#inspector-memory-structured
```

用于展示结构化记录。

角色编辑器中原有重要 ID 保持不变：

```text
#role-modal
#role-modal-title
#inspector-close
#inspector-role-id
#inspector-provider
#inspector-model
#inspector-thinking
#inspector-story-fields
#inspector-self-model
#inspector-goals
#inspector-memory
#inspector-impressions-list
#inspector-impression-add
#inspector-save
#inspector-delete
#inspector-sync-story
```

标签切换使用：

```text
[data-inspector-tab]
[data-inspector-panel]
```

不要改成左栏使用的：

```text
[data-tab]
```

因为左栏已经使用：

```text
data-tab="roles|lore"
```

---

## 4. 当前真正未完成的工作

## 4.1 第一优先级：自动 digest 改为结构化写入

当前真实代码仍是：

```text
src/room-runtime.ts
  digestAfterSpeech()
    → workers.digest(role, sceneText)
    → digest.events
    → appendMemoryEvents()
    → roles.memory_timeline
```

`src/model-gateway.ts` 当前 digest schema 仍然要求：

```json
{
  "events": {
    "时间标签": ["字符串记忆"]
  }
}
```

`src/workers.ts` 的 fake digest 也仍然返回旧 `events`。

需要改为：

```json
{
  "entries": [
    {
      "kind": "interaction",
      "text": "玩家承认曾经隐瞒伤势。",
      "subjects": ["player"],
      "salience": 4,
      "confidence": 1
    }
  ]
}
```

### 服务端必须补齐的字段

模型只能返回：

```text
kind
text
subjects
salience
confidence
```

服务端补齐：

```text
id
roomId
roleId
sceneId
turnId
worldChangeId
occurredAt
occurredLocation
source
visibility
status
dedupeKey
createdAt
updatedAt
```

不要信任模型自行返回：

```text
时间
地点
来源 ID
worldChangeId
visibility
status
```

### digest 的校验规则

- 只接受合法 `MemoryKind`；
- `text` trim，空文本丢弃；
- `subjects` 必须是字符串数组；
- `salience` clamp 到 1-5；
- `confidence` clamp 到 0-1，最好限制为 `0 / 0.25 / 0.5 / 0.75 / 1`；
- 服务端强制使用已批准 Scene 的时间和地点；
- 只对 `presence = present` 的 NPC digest；
- 同一 `roleId + sceneId + kind + text` 不重复插入；
- digest 失败不应阻断已经发布的 Scene；
- Director 绝不能读 NPC 私有记忆。

### 最小建议

将 Worker 接口从：

```ts
digest(role, sceneText)
```

改为：

```ts
digest(role, sceneContext)
```

其中 `sceneContext` 至少包含：

```ts
{
  id,
  turnId,
  text,
  sceneTime,
  sceneLocation,
  sceneKind,
  worldChangeId
}
```

如果一次大改风险过高，可以保留旧第二参数并增加可选第三参数，但最终 canonical 应该以 Scene 为输入。

---

## 4.2 第二优先级：Scene 增加稳定世界变更关联

当前 `WorldChangeRequest` 没有稳定 ID，`rooms.pending_world_change` 只是临时 JSON。

应新增：

```text
world_changes
```

建议字段：

```text
id
room_id
turn_id
source
status
request
approved_request
before_scene_time
after_scene_time
before_scene_location
after_scene_location
narration_scene_id
created_at
approved_at
rejected_at
```

建议状态：

```text
proposed
approved
rejected
superseded
```

建议给 `scenes` 增加：

```text
scene_kind
world_change_id
```

建议 `scene_kind`：

```text
dialogue
player
narration
system
```

最终关系：

```text
world_change
  → narration scene / dialogue scene
  → npc_memories.world_change_id
```

世界变更没有叙述正文时，不要凭空创建 NPC 记忆；只有 NPC 能从已批准正文中观察到的内容，才进入其私有记忆。

### 需要修改的流程

- `RoomRuntime.approveSpeech()`；
- `RoomRuntime.approveWorldChange()`；
- `RoomRuntime.rejectWorldChange()`；
- `Store.approveSpeech()`；
- `Store.applyWorldChangeLocked()`；
- `Store.addNarrationScene()`；
- `app-boot.ts` 世界变更 API 路由。

这些地方必须共享同一个稳定 `worldChangeId`。

---

## 4.3 第三优先级：角色记忆上下文改为读取 npc_memories

当前 `src/model-gateway.ts` 的：

```text
formatMemoryTimeline(role)
```

读取的是：

```text
role.memoryTimeline
```

最终应改为：

```text
formatMemoryContext(role.memories)
```

只读：

```text
status = active
visibility = private
```

建议排序：

```text
salience DESC
occurred_at DESC
created_at DESC
```

建议限制数量或字符数，避免上下文无限增长。

只注入给该 NPC 自己的角色模型：

```text
role.decide
role.speak
role.digest
```

不要注入 Director：

```text
director.draft
 director.consult
 director.chat
```

Director 可见内容仍然是：

```text
公开人设
当前角色状态
公开 reaction / brief
已批准 scenes
世界书
```

---

## 4.4 第四优先级：记忆管理 UI 完全结构化

当前记忆页仍有旧文本入口：

```text
#inspector-memory
```

它的旧行为是：

```text
文本时间线
  → parseTimelineFromEdit()
  → /api/roles/intervene
  → 整块覆盖 roles.memory_timeline
```

这不符合最终设计。

应改成记录列表，每条记录显示和编辑：

```text
kind
occurredAt
occurredLocation
text
subjects
salience
confidence
source
status
```

推荐操作：

```text
新增记忆
编辑记忆
撤回
标记替代
恢复/归档
```

记忆操作应调用独立 API，不再通过：

```text
/api/roles/intervene
```

角色干预 API 只负责：

```text
selfModel
goals
provider/model/thinking
impressions
```

### 推荐 API

```text
GET    /api/roles/memories?roleId=<id>
POST   /api/roles/memories
PATCH  /api/roles/memories/:id
POST   /api/roles/memories/:id/retract
POST   /api/roles/memories/:id/supersede
```

当前已有前三类中的查询、POST 和 retract，但 URL 是简化版：

```text
GET  /api/roles/memories?roleId=...
POST /api/roles/memories
POST /api/roles/memories/retract
```

后续可以保持兼容或改为 REST 风格，但要同步修改前端。

---

## 4.5 第五优先级：初始剧本和新建 NPC 的记忆导入

当前以下代码仍使用：

```text
memoryTimeline
```

位置包括：

```text
src/store.ts seed / createRoomFromPackage / restart
src/store.ts role proposal 创建
src/app-boot.ts roles/create
src/st-card-import.ts
src/story-packages.ts
src/core/solutions.ts
src/core/state.ts
src/model-gateway.ts role proposal schema
```

新存档规则应为：

```text
剧本初始记忆 → npc_memories.source = import
手工新增记忆 → source = manual
角色反应记忆 → source = role_reaction
世界变更正文记忆 → source = world_change 或 story，按实际来源确定
```

不能在新存档创建时继续把初始记忆只写进 `roles.memory_timeline`。

建议先实现一个服务端方法：

```ts
seedNpcMemories(roomId, roleId, memoryInput)
```

然后所有新角色入口统一调用。

---

## 4.6 第六优先级：测试重写和补充

最终应更新或新增测试：

### Store

```text
npc_memories 表会创建
结构化字段 round-trip
insertNpcMemories 幂等
retract / supersede
按 role 查询 active / inactive
```

### Digest

```text
模型返回 entries
非法 kind 被丢弃
空 text 被丢弃
salience/confidence 被规范化
Scene 时间地点由服务端覆盖
```

### Scene / World Change

```text
记忆正确关联 sceneId
记忆正确关联 turnId
世界变更 narration 正确关联 worldChangeId
重复 digest 不重复写入
无正文世界变更不生成记忆
```

### 私有隔离

```text
NPC prompt 包含自身 active memories
Director prompt 不包含 npc_memories
撤回的记忆不进入 prompt
```

### NPC 管理

```text
新增手工记忆
编辑记忆
撤回记忆
标记替代记忆
不在场 NPC 不 digest
```

### 当前旧测试

以下测试仍以旧 timeline 为断言，需要最终改写：

```text
test/chat-mode.test.ts
test/scene-memory.test.ts
test/mind-lifecycle.test.ts
test/ooc-intervention.test.ts
test/role-management.test.ts
test/story-sync.test.ts
test/migrated-db.test.ts
test/model-gateway.test.ts
```

在全部测试切到新模型之前，可以继续用临时 projection 保持基线，但不要把 projection 当新架构的最终实现。

---

## 5. 不能重复做的工作

以下工作已经完成，不要重新实现或回滚：

### 前端启动修复

如果辅助 Core 接口失败，旧 UI 仍应初始化。相关提交：

```text
f724ca7
aab4a7c
```

不要重新恢复 fail-fast 的 `Promise.all()` 启动链。

### Core 静态模块路由

服务器已经提供：

```text
/core-client.js
/core-interactions.js
/core-interactions.css
```

相关提交：

```text
8420f16
```

不要删除这些静态路由。

### 固定流程领域 UI

当前正式交互位置是：

```text
导演建议：右侧导演对话框
玩家行动：页面底部输入框
角色发言：左侧角色按钮
批准/放弃/重考：中央内容区
```

不要重新启用重复的通用 Core Interaction 面板抢占这些控件。相关提交：

```text
a36ef86
```

### Chat 台词放弃和带意见重考

相关提交：

```text
24062d9
```

已有：

```text
/api/chat/reject-speech
```

以及中央：

```text
批复意见输入框
带意见重考
放弃
批准发布
```

---

## 6. 推荐实施顺序

不要同时大改所有层。推荐按以下顺序提交：

### 阶段 A：自动 digest 结构化

修改：

```text
src/types.ts
src/workers.ts
src/model-gateway.ts
src/room-runtime.ts
```

目标：

```text
digest → entries[] → npc_memories
```

暂时允许 `memoryTimeline` 只作测试/显示 projection，不能新增写入逻辑。

完成后运行：

```text
pnpm test
```

单独提交。

### 阶段 B：Scene / World Change 关联

修改：

```text
src/types.ts
src/store.ts
src/room-runtime.ts
src/app-boot.ts
```

目标：

```text
WorldChange → Scene → NpcMemory
```

加入 `world_changes` 表、稳定 ID、`scene_kind` 和 `world_change_id`。

补测试后单独提交。

### 阶段 C：角色上下文改读结构化记忆

修改：

```text
src/model-gateway.ts
src/core/state.ts
```

目标：

```text
NPC 自己看到 active private memories
Director 看不到
```

单独提交。

### 阶段 D：结构化记忆 UI

修改：

```text
public/index.html
public/app.js
public/style.css
src/app-boot.ts
```

目标：

```text
记忆条目列表 + 编辑 + 撤回 + supersede
```

不要继续通过 `#inspector-memory` 的整块文本覆盖接口保存。

单独提交。

### 阶段 E：初始记忆和新角色导入

修改：

```text
src/store.ts
src/story-packages.ts
src/st-card-import.ts
src/app-boot.ts
src/core/solutions.ts
```

目标：

```text
新剧本/新 NPC 的初始记忆直接写 npc_memories
```

单独提交。

### 阶段 F：重写旧测试并补全回归

最后统一把旧 timeline 断言改成：

```text
listNpcMemories()
role.memories
数据库查询
```

完成后目标是：

```text
pnpm test
全部通过
```

---

## 7. 当前关键文件索引

### 后端组装和 HTTP

```text
src/server.ts
src/app-boot.ts
```

### 业务状态和回合

```text
src/room-runtime.ts
src/store.ts
src/types.ts
```

### 模型和提示词

```text
src/model-gateway.ts
src/workers.ts
prompts/prompts.json
```

### Core

```text
src/core/protocol.ts
src/core/runtime.ts
src/core/solutions.ts
src/core/state.ts
src/core/domain-events.ts
src/core/event-log.ts
src/core/command-adapter.ts
```

### 前端

```text
public/index.html
public/app.js
public/style.css
public/core-client.js
public/core-interactions.js
```

### 当前架构总文档

```text
custom/docs/PROGRAM-STRUCTURE.md
```

---

## 8. 下一工作环境第一步

进入项目后严格执行：

```powershell
cd D:\AI\AIRP\character-tavern
git status --short
pnpm test
git log -8 --oneline
```

确认：

```text
工作区干净
153 passed
0 failed
```

然后从阶段 A 开始，不要先改 UI：

```text
digest 输出 entries[]
→ RoomRuntime 结构化写入 npc_memories
→ 测试幂等和场景关联
```

阶段 A 完成前，不要做：

```text
删除 memoryTimeline 字段
删除旧测试
删除 appendMemoryEvents
改动 Director prompt
```

因为这些会让定位问题变得困难。阶段 A 稳定后，再分阶段切换读取和测试。

---

## 9. 最终验收标准

最终完成后应满足：

```text
1. 新存档不依赖 roles.memory_timeline 作为记忆真源。
2. NPC 记忆以 npc_memories 结构化记录存储。
3. 每条记忆可关联 scene_id / turn_id / world_change_id。
4. Scene 时间和地点由服务端快照决定。
5. digest 重复执行不会重复插入。
6. 记忆支持撤回和 supersede。
7. NPC 只读取自己的 active private memories。
8. Director 不读取 NPC 私有记忆。
9. 世界变更具备独立审计记录。
10. 角色管理器记忆页使用结构化条目，不再整块文本覆盖。
11. 新剧本和新 NPC 初始记忆写入 npc_memories。
12. `pnpm test` 全部通过。
13. 移动端浏览器 / Termux 运行不被破坏。
```

最终一句话：

> 当前项目已经有 Core/Workflow 主线、稳定的领域 UI、结构化记忆表和基础管理 API；交接后的主要工作是把自动 digest、Scene/World Change 关联、NPC 私有上下文和结构化记忆编辑器串成一条完整且可审计的 canonical 链路。
