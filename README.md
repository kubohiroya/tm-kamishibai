# TMPose Kamishibai

English | [日本語](README.ja.md)

**Participatory AI storytelling driven by body poses**

TMPose Kamishibai is an interactive storytelling system in which participants move a story forward by posing in front of a camera. It uses TMPose for pose recognition and TurboWarp for authoring and playback, turning scripts and assets into stories that run on the Web or as SB3 projects.

This repository contains the Kamishibai runtime, DSL, CLI and JavaScript APIs, distributable SB3 projects, and the public website. The [documentation site](https://kubohiroya.github.io/tmpose-kamishibai-docs/) is the source of truth for operating instructions and script references.

![TMPose Kamishibai showing Urashima Taro and a turtle over a camera feed while pose recognition advances the story](site/images/image01.png)

[Project website](https://kubohiroya.github.io/tmpose-kamishibai/) · [Try the Web app](https://sqs.prof.cuc.ac.jp/kamishibai/) · [Download an SB3](https://kubohiroya.github.io/tmpose-kamishibai/downloads/) · [Read the documentation](https://kubohiroya.github.io/tmpose-kamishibai-docs/) · [Explore samples](https://kubohiroya.github.io/tmpose-kamishibai-samples/)

## What You Can Build

- Advance a story through participant poses, keyboard input, and stage touches
- Describe scenes, branches, dialogue, motion, audio, and pose recognition in YAML or the 3.1/3.2 text DSL
- Preview scripts in TurboWarp and export self-contained SB3 stories for distribution
- Automate validation, live preview, SB3 builds, legacy DSL conversion, and asset distribution with the CLI
- Invoke DSL 4.0 core actions from TurboWarp blocks or the JavaScript API

## Choose a Version

|                 | 3.2.3                                           | 4.0.0-rc.7                                                    |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Status          | Stable and currently recommended                | Release candidate                                             |
| Best for        | Workshops, stable use, existing 3.1/3.2 stories | Evaluating YAML authoring, browser workflows, and the CLI/API |
| Script format   | 3.1/3.2 text DSL                                | DSL 4.0 YAML                                                  |
| Get it          | [Downloads][downloads]                          | [Downloads][downloads] or the npm `next` tag                  |
| Read on updates | [Published documentation][docs]                 | [4.0 release notes][rc7]                                      |

If you are unsure, use 3.2.3. Version 4.0.0-rc.7 is a public candidate for evaluating the 4.0 authoring workflow and APIs before the stable release. Published 3.1 and 3.2 stories continue to work without migrating to 4.0.

## Try It First

Open the [published Web app](https://sqs.prof.cuc.ac.jp/kamishibai/) or the [Urashima Taro sample](https://kubohiroya.github.io/tmpose-kamishibai-samples/stories/urashima/web/) to try a story in your browser. Allow camera access, then follow the on-screen instructions and perform the requested poses.

To open a project in TurboWarp, download an SB3 for the series you need from the [downloads page][downloads]. Materials for running an event are organized on the [workshops page](https://kubohiroya.github.io/tmpose-kamishibai-docs/workshops/).

## Build a Story with DSL 4.0

### Browser-only authoring

The 4.0.0-rc.7 Standard SB3 includes an authoring runner that selects and validates a script, provides live preview, and builds a distributable SB3.

1. [Download the 4.0 SB3][downloads] and open it in the [TurboWarp Editor](https://turbowarp.org/editor).
2. Click the green flag, then choose **Open** and select a story file or project directory.
3. Edit YAML or local assets in an external editor. Valid saves are checked and applied automatically.
4. Choose **Build distributable SB3** to save a story with its script and assets embedded.

Watching a project directory requires the File System Access API in a top-level HTTPS page on desktop Chrome or Edge. When a native save picker is unavailable, the runner falls back to a browser download. Other unsupported authoring operations can use single-file selection or the CLI below. See the [DSL 4.0 author guide](https://kubohiroya.github.io/tmpose-kamishibai-docs/dsl-author-guides/dsl-4.0-author-guide/) for browser requirements, UI instructions, and troubleshooting.

### Minimal project

A DSL 4.0 project can consist of just one root-level `.k4.yml` script. Assets such as images, audio,
and pose models may live below the same project root; their directory names are organizational and
may be chosen freely.

```text
my-story/
└── opening.k4.yml
```

When exactly one root-level `.k4.yml` file exists, TMPose Kamishibai selects it automatically and
`project.source.yml` is unnecessary. With two or more scripts, select the entry script either with
`project.source.yml` or the CLI `--source` option instead of relying on a fixed filename.

```text
my-story/
├── project.source.yml
├── opening.k4.yml
└── alternate-ending.k4.yml
```

```yaml
path: opening.k4.yml
```

Every `project.source.yml` field is optional.

| Field                          | Required | Value or default                                                                                        |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `formatVersion`                | No       | `1`                                                                                                     |
| `mode`                         | No       | `external`                                                                                              |
| `sourceId`                     | No       | `main`; the CLI `--source-id` option overrides it.                                                      |
| `path`                         | No       | No fixed filename. Selection is `--source`, then `path`, then the only root-level `*.k4.yml` candidate. |
| `cacheId`, `cacheDatabaseName` | No       | Absent by default; when explicitly supplied, both fields are required together.                         |

An empty or comment-only manifest therefore applies all defaults. If neither the CLI nor a manifest
selects a source, zero or multiple root-level `.k4.yml` candidates produce an error. A missing
manifest is not created implicitly.

Project input also accepts `project.source.yaml` and `project.source.json`, discovered after
`project.source.yml` in that order. This README consistently uses the recommended `.yml` spelling.

At minimum, a `.k4.yml` script declares a version and one or more scenes.

```yaml
kamishibai: '4.0'

controls:
  keymaps:
    production:
      Space: navigation.nextAction

scenes:
  opening:
    - wait: 1
    - goto: ending
  ending: []
```

The source order of `scenes` defines the normal execution order. Do not use formatters that sort scene keys, and avoid scene IDs made only of digits with the current implementation. See the [DSL 4.0 surface specification](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-surface.md#21-scenes-mappingの順序) for the formal contract and known limitation.

For practical scripts, asset references, pose models, branches, and speech bubbles, continue with the [author guide](https://kubohiroya.github.io/tmpose-kamishibai-docs/dsl-author-guides/dsl-4.0-author-guide/) and the [sample repository](https://github.com/kubohiroya/tmpose-kamishibai-samples).

### Validate, preview, and build with the CLI

The [`@kubohiroya/tmpose-kamishibai`](https://www.npmjs.com/package/@kubohiroya/tmpose-kamishibai/v/4.0.0-rc.7) CLI is intended for CI, reproducible builds, larger projects, and distribution-profile management. Use Node.js 22.12.0 or later and pnpm 11, and install the exact version you have validated.

```bash
pnpm add --save-exact @kubohiroya/tmpose-kamishibai@4.0.0-rc.7
pnpm exec tmpose-kamishibai --help
```

Validate a script without building it.

```bash
pnpm exec tmpose-kamishibai validate-dsl4 \
  --input opening.k4.yml \
  --format pretty
```

Watch the complete project and preview it in a browser.

```bash
pnpm exec tmpose-kamishibai preview-dsl4 --watch \
  --base kamishibai-4-base.sb3 \
  --project-root . \
  --control-profile production \
  --channel bundled
```

Build a self-contained SB3 from the same input.

```bash
pnpm exec tmpose-kamishibai build-dsl4 \
  --base kamishibai-4-base.sb3 \
  --project-root . \
  --output dist/my-story.sb3 \
  --control-profile production \
  --channel bundled
```

The CLI applies finite safety limits when the four common limit options are omitted.

| Option                    | Default   | Override or limitation                                                                |
| ------------------------- | --------- | ------------------------------------------------------------------------------------- |
| `--max-source-bytes`      | 1048576   | Current 1 MiB frontend ceiling, bounded separately by YAML node and action limits     |
| `--max-asset-file-bytes`  | 16777216  | Increase when one reviewed asset is larger than 16 MiB                                |
| `--max-asset-files`       | 256       | Increase for build/asset jobs with more files; browser preview currently stops at 256 |
| `--max-total-asset-bytes` | 134217728 | Increase when reviewed assets exceed 128 MiB in total                                 |

These values are ceilings, not reserved memory. The 1 MiB source ceiling was selected after measuring
long-dialogue inputs at the existing 2,000-action boundary; the benchmark and rationale are recorded
in the [resource-limit design](./docs/design/dsl-4-expression-limits-diagnostics.md#23-source-frontend既定policy).
Asset overrides remain available for exceptional projects, but preview values above the recommended
128 MiB asset total require `--allow-large-preview-artifacts` and still have absolute browser limits.
Source Graph includes remain opt-in and require their separate file-count, total-source-byte, and
depth limits because their topology cannot be inferred safely.

The CLI also provides the following commands. See `tmpose-kamishibai --help` and the [maintainer guide](https://kubohiroya.github.io/tmpose-kamishibai-docs/developer-guides/developer-guide/) for arguments and exit statuses.

| Command               | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| `build-sb3`           | Build the SB3 outputs for a 3.1/3.2 script and its assets     |
| `convert-dsl4`        | Convert a 3.1/3.2 text script to DSL 4.0 YAML                 |
| `convert-dsl4-assets` | Convert 4.0 assets among local, remote, and SB3 project forms |
| `lock-dsl4-assets`    | Verify allowlisted remote assets and create a lock            |
| `audit-dsl4-assets`   | Audit a distribution profile and lock without network access  |
| `vendor-dsl4-assets`  | Pin remote assets into a content-addressed offline mirror     |

DSL 4.0 can select the backward-compatible `legacy` model initialization policy or
`latest-needed`, which cancels an obsolete model preparation and keeps only the latest request.
TMPose 1.12.0 owns initialization of the camera canvas context and intentionally uses a normal
Canvas2D context. Physical-camera measurements of its 320×240, one-draw/one-read path did not show
a repeatable end-to-end benefit from `willReadFrequently`. The same rule applies to scratch-render:
each `Silhouette.unlazy()` materialization performs one read and then caches the pixel array, while
Chromium warns on the second read accumulated by the shared canvas without measuring read rate or
latency. Kamishibai therefore patches neither upstream implementation merely to suppress the
warning. To roll back the TMPose boundary, use the rc.5 artifact pinned to TMPose 1.10.0. See the
[DSL 4.0 surface specification](./docs/design/dsl-4-surface.md#41-poseモデル初期化) for the schema,
defaults, and cancellation boundary.

TMPose 1.12.0 also supplies the configurable SVG pose overlay used by DSL 4.0. Opt in under
`poseRecognition.preview.overlay`; you can show or hide it, style any of the 17 joints, style the
shared bones, set the minimum keypoint confidence, and scale joint or bone properties by
confidence. Existing scripts omit this object and keep the overlay hidden. The complete YAML
example and defaults are in the
[pose overlay surface contract](./docs/design/dsl-4-surface.md#43-pose-overlay).

TMPose 1.12.0 also aligns its public TurboWarp opcodes with the block wording:
`startRecognition`, `stopRecognition`, `isRecognizing`, and `firstRecognitionMsReporter` replace
the former `*Predict*` names without aliases. DSL 4.0 already used the recognition-named
Composition API, so the YAML schema and runtime behavior are unchanged; hand-authored TurboWarp
scripts that stored the removed opcodes must be rebuilt with the rc.7 palette.

JavaScript consumers can import the package exports `@kubohiroya/tmpose-kamishibai/builder`, `@kubohiroya/tmpose-kamishibai/dsl4`, and `@kubohiroya/tmpose-kamishibai/converter` as needed.

## How It Works

All DSL 4.0 authoring and distribution paths share the same inputs and validation rules.

```text
YAML + assets
    ↓
source frontend (parse, schema, semantic validation)
    ↓
browser preview / CLI build
    ↓
self-contained SB3
    ↓
TurboWarp runtime + TMPose
```

- The selected YAML script and, when present, `project.source.yml` remain the editable sources of truth
- Preview, validation, build, and runtime loading use the same StoryDocument and diagnostics
- Local assets are embedded in the story SB3; remote assets declare integrity and a distribution profile
- Failed builds preserve existing output and replace it only with a validated candidate

See the [DSL 4.0 processing architecture](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-processing-architecture.md) for processing boundaries and the [asset distribution profile design](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-asset-distribution-profiles.md) for delivery behavior.

## Develop This Repository

### Requirements

- Node.js 22.12.0 or later
- pnpm 11
- A desktop environment capable of running TurboWarp when changing SB3 or browser integration

### Setup and verification

```bash
pnpm install --frozen-lockfile
pnpm verify:quick
```

| Command             | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `pnpm verify:quick` | Lint, type-check, and run the lightweight tests during development  |
| `pnpm verify:full`  | Run the CI-equivalent SB3, full test, E2E, site, and package checks |
| `pnpm format`       | Check formatting with Prettier                                      |
| `pnpm test`         | Run the full unit and integration suite                             |
| `pnpm run build`    | Build the site and fetch verified Release SB3 assets into `dist/`   |
| `pnpm sb3:build`    | Generate the current candidate into ignored `tmp/` storage          |
| `pnpm sb3:check`    | Regenerate and verify the current DSL 4.0 release candidate         |

Before implementation, record the scope, dependencies, acceptance criteria, and rollback in a GitHub Issue, then keep each pull request small. Use [GitHub Issues](https://github.com/kubohiroya/tmpose-kamishibai/issues) for bug reports and proposals.

### Key directories

| Directory             | Responsibility                                                                |
| --------------------- | ----------------------------------------------------------------------------- |
| `bin/`                | Executable entry points for the published CLI                                 |
| `src/dsl4/`           | DSL 4 domain model, parser, runtime, and platform adapters                    |
| `src/builder/`        | CLI commands and the SB3, preview, asset, and project-source builders         |
| `src/converter/`      | Legacy-script to DSL 4 conversion API                                         |
| `schema/`             | Public JSON Schemas                                                           |
| `scripts/sb3/`        | Current-release generation, publication, and Release-asset download workflows |
| `scripts/sb3/assets/` | Named assets owned by the current DSL 4 release generator                     |
| `release-metadata/`   | Small records for the current release identity and publication state          |
| `site/`               | GitHub Pages source; published SB3 files are injected only during build       |
| `docs/design/`        | Implementation-adjacent design contracts                                      |
| `docs/releases/`      | Release notes                                                                 |
| `test/`               | Unit, integration, current browser E2E tests, and minimal fixtures            |

Published SB3 files and their historical expanded sources are not stored on the current branch.
Pages obtains each published SB3 from its exact GitHub Release URL and verifies the catalog size,
SHA-256, ZIP structure, and stamped Title metadata before copying it into `dist/downloads/`.
Candidate source trees and SB3 files are generated only in OS temporary or ignored `tmp/` storage;
neither `app/` nor `release-sources/` is part of the repository layout.

## Documentation

- [Published documentation](https://kubohiroya.github.io/tmpose-kamishibai-docs/): operating instructions, author guides, commands, and workshop materials
- [Documentation source](https://github.com/kubohiroya/tmpose-kamishibai-docs): source documents and issues
- [DSL 4.0 surface specification](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-surface.md): YAML contracts beyond the schema and the action surface
- [DSL 4.0 migration design](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-migration.md): differences from 3.2 and the migration policy
- [v4.0.0-rc.7 release notes][rc7]: publication status, compatibility, and verified artifacts

## Related Projects

- [`kubohiroya/tmpose-kamishibai-samples`](https://github.com/kubohiroya/tmpose-kamishibai-samples): sample scripts, images, audio, SB3 projects, and Web stories
- [`kubohiroya/tmpose-kamishibai-docs`](https://github.com/kubohiroya/tmpose-kamishibai-docs): documentation for participants, authors, developers, and workshop staff
- [`kubohiroya/sb3-toolchain`](https://github.com/kubohiroya/sb3-toolchain): SB3 extraction, validation, rebuilding, and embedded-extension management
- [`kubohiroya/turbowarp-tmpose`](https://github.com/kubohiroya/turbowarp-tmpose): pose-recognition extension for TurboWarp

## License

Software and assets copyrighted by this project are licensed under MPL-2.0 unless marked otherwise. See [`LICENSES.md`](LICENSES.md) for third-party works and asset-specific terms. Documentation and samples are governed by the terms in their respective repositories.

[docs]: https://kubohiroya.github.io/tmpose-kamishibai-docs/
[downloads]: https://kubohiroya.github.io/tmpose-kamishibai/downloads/
[rc7]: https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/releases/v4.0.0-rc.7.md
