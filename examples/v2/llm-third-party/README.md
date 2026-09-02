# Independent third-party LLM System

This example is intentionally separate from the official implementation. It uses only the public authoring SDK and the `LlmSystemStartContext` contract. The returned service owns profile CRUD, default role/director/assistant routes, secret handling, driver/model catalogs, streaming completion, request cancellation, timeout, and usage aggregation.

Create a project first (the command is separate from the verification path):

```text
node scripts/create-stagecraft-plugin.mjs --template llm-system --name ./my-llm
```

Verification path:

```text
node scripts/stagecraft.mjs plugin build ./examples/v2/llm-third-party
node scripts/stagecraft.mjs plugin check ./examples/v2/llm-third-party
node scripts/stagecraft.mjs plugin test ./examples/v2/llm-third-party
node scripts/stagecraft.mjs plugin pack ./examples/v2/llm-third-party
```

制作记录：首次独立实现后修复了 stop/cancel 的活动 driver 绑定、usage 元数据和默认路由优先级；全程禁止私有模块导入，桌面/Android 共用同一 ESM dist。Flash 级评估：示例可交付用于契约联调，但尚未验证真实供应商网络或真机；生产使用前仍需接入真实 Provider Driver、模型发现 HTTP 和平台 secret port。无 state/secret port 时示例只保留内存密钥，重启会丢失。

The plugin receives already assembled Solution messages unchanged; it never adds a system prompt.

The package manifest requires host.storage for persisted profiles/routes/usage and optionally requests host.secrets for platform-backed credentials. Without storage authorization the v2 Host rejects the plugin; without secrets it uses in-memory credentials only.
