# DSL 4.0 transactional asset live reload

Issue #391 defines the development-only contract for reloading project-local image, sound, and
pose-model assets without rebuilding the base SB3. This document fixes the implementation boundary;
the machine-readable companion is
`test/fixtures/dsl4/asset-live-reload-contract.json`.

## Rollout boundary

The startup-fixed `dsl4WebPreviewAssetLiveReload` flag defaults to `false` and requires
`dsl4Runtime`, `dsl4AppShell`, and `dsl4WebPreviewAdapter`. When disabled, Web Preview keeps the
source-only behavior from #390 and treats asset changes as a CLI full-rebuild boundary. The adapter,
poll timers, decoders, providers, and protocol capabilities are not initialized.

When enabled, `createDsl4WebPreviewShell` owns one `createDsl4BrowserAssetReloadPipeline`. The source
adapter passes the selected root handle only through an in-process callback, and each valid source
result starts or updates the asset pipeline with the startup-fixed structural fingerprint. Shell
polling, idle settlement, diagnostics, and disposal include both source and asset paths.

When `dsl4PreviewReloadOverlay` is also enabled, the shell constructs the shared reload surface first
and passes that same instance to the asset pipeline. Asset candidates, diagnostics, and watch state
therefore share one revision order and overlay with source candidates; `restartGeneration` is
required for manual asset reload from the shared dialog.

The feature is part of the development preview shell. An embedded-story production run, Web player,
or Packager must not initialize it. The non-embedded TurboWarp editor may own transient preview state
in memory, but no saved SB3 may contain a directory handle, file/blob/array-buffer, candidate,
revision, preview token, decoded resource, reload UI state, preference, or reload timestamp.

Issue #538 adds a narrower path to the non-embedded Standard SB3. Each valid YAML generation
re-captures its declared local files and re-resolves remote and VM-owned project assets before source
staging. This does not enable `dsl4WebPreviewAssetLiveReload`: changing only an asset without a YAML
generation is still outside that path. An embedded-story production run remains unchanged.

## Ownership and security

- The browser adapter uses only the read-only directory handle selected by the user for #390.
- It reads the exact file paths declared by the active StoryDocument and the exact new paths declared
  by a validated candidate StoryDocument. It never recursively scans the project root.
- A pose-model directory is one declared bundle boundary. Only its bundle entries are enumerated.
- Absolute paths, URLs, backslashes, empty and dot segments, and traversal outside the selected root
  are rejected before filesystem access.
- Source text, asset bytes, full paths, handles, and decoded resources never enter protocol summaries,
  diagnostics, logs, telemetry, or reload UI state.
- Hashing, decoding, preparation, and model registration accept cancellation. Superseded candidates
  release every owned object URL, audio resource, tensor/model, and provider once.

## Snapshot and change classes

Each accepted generation fixes one normalized source integrity, structural fingerprint, asset graph,
and file/bundle content integrity. `lastModified`, size, and filesystem events are hints only.

| Change                                                              | Classification                   | Action                                        |
| ------------------------------------------------------------------- | -------------------------------- | --------------------------------------------- |
| No normalized source or content change                              | `no-change`                      | Do nothing                                    |
| Source only                                                         | `source-live-reload`             | Existing source candidate                     |
| Existing ID content only                                            | `asset-live-reload`              | Asset candidate                               |
| Source and existing content                                         | `composite-live-reload`          | One source+asset generation                   |
| Source plus new file-backed ID                                      | `additive-composite-live-reload` | One additive generation                       |
| Runtime structure, removal, rename, kind/path, or pose bundle shape | `full-rebuild`                   | Keep current generation and show CLI fallback |

An addition is safe only when every active asset entry is byte-for-byte graph-equivalent, every new
ID is unique and file-backed, all referenced files are stable and validated, and the candidate source
changed. Project-owned TurboWarp assets have no filesystem content integrity and their same-VM native
updates remain outside this transaction. In the non-embedded #538 path, a later valid source
generation may nevertheless refer to the current VM costume, backdrop, or sound by name; reload does
not call `loadProject()` and therefore does not remove editor-added assets.

## Stable read and limits

The browser uses non-overlapping 500 ms foreground polling, a 5 s hidden-page interval, a 100 ms quiet
window, 50 ms retry, and a 2 s stability timeout. A stable candidate requires two reads with the same
file set, bytes, and SHA-256 integrity. The initial limits are 128 files, 20 MiB per file, 64 MiB total,
16,777,216 image pixels, 1,800 audio seconds, 8 channels, 192 kHz, and two concurrent decode tasks.
Callers may select lower positive limits but may not omit limits.

YAML-first and file-first additions converge on the same candidate. Missing, partial, unstable,
permission-denied, or invalid inputs retain the last-known-good generation and keep watching the exact
path. Restoring identical content clears the diagnostic without reload; different valid content creates
one new monotonic candidate.

## Kind validation

- Image assets require an allowed extension and matching SVG/PNG/JPEG/WebP/GIF signature. Browser
  decode and pixel dimensions must pass before staging.
- Sound assets require an allowed extension and matching WAV/MP3/Ogg signature. Browser decode,
  duration, channel count, and sample rate must pass.
- Pose models require `model.json`, `metadata.json`, and exactly one weights `.bin`. JSON parsing,
  declared weight metadata, labels, and StoryDocument pose references must agree. The candidate uses a
  generation-specific TM namespace and never overwrites the active registration in place.

## Transaction and protocol

The optional protocol capabilities are `asset.stage.v1`, `asset.commit.v1`, `asset.defer.v1`, and
`asset.diagnostics.v1`. A peer that does not negotiate them fails closed to full rebuild for asset
changes while source-only reload remains available.

One monotonic revision binds source, graph, bytes, validation, affected scenes, and a one-shot asset
provider. The transaction prepares the complete candidate before a runtime safe boundary, validates the
candidate/revision/session again, activates the new runtime and asset generation atomically, and releases
the old generation only after acknowledgement. Prepare or activation failure rolls back the candidate,
resumes the old generation, and cannot leave a mixture of old and new assets.

Failure to release the previous generation after the commit acknowledgement is a cleanup diagnostic,
not a failed commit: the protocol still reports the newly active revision as committed. The failed
release remains owned by the transaction and is retried during disposal.

The protocol summary may include asset ID, kind, file count, abbreviated before/after integrity,
affected scene IDs, validation outcome, and diagnostic IDs. It cannot include bytes or paths.

## Diagnostics and rollback

Stable codes distinguish missing/renamed files, permission loss, unstable snapshots, count/size limits,
media signature/decode/semantic failures, incomplete pose bundles, stale revisions, preparation,
activation, rollback/release failures, background throttling, and full rebuild requirements.

Rollback sets `dsl4WebPreviewAssetLiveReload=false`. Source-only Web Preview, Node source watching,
production playback, existing asset schema, and built SB3 files remain valid. All candidate state is
session-owned, so rollback requires no persistent-data migration.

## Browser support, latency, and known limits

Support is capability-based rather than user-agent-based.

| Browser context                                                         | Asset live reload behavior                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Secure top-level context with `showDirectoryPicker` and read permission | Enabled when every required startup flag and optional asset protocol capability is present  |
| Insecure or embedded context, missing picker API, or revoked permission | Last-known-good preview continues; the diagnostic points to the CLI validate/build fallback |
| Peer missing any `asset.*.v1` capability                                | Candidate is released and classified as full-rebuild-required                               |

The nominal visible-page detection budget is the 500 ms poll interval plus a 100 ms quiet window and
two reads. Hidden pages use a 5 s interval. An unstable save retries every 50 ms for at most 2 s; the
current generation remains active throughout. The implementation serializes reads and validation, so
the effective decode concurrency is one and stays below the contract ceiling of two.

The initial finite ceilings are 128 files, 20 MiB per file, 64 MiB total, 16,777,216 image pixels,
1,800 audio seconds, 8 channels, and 192 kHz. A pose bundle is currently an unpacked directory with
exactly `model.json`, `metadata.json`, and one weights `.bin`. The adapter does not persist directory
handles, scan for undeclared files, or watch VM-owned project asset mutation as an independent
candidate. The non-embedded path re-resolves those project assets only when a valid YAML generation
is staged. Asset removals, renames, kind/path changes, and bundle-shape changes remain full-rebuild
boundaries for the dedicated asset-only transaction.
