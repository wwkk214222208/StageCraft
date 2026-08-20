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

## Build and verification

The standard Gradle 8.9 wrapper and AGP 8.7.3 contract are checked in. With the required AGP artifact available in the Gradle cache and SDK 35 installed:

```text
android/gradlew -p android testDebugUnitTest assembleDebug lintDebug --offline --no-daemon
```

The repository-local JDK is under `.toolchains/jdk-extract/`. With the repository-local toolchain and cached AGP available, `testDebugUnitTest`, `assembleDebug`, and `lintDebug` pass. Android build outputs, `local.properties`, APKs, and private assets remain ignored and are not committed.
