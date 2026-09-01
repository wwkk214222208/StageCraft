# StageCraft v2 components, Store and Host–Core contract (M3 draft)

> Status: implemented reference logic and contract tests only (2026-09-01). This is not the frozen v2 Manifest/ABI and does not change the shipping v1 startup chain.

## Component model

`src/v2/component-contract.ts` defines a `ComponentManifest` distinct from the M2 authoring manifest. Every component declares `schemaVersion`, identity, `componentType` (`core` or `plugin`), browser ESM `entrypoints.runtime`, optional UI entry, API requirements, dependencies, capability requests and opaque integrity fields. A core must not declare `pluginCategory`; a plugin must declare one of `llm-system`, `provider-driver`, `solution`, `tool`, `effect`, `ui` or `composite`.

`hostApi.version` is the Host ABI required by a component. A Core must declare `hostApi`, which is checked against the plan's Host version. `coreApi` is optional: when present on a Core it is the version provided to ordinary plugins; a plugin's optional `coreApi` is a requirement that must match that provided version. A Core with no `coreApi` is valid when no selected plugin requires it. Thus `coreApi` is not the Host ABI and does not force a third-party Core to adopt the optional official plugin architecture. M3 uses exact version equality; ranges are deferred.

The v2 launch plan has exactly one independent, non-empty `core` selection and a separate `plugins[]` list. `plugins[]` cannot contain a Core. Plan and manifest hashes are deterministic identity hashes for selection consistency; M3 does not claim cryptographic signature verification.

## Store and selection

`MemoryComponentStore` is a platform-neutral reference implementation for bundled and local records. It supports exact `id + version` reads, deterministic listing, metadata, and deletion of local components. Bundled components cannot be deleted. It intentionally does not install files or load Android/Desktop code; a future platform adapter must preserve these semantics.

## Host–Core ABI and capabilities

`HostCoreSession` models the minimal cold-start handshake. Host provides a narrow async `HostPort`; Core receives only a gated port through `boot(entry)`, the plan's read-only `pluginSelections`, and an optional read-only generic `components` handoff (manifest plus module/default export). Core must emit `ready` with matching Host API, selected Core identity and plan hash before Host calls are allowed. A failed/mismatched handshake enters terminal `failed`; shutdown is terminal and neither state can return to `ready`. `negotiateCapabilities` deterministically grants available capabilities, fails on missing required requests and reports denied optional requests.

`official-core-plugin-api.ts` is a separate optional `OfficialCorePluginApi` compatibility profile for Cores that want the official plugin convenience interface. The Host–Core ABI does not import or require this profile; a third-party Core may implement the Host ABI directly.

## Trust and non-goals

The Host must verify a selected Core package/manifest/API/integrity before executing it. M3 defines the generic handoff boundary; the M4 desktop reference additionally verifies selected ordinary-plugin artifacts before importing them and passes them to Core. Android executable third-party components remain browser-compatible ESM only. M3 does not implement a loader, real filesystem/Android Store, native components, signatures, strong sandboxing, Git/marketplace, hot reload or startup integration. Changes take effect on cold restart.

M2 `src/sdk/authoring.ts` remains a convenience authoring prototype. It is not silently treated as a v2 ComponentManifest; an explicit adapter/mapping and a later ABI review are required.
