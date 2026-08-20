# StageCraft Android remote client

This directory is the native Android remote client. It does not embed Node.js or start a localhost server. A single Activity hosts a local, packaged WebView renderer; Java owns pairing, bearer credentials, Core protocol HTTP/SSE, reconnect policy, lifecycle, and Android Keystore storage.

## Platform choices

- `minSdk 26`: the minimum supported version has Android Keystore AES-GCM and WebView Safe Browsing APIs used by the app.
- `compileSdk/targetSdk 35`: the first APK baseline targets Android 15 behavior.
- Java 17 and Android Gradle Plugin 8.7.3 with Gradle 8.9.
- No third-party runtime libraries. JUnit is test-only.

The manifest permits cleartext traffic only because Android network security configuration cannot enumerate dynamic LAN IP addresses at runtime. Application validation still rejects every `http://` address unless the user explicitly enables the visible insecure-LAN switch. HTTPS is the default. This development transport is not a substitute for TLS on an untrusted network.

## Security boundary

- The WebView loads only `https://appassets.androidplatform.net/` resources intercepted from packaged assets. File/content access, cookies, DOM storage, mixed content, popups, remote frames, and release WebView debugging are disabled.
- `addJavascriptInterface` is installed only on that trusted page. CSP forbids frames and network requests; untrusted card/UI content must never be placed in this WebView in a later phase.
- The bearer session is held by Java and encrypted with an Android Keystore AES-GCM key. SharedPreferences contains only ciphertext and IV; JavaScript receives neither the token nor an Authorization header.
- Commands are single-attempt. SSE is established before the authoritative View fetch; foreground recovery always performs a full resync.
- Portraits are fetched by Java with the bearer header only from a flat `/assets/<filename>` path on the validated server. Redirects, non-raster MIME types, path traversal, and responses over 2 MiB are rejected; the trusted renderer receives only a raster data URL.
- The system file picker accepts PNG character cards. Java verifies the PNG signature and 8 MiB bound, then performs one authenticated import request; raw card data is never passed to the WebView.

## Renderer asset packaging

The three audited renderer sources live in `app/src/main/assets/`. The `packageRemoteRenderer` Gradle `Sync` task copies only `index.html`, `styles.css`, and `renderer.js` into `app/build/generated/remote-renderer`; the Android main source set packages that generated directory. `preBuild` depends on this task, so tests and APK builds use the same deterministic allowlist and cannot accidentally include unrelated files.

## Build

The repository contains the standard Gradle 8.9 wrapper, including its checked wrapper JAR and distribution checksum. With the repository-local toolchain available under `.toolchains/`, run:

```text
android/gradlew -p android testDebugUnitTest assembleDebug
```

SDK 35 and Build Tools 35 are required. A successful local build writes the debug APK below `android/app/build/`; that directory is ignored and the generated APK is not committed or distributed from source control.

For a repository-local toolchain, set `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_USER_HOME`, and `GRADLE_USER_HOME` to directories below the ignored `.toolchains/` folder before invoking the wrapper. Do not write those absolute machine paths to `local.properties` or committed Gradle files.
