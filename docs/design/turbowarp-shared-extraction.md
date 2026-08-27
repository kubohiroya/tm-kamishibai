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

- `src/dsl4/platform/turbowarp-broadcast-action-port.js` now delegates to `createTurboWarpBroadcastPort({errorCodePrefix: 'K4'})`.
- Related `tm-kamishibai` checks pass: `pnpm typecheck`, `pnpm lint`, and `node --test test/dsl4-turbowarp-broadcast-action-port.test.mjs test/dsl4-architecture.test.mjs test/dsl4-turbowarp-runtime-host.test.mjs`.

Remaining migration candidates:

- runtime access pieces from `src/dsl4/platform/turbowarp-runtime-host.js`
- generic VM subscription patterns used by runtime shutdown handling

Compatibility wrapper:

```js
import {createTurboWarpBroadcastPort} from '@kubohiroya/turbowarp-runtime-host';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function broadcastError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

export function createDsl4TurboWarpBroadcastActionPort(options) {
  if (!isRecord(options)) {
    throw broadcastError(
      'K4-BROADCAST-RUNTIME-001',
      'TurboWarp broadcast action port options must be an object',
    );
  }
  return createTurboWarpBroadcastPort({
    runtime: options.runtime,
    errorCodePrefix: 'K4',
  });
}
```

The wrapper keeps the public DSL 4.0 factory name and `K4-BROADCAST-*` diagnostic surface while moving the exact broadcast/wait mechanics to the shared package.

Acceptance criteria:

- Existing broadcast action tests still pass.
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
