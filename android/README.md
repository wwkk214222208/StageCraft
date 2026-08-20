# StageCraft Android local and remote client

This directory is the native Android host for the shared StageCraft Core protocol. It supports the existing remote HTTP/SSE mode and provides the phase-five local host boundary: `AndroidHumanPlugin` and `LocalCoreConnection` forward the same view, command, event, approval, transaction, and UI-extension protocol to an injected Core runtime.

## Local mode boundary

`NativeBridge.installLocalCore(...)` is the integration point for the app composition root. The supplied `LocalCoreConnection.CoreHost` must be the shared Core runtime; Android does not implement Director, Chat, approval, state transactions, workflows, or card business logic a second time. The renderer and `renderer.js` are shared by both modes.

The checkout currently contains the portable Core as Node/TypeScript and does not contain an Android JS/WASM Core runtime artifact. Therefore the APK host contract, ports, tests, and lifecycle wiring are implemented here, while packaging a real embedded Core runtime remains an integration/build prerequisite for a standalone APK. A future composition root should adapt the shared Core through `CoreHost`, not replace it with Android domain code.

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
