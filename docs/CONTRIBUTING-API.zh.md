# API 贡献指南（新增 / 修改路由）

> 本文面向新贡献者：**只读本文 + 路由定义 + 对应行为测试，就能新增或修改功能**，
> 不需要理解历史施工过程（Gate 评审、工作包编号、遗留裁决）。

## 1. 三层结构（先读这个）

本项目把**运行时契约**与**项目治理**彻底分开，避免"加一条路由必须理解整套历史流程"：

| 层 | 位置 | 内容 | 谁消费 |
|---|---|---|---|
| **运行时契约** | `src/api-route-registry.ts` → 生成 `android/.../api-route-registry.json` | 只放**机器可执行或行为必需**的字段：method/path/owner/capability/handlerId/auth/dispatchPolicy/schema/stream/deprecated | 桌面 gateway（TS）、Android gateway（Java 读 JSON 资产） |
| **治理层** | `governance/api-governance.ts`（入库） | 裁决、修复工单、期限、迁移原因——按路由身份索引 | 报告脚本 `scripts/api-owner-report.mjs`、治理检查 `scripts/check-governance.mjs`；**不进 APK、不参与运行时解析** |
| **行为测试** | `test/api-route-registry.test.ts` 等 | 只测行为：registry 完备性、匹配语义、gateway 分派、handler 响应、生成物一致 | CI / `npm test` |

**硬约束**（由 `scripts/check-governance.mjs` 强制）：
- `src/` 与资产生成脚本（`scripts/generate-*.mjs`）**永不 import** `governance/`
- 运行时 registry 的 `note` **不得携带** 裁决/W/R/Gate/Q 治理令牌
- 治理条目引用的路由必须真实存在

## 2. 新增一条 HTTP 路由

### 2.1 判断它属于哪一层

- 路由的**行为**（谁处理、怎么分派、什么鉴权、返回什么）→ 运行时 registry
- 路由的**历史**（为什么这么定、谁负责修、什么时候修完）→ 治理层（通常不需要，只有"待办/迁移中"才登记）
- 路由的**测试**（注册是否正确、gateway 是否按 policy 分派、handler 返回什么）→ 行为测试

### 2.2 修改 `src/api-route-registry.ts`

在 `API_ROUTES` 数组里加一条，例如：

```ts
{
  method: 'POST',
  pattern: '/api/my-feature',
  owner: 'core',            // core | main-host | desktop-only | deprecated
  capability: 'my.feature',
  auth: 'none',
  handlerId: 'my.feature.run',
  requestSchema: 'MyRequest@1',   // 可选：命名 fixture 引用
  responseSchema: 'MyResult@1',   // 可选
  note: '行为性说明（可选）：如"非幂等；断线后标记 unknown-after-disconnect"。',
},
```

规则：
- **owner 决定分派**：`core` → 代理到 Core；`main-host` → 宿主 handler；`desktop-only` → Android 本地返回 `unsupported_capability`；`deprecated` → 迁移 adapter。`authPolicy`/`dispatchPolicy` **按 owner 自动派生**，不要手写。
- **note 只写行为**：禁止写"裁决(accepted)...W4 需补齐"这类治理内容（会触发治理检查失败）。
- **不要加治理字段**：`ApiRoute` 类型没有 `adjudication`/`fixPackage`/`fixDeadline`，也不允许加回去。
- 重复 `(method, pattern)`、同形状歧义 pattern、缺 `capability`/`handlerId` 都会让构建失败（模块加载即校验）。

### 2.3 重生成 Android 资产

```bash
node --experimental-strip-types scripts/generate-api-route-registry.mjs
```

这会重写 `android/app/src/main/assets/api-route-registry.json`（确定性排序，`test/api-route-registry.test.ts` 强制与生成器逐字节一致）。**提交时必须包含更新后的 JSON**。

### 2.4 实现 handler（如果路由是 core owner）

在 `src/portable/core-business-handlers.ts` 的 `CoreBusinessHandlers` 声明表里加 `handlerId → 实现`：

```ts
'my.feature.run': async (facade, body, params) => {
  // 调组合根 facade 方法，返回 { status, body }
  return { status: 200, body: { ok: true } }
},
```

约束：
- **handlerId 必须与 registry 一一对应**（`buildPortableCoverage` 交叉验证，测试强制无漂移）
- 状态修改必须走 Core（Command → StateEvent → 事务），**不要绕过 Core 直接写 Store**
- 文件字节（头像/存档）经原生端口，主进程不经手

### 2.5 加行为测试

在 `test/api-route-registry.test.ts` 或对应行为的测试文件里加断言，例如：

```ts
// 覆盖：前端/桌面/shim 实际调用必须已登记（扫描器会自动覆盖新路由）
// 匹配：matchApiRoute('POST', '/api/my-feature')?.handlerId === 'my.feature.run'
// 分派：gateway 按 dispatchPolicy 决策（Android JVM 测试 GateBcClosureTest）
// 行为：handler 返回正确响应（core-business-handlers 测试）
```

## 3. 新增 / 修改 native 操作（JS bridge）

native 操作（`invokeSync`/`invokeAsync` 通道）的注册在 `src/native-operation-registry.ts`：

```ts
{ name: 'my.op', owner: 'core-native', surface: 'generic-dispatch', legacyExposure: 'none' }
```

- `owner`：`core-native`（Core 侧）或 `main-host`（主进程侧），两份 allowlist **必须不相交**（测试穷举真实 Java 分派键证明）
- `legacyExposure: 'legacy-main-core'` 是**迁移期例外**（今天仍可从主 WebView 到达的 core-native 操作），只允许收缩、不得新增
- 新操作**不要**标 `legacy-main-core`——新 bridge 从第一天起执行各自 allowlist
- 改完跑 `node --experimental-strip-types scripts/generate-gatebc-assets.mjs` 重生成 `native-operation-registry.json`

## 4. 什么该进治理层（而不是运行时）

以下内容**只**放在 `governance/api-governance.ts`，绝不进运行时 registry 或 JSON 资产：

- Gate 阶段 / 评审轮次（Gate A/B/C/D、评审 R1-R12）
- 工作包编号（W4/W5/W6）
- 修复工单、截止时间（fixPackage/fixDeadline）
- 裁决结论（accepted/revised/deferred）与"临时迁移原因"
- 迁移开关的**决策记录**（何时翻转 `legacyCoreBridgeEnabled`——这属于治理决策，开关本身是运行时字段）

判断原则：**去掉这个字段，运行时行为是否改变？** 不变 → 它是治理，进治理层；变 → 它是运行时，留在 registry。

## 5. 验证清单（提交前）

```bash
# 1. 全量行为测试
pnpm test

# 2. 治理检查（独立于运行时测试，CI 可单独跑）
node --experimental-strip-types scripts/check-governance.mjs

# 3. Android JVM 测试（改了 Java / 资产时）
cd android
$env:JAVA_HOME = "D:\AI\AIRP\character-tavern\.toolchains\jdk-extract\jdk-17.0.20+8"
$env:GRADLE_USER_HOME = "D:\AI\AIRP\character-tavern\.gradle-home"
./gradlew :app:testDebugUnitTest
```

提交时必须包含：`src/` 改动 + 重新生成的 assets JSON + 行为测试。**不要**提交 `custom/docs/`（不入库，私有评审用）。

## 6. 相关文件速查

| 想做什么 | 看这里 |
|---|---|
| 全部 `/api/*` 路由定义 | `src/api-route-registry.ts` |
| core owner 路由的 handler | `src/portable/core-business-handlers.ts` |
| 可移植 handler 层（对等性） | `src/portable/api-handler.ts` |
| native 操作（JS bridge） | `src/native-operation-registry.ts` |
| 治理数据（裁决/工单/期限） | `governance/api-governance.ts` |
| 治理检查（护栏） | `scripts/check-governance.mjs` |
| Android 资产生成 | `scripts/generate-api-route-registry.mjs`、`scripts/generate-gatebc-assets.mjs` |
| 行为测试 | `test/api-route-registry.test.ts`、`test/native-operation-registry.test.ts` |
| Android JVM 行为测试 | `android/app/src/test/.../GateBcClosureTest.java` |
