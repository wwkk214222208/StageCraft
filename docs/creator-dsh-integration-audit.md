# Creator Workbench and DSH Integration Audit

Date: 2026-06-25

Scope: `src/dsh-story-bridge.ts`, `src/creator-workbench-service.ts`, `src/app-boot.ts`, Creator browser wiring in `public/app.js`, Creator UI contracts/tests, and the available DSH host APIs.

## Current Findings

### Story bridge

`src/dsh-story-bridge.ts` exports four task IDs and a Cordis plugin:

- `dsh.story.generate`
- `dsh.story.polish`
- `dsh.story.consistency`
- `dsh.story.expand-opening`

The plugin registers effect handlers only when `agents.runTask`, `llm`, and `approval.request` are present. Each input is reduced to a bounded owner/task/title/opening/brief/text/constraints/source envelope, checked for JSON safety, owner-prefix checked, approval-gated, and passed to `agents.runTask`. The result is reduced to a bounded `preview`, optional string suggestions, and optional string fields. Fiber disposal removes all handlers.

The plugin is not installed by `startTavern()` or `dsh-rp`. `llm` is required but unused. There is no story/session registry, authentication binding, cancellation exposed to callers, TTL/quota/replay protection, durable review ID, baseline/candidate snapshot, field diff, acceptance, conflict check, apply/reject/revert, or persistence. Results are transient task output.

### Creator Workbench service and routes

`CreatorWorkbenchService` is a process-local map of previews with a 15-minute TTL. It reads the current file-backed `StoryPackage`, extracts text or ST JSON/PNG, creates an in-memory candidate, computes diffs, and writes only in `apply()` or `revert()`.

Existing routes:

- `GET /api/story/get?id=...`
- `POST /api/creator/preview`
- `POST /api/creator/apply`
- `POST /api/creator/revert`
- `POST /api/story/save`

Apply validates expiry and baseline equality, then applies only explicitly accepted diff paths. Revert currently restores the baseline without checking expiry, used state, or concurrent changes; repeated revert can overwrite unrelated edits. Apply marks a preview used before the write/validation completes, so a failed write can consume it. The service does not expose preview lookup/status and route bodies have no Creator-specific schema/size/owner validation. `story-package-json` is declared in the contract but is not implemented by this service.

`creator-preview-apply.ts` contains a stronger Core proposal adapter with owner checks, validation, conflict detection, rollback and audit events, but it is not wired into `app-boot.ts`'s HTTP Workbench path.

### Browser and UI

`public/app.js` has a functional legacy StoryPackage editor and explicit Creator apply/revert wiring. ST card import switches to `/api/creator/preview` when the story editor is open; it does not auto-apply. Field decisions are held in `window.creatorPreview` until Apply. Ordinary story save remains `/api/story/save`.

`src/creator-workbench-ui.ts` defines a three-panel declarative manifest and capability-gated Agent actions, but `app-boot.ts` neither registers the manifest nor projects its state nor supplies its controller. Therefore that manifest is currently contract/test surface rather than a live Right Agent panel. No browser code currently creates or opens a DSH session.

Existing tests cover bridge bounds/owner checks/cleanup, Creator service extraction/apply/revert basics, proposal adapter behavior, manifest shape, and browser apply/revert wiring. They do not cover story-scoped DSH lifecycle, direct session opening, bridge installation, task results entering Creator previews, session ownership, route conflict semantics for revert, or UI controller/state registration.

## Available DSH APIs and lifecycle

The installed DSH host API proxy exposes:

- `sessions.create({ cwd | workspaceId, sessionId?, agentPreset? }) -> sessionId`
- `sessions.prompt({ sessionId, mode: 'queue' | 'steer', content: [{ type: 'text', text }] })`
- `sessions.history({ sessionId, ... })` for read-only history; it does not resume or publish an Agent
- `sessions.rename`, `sessions.cancel`, `sessions.fork`, `sessions.list`

The browser client runtime exposes `sessions.create`, `sessions.open`, `sessions.scope`, `sessions.history`, and related session operations. DSH session IDs are the shared agent/session identity. The host-side `AgentRegistry.create()` returns an owned `AgentHandle`; its disposer stops/drains the agent, unregisters it, removes its session, and unwinds the scoped world. `resume()` is the corresponding persisted-session operation.

The safest session-scoped design is therefore to let the DSH host own session creation and teardown, and pass only a validated story binding/context into the session setup. Do not create arbitrary Agent objects from the StageCraft HTTP server, do not infer ownership from ambient initiators, and do not expose private card or session internals through the bridge.

## Exact Integration Plan

1. **Define one explicit bridge contract.** Add a narrow optional `DshStorySessionBridge` capability, discovered from the supplied DSH host context rather than imported from private DSH packages. It should expose `openStorySession({ storyId, title, workspaceId/cwd? })`, `promptStorySession({ sessionId, task, envelope, signal? })`, `historyStorySession`, and `closeStorySession` only where the host permits it. Return opaque session IDs and public summaries, never Agent objects, private cards, credentials, or raw host internals.

2. **Bind every session to the current story.** Use a server-created opaque owner such as `creator:<app-instance>:<story-id>:<nonce>`, and store `{ storyId, sessionId, owner, createdAt, lastUsedAt }` in a bounded in-memory registry. Validate the selected story on every operation; reject foreign session/story pairs. Keep one active session per Workbench/story in the UI and close it when the Workbench closes or expires. If no optional bridge is present, show the existing Workbench without DSH actions.

3. **Use DSH's public lifecycle.** In an actual DSH host, create the session with `sessions.create` or the host's owned `AgentRegistry.create/resume`, using a story-specific workspace/cwd only if the host explicitly grants that directory. Prompt through `sessions.prompt`; read results through public history/event APIs. Do not use private custom-card access. For embedded standalone mode, keep the bridge absent and preserve current behavior.

4. **Install the bridge only when capabilities exist.** In `dsh-rp`/host composition, inject the optional DSH agent, approval, and session services and install the story bridge under a fiber. In `startTavern`, accept an optional bridge/controller capability and do not require DSH services. Preserve embedded runtime and current HTTP routes when absent.

5. **Unify DSH output with Creator review state.** Extend the Workbench service with `previewFromAgent` (or an equivalent adapter) that captures the exact baseline, validates a bounded candidate/field patch, computes `CreatorFieldDiff[]`, assigns a review ID/TTL, and stores source metadata including task/session/story owner. Every DSH result must enter this review store. No result may write a story file or Core state before explicit field decisions and Apply.

6. **Prefer the Core proposal path for application.** Wire the existing `CreatorPreviewApplyAdapter` into the Workbench route/controller where the Core runtime is available. Apply should create a proposal, require explicit approval, enforce the baseline revision/content conflict check, atomically persist accepted paths, and emit audit events. Revert/reject should only discard the pending review unless an explicit rollback operation is requested; never silently overwrite unrelated current edits. Keep the legacy file-backed service as the embedded compatibility path, but align expiry, ownership, conflict, and used-state rules.

7. **Register the live Right Agent panel.** At startup, register `createCreatorWorkbenchUi()` against a controller backed by the story-scoped registry and review store. Project editor values, review summary, diffs, warnings, task status, session status, and capability availability into the `creator.workbench` namespace. The controller must implement import/extract/task/decide/apply/revert, with task actions returning a review preview rather than applying.

8. **Add direct open behavior in the browser.** The Right Agent panel's Open/Start action should call an application capability that creates or reuses the session for the selected story, then navigate/open the DSH session through the host-provided client session runtime. If the optional capability is missing, keep the panel usable and explain that direct DSH opening is unavailable. Never construct a URL by guessing a private DSH route.

9. **Preserve compatibility.** Leave embedded runtime startup, old `/api/story/save`, legacy ST JSON/PNG import, Creator preview/apply/revert, and optional bridge semantics intact. ST import remains input into a review preview; the old direct `/api/st-cards/import` path remains unchanged outside Workbench mode.

10. **Test the contracts at the seams.** Add tests for bridge absent/present installation, story/session owner isolation, create/reuse/close lifecycle, bounded payloads and cancellation, DSH result to review preview conversion, review expiry and replay, explicit apply-only persistence, conflict-safe revert/reject, live manifest/controller registration, and browser direct-open capability fallback. Add an integration test using a fake public DSH session API rather than private card internals.

## Gaps and Risks to Resolve Before Implementation

- The current repository has no dependency or adapter for the DSH host API proxy/client runtime; adding direct browser session opening requires an optional host-injected capability or a deliberately versioned bridge package.
- The application currently has one `roomId` and constructs the Workbench repository from `options.storyId`, while `/api/story/get` accepts arbitrary IDs. The Workbench must be made explicitly story-ID scoped before supporting editing of existing stories reliably.
- `CreatorWorkbenchService.revert()` semantics are unsafe for concurrent edits and differ from the stronger proposal adapter; these must be reconciled before exposing a DSH-backed revert action.
- The task bridge's `llm` requirement is unused and should be removed or justified when the real DSH agent service is wired.
- Browser navigation into the DSH GUI needs a host-owned open-session callback or documented route contract; the current StageCraft app cannot safely infer it from `http://127.0.0.1:8899`.
- Session workspace/cwd access must be explicitly authorized. A story ID alone must never grant filesystem access to card contents or a private custom card.

No runtime source was changed in this audit.
