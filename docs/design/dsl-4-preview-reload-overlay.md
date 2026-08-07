# DSL 4.0 preview reload status overlay

Issue #394 replaces candidate-blocking reload prompts with one development-only policy and overlay
shared by Web Preview and the browser page opened by the CLI preview host. The machine-readable
companion is `test/fixtures/dsl4/preview-reload-overlay-contract.json`.

## Rollout and ownership

The startup-fixed `dsl4PreviewReloadOverlay` flag defaults to `false` and requires `dsl4Runtime` and
`dsl4AppShell`. It is independent of `dsl4WebPreviewAdapter`, so Web and CLI browser hosts construct
the same component. When disabled, the existing candidate dialog remains available. Rollback sets
`dsl4PreviewReloadOverlay=false`; source and asset adapters remain unchanged.

The overlay, policy, preference, successful reload time, layout rectangles, dialog state, candidate
revision, and browser storage key are development-session data. They cannot enter YAML, project
settings, SB3, Web player, Packager output, or the ordinary TurboWarp editor.
Production exclusion checks reject the persisted field names `previewReloadOverlay`,
`reloadPreference`, `reloadTimestamp`, `reloadDialogState`, `reloadLayoutState`, and
`reloadCandidateRevision`.

## State and priority

The state model represents `watching`, `stabilizing`, `applying`, `reloaded`, `diagnostic`, `paused`,
and `disconnected`. Display priority is `diagnostic > applying > reloaded > stabilizing > paused >
disconnected > watching`. A diagnostic keeps the last-known-good generation and is never dismissed
by ordinary preview input.

A valid monotonic generation auto-applies at the runtime safe boundary with the session preference.
The default requested preference is `action`. An action anchor is used only when replay-safe;
fallback is deterministic from action to scene to story. The requested preference is retained when
fallback occurs, while the actual anchor and bounded reason are recorded separately.

Rapid candidates and commits are serialized. Only the newest valid pending generation is adopted,
and an older or duplicate adoption cannot move the preview backward. Source and asset data from
different revisions are never combined.

## Success acknowledgement

`reloaded` starts only after commit acknowledgement, and the displayed time is the acknowledgement
time. The initiating input cannot acknowledge its own reload. The first later meaningful preview key
or touch records acknowledgement, but the visual success state remains for at least 2,000 ms.
Opening the status dialog is an explicit acknowledgement. A diagnostic always overrides success.

## Dialog transaction

Opening the status button captures the latest validated generation without replacing it while the
dialog is open. A newer generation marks that selection stale and returns the dialog to its first
stage.

The first stage selects `story`, `scene`, or `action`; selection alone has no side effect. The second
stage provides four explicit scopes:

- `reload-once`: restart the displayed generation without changing the session preference.
- `reload-and-save`: restart it and commit the selected preference only after reload succeeds.
- `save-next`: update the next-reload preference immediately without reloading or success emphasis.
- `cancel`: discard every draft value without reloading or changing preference.

The close button and Escape have exactly the `cancel` meaning. Focus enters the modal, remains inside
with Tab/Shift+Tab, and returns to the status button after close. Automatic reload never steals focus.
Status changes use a polite live region; a new diagnostic uses an assertive live region without
re-announcing an identical code.

## Layout and eight anchors

The preferred browser-local anchor defaults to `top-right` and uses the versioned key
`dsl4.preview.reload.anchor.v1`. The selectable anchors, in deterministic tie-break order, are
`top-left`, `top-center`, `top-right`, `right-center`, `bottom-right`, `bottom-center`,
`bottom-left`, and `left-center`; the center is never selectable.

The common layout coordinator receives viewport/safe-area geometry and explicit reserved rectangles
from camera controls or other preview chrome. It chooses the closest non-intersecting anchor and
records a collision reason. When every anchor is occupied, it stacks within the preferred anchor
without overlapping the registered rectangle. It recomputes after geometry changes and returns to the
preferred anchor without animation when the conflict disappears. Movement is deferred while the
button is pressed, pointer-captured, or keyboard-focused unless the current position leaves the
viewport.

The status button is at least 44 x 44 CSS px, stays inside the safe area, has a visible focus ring and
3:1 component contrast, and expresses state with icon shape, badge text, accessible name, and status
text rather than color alone. Any pulse is bounded to five seconds and disabled by
`prefers-reduced-motion`.

## Verification and rollback

Unit and DOM integration fixtures cover safe fallback, rapid generations, manual transaction scopes,
stale dialogs, success timing, diagnostic priority, keyboard/touch/focus behavior, reduced motion,
eight-anchor collision resolution, browser-local storage fallback, Web/CLI component identity, and
production exclusion.

Rollback is one startup change: `dsl4PreviewReloadOverlay=false`. No stored project data requires
migration; the browser-local anchor value is ignored while the flag is off.
