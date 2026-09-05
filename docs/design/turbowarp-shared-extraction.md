# TurboWarp Shared Package Extraction

This document defines the first extraction boundaries for reusable TurboWarp app components that should be shared by `tm-kamishibai` and `tm-3d-app`.

The goal is not to move Kamishibai semantics into shared packages. Shared packages should own app-neutral TurboWarp runtime, preview, and shell mechanics. `tm-kamishibai` keeps DSL 4.0 story semantics, diagnostics, copy, and release policy.

## Package Plan

### `@kubohiroya/turbowarp-runtime-host`

Status: published as `@kubohiroya/turbowarp-runtime-host@0.1.0` and pushed to <https://github.com/kubohiroya/turbowarp-runtime-host>.

Verification:

- `pnpm run check` passes.
- `npm install @kubohiroya/turbowarp-runtime-host@0.1.0` works from a clean temporary project.
- The broadcast port supports an app-specific diagnostic prefix, so `tm-kamishibai` can preserve `K4-BROADCAST-*` error codes while the shared package defaults to `TWRH-BROADCAST-*`.

Owns:

- Scratch VM / TurboWarp runtime resolution.
- Runtime event subscription and disposable listener cleanup.
- Narrow `startHats`, `getTargetForStage`, `_stopThread`, and `threads` access.
- App-neutral exact broadcast start/wait behavior.
- AbortSignal cancellation behavior for runtime-owned async operations.

Does not own:

- DSL 4.0 action semantics.
- Kamishibai story variable names or action manifest.
- Pose, bubble, speech, navigation, or scene transition semantics.
- Extension `getInfo()` metadata for a concrete app.

Migration status:

- `src/dsl4/platform/turbowarp-runtime-host.js` now creates the shared `createTurboWarpBroadcastPort({errorCodePrefix: 'K4'})` directly.
- The previous local `src/dsl4/platform/turbowarp-broadcast-action-port.js` wrapper and its wrapper-only tests were removed after the shared package took over the TurboWarp broadcast ownership rules.
- `scripts/sb3/dsl4-runtime-extension-entry.js` and `scripts/sb3/dsl4-runtime-authoring-profile.js` now resolve the TurboWarp runtime once through `createTurboWarpRuntimeHost({Scratch, requireUnsandboxed: true})` and reach it only through `runtime`, `onRuntimeEvent`, `startHats`, and `getStageTarget`. `Scratch.vm.runtime`, `runtime.on('PROJECT_STOP_ALL', …)`, and `getTargetForStage()` no longer appear in app code, and `test/dsl4-architecture.test.mjs` keeps them out.
- `Scratch.vm` surface that the shared package does not own — `toJSON()`, `saveProjectSb3DontZip()`, and `renderer.canvas` — stays in `tm-kamishibai`.
- Related `tm-kamishibai` checks pass: `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm dsl4:playback-runtime:generate`, and `pnpm test:quick`.

Remaining migration candidates:

- Stage target resolution in `src/dsl4/platform/turbowarp-transition-port.js` and `src/dsl4/platform/scratch-pose-feedback-adapter.js`. Those ports accept a runtime that only provides `getTargetForStage`, while `createTurboWarpRuntimeHost` also requires `on` and `startHats`. Migrate them once the shared package exposes a stage-only accessor, rather than widening the port contracts to fit the current host validation.
- `vm.runtime` access in `src/dsl4/browser-turbowarp-stage.js`, which owns its own Scratch VM instance instead of an injected TurboWarp host.

Acceptance criteria:

- Existing runtime host broadcast action tests still pass.
- Scratch VM access in app code is reduced to an injected runtime host interface.
- `tm-3d-app` can reuse the same runtime host for 3D scene graph operations.

### `@kubohiroya/turbowarp-preview-runtime`

Status: published as `@kubohiroya/turbowarp-preview-runtime@0.1.0` and pushed to <https://github.com/kubohiroya/turbowarp-preview-runtime>.

Verification:

- `pnpm run check` passes.
- `npm install @kubohiroya/turbowarp-preview-runtime@0.1.0` works from a clean temporary project.
- Initial API covers capability negotiation, session/revision validation, stage/defer/commit/disconnect handling, and app-neutral reload anchor resolution.

Owns:

- Preview protocol primitives.
- Preview transport policy.
- Live reload session primitives.
- Reload planning and reload policy primitives.
- Browser preview runtime bridge primitives.
- Browser source adapter contracts.
- App-neutral reload overlay and reload surface behavior.

Does not own:

- DSL 4.0 source frontend.
- Kamishibai diagnostic codes or source diagnostic projection.
- Kamishibai asset/session semantics.
- Pose or story runtime reload decisions.
- UI copy.

First migration candidates:

- `resolveDsl4ReloadAnchor` in `src/dsl4/preview-reload-policy.js`
- `src/dsl4/preview-protocol.js`
- `src/dsl4/preview-reload-policy.js`
- `src/dsl4/reload-planner.js`
- `src/builder/dsl4-preview-transport-policy.js`
- app-neutral pieces of `src/builder/dsl4-preview-reload-overlay.js`
- app-neutral pieces of `src/builder/dsl4-preview-reload-surface.js`

Acceptance criteria:

- Existing local/browser preview tests still pass.
- Preview protocol remains source-compatible for current DSL 4.0 preview clients.
- `tm-3d-app` can implement live preview without importing DSL 4.0 frontend code.

Migration status:

- `resolveDsl4ReloadAnchor` now delegates app-neutral anchor fallback to `resolveReloadAnchor` from `@kubohiroya/turbowarp-preview-runtime@0.1.0`.
- `validateCapabilities` in `src/dsl4/preview-source-protocol-port.js` now delegates capability token grammar, duplicate rejection, and ordering to `normalizeCapabilities` from `@kubohiroya/turbowarp-preview-runtime@0.1.0`. The DSL 4.0 required capability set stays local because it names `source.stage.v1`, `source.commit.v1`, `restart.choice.v1`, and `diagnostics.v1`, which are Kamishibai preview policy rather than shared grammar. Malformed capability input now fails with the shared `PreviewProtocolError`, which still extends `TypeError`, so existing `assert.throws` callers keep passing.
- The broader `createDsl4PreviewProtocolSession` still remains in `tm-kamishibai` because the current DSL 4.0 wire protocol owns candidate ids, restart choices, source integrity, and `preview.source.staged/committed/deferred` events that are not part of `turbowarp-preview-runtime@0.1.0`.
- Related checks pass: `pnpm sb3:check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, and `node --test test/dsl4-preview-reload-policy.test.mjs test/dsl4-preview-reload-overlay.test.mjs test/dsl4-preview-reload-surface.test.mjs test/dsl4-architecture.test.mjs test/dsl4-downloadable-release.test.mjs`.

Open boundary decision before the next extraction step:

- `src/dsl4/preview-protocol.js` and `src/dsl4/reload-planner.js` are declared DSL 4.0 core entries in `test/dsl4-architecture.test.mjs`, and that test forbids every `@kubohiroya/turbowarp-*` specifier inside a core import graph. The duplicate capability token grammar in `preview-protocol.js` therefore cannot delegate to `normalizeCapabilities` yet.
- The rule exists to keep the core free of platform and I/O dependencies. `@kubohiroya/turbowarp-preview-runtime` has no dependencies and no platform access, so a narrow allowlist for that one specifier would be consistent with the rule's intent, but relaxing a core purity guard is a separate decision and should land as its own PR rather than as a side effect of an import migration.

### `@kubohiroya/turbowarp-app-shell`

Status: published as `@kubohiroya/turbowarp-app-shell@0.1.0` and pushed to <https://github.com/kubohiroya/turbowarp-app-shell>.

Verification:

- `pnpm run check` passes.
- `npm install @kubohiroya/turbowarp-app-shell@0.1.0` works from a clean temporary project.
- Initial API covers locale resolution and disposable runtime message indicators with injected copy/action behavior.

Owns:

- Standard app shell skeleton.
- Runtime title controls mechanics.
- Runtime application menu mechanics.
- Loading screen presenter.
- Runtime error and warning indicators.
- Source chooser shell mechanics.
- Locale/copy/icon/action injection contracts.

Does not own:

- Kamishibai menu labels or copy.
- DSL 4.0 diagnostic presentation policy.
- Story source selection policy.
- Pose/runtime-specific controls.
- Title backdrop generation policy.

First migration candidates:

- app-neutral pieces of `src/dsl4/platform/standard-app-shell.js`
- `src/dsl4/platform/runtime-title-controls.js`
- `src/dsl4/platform/runtime-application-menu.js`
- `src/dsl4/platform/loading-screen-presenter.js`
- `src/dsl4/platform/runtime-error-indicator.js`
- `src/dsl4/platform/runtime-warning-indicator.js`
- app-neutral pieces of `src/dsl4/platform/runtime-source-chooser.js`

Migration status in `tm-kamishibai`:

- `src/dsl4/platform/runtime-error-indicator.js` now delegates browser locale fallback to `resolveAppShellLocale` from `@kubohiroya/turbowarp-app-shell@0.1.0`.
- The fatal error dialog still remains in `tm-kamishibai` because it owns DSL 4.0 diagnostic rows, source excerpts, `data-dsl4-runtime-error-*` test hooks, and the return-to-menu action contract.
- The non-modal runtime warning indicator still remains in `tm-kamishibai` because `turbowarp-app-shell@0.1.0` only exposes a centered message overlay and does not yet provide a bottom toast with dismiss semantics and `role="status"`.

Acceptance criteria:

- Browser fixture tests keep the same visible behavior.
- Copy, icons, locale, and actions are injected from `tm-kamishibai`.
- `tm-3d-app` can build a 3D app shell without depending on Kamishibai story code.

## Migration Order

1. Extract `@kubohiroya/turbowarp-runtime-host` first. It is the lowest-level boundary and can support both app shell and preview runtime work.
2. Extract preview protocol and reload primitives into `@kubohiroya/turbowarp-preview-runtime`.
3. Extract app shell mechanics into `@kubohiroya/turbowarp-app-shell`.
4. Replace `tm-kamishibai` imports incrementally, one package and one behavior group at a time.
5. Use the new packages from `tm-3d-app` only after the equivalent `tm-kamishibai` behavior remains covered by tests.

## Rollback

Each migration PR should keep the old app-specific behavior close to the call site until the replacement test passes. If a shared package boundary proves too broad, revert the import migration and keep the extracted package API narrower rather than moving app semantics into the shared package.
