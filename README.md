# DeepPlugin Harness

DeepSeek 生态整活之作：一套独立、本地优先的多角色 RP 工作台（dsh 插件形态）。角色与 Director 都是受控上下文上的一轮模型 Worker；角色连续性来自持久化的私有记忆、自我模型和当前状态，而不是完整聊天历史。

随项目附带 dsh 插件集成（`dsh-rp`）：装好 profile 后 `dsh --profile <name>` 会在 RP_PORT（默认 8799）打开酒馆。

## 核心能力（当前垂直切片）

- 两种游玩模式：**导演模式**（Director 编织场景的现行流程）与**群聊模式**（无导演：点角色发言 → 审批 → 在场角色记入记忆）。
  - **沉浸模式**：跳过审批，AI 主导，输入后自动走完并发布；期间场景、角色状态、角色面板只读。
- SQLite 持久化 Room、角色、回合、草稿与 canonical Scene；`required` / `optional` 角色并行决策门槛。
- 角色连续性：持久化私有记忆时间线、他人印象、**长期目标（独立字段）**与当前状态。
- 流式思维链透出（折叠/显隐可开关）、token 用量小字（可开关，不入正文）、SSE 状态推送。
- 世界书（全量注入）+ ST 角色卡导入坯子（PNG/JSON → 角色 + 世界书 + 私有段）。
- 存档：剧本名-游玩模式-编号自动命名；独立运行（`npm run dev`）与 dsh 插件（8799）双形态。

## 目录与发布边界

遵循 SillyTavern 的 AGPL-3.0 协议（见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE) 的徽标/默认内容单独声明）。**随仓库发布**工具协议与默认内容；用户自建内容不进仓库。

| 路径 | 内容 | 发布 |
| --- | --- | --- |
| `src/` `public/` `test/` `prompts/prompts.json` `dsh-rp/` | 工具协议、逻辑、UI、测试 | ✅ 发布 |
| `stories/eldoria.json` | 默认剧本（下拉标「（默认）」） | ✅ 发布 |
| `stories/custom/`（保留 `.gitkeep`） | 私人剧本，会自动合并进下拉（不带标记） | ❌ 目录保留、内容不上传 |
| `custom/`（保留 `.gitkeep`） | 私人文档、图片素材、数据库备份 | ❌ 目录保留、内容不上传 |
| `data/`（sqlite、`providers.json` 密钥、日志）、`save/`（存档） | 运行数据 | ❌ ignore |

## 默认剧本

- `stories/eldoria.json`：默认启动剧本（新装或空库；若已有其他房间则保留现有房间）。Eldoria 迷雾森林守护者，基于 SillyTavern 默认角色 Seraphina / Eldoria 世界观扩充，包含塞拉菲娜、罗温与影牙·维克斯三个角色。其角色与基础设定来自 SillyTavern（AGPL-3.0，作者 @OtisAlejandro），保持 AGPL-3.0 兼容，见 [NOTICE](./NOTICE)。
- `test/fixtures/royal-festival.json`：旧占位剧本，现仅作为测试夹具保留。

## 运行

需要 Node.js 24+：

```powershell
npm run dev
```

打开 `http://127.0.0.1:8787`。数据保存在 `data/character-tavern.sqlite`。模型端点与密钥在 `providers.json`（模板见 `providers.example.json`）。

```powershell
npm test
```

## 授权

本项目：GNU AGPL-3.0（[LICENSE](./LICENSE)）。徽标与第三方默认内容的单独声明见 [NOTICE](./NOTICE)。