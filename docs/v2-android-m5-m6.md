# StageCraft v2 Android component path (M5–M6)

Android stores user-trusted v2 component archives under the app-private `filesDir/components` directory. Installation is atomic and validates the manifest, identity, entrypoint hashes, path containment, archive/file/count limits, and browser-only single-file ESM rules. Dex, Java/Kotlin, native libraries, Termux, and Node built-ins are rejected. This is not a strong sandbox or a signature system; the user explicitly accepts third-party code risk.

The v2 launch plan is separate from the existing v1 `PluginManager` plan. It selects one Core and an independent plugin list. A selected external Core takes effect after a cold restart and is loaded from the private store only after Java validates the complete plan and hashes. With no valid external effective plan, the APK Core remains the rescue path.

Recovery records requested/effective selection, failure counts and quarantine in `component-launch-plan.v2.recovery.json`. Three failures quarantine a Core. Safe mode or a quarantined selection uses the last-good plan when available; otherwise startup uses the embedded rescue Core. A successful Core handshake records the effective plan as last-good.

The small native management surface is exposed through `StageCraftNative`: list state, install a SAF archive, select a Core with `acknowledgeRisk=true`, enable or disable installed ordinary plugins, enter rescue mode, and clear quarantine. Enabling third-party plugin code also requires `acknowledgeRisk=true` and an active external Core plan; the bundled v1 Core does not promise the optional v2 plugin API. Switching Core retains the selected plugin set only when the complete resulting plan remains compatible. The read-only loader exposes only `/v2/launch-plan.json` and exact selected component runtime/UI URLs. Generic Core operations continue through the existing in-process bridge.

The CLI archive format is `manifest.json` plus the referenced runtime/UI files. Changes are intentionally cold-start only; there is no marketplace, hot reload, native plugin ABI, or strong isolation in this phase.

## 2026-09-02 real-device evidence

The repeatable instrumentation smoke was run against FOA-AL00 (Android 12, API 31). It uses the same five checked-in `examples/v2/{core,driver,llm,solution,tool}/dist/index.js` artifacts as the desktop v2 e2e path. The observed sequence was install → Core/plugin selection → cold restart → Core health `ready` → `POST /api/core/commands` `demo/run`; assertions covered the Solution system prompt, streamed Driver chunks, LLM usage, and Tool output.

Reproduce with:

```powershell
powershell -File scripts/android-v2-smoke.ps1 -Case smoke -Build -Install
```

This is a single-device smoke record, not multi-device compatibility certification. Marketplace UI remains outside the M5–M6 scope; the test uses the developer/instrumentation entry only.

## 2026-09-02 收尾增量

- **页面侧逐能力授权**：`buildV2WebConfig` 将 Core manifest 与插件 manifest 一并下发；页面宿主端口按 caller（pluginId+version）对照组件 granted 能力集合逐操作校验（`host.log`→`host.log`、`host.storage.*`→`host.storage`），未识别操作、缺失 caller、能力未声明一律拒绝。
- **host.storage**：新增 core-native 操作 `storage.read`/`storage.write`（仅 Core WebView 可达，不进 legacy 迁移期例外集）；Java `V2ComponentStorage` 在 Java 侧再次校验 caller 组件 manifest 已声明 `host.storage` 能力，然后读写 `filesDir/v2-storage/<id>/<area>.json`（原子替换写）。这不是秘密存储；密钥级存储仍走 AndroidSecretStore（`secret.*`）。
- **插件级隔离**：页面桥逐插件 import，失败者隔离并记录诊断，Core 以剩余集合启动；Java 侧的包校验失败仍 fail closed。
- **守卫收口**：`NativeOperationGuard` 改为消费生成器输出的 `coreNative` 目标集（不再等同 legacy 例外集）；v2 管理面此前漏登记的 `@JavascriptInterface` 方法（含 synchronized 修饰的 7 个 + `chooseV2Component`）已全部补登记，registry 测试的正则现在穷举 synchronized 方法。
