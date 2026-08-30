# 空角色支持改动 —— Pending 观察跟踪

> 状态：**PENDING**（已提交，待功能核实与长期观察）
> 创建：2026-08-30
> 背景：互动式小说模式（玩家直接与导演交互、无 NPC）。用户裁决：桌面 `role.delete` 的「至少保留一个角色」约束不合理，应允许删到空角色；配套放宽剧本/导入层的空角色约束。

---

## 一、决策与改动清单

| 提交 | 文件 | 改动 | 说明 |
|---|---|---|---|
| `76badbd` | `src/story-packages.ts` | `validateStoryPackage`：roles 从「必须非空」放宽为「须为数组（可为空）」 | 影响 load/save/create/saveAs/creator 预览/归档全部路径 |
| `76badbd` | `test/creator-contracts.test.ts` | 空 roles 断言从「被拒」改为「通过」 | 配套测试 |
| `cb97075` | `android/.../AndroidCompositionOperations.java` | `validateImportedStory`：移除 `roles.length()==0` 拒绝，保留上限 256 | Android 导入剧本 |
| `25c7d22` | `src/store.ts` | `deleteRole`：移除「至少保留一个角色」约束 | 允许删到 0 角色；删不存在仍抛错 |
| `25c7d22` | `test/role-management.test.ts` | 删空断言改为 `roles.length === 0` | 配套测试 |
| `d4a866f` | `src/core/solutions.ts` | chat 模式无在场角色 → 退回 text 交互「玩家行动」 | 消除空 role-select 卡死（同批配套） |

**核心语义**：空角色房间 = 玩家直接与导演交互（导演模式天然自洽）；chat 模式退回 text 交互，玩家行动持续入正文，无角色响应。

---

## 二、预期影响面（需观察）

### 已调查确认安全的路径
- 导演模式空角色 turn：`processTurn` 空 decisions → `Promise.all([])` → 正常进 draft；`validateDraft` 不要求 roles 非空
- 模型 prompt 空 roles：`roles.map().join('\n')` 空串，模板安全
- `store.seed`/`applyStoryPackage`/`getRoom` 投影：空 roles 安全（`for...of []` 空循环、`roles ?? []` 兜底）
- Android `roomFromStory`：空 roles → `new JSONArray()` 空，安全
- chat 模式 `speakAll`/`directorDecide`：已有「无在场角色」守卫（400）

### 待观察的风险点（本次未改，需功能验证后决定是否处理）
1. **chat 模式 + speechMode=manual + 空角色**：玩家行动入正文后停在 awaiting-player-input，前端显示「玩家行动」text 交互 → 玩家可连续输入。**观察：连续输入是否造成 player scene 无限追加、是否有预期外的正文膨胀**
2. **`role.memories.reorder` 空数组**：Android 端空 memoryIds **清空该角色全部记忆**（桌面 400）。空角色房间虽无记忆可清，但**若删空后重新加角色**，此路径仍存在数据丢失风险——独立待办，未随本批处理
3. **`story-packages.ts` 的 `loadStoryPackageWithTxt`/`createStoryPackage`**：新建剧本仍默认带「向导」角色（模板行为，未改）。**观察：互动式小说用户是否期望新建即空角色**（如需可在创建流程加选项）
4. **前端 `render` 空角色**：`roleCards` 空数组 → 角色区空白、`focalRoleIds` 清空。**观察：空角色时 UI 是否仍可正常操作（底部输入框/导演交互），是否有空白区视觉问题**
5. **`director-service.ts:406`** `validateDraft` 空 roles 时 `roleIds` 空集 → 导演模型若在 stateUpdates 发非 player roleId 会 400。**观察：空角色导演模式实际生成 draft 时是否触发此误报**
6. **`store.createTurn` 空 decisions**：导演模式空角色 turn 写空 decisions。**观察：前端渲染空 decisions 是否正常（左侧栏/回合记录）**

### 反向确认（已核实无问题）
- Android `deleteRole`（applyRoleOrMemory）本无「至少保留一个」约束 → 双端一致
- `stagecraft-management-service.deleteRole` 只校验「空闲时」→ 双端一致
- `store.importRoom` 空 roles 可导入（`for...of []` 空）

---

## 三、功能核实清单（用户核实用）

- [ ] 桌面：删光所有角色 → 房间 roles 为空，无报错
- [ ] 桌面：空角色房间继续导演模式对话（提交 turn → 出 draft → 批准）
- [ ] 桌面：空角色剧本保存/另存为（story.save / save-as）通过
- [ ] 桌面：空角色剧本导入（story.import）通过
- [ ] 桌面：空角色房间存档/读档（archive.save / load）往返完整
- [ ] Android：导入空角色剧本通过（validateImportedStory）
- [ ] Android：删光角色 → chat 模式显示「玩家行动」输入框而非空下拉
- [ ] 桌面/Android：空角色房间重新加角色（角色管理 / 导演提议新人物）正常

## 四、回滚预案

如需回滚到"强制至少一个角色"：
1. `git revert 25c7d22`（deleteRole 约束恢复）
2. `git revert 76badbd cb97075`（剧本/导入非空恢复）
3. `git revert d4a866f`（chat 空角色退回 role-select，如确需）

注意：`25c7d22` 依赖 `76badbd` 的语义（删空后剧本可保存），单独回滚 `25c7d22` 会让"删到空但存不了"的不一致状态回归。

---

## 五、后续跟进

- 本批改动覆盖：剧本层校验（双端）、删除约束（桌面）、chat 空角色交互（core）
- 尚未处理（独立待办，见二.2）：`role.memories.reorder` 空数组清空记忆
- 观察窗口：建议至少一轮完整功能验证（新建空角色剧本 → 游玩 → 存档 → 导入导出）后再关闭本 PENDING

---

## 六、暂记：thinking 强度 —— 桌面设计本身是妥协，Android 连妥协都未落地

> 状态：**PENDING（双端设计均属妥协，Android 存在真实缺口）**。提交 `9d7dc47`（2026-08-30）。

### 背景：桌面的 `off/brief/standard/deep` 抽象本身就是妥协
各模型思维链强度参数格式**千奇百怪**（`src/thinking-params.ts:62-90` 每家族一张映射表）：
- DeepSeek：`thinking {type}` + `reasoning_effort` high/max
- GLM：`thinking {type}` + `reasoning_effort` max/xhigh/…/minimal/none
- Gemini：`reasoning_effort` → 自动映射 thinking_level（minimal/low/medium/high）
- OpenAI：`reasoning_effort` none/minimal/low/medium/high/xhigh/max
- Kimi K3：始终思考无法关闭，顶层 `reasoning_effort` low/high/max
- 豆包：`thinking {type}` enabled/disabled/auto
- Claude/unknown：原生参数不可靠 → 提示词引导（`promptGuidance`）

`off/brief/standard/deep` 四档是对上述格式的**强行归一化**——不存在统一标准，桌面这套抽象是**已知妥协**。因此：
- 桌面 `setDirectorThinking` 的 `off/brief/standard/deep` 白名单是**合理入口校验**（抽象层内部必须限定档位，否则 `effort()` 映射表查不到）
- Android `provider.director-thinking` 的本地模拟**不是"未同步桌面"的缺陷**，而是这套妥协设计在 Android 的存储层延伸

### 真实缺口：Android 模型请求完全没走 thinking 抽象
核查 `android-local-core.ts`：
- `toOpenAiBody`（:186-197）只组装 `model/messages/stream/tools/response_format`，**无任何 thinking 参数注入**
- `modelRequest`（:199-256）→ Java transport 直接发裸 OpenAI 兼容请求
- Java 侧仅转发 thinking delta 事件（模型输出的思维链流），**无请求侧注入**
- 结论：**Android 的 director-thinking 值"写了但模型请求完全不用"**——连桌面的妥协映射（`buildThinkingParams`）都没在 Android 落地。角色级 `setRoleThinking`（`room.roles[].thinkingStrength`）同理，仅存储、不生效

### 待办
- [x] **处置决策（2026-08-30）**：**暂不处理**。理由：thinking 强度注入涉及多模型格式兼容的架构性改动（`buildThinkingParams` 家族映射 + Java transport 透传 + 提示词引导三条路径），当前除 DeepSeek 外其他模型实际使用者很少，假生效影响面可控；等模型生态明确后再决定补注入或降级 unsupported。**此条目保持 open，非紧急。**
- [ ] **决策**：Android 是否补 thinking 注入（在 `toOpenAiBody` 复用 `buildThinkingParams(model, strength)`，需从 meta/room 读取档位）——补则解决"假生效"，不补则应将 director-thinking/setRoleThinking 降级为明确 unsupported 并隐藏 UI，避免误导
- [ ] 补注入时注意：Android 请求经 Java transport（`AndroidModelTransport`），`reasoning_effort`/`thinking` 字段需确认能透传到 OpenAI 兼容端点（当前 `toOpenAiBody` 无白名单限制，字段可加）
- [ ] 提示词引导路径（claude/unknown 家族）在 Android 同样缺失（system 提示词无 `promptGuidance` 后缀）——若补注入需一并考虑

### 影响面
- 显示层 OK：前端 `updateInspectorThinkingOptions` 读 `defaults.directorThinkingStrength` 显示档位
- 生效层：**Android 完全无效**（模型请求不带 thinking 参数）——用户以为设置了强度，实际模型按默认行为输出
- 此条与本批"空角色"改动无关，属顺手修复中暴露的既有妥协/缺口，故单独记录
