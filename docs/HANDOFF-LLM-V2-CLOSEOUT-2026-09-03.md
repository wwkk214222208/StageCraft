# LLM / v2 收尾交接（2026-09-03）

## 1. 当前目标

本轮工作解决两个早期架构问题：

1. LLM 插件不再被当成“单个供应商路由”，而是完整、可替换的 LLM System，负责 provider/model catalog、credential profile/secret、routing、lifecycle、stream、request-scoped cancel、usage。
2. 桌面与 Android 复用同一组件契约；Android 允许用户安装浏览器兼容的第三方 JavaScript/ESM Core 与普通插件，但不加载第三方 Dex/Java/Kotlin/.so、Termux、Node built-ins 或 native bridge。能力检查是合作式授权，不是强沙盒，风险由用户承担。

必须继续遵守的边界：

- Provider Driver 只做供应商协议适配，不拥有全局路由、凭据管理或完整 LLM 生命周期。
- Solution 拥有 system prompt、prompt assembly、领域状态与 workflow；这些职责不能划入 LLM System。
- 当前 shipping Node/Android 组合已经由独立 official LLM System 持有完整管理职责。原 Core router 与旧 HTTP provider API 仅是兼容适配面，不应再描述为“LLM 仍在 Core 内”。
- 市场界面暂不做；此前计划步骤 7 已由用户明确跳过。
- 不做强沙盒、签名市场、原生第三方插件、热加载、发布版本号调整。

## 2. 已提交成果

当前分支：`main`

当前已提交 HEAD：`a7dd0b6`

按顺序的关键提交：

```text
299a2db feat: extract replaceable LLM system
72b988a feat: route desktop models through LLM system
ea6cc6d feat: route Android models through LLM system
a7dd0b6 feat: verify third-party LLM system authoring
```

更早的 v2 恢复与 Android 生命周期加固位于：

```text
ebf0fa1 fix: harden v2 recovery and Android lifecycle
```

`a7dd0b6` 提交时仓库测试为 684/684，通过第三方 LLM System 的 build/check/test/pack 与 runtime contract 验证，工作区当时干净。

## 3. 当前工作区：尚未提交的收尾改动

另一个 AI 曾进入工作区，但没有产生新提交、reset 或 stash。随后由 Luna 完成了收尾文档与一个测试稳定性修正，root 已逐项复核并要求 Luna 修正误导表述。

当前预期修改文件：

```text
.gitignore
README.md
android/README.md
docs/architecture-v2-proposal.md
docs/architecture.md
docs/plugin-authoring-v2.md
docs/v2-android-m5-m6.md
docs/v2-migration-and-usage.md
docs/v2-official-core-m8.md
examples/v2/README.md
test/server-startup.test.ts
docs/HANDOFF-LLM-V2-CLOSEOUT-2026-09-03.md
```

这些未提交改动的意图：

- 统一说明 LLM System / Provider Driver / Solution / Core 的真实边界。
- 明确 shipping 组合已使用 independent official LLM System，旧 router/API 只是兼容适配。
- 明确 Android `host.secrets` 需要 manifest 声明和 Host 授权，授权后使用按组件命名空间隔离的 Keystore-backed 存储。
- 明确桌面参考 Host 只有普通 `host.storage`，不宣称安全 secret port。
- 明确第三方 Android 组件是 user-trusted browser ESM，不是强沙盒。
- 如实记录作者性证据目前只有一个独立第三方 LLM System 样本，且经过多轮修复；不能声称一次生成可靠或正式统计门槛通过。
- 从对外文档移除内部施工编号“阶段 8 / Stage 8”。
- 最小 LLM System 示例显式声明 `host.storage` required、`host.secrets` optional。
- `.gitignore` 忽略另一个 AI 留下的 `.tmp-*.txt` 设备日志，但不删除这些证据文件。
- `test/server-startup.test.ts` 将 import-only 启动 smoke 的超时由 5 秒放宽到 15 秒；超时仍会 kill 子进程，不会把真实挂死当成通过。

## 4. 启动失败的结论

此前出现：

```text
SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Return statement is not allowed here
```

相应语法问题已经在前序工作中修正，并补有 `server.ts` 可被 Node strip-types 实际加载的回归测试。

另一个 AI 后来执行完整测试时，该测试在全套并发调度下以 5174ms 超过原 5 秒上限，造成 683/684；root 单独复跑该文件为 2/2，首项约 397ms，因此判断为测试时限过紧的并发抖动，不是语法问题复发。当前未提交改动把上限调到 15 秒并保留强制终止子进程的兜底。

设计要求仍然成立：插件或 Core 启动失败时，Host 控制面必须存活，并进入可编辑插件配置、导出诊断、恢复或切换 remote mode 的页面；不能只显示业务 Core 的失败页。

## 5. 已有测试证据

- `a7dd0b6` 时仓库测试：684/684。
- Android 真机 instrumentation 构建报告：6 tests，0 failures；设备为 FOA-AL00 / Android 12。
- root 对启动测试的隔离复跑：2/2。
- Luna 对当前收尾改动报告：完整测试 684/684，相关目标测试 21/21，governance / syntax / `git diff --check` 通过。
- root 已复核当前文档 diff，并执行过 `git diff --check`；无 whitespace error。

注意：Luna 最后一轮只改了文档表述和示例，root 原计划在其后再亲自执行一次完整回归，但本任务因额度临界被用户中止。因此“当前最终工作区的 root 完整复跑”仍未完成，不能伪称已经完成。

## 6. 下一位接手者只需做的事

不要重新设计，不要扩大范围。按以下顺序收尾：

1. 查看 `git status --short`，确认除上述文件和已知临时日志外没有意外改动。
2. 运行 `git diff --check`。
3. 运行完整测试：

   ```powershell
   npm test
   ```

4. 如需额外确认第三方作者路径，只运行现有样本的 build/check/test/pack 和 `test/third-party-llm.test.ts`，不要创建更多评估样本。
5. 若完整测试通过，审阅一次 `git diff --stat` 与关键文档措辞，然后把本轮收尾改动连同本交接文档提交为一个 commit。
6. 提交后停止。不要做市场 UI，不要做发布，不要升级版本，不要继续阶段 7。

建议提交信息：

```text
docs: close out replaceable LLM system work
```

## 7. 工作区外部状态与注意事项

- `.tmp-regression-node.log` 是另一个 AI 留下的完整测试日志，已被现有 `*.log` 规则忽略。
- `.tmp-device-log-main.txt`、`.tmp-device-log-core.txt` 是真机故障/恢复 smoke 日志；新规则会忽略它们，但不要为了收尾主动删除。
- 设备日志中的 `demo components missing`、bridge invalid、rebind storm 是故意注入的恢复测试，不代表最终 instrumentation 失败；权威结果是构建报告中的 6/6。
- 工作区外 `D:\AI\dsh-harness` 有两个既存 Node 进程，占用 8899/8799；它们不属于本任务，不要终止。
- 当前 app/test 包可能仍安装在真机上，但 app 进程没有运行；本轮纯文档/测试超时收尾无需重装 APK。

## 8. 验收口径

用户明确要求的是“功能实现、无明显 bug”级别，不要求过度打磨。收尾应满足：

- shipping 桌面/Android 确实经独立 LLM System 路由；
- 第三方 LLM System 能通过公开脚手架和契约交付；
- Android 第三方 Core/插件路径开放，但风险边界写清；
- Solution 的系统提示词职责没有被挪入 LLM；
- 启动失败仍能进入 Host 管理/恢复面；
- 完整测试通过，无明显回归；
- 文档不夸大 authorability、安全性或 v2 冻结程度。

达到以上条件后即可提交并停止。
