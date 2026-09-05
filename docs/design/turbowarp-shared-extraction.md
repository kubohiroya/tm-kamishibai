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
- `createDsl4TurboWarpRuntimeEnvironment` now builds one `createTurboWarpRuntimeHost({runtime})` for the whole session and hands it to the adapters that need the Stage. `HostPortContext` carries `runtimeHost` next to `runtime`, so `createHostPort` implementations receive the adapter instead of resolving the Stage themselves.
- `src/dsl4/platform/turbowarp-transition-port.js` and `src/dsl4/platform/scratch-pose-feedback-adapter.js` take an injected `runtimeHost` and call `getStageTarget()`. Their unit fixtures shrank from a runtime duck-type to the host contract, which is what the acceptance criterion "Scratch VM access in app code is reduced to an injected runtime host interface" asks for. The earlier concern about widening the port contracts does not apply to injection: the ports never construct a host, so they never require `on` or `startHats`.
- `src/dsl4/browser-turbowarp-stage.js` builds its own host from the VM it creates and uses `getStageTarget()` and `runtimeHost.runtime`. It still reads `vm.runtime.targets` directly for the target-count snapshot, because `targets` is not part of the shared surface.
- `getTargetForStage` no longer appears anywhere in `tm-kamishibai`, and `test/dsl4-architecture.test.mjs` keeps it out.
- Related `tm-kamishibai` checks pass: `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm dsl4:playback-runtime:generate`, `pnpm test:full`, `pnpm sb3:check`, and `pnpm e2e:chromium`.

Remaining migration candidates:

These need API that `turbowarp-runtime-host@0.1.0` does not expose yet, so they stay in `tm-kamishibai` until the shared package grows:

- Target enumeration (`runtime.targets`) used by `src/dsl4/platform/turbowarp-actor-adapter.js`, `src/dsl4/platform/asset-manager-adapter.js`, `src/dsl4/platform/turbowarp-crossfade-platform.js`, and `src/dsl4/action-hat-detector.js`.
- Renderer access (`runtime.renderer`, `runtime.requestRedraw`) used by the crossfade platform and the bubble advance indicator.
- Monitor access (`runtime.monitorBlocks`, `runtime.getMonitorState`) used by the Scratch pose feedback adapter through `runtimeHost.runtime`.
- The runtime variable block surface and the block surface construction helper named in issue #689. Those are `getInfo()`-shaped block builders; extracting them needs an app-neutral block surface API in the shared package.

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
- `src/dsl4/preview-protocol.ts`
- `src/dsl4/preview-reload-policy.js`
- `src/dsl4/reload-planner.ts`
- `src/builder/dsl4-preview-transport-policy.js`
- app-neutral pieces of `src/builder/dsl4-preview-reload-overlay.js`
- app-neutral pieces of `src/builder/dsl4-preview-reload-surface.js`

Acceptance criteria:

- Existing local/browser preview tests still pass.
- Preview protocol remains source-compatible for current DSL 4.0 preview clients.
- `tm-3d-app` can implement live preview without importing DSL 4.0 frontend code.

Migration status:

- `resolveDsl4ReloadAnchor` now delegates app-neutral anchor fallback to `resolveReloadAnchor` from `@kubohiroya/turbowarp-preview-runtime@0.1.0`.
- `validateCapabilities` in `src/dsl4/preview-source-protocol-port.ts` now delegates capability token grammar, duplicate rejection, and ordering to `normalizeCapabilities` from `@kubohiroya/turbowarp-preview-runtime@0.1.0`. The DSL 4.0 required capability set stays local because it names `source.stage.v1`, `source.commit.v1`, `restart.choice.v1`, and `diagnostics.v1`, which are Kamishibai preview policy rather than shared grammar. Malformed capability input now fails with the shared `PreviewProtocolError`, which still extends `TypeError`, so existing `assert.throws` callers keep passing.
- `capabilityList` in `src/dsl4/preview-protocol.ts` now delegates to the same `normalizeCapabilities`, and restates its rejection as `K4-PREVIEW-PROTOCOL-SCHEMA` so the DSL 4.0 wire contract is unchanged. `test/dsl4-preview-protocol.test.mjs` pins that error code for malformed, mis-cased, and duplicated capability tokens, which was previously unpinned.
- The broader `createDsl4PreviewProtocolSession` still remains in `tm-kamishibai` because the current DSL 4.0 wire protocol owns candidate ids, restart choices, source integrity, and `preview.source.staged/committed/deferred` events that are not part of `turbowarp-preview-runtime@0.1.0`.
- Related checks pass: `pnpm sb3:check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, and `node --test test/dsl4-preview-reload-policy.test.mjs test/dsl4-preview-reload-overlay.test.mjs test/dsl4-preview-reload-surface.test.mjs test/dsl4-architecture.test.mjs test/dsl4-downloadable-release.test.mjs`.

DSL 4.0 core purity rule:

- `test/dsl4-architecture.test.mjs` used to forbid every `@kubohiroya/turbowarp-*` specifier inside a declared DSL 4.0 core import graph, which blocked core entries such as `src/dsl4/preview-protocol.ts` and `src/dsl4/reload-planner.ts` from using any shared package.
- The rule now allows a named allowlist, `pureSharedPackages`, currently holding only `@kubohiroya/turbowarp-preview-runtime`. Every other `@kubohiroya/turbowarp-*` specifier and `scratch-vm` stay forbidden in core graphs, and `node:` builtins stay forbidden everywhere in them.
- The allowlist is not a blanket exemption. A companion test asserts that each listed package declares no `dependencies`, `peerDependencies`, or `optionalDependencies`, that its entry module imports nothing, and that its source never names `globalThis`, `window`, `document`, `navigator`, `indexedDB`, `localStorage`, `fetch`, `XMLHttpRequest`, `WebSocket`, `Scratch`, `process`, or `require`. `@kubohiroya/turbowarp-app-shell` fails that guard today, so the intent of the original rule is preserved: the core stays outside platform and I/O dependencies, while app-neutral extraction is no longer blocked by package boundary alone.
- Adding a package to `pureSharedPackages` is a deliberate decision. If a shared package ever needs platform access, it does not belong in the DSL 4.0 core graph and its core caller should move behind an injected port instead.

### `@kubohiroya/turbowarp-app-shell`

Status: published as `@kubohiroya/turbowarp-app-shell@0.1.0` and pushed to <https://github.com/kubohiroya/turbowarp-app-shell>. `0.2.0` adds the shell primitives this repository now consumes.

Verification:

- `pnpm run check` passes.
- `npm install @kubohiroya/turbowarp-app-shell@0.1.0` works from a clean temporary project.
- `0.1.0` covers locale resolution and disposable runtime message indicators with injected copy/action behavior.
- `0.2.0` adds title controls, application menu, loading presenter, and source chooser primitives, plus the injection points those primitives need to keep an app's own presentation: per-part DOM attributes, icon `filter`/`size`/`fontSize`, absolute menu action `position`, menu status `color`, `closeIconMetrics`, and `align: 'center'` source choices.

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

Remaining migration candidates:

- app-neutral pieces of `src/dsl4/platform/standard-app-shell.ts`
- `src/dsl4/platform/runtime-error-indicator.ts`
- `src/dsl4/platform/runtime-warning-indicator.ts`

Migration status in `tm-kamishibai`:

- `src/dsl4/platform/runtime-title-controls.ts`, `src/dsl4/platform/runtime-application-menu.ts`, `src/dsl4/platform/loading-screen-presenter.ts`, and `src/dsl4/platform/runtime-source-chooser.ts` are now thin adapters over `createAppShellTitleControls`, `createAppShellApplicationMenu`, `createAppShellLoadingPresenter`, and `createAppShellSourceChooser`. Each module keeps its existing Kamishibai-facing signature, so no call site changed.
- `tm-kamishibai` injects everything app-specific: menu and title copy, the menu icon set and its recolor filter, the stage-relative menu layout including the build-visible arrangement, the close glyph metrics, the source choice set, and every `data-dsl4-*` selector.
- The rendered DOM is unchanged apart from additive `data-turbowarp-app-shell-*` attributes and the menu/title icon element, which is now a `<span>` with a `background-image` instead of an `<img>`. Both render the same asset at the same container-relative box.
- `src/dsl4/platform/runtime-error-indicator.ts` delegates browser locale fallback to `resolveAppShellLocale`.
- The fatal error dialog still remains in `tm-kamishibai` because it owns DSL 4.0 diagnostic rows, source excerpts, `data-dsl4-runtime-error-*` test hooks, and the return-to-menu action contract.
- The non-modal runtime warning indicator still remains in `tm-kamishibai` because `turbowarp-app-shell@0.2.0` only exposes a centered message overlay and does not yet provide a bottom toast with dismiss semantics and `role="status"`.
- The Standard app-shell title dialog in `src/dsl4/platform/standard-app-shell.ts` still remains in `tm-kamishibai` because `turbowarp-app-shell@0.2.0` has no modal about-dialog primitive, and the dialog owns the Kamishibai title backdrop policy and runtime start handoff.
- `0.2.0` is pinned to a git ref rather than a registry version, because the npm release is still blocked on publish credentials. `package.json` names the commit, and `pnpm-workspace.yaml` allows its build so pnpm runs the package's `prepare` script — a git checkout carries no `dist/`. Restore the registry pin once `0.2.0` is on npm: set the dependency back to `0.2.0`, drop the `allowBuilds` entry, restore the `minimumReleaseAgeExclude` entry, and re-run `pnpm install`.

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
