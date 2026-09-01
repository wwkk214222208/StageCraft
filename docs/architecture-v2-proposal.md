# StageCraft v2 architecture baseline (reference path, experimental)

> Status: reference path implemented through M8/M9 (2026-09-02), experimental and not frozen. v1 remains shipping; this document does not claim that v2 replaced the v1 startup chain. Existing `docs/architecture.md` and its launch-mode table describe v1 behavior unless they explicitly link here.

## Vocabulary

* **Host** is the small, platform-facing launcher and adapter. It owns process/WebView lifecycle, permissions, storage and the launch plan. Desktop and Android expose the same Host semantics.
* **Core** is the one exclusive, replaceable component selected by a launch plan. The APK contains a default/rescue Core, but a user may load a third-party Core at their own risk.
* **Plugin** is an extension loaded by a Core. Ordinary plugin categories are LLM System, Solution, Tool/Effect and UI. The authoring SDK's `provider-driver` is a provider-specific adapter inside an LLM System, not an LLM System itself.
* **LLM System** owns provider/model/credential/routing/lifecycle/stream/cancel/usage and consumes Provider Drivers. A Provider Driver does not own routing or credentials.
* **Solution** owns system prompts, prompt assembly, domain semantics, workflows, state and solution UI. These responsibilities do not belong to LLM.
* **Host ABI** is the small contract between Host and Core. The optional official Core Plugin API is a compatibility convenience, not a mandatory internal architecture for every Core.
* **Launch plan** is an immutable startup selection. Changing it requires stopping the old Core and restarting the application; this proposal has no hot reload.

## Responsibility and trust boundaries

The Host is trusted to enforce platform lifecycle and to keep its control plane available when Core fails. Core is trusted with application state and user-selected plugin code. Third-party Core/plugin code is not sandboxed in this phase: the user accepts its risk, and the installer must show capabilities and integrity diagnostics. Android third-party components are browser-compatible JavaScript/ESM only; no external Dex/Java/Kotlin/.so, Termux, Node built-ins or native bridge is loaded.

The Host never implements Solution or LLM policy. Core never imports Node filesystem, Android APIs or DOM APIs. UI code receives a host mount handle and uses the host UI surface; it does not reach through to private Host/Core classes. State mutations go through Core commands/events and its transaction boundary.

## Startup, failure and recovery sequence

1. Host reads the persisted desired plugin set and builds a deterministic launch plan (or selects the embedded rescue Core when no plan is usable).
2. **Before executing the selected Core**, Host verifies the package boundary: manifest shape, allowed API version, integrity and the declared browser/portable entry. A failed verification never enters Core execution.
3. Host starts exactly one verified Core and passes the plan plus the minimal Host ABI ports.
4. Core validates ordinary plugin manifests, API compatibility, dependencies and integrity metadata, then loads plugins in dependency order. A failed optional plugin is quarantined with a user-visible diagnostic; a failed required plugin enters degraded or failed state.
5. Host waits for a health handshake containing protocol version, selected Core identity and plugin diagnostics. Only then does it expose normal UI/data routes.
6. If Core exits or the handshake fails, Host preserves management/recovery UI, records the failure, stops normal data routes, and offers rescue Core, disable-last-change and remote/restart recovery actions.
7. Recovery is a cold restart with a new launch plan. No code is hot-reloaded and no partially loaded plugin is allowed to mutate the next plan.

## Explicit non-goals for v2 proposal

This phase does not freeze the final Manifest or Host ABI; implement marketplace, Git installation, signatures, strong sandboxing, hot reload, universal plugin compatibility, or desktop/Android native plugin loading. It also does not move the current v1 startup chain or claim that the SDK/reference path is production-ready.

## Compatibility with v1 documents

The current v1 has a richer internal Core/plugin arrangement and legacy desktop/Android paths. Those details remain the shipping behavior until a separately reviewed migration. This proposal is a direction and an authoring boundary for iteration, not a replacement for the v1 contract in `src/plugin-contract.ts`.
