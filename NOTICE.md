# NOTICE

本仓库以 [GNU AGPL-3.0](./LICENSE) 授权发布。以下声明按需补充/保留，随再分发一并携带。

## 徽标（header 左侧图形）

页面 header 使用本项目自有的简单代码原生标识；未分发第三方徽标素材。

- 该标识为本项目源码原生绘制，不包含第三方徽标素材。

## SillyTavern（AGPL-3.0）默认内容

部分游戏内容（Eldoria 默认剧本的角色与基础设定，作者 @OtisAlejandro）来自
[SillyTavern](https://github.com/SillyTavern/SillyTavern) 的 AGPL-3.0 默认内容。

- 本项目与其保持 AGPL-3.0 兼容，并按 AGPL-3.0 要求保留相应署名与许可证信息。
- 使用本项目的 AGPL-3.0 衍生作品，若向用户提供网络服务，需按 AGPL-3.0 §13 提供对应源代码获取方式。

## 其他

- `data/`（数据库、提供商密钥配置、运行日志）、`save/`（存档）与 `custom/`、`stories/custom/`（私人剧本、私有文档、备份）**不随仓库发布**，见 `.gitignore`。

## Cordis / DSH 生态及构建依赖

本阶段只依赖 Cordis，不复制其源码。DSH 使用的 scoped 宿主包名为
`@deepseek-ai/cordis`；本项目插件将其声明为精确版本
`4.0.0-rc.7` 的 peer dependency。根项目的同名开发依赖只是指向公开
`cordis@4.0.0-rc.7` 的 npm alias，用于本地测试，发布 DSH bundle 时不打包
第二份 Cordis。

- **Cordis 4.0.0-rc.7** — MIT，作者 Shigma，来源：
  <https://github.com/cordiverse/cordis>。
- **cosmokit 1.8.1** — MIT，Cordis 的运行时依赖，作者 Shigma，来源：
  <https://github.com/shigma/cosmokit>。
- **@standard-schema/spec 1.1.0** — MIT，Cordis 的运行时依赖，作者 Colin
  McDonnell，来源：
  <https://github.com/standard-schema/standard-schema>。
- **@deepseek-ai/schemastery 3.18.1** — MIT，DSH 配置 schema 依赖，来源为
  DSH 仓库的 `vendor/schemastery`：
  <https://github.com/deepseek-ai/deepseek-harness/tree/main/vendor/schemastery>。
- **esbuild 0.28.2** — MIT，仅用于构建 bundle，不进入运行时包，来源：
  <https://github.com/evanw/esbuild>。

DSH（DeepSeek Harness）本身是 MIT 项目；本阶段不复制或重新分发 DSH
源码，只按其 Cordis 宿主插件接口接入。实际宿主版本和上游许可文本以 DSH
发布包及其仓库为准：
<https://github.com/deepseek-ai/deepseek-harness>。

## Android 构建依赖

Android 客户端不引入第三方运行时库。下列依赖仅用于构建或测试，不进入本项目
Java 运行时代码；标准 Gradle Wrapper JAR/脚本作为构建引导文件随源码提供。

- **Gradle Wrapper 8.9** — Apache-2.0，来源：
  <https://github.com/gradle/gradle>。
- **Android Gradle Plugin 8.7.3** — Apache-2.0，仅构建依赖，来源：
  <https://android.googlesource.com/platform/tools/base/>。
- **JUnit 4.13.2** — EPL-1.0，仅测试依赖，来源：
  <https://github.com/junit-team/junit4>。
