# v1 / v2 迁移与使用说明

当前 shipping 的 Node/Android 组合根均由独立 official LLM System 持有 provider/model/credential/routing/lifecycle/stream/cancel/usage；原 Core router 与旧 HTTP provider API 仅作为兼容适配面保留。v2 的 M3–M9 参考路径及可替换 LLM System 作者路径已经实现，但仍未冻结，也没有替换 shipping 组合。两套启动链可以共存，但一次启动只选择一套 Core。

## 从 M2 authoring 到 M3 component

M2 的 `stagecraft.plugin.json` 是作者输入与构建元数据；M3 的 `manifest.json` 是 Host/Store 消费的显式组件描述。`stagecraft plugin pack` 会生成两者：`category=core` 映射为 `componentType=core + hostApi`，其他类别映射为 `componentType=plugin + pluginCategory`；`entry.desktop/android` 在当前 0.1 规范中必须指向同一个已 bundle 的单文件 ESM，`integrity.runtime` 为 sha256。不要把 authoring 函数放进 `manifest.json`。

## 桌面

v2 默认从 `<userDataRoot>/data/component-launch-plan.v2.json` 读取计划，组件位于 `<userDataRoot>/components/<id>/<version>/`。Host 先校验计划、manifest、路径、hash、能力和单文件 ESM，再导入 Core；Core 失败不会悄悄回退 v1。计划改变需要停止并重启，当前没有热加载。参考 Host 暴露 `/api/v2/core/status` 与 `/api/v2/core/invoke`，还没有完整市场 UI。

## Android

v1 插件管理器与 v2 Component Store 并存。实际顺序是：通过 SAF 逐个 install 全部 zip；调用 `selectV2Core(id, version, true)` 选择 Core；再逐个调用 `setV2PluginEnabled(id, version, true, true)` 启用 ordinary plugins；最后重启。没有 active v2 Core plan 时，bundled v1 Core 下不能启用这些 v2 插件。安装复制到应用私有 filesDir 的 Component Store，原子安装后才更新索引。恢复路径包括 last-good、失败计数达到阈值后的 quarantine 和 rescue Core。Android 外部组件仅允许浏览器兼容 JS/ESM 单文件，不加载第三方 Dex/Java/Kotlin/.so、Termux 或 Node built-ins；能力声明和授权是合作式控制，不是强沙盒，风险由用户承担。

### 2026-09-02 真机 smoke 证据

在 FOA-AL00（Android 12，API 31）上，instrumentation 使用与 desktop e2e 相同的 `examples/v2/{core,driver,llm,solution,tool}/dist/index.js` 五个构建产物，验证了 install → select → cold restart → health `ready` → `/api/core/commands` `demo/run`。断言覆盖 Solution system prompt、stream chunks、LLM usage 与 Tool 结果。

复现命令：

```powershell
powershell -File scripts/android-v2-smoke.ps1 -Case smoke -Build -Install
```

该记录仅是单设备真机冒烟证据，不是多设备兼容性认证；市场 UI 仍不在范围内，测试只走开发者/instrumentation 入口。

## Core、插件与 LLM 边界

第三方 Core 只需实现最小 Host ABI；official Core plugin runtime 是可选便利层，并非第三方 Core 必须实现的 ABI。LLM System 是完整可替换的管理系统，拥有 provider/model/credential/routing/lifecycle/stream/cancel/usage；Provider Driver 只是协议适配，不能接管全局路由或凭据管理。Solution 拥有 system prompt、prompt assembly、领域状态和 workflow，不能把这些责任塞入 LLM。Android `host.secrets` 必须先由组件 manifest 声明并获 Host 授权，随后才提供按组件命名空间隔离的 Keystore-backed 端口；桌面参考 Host 只提供普通 `host.storage`，不宣称安全 secret port。

## 当前作者性证据（非正式门槛结论）

当前只有一个独立第三方 LLM System 样本（`examples/v2/llm-third-party`）。它经历多轮审查修复（包括 stop/cancel、usage 元数据和默认路由优先级），随后通过 `build → check → test → pack` 与 runtime 合约验证。该证据只支持“有脚手架和测试时能交付功能可用插件”，不能声称一次生成可靠，也不能声称正式统计门槛通过。

## 限制

当前没有签名、市场、Git 安装、强沙盒、通用跨版本兼容或原生第三方插件加载；Android 和桌面 UI 管理入口仍是参考 API/开发入口。不要将 v2 实验路径的 manifest、Host ABI 或 Core plugin API 当作稳定公共协议。
