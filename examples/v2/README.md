# StageCraft v2：最小可运行示例

这是一个不含真实密钥的端到端样例，拆成五个组件：可替换 Core、LLM System、Provider Driver、Solution 和 Tool。Solution 负责 system prompt 与 prompt assembly；LLM System 只负责驱动注册、路由、流式与 usage；Provider Driver 只模拟供应商响应。

## 构建组件

在仓库根目录执行：

```bash
for p in core driver llm solution tool; do
  node scripts/stagecraft.mjs plugin build examples/v2/$p
  node scripts/stagecraft.mjs plugin check examples/v2/$p
  node scripts/stagecraft.mjs plugin pack examples/v2/$p
done
```

Windows PowerShell 可执行：

```powershell
"core","driver","llm","solution","tool" | % { node scripts/stagecraft.mjs plugin build "examples/v2/$_"; node scripts/stagecraft.mjs plugin check "examples/v2/$_"; node scripts/stagecraft.mjs plugin pack "examples/v2/$_" }
```

每个目录的 `dist/index.js` 都是浏览器兼容的单文件 ESM，pack 生成的 zip 同时包含 M2 authoring metadata 与显式的 M3 `manifest.json`。示例没有 secret；真实凭据只能由运行时的 credential profile 提供。

## 桌面运行

将每个 zip 解压到 `<userDataRoot>/components/<id>/<version>/`，把各组件的 `manifest.json` 放在对应目录，并写入 `data/component-launch-plan.v2.json`。计划的 `core` 指向 `example.stagecraft.core`，plugins 按依赖顺序选择 driver、llm、solution、tool。然后以 v2 desktop entry 启动；Host 会在导入 Core 前校验所有文件。

当前参考路径没有完整市场 UI。开发时可使用已有 Host API：`GET /api/v2/core/status`，以及 `POST /api/v2/core/invoke`，例如 `{ "operation":"demo/run", "input": {"user":"hello"} }`。

## Android

在 APK 的组件管理入口通过系统文件选择器（SAF）逐个选择上述 `.stagecraft-plugin.zip` 并完成 install；然后调用 `selectV2Core(id, version, true)` 选择 Core，再对 driver、llm、solution、tool 分别调用 `setV2PluginEnabled(id, version, true, true)`，最后重启。没有 active v2 Core plan 时，bundled v1 Core 下不能启用这些 v2 ordinary plugins。当前 v2 入口是开发/参考 API，不是完整市场页面；若 UI 尚未接线，可从现有 native bridge 开发入口调用 install、select Core、enable plugin、restart/rescue。Android 只接受打包后的 JS/ESM 单文件，不加载第三方 Dex/Java/Kotlin/.so，也不热加载。

运行 `test/m9-v2-e2e.test.ts` 可看到同一套 Solution→LLM System→Driver→stream/usage→Tool 链路。
