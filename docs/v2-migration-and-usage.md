# v1 / v2 迁移与使用说明

当前发布仍是 v1：已有 Node/Android 入口、旧插件管理器和 legacy LLM router 继续工作。v2 是已经实现到 M9 的实验性参考路径，尚未冻结，也没有替换 v1。两套启动链可以共存，但一次启动只选择一套 Core。

## 从 M2 authoring 到 M3 component

M2 的 `stagecraft.plugin.json` 是作者输入与构建元数据；M3 的 `manifest.json` 是 Host/Store 消费的显式组件描述。`stagecraft plugin pack` 会生成两者：`category=core` 映射为 `componentType=core + hostApi`，其他类别映射为 `componentType=plugin + pluginCategory`；`entry.desktop/android` 在当前 0.1 规范中必须指向同一个已 bundle 的单文件 ESM，`integrity.runtime` 为 sha256。不要把 authoring 函数放进 `manifest.json`。

## 桌面

v2 默认从 `<userDataRoot>/data/component-launch-plan.v2.json` 读取计划，组件位于 `<userDataRoot>/components/<id>/<version>/`。Host 先校验计划、manifest、路径、hash、能力和单文件 ESM，再导入 Core；Core 失败不会悄悄回退 v1。计划改变需要停止并重启，当前没有热加载。参考 Host 暴露 `/api/v2/core/status` 与 `/api/v2/core/invoke`，还没有完整市场 UI。

## Android

v1 插件管理器与 v2 Component Store 并存。实际顺序是：通过 SAF 逐个 install 全部 zip；调用 `selectV2Core(id, version, true)` 选择 Core；再逐个调用 `setV2PluginEnabled(id, version, true, true)` 启用 ordinary plugins；最后重启。没有 active v2 Core plan 时，bundled v1 Core 下不能启用这些 v2 插件。安装复制到应用私有 filesDir 的 Component Store，原子安装后才更新索引。恢复路径包括 last-good、失败计数达到阈值后的 quarantine 和 rescue Core。Android 外部组件仅允许浏览器兼容 JS/ESM 单文件，不加载第三方 Dex/Java/Kotlin/.so、Termux 或 Node built-ins；无强沙盒、无热加载，风险由用户承担。

### 2026-09-02 真机 smoke 证据

在 FOA-AL00（Android 12，API 31）上，instrumentation 使用与 desktop e2e 相同的 `examples/v2/{core,driver,llm,solution,tool}/dist/index.js` 五个构建产物，验证了 install → select → cold restart → health `ready` → `/api/core/commands` `demo/run`。断言覆盖 Solution system prompt、stream chunks、LLM usage 与 Tool 结果。

复现命令：

```powershell
powershell -File scripts/android-v2-smoke.ps1 -Case smoke -Build -Install
```

该记录仅是单设备真机冒烟证据，不是多设备兼容性认证；市场 UI 仍不在范围内，测试只走开发者/instrumentation 入口。

## Core、插件与 LLM 边界

第三方 Core 只需实现最小 Host ABI；official Core plugin runtime 是可选便利层，并非第三方 Core 必须实现的 ABI。LLM System 是完整管理系统，拥有 provider/model/credential/routing/lifecycle/stream/cancel/usage；Provider Driver 只是单供应商适配。Solution 拥有 system prompt、prompt assembly、领域状态和 workflow，不能把这些责任塞入 LLM。

## 已验证的低门槛

Luna/flash 级作者性门槛评估中，Tool、Provider Driver、Solution、UI、Core 均可在最多一次修复内完成；随后每类均通过 build/check/pack 与行为验证。本轮 LLM System 首轮出现 title mismatch，修复后 4/4 行为项通过，并通过 build/check/pack。该结果只代表“能交付可用插件、无明显 bug”的务实门槛，不是安全认证或 API 冻结承诺。

## 限制

当前没有签名、市场、Git 安装、强沙盒、通用跨版本兼容或原生第三方插件加载；Android 和桌面 UI 管理入口仍是参考 API/开发入口。不要将 v2 实验路径的 manifest、Host ABI 或 Core plugin API 当作稳定公共协议。
