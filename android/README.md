# StageCraft Android local and remote client

This directory is the native Android host for the shared StageCraft Core protocol. It supports remote HTTP/SSE mode and the phase-five embedded browser Core path. The generated `embedded-core.js` executes the shared `CoreRuntimeSkeleton` protocol in the WebView; Java only owns lifecycle, media, pairing, and transport boundaries.

## Local mode boundary

`NativeBridge.installLocalCore(...)` is the integration point for the app composition root. The supplied `LocalCoreConnection.CoreHost` must be the shared Core runtime; Android does not implement Director, Chat, approval, state transactions, workflows, or card business logic a second time. The renderer and `renderer.js` are shared by both modes.

The embedded path is deliberately limited to the shared, platform-neutral Core skeleton. Gradle runs `scripts/build-android-core.mjs` with the repository's pinned esbuild, packages the bundle and manifest into the APK, and the native bridge verifies artifact name, byte count, SHA-256, bundle version, protocol version, and bridge version before local mode is allowed. Append `?mode=remote` to the trusted asset URL for remote transport during development. The embedded bundle now boots the shared StageCraft solution composition: chat/director/management services, solution handlers, state repository, and model router (the model gateway, SQLite repository, Cordis services are wired through the portable composition boundary). Java remains limited to bounded persistence, secret, model, and lifecycle ports; no Java domain fallback or fake `CoreHost` is provided.

## Android ports

- `AndroidSqliteRepository` provides transactional records, Core snapshots, assets, and recovery metadata in `stagecraft.sqlite`.
- `AndroidSecretStore` encrypts model provider secrets with an Android Keystore AES-GCM key. Secrets never enter WebView storage, CoreView, URLs, or logs.
- `AndroidModelTransport` sends model requests and emits bounded SSE deltas; cancellation closes active connections.
- `StageCraftArchive` imports/exports only bounded `stagecraft.json` ZIP archives and rejects unsafe archive content by requiring the canonical entry.
- PNG card bytes are bounded and signature-checked before any import. JSON card parsing remains a Core/compatibility concern; Android only transports selected data.
- Foreground/background state is forwarded to the local or remote human plugin. Core snapshots are persisted by the repository, so force-close recovery is based on durable state rather than WebView memory. Generation must be cancelled or moved to an Android foreground service by the final app composition root.

## Security boundary

The WebView loads only `https://appassets.androidplatform.net/` resources intercepted from packaged assets. File/content access, cookies, DOM storage, mixed content, popups, remote frames, and release WebView debugging are disabled. Remote bearer sessions remain Java-only and are encrypted with Android Keystore AES-GCM. Commands are single-attempt; SSE is established before authoritative view fetch; foreground recovery performs a full resync.

## Remote full-UI mode (方案 A)

配对成功或会话恢复后，`MainActivity.showRemoteUi(...)` 直接让 WebView 加载 **PC 端完整 Web UI**（`http://<LAN-IP>:<port>/`），不再使用本地最小 renderer：

- `StageCraftWebViewClient` 在 `shouldInterceptRequest` 里：
  - 主页面 HTML 用 Bearer 拉取，并在 `<head>` 注入 bootstrap 脚本（早于 `app.js` 执行），补丁 `fetch` / `XMLHttpRequest` / `EventSource` 自动携带 `Authorization: Bearer`；
  - 图片等无头请求（`/assets`、`/custom`、`/story-assets`）用 Bearer 重新拉取返回；
  - 已带 Authorization 的 GET 与 POST/PUT 等带 body 请求原样交给 WebView 处理。
- 原生 `RemoteCoreConnection` 继续作为**授权看门狗**：SSE 收到 401 → `onUnauthorized` → 清会话并回到本地配对页。
- 本地资产（配对页 / 嵌入核心模式）仍由同一客户端拦截服务。

## Offline full-UI mode (方案 B：完全离线复用 Web UI)

配对页「本地模式（不连电脑，完整界面）」经 `StageCraftWebViewClient.OfflineNavigation` 把主框架重写到 **应用内环回服务器**（`OfflineLoopbackServer`，127.0.0.1 随机端口）的 `/web/offline.html`：**APK 内置 PC 端同一套完整 Web UI**（构建期由 Gradle 把根目录 `public/` 打包为 `assets/web/**` 并生成离线入口），游玩完全离线，模型调用经设备原生网络直连供应商。环回 origin（http://localhost）按常规 Web 语义工作（ES module / fetch / EventSource / 安全上下文），`appassets://` 自定义 scheme 下 WebView 对 module 脚本支持不可靠，故仅承载配对页与身份边界；资产契约由 `LocalAssetResolver` 在 appassets 拦截与环回服务器之间共用。

架构：

- `offline.html` = `public/index.html`（`__MODE_FLAG__=true` 关闭 DSH 依赖组件）+ 注入 `embedded-core.js`（离线组合根）与 `local-runtime-web-entry.js`（本地运行时 Web 入口），均早于 `app.js` 执行。
- `src/portable/android-offline-core.ts`（esbuild 打包为 `embedded-core.js`）：在页面内运行共享 `CoreRuntimeSkeleton` + chat/director/management 服务（`android-composition.ts`），并以**与桌面同一个 `createRealWorkers`**（gameplay 提示词渲染 + 预设管线；提示词 IO 由 `PromptStorage` 注入：构建期内联 gameplay + SQLite 预设）驱动生成；凭据只存 `AndroidSecretStore`，网络由 `AndroidModelTransport`（OpenAI 兼容 SSE 解析，含 `reasoning_content` 思考增量）在 Java 侧发起。
- `local-runtime-web-entry.js`：本地运行时的人机入口。它桥接 `fetch`/`EventSource` 与本地 Core，并复用 PC 端 HTTP 契约及 **Core 命令协议**（`{roomId, scope, action}`）；它不拥有剧本、存档、设置、角色或回合业务规则。房间快照经 `/api/events` 推送，思考增量经 `/api/thinking-events` 推送。仅 DSH 助手与远程配对等真正依赖外部服务的能力允许不在本地运行时提供。
- 原生异步桥：`NativeBridge.invokeAsync`（operation + callbackId）承载 `model.request` / `story.read`。
- 模型供应商：应用内「连接 → 管理供应商」新建（接口地址、API Key、模型名），写入 `offline.provider.default`（Keystore 加密 secret）；模型名单离线不可自动发现，需手动填写（如 `deepseek-chat`）。
- 离线边界：`StageCraftWebViewClient` 仅放行 `appassets://` 本地资源（`/web`、`/assets`、`/story-assets`），文件/内容/Cookie/混合内容仍全禁。

## Build and verification

The standard Gradle 8.9 wrapper and AGP 8.7.3 contract are checked in. With the required AGP artifact available in the Gradle cache and SDK 35 installed:

```text
android/gradlew -p android testDebugUnitTest assembleDebug lintDebug --offline --no-daemon
```

The repository-local JDK is under `.toolchains/jdk-extract/`. With the repository-local toolchain and cached AGP available, `testDebugUnitTest`, `assembleDebug`, and `lintDebug` pass. Android build outputs, `local.properties`, APKs, and private assets remain ignored and are not committed.

### Real WebView UI test

`src/androidTest/java/ai/stagecraft/android/MainActivityWebViewTest.java` starts the real `MainActivity` and verifies the real WebView has a `WebChromeClient` and loads `web/offline.html`. This is separate from Node/VM route tests and requires an Android emulator or physical device. The first build needs network access to download `androidx.test:runner:1.6.2`, `androidx.test:rules:1.6.1`, and `androidx.test.ext:junit:1.2.1`; after they are cached, use:

```text
android/gradlew -p android assembleDebug assembleDebugAndroidTest
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w -e class ai.stagecraft.android.MainActivityWebViewTest ai.stagecraft.android.test/androidx.test.runner.AndroidJUnitRunner
```

The test requires no root access and does not require WebView remote debugging. It validates the Activity/WebView setup, not the full native SQLite CRUD workflow; add user-flow assertions here when a test device is available.
