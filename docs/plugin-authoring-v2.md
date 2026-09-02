# StageCraft plugin creation specification (M1/M2 prototype)

> This is a proposed authoring contract, not the frozen v2 ABI. The runnable prototype lives in `src/sdk/authoring.ts` and `scripts/stagecraft.mjs`.

## Difficulty levels and public information

| Level | Author writes | Expected audience | Must not be exposed |
| --- | --- | --- | --- |
| Tool/config | `defineToolPlugin`, schema, `execute` | flash-level model or first-time author | Cordis patching, private Context/class, lifecycle cleanup, platform branches, hand-written hashes |
| Provider | `defineProviderDriver`, provider protocol stream | integration author | credential storage, routing policy, global cancellation bookkeeping |
| LLM System | `defineLlmSystem`, returned `LlmSystemService`, catalogs, credentials, routing, lifecycle and usage | system author | provider protocol details, solution prompts and domain state |
| Solution | `defineSolution`, prompt assembly, commands | domain author | LLM provider internals, Store/SQLite, internal state reducers |
| Host + UI | `defineUiPlugin`, host mount handle | UI author | DOM assumptions, Android/Desktop forks, Host process APIs |
| Core template | `defineCore`, lifecycle callbacks | advanced author | Host process boot, native loaders, ABI negotiation internals |

Every author sees a small, typed context: plugin id, API version, read-only config, logging and (for tools) an abort signal. The SDK returns plain browser-compatible ESM objects. A plugin author should be able to copy a template, fill in one function, and run check/test/build/pack without learning the runtime internals.

## Suggested API

The prototype exposes `defineToolPlugin`, `defineProviderDriver`, `defineLlmSystem`, `defineSolution`, `defineUiPlugin` and `defineCore`. `defineProviderDriver` is only a provider-protocol adapter: it receives the driver/model and runtime credential material selected by the LLM System and must not implement global routing or credential policy. `defineLlmSystem` returns a complete `LlmSystemService` owning provider-profile CRUD, model discovery, explicit role/director/assistant routing, lifecycle, completion streams, request cancellation and usage records. It receives the messages already assembled by the Solution; it never invents, appends or interprets a system prompt. The official reference implementation and OpenAI-compatible driver adapter live in `src/llm/` and reuse the production ModelGateway stream/JSON parsers. The adapter only emits `json_schema` when complete schema metadata is supplied and forwards tool definitions when `toolCalling` is enabled; otherwise it sends a valid plain completion request.

### Smallest LLM System

```ts
const system = defineLlmSystem({
  id: 'example.llm-system', version: '0.1.0', title: 'Example LLM System',
  async start(context) {
    const service = await createDefaultLlmSystemService(context)
    await service.upsertCredentialProfile({ id: 'main', profileId: 'main', providerId: 'example', driverId: 'example', label: 'Main account' })
    return service
  },
})
```

在 LLM 路由结果中，`providerId` 保持兼容用的 provider/driver 别名，`driverId` 表示协议驱动，`profileId` 表示供应商实例；不要再把 profile id 写入 `providerId`。凭据 secret 只通过 secret port（没有 port 时由官方实现暂存于内存）传递，不属于公开 profile、usage 或 manifest。

Use `createAuthoringLlmSystemHarness` only to start and validate a plugin's returned service. `createDefaultLlmSystemService` is an optional reference implementation that a plugin may explicitly call. Credentials are runtime-only values; profile metadata and diagnostics contain references and labels, never secrets. The service calls the selected driver with the exact selected route and the exact Solution-provided messages.

All definitions require reverse-domain lowercase id, full semver version, title and API version `0.1`. The manifest category is deliberately separate from the existing v1 `PluginKind` so this prototype does not silently freeze or rewrite the v1 launcher contract.

The SDK projects only metadata into `plugin.manifest`; executable callbacks and schemas never become manifest keys. Public nested metadata is defensively copied and frozen. Provider requests carry a caller-owned `requestId` in addition to `AbortSignal`, so a driver can correlate `cancel(requestId)` with a stream.

## Diagnostics and portable checks

Diagnostics are actionable, deterministic and fail closed: identify file, category and a suggested fix; never silently downgrade. The v0.1 prototype intentionally supports one shared portable ESM entry: `entry.desktop`, `entry.android` and `output` must be the same root-contained path. `stagecraft plugin check` validates manifest shape, API compatibility, source/ESM entrypoints, browser-only restrictions, both declared entries, integrity metadata, and imports the built ESM's default export to compare its authoring manifest metadata. Because check executes local build code (with cache-busting imports), authors should run it only in a trusted development directory. `build` bundles ESM with esbuild; `test` runs the package's Node test files and fails when none exist; `pack` emits a deterministic ZIP containing the manifest and the shared built ESM. These commands are usable on Windows PowerShell and do not require native tooling.

The prototype intentionally reports missing built artifacts as a check error, while `build` writes `dist/index.js` and integrity metadata. It does not pretend that a package is signed or sandboxed.

## Luna Authorability Gate

The gate measures independent, task-complete samples, with a fresh author context and no private runtime knowledge. A sample passes only when the package validates, builds, runs its test, and produces the expected behavior on both declared entries.

| Task class | First attempt | Within two repair rounds |
| --- | ---: | ---: |
| Tool/config | >=90% | >=95% |
| Provider/Solution | >=70% | >=90% |
| Host + UI | >=70% | >=90% |
| Template Core | — | >=70% |

Formal gating requires at least five independent samples per class. Record time-to-first-success, diagnostic category, repair count, forbidden-import rate, and portable-entry parity. A failed sample may not be counted as fixed merely because it was manually edited by an engineer. The Core template uses an authoring-only harness (`registerCommand` + `ready` + `dispatch`) to demonstrate behavior; this harness is provisional and is not the final Host ABI.
