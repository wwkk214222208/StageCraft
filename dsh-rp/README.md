# dsh-rp —— Character Tavern 的 Cordis/dsh 适配壳

把[角色酒馆](..)（Character Tavern）包成一个**自包含 Cordis 插件**，让 dsh 用户用 dsh 自己的插件体系装上并启动酒馆——蹭 DeepSeek Harness 的热度与分发渠道，核心代码零改动、零 dsh 服务依赖。

## 为什么是"壳"而不是重写

- `inject = []`：不依赖 dsh 的 `llm / session / web / agents` 等服务，应用自包含（自己的 SQLite、自己的端口、自己的前端）。
- 热度照蹭、退出通道还在：装进 dsh 是加分项，不装也照常独立运行。
- 与 [../src/app-boot.ts](../src/app-boot.ts) 共用同一套启动逻辑（`startTavern()`），独立入口 `npm run dev` 与插件壳行为完全一致。

## 验证

```bash
node dsh-rp/verify.mjs
```

脚本会：① 用 stub ctx 调用插件 `apply` 启动酒馆并请求 `/api/room`；② 若本机有 `@deepseek-ai/cordis`（如 dsh-harness 的 node_modules），用**真实 Cordis** `ctx.plugin + ctx.start/stop` 跑一遍完整生命周期。

## 装进 dsh profile

1. 把本目录加进 profile 的依赖（官方命令：`dsh plugin --profile <name> add <path-or-git-url>`，或手动 `pnpm add` 进 profile workspace）。
2. `cordis.patch.yml` 已提供标准 bundle 行（`- insert: [{ id: rp, name: 'dsh-rp' }]`），或手动在 `cordis.patch.yml` 追加同样内容。
3. `dsh --profile <name>` 启动后访问 `http://127.0.0.1:8799`（可用 `RP_PORT` 改端口）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `RP_PORT` | `8799` | 酒馆 HTTP 端口（避开独立酒馆 8787 与 dsh web GUI 8898） |
| `RP_ROOT` | 仓库根（`../..` 相对本文件） | 数据/剧本/静态资源根目录 |

## 原型限制（发布前要做的事）

- `main` 指向 `src/index.ts`（TS 源码）：Node 24 默认 type stripping 可直接跑；发布 npm 前应像每个 `dsh-*` 包一样编译出 `lib/`。
- 尚未声明 `Config`（schemastery schema）——按 dsh 插件规范加上 `Config` 后即可在 `cordis.patch.yml` 里配端口/数据目录，而不用环境变量。
- `root` 按仓库布局解析（`dsh-rp/src` 上两级）；真正发布后应改为读取宿主提供的路径配置。
