# StageCraft v2 desktop Core path (M4 prototype)

> Status: implemented reference desktop Host path and tests. The v1 `startTavern` path remains the default when no explicit v2 plan exists; Android has an independent v2 private-store path described in `v2-android-m5-m6.md`.

## User data layout

The desktop Host looks for an explicit plan at:

`<userDataRoot>/data/component-launch-plan.v2.json`

Selected component packages are manually placed at:

`<userDataRoot>/components/<id>/<version>/manifest.json`
`<userDataRoot>/components/<id>/<version>/<entrypoints.runtime>`

The reference Host is fail-closed for network exposure: M4 accepts only
`127.0.0.1`, `localhost`, or `::1`. The mutating endpoints `POST
/api/v2/core/invoke` and `POST /api/v2/core/stream` require a loopback API
token (`x-stagecraft-token` header or `?token=`); the token is generated at
startup, persisted at `<userDataRoot>/data/v2-host-token`, and returned as
`authToken`. Every `/api/v2` route also rejects a non-loopback `Host` header
(DNS-rebinding guard). Remote (non-loopback) v2 access remains out of scope.

M4 does not install archives. The Host validates plan/manifest shape, component-root containment (including realpath), single-file browser ESM restrictions and SHA-256 integrity before importing the selected Core. Runtime and UI entries may not use static/export-from/dynamic module loading; authors should bundle with the StageCraft CLI first. A present but invalid explicit plan is an error and enters the existing fallback; it is never silently changed to legacy selection.

## Selection and ABI

`src/v2/desktop-entry.ts` selects exactly one branch before invoking a composition root. No-plan selects legacy `startTavern`; a plan invokes only `startV2DesktopHost`, so the selected third-party Core is not preceded by an official `CoreRuntimeSkeleton`.

`src/v2/desktop-host.ts` serves `GET /api/v2/core/status`, `GET /api/v2/ui` (reference UI mount page), `POST /api/v2/core/invoke` and `POST /api/v2/core/stream` (transfer-level SSE: chunks are forwarded as the Core produces them, a client disconnect releases the producer, and a missing/unready stream surfaces as a JSON error). The HostPort enforces per-capability authorization: `host.log` requires the `host.log` capability and `host.storage.*` requires `host.storage`, checked against the granted set of the identified caller (`host.call(operation, input, caller)`); unknown operations, unidentified callers and ungranted capabilities fail closed. `host.storage.read/write` store one JSON file per area under `<userDataRoot>/data/v2-storage/<componentId>/` in a per-component namespace. Required capabilities for the Core and selected ordinary plugins are negotiated before any third-party import; denied optional capabilities are reported by status. Every selected runtime and optional UI entry is path/realpath, browser-ESM, and SHA-256 checked before import. UI entries are exposed only as the exact read-only URLs listed by status; the mount page drives a minimal DOM surface (text/stack/button views) and dispatches button `action`s back through `/api/v2/core/invoke`.

After those checks, ordinary plugin modules are handed to Core through the
generic read-only `CoreBootContext.components` list; the boot request contains
the effective `pluginSelections`. A plugin whose module throws at import time
is quarantined with a status diagnostic and excluded from the effective
selections — the Core boots with the remaining set; artifact verification
failures (integrity, path, browser-ESM rules) remain fail-closed startup
errors. The Host does not interpret LLM, Solution, or UI
semantics, and no official Core Plugin API is required.

The imported default export may implement the M3 `HostCoreEntry` directly, or use the explicit M2 adapter: an M2 `defineCore` plugin's `registerCommand` handlers become generic Host→Core operations, and `ready()` maps to the Host-Core handshake. The external package remains described by a M3 `ComponentManifest`; the M2 authoring manifest is not silently reused as that package manifest.

Shutdown is ordered as stop HTTP acceptance, invoke Core shutdown, then release the session; cleanup is attempted in `finally` even when shutdown reports an error. When the v2 Host fails to start, `src/server.ts` falls back to the v2 recovery server (`src/v2/desktop-recovery.ts`, `/admin/v2`), which imports only the pure contract/plan modules and can disable a plugin (rewrite the plan with fresh hashes) or clear the plan entirely; without a v2 plan the v1 plugin fallback page (`/admin/plugins`) remains the recovery entry. M4 is intentionally not a loader/installer: signatures, strong sandboxing, native components, marketplace/Git, hot reload, desktop last-good plan tracking and full UI framework integration remain future work. Third-party code is user-trusted code.
