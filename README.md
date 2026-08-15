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

|                 | 3.2.3                                           | 4.0.0-rc.5                                                    |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Status          | Stable and currently recommended                | Release candidate                                             |
| Best for        | Workshops, stable use, existing 3.1/3.2 stories | Evaluating YAML authoring, browser workflows, and the CLI/API |
| Script format   | 3.1/3.2 text DSL                                | DSL 4.0 YAML                                                  |
| Get it          | [Downloads][downloads]                          | [Downloads][downloads] or the npm `next` tag                  |
| Read on updates | [Published documentation][docs]                 | [4.0 release notes][rc5]                                      |

If you are unsure, use 3.2.3. Version 4.0.0-rc.5 is a public candidate for evaluating the 4.0 authoring workflow and APIs before the stable release. Published 3.1 and 3.2 stories continue to work without migrating to 4.0.

## Try It First

Open the [published Web app](https://sqs.prof.cuc.ac.jp/kamishibai/) or the [Urashima Taro sample](https://kubohiroya.github.io/tmpose-kamishibai-samples/stories/urashima/web/) to try a story in your browser. Allow camera access, then follow the on-screen instructions and perform the requested poses.

To open a project in TurboWarp, download an SB3 for the series you need from the [downloads page][downloads]. Materials for running an event are organized on the [workshops page](https://kubohiroya.github.io/tmpose-kamishibai-docs/workshops/).

## Build a Story with DSL 4.0

### Browser-only authoring

The 4.0.0-rc.5 Standard SB3 includes an authoring runner that selects and validates a script, provides live preview, and builds a distributable SB3.

1. [Download the 4.0 SB3][downloads] and open it in the [TurboWarp Editor](https://turbowarp.org/editor).
2. Click the green flag, then choose **Open** and select a story file or project directory.
3. Edit YAML or local assets in an external editor. Valid saves are checked and applied automatically.
4. Choose **Build distributable SB3** to save a story with its script and assets embedded.

Watching a project directory requires the File System Access API in a top-level HTTPS page on desktop Chrome or Edge. When a native save picker is unavailable, the runner falls back to a browser download. Other unsupported authoring operations can use single-file selection or the CLI below. See the [DSL 4.0 author guide](https://kubohiroya.github.io/tmpose-kamishibai-docs/dsl-author-guides/dsl-4.0-author-guide/) for browser requirements, UI instructions, and troubleshooting.

### Minimal project

A DSL 4.0 project keeps its source manifest, YAML script, and assets such as images, audio, and pose models under one project root. Asset directory names are organizational and may be chosen freely.

```text
my-story/
├── project.source.json
├── story.k4.yml
├── images/
├── sounds/
└── pose-models/
```

`project.source.json` identifies the entry source.

```json
{
  "formatVersion": 1,
  "mode": "external",
  "sourceId": "main",
  "path": "story.k4.yml"
}
```

At minimum, `story.k4.yml` declares a version and one or more scenes.

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

The [`@kubohiroya/tmpose-kamishibai`](https://www.npmjs.com/package/@kubohiroya/tmpose-kamishibai/v/4.0.0-rc.5) CLI is intended for CI, reproducible builds, larger projects, and distribution-profile management. Use Node.js 22.12.0 or later and pnpm 11, and install the exact version you have validated.

```bash
pnpm add --save-exact @kubohiroya/tmpose-kamishibai@4.0.0-rc.5
pnpm exec tmpose-kamishibai --help
```

Validate a script without building it.

```bash
pnpm exec tmpose-kamishibai validate-dsl4 \
  --input story.k4.yml \
  --max-source-bytes 262144 \
  --format pretty
```

Watch the complete project and preview it in a browser.

```bash
pnpm exec tmpose-kamishibai preview-dsl4 --watch \
  --base kamishibai-4-base.sb3 \
  --project-root . \
  --source-manifest project.source.json \
  --control-profile production \
  --channel bundled \
  --max-source-bytes 65536 \
  --max-asset-file-bytes 16777216 \
  --max-asset-files 64 \
  --max-total-asset-bytes 67108864
```

Build a self-contained SB3 from the same input.

```bash
pnpm exec tmpose-kamishibai build-dsl4 \
  --base kamishibai-4-base.sb3 \
  --project-root . \
  --source-manifest project.source.json \
  --output dist/my-story.sb3 \
  --control-profile production \
  --channel bundled \
  --max-source-bytes 262144 \
  --max-asset-file-bytes 16777216 \
  --max-asset-files 256 \
  --max-total-asset-bytes 134217728
```

The byte limits are deliberately required: they make malformed input and unexpectedly large artifacts fail closed. Increase them only after reviewing the intended project size.

The CLI also provides the following commands. See `tmpose-kamishibai --help` and the [maintainer guide](https://kubohiroya.github.io/tmpose-kamishibai-docs/developer-guides/developer-guide/) for arguments and exit statuses.

| Command               | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| `build-sb3`           | Build the SB3 outputs for a 3.1/3.2 script and its assets     |
| `convert-dsl4`        | Convert a 3.1/3.2 text script to DSL 4.0 YAML                 |
| `convert-dsl4-assets` | Convert 4.0 assets among local, remote, and SB3 project forms |
| `lock-dsl4-assets`    | Verify allowlisted remote assets and create a lock            |
| `audit-dsl4-assets`   | Audit a distribution profile and lock without network access  |
| `vendor-dsl4-assets`  | Pin remote assets into a content-addressed offline mirror     |

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

- YAML and `project.source.json` remain the editable sources of truth
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
| `pnpm test`         | Run the full suite, including generated SB3 and real-VM tests       |
| `pnpm run build`    | Build the public site and downloadable SB3 projects into `dist/`    |
| `pnpm sb3:build`    | Build the editable SB3 at `tmp/kamishibai.sb3`                      |
| `pnpm sb3:check`    | Verify `app/` and the DSL 4.0 release sources                       |

Before implementation, record the scope, dependencies, acceptance criteria, and rollback in a GitHub Issue, then keep each pull request small. Use [GitHub Issues](https://github.com/kubohiroya/tmpose-kamishibai/issues) for bug reports and proposals.

### Key directories

- `app/`: current Kamishibai SB3 source
- `release-sources/`: immutable versioned snapshots for reproducing published SB3 projects
- `src/dsl4/`: DSL 4.0 domain, runtime, and platform adapters
- `src/builder/`: CLI, SB3 builder, and preview builder
- `schema/`: public JSON Schemas
- `site/`: public website source
- `scripts/`: build, release, and verification workflows
- `test/`: unit, integration, browser E2E tests, and fixtures
- `docs/design/`: implementation-adjacent design contracts

## Documentation

- [Published documentation](https://kubohiroya.github.io/tmpose-kamishibai-docs/): operating instructions, author guides, commands, and workshop materials
- [Documentation source](https://github.com/kubohiroya/tmpose-kamishibai-docs): source documents and issues
- [DSL 4.0 surface specification](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-surface.md): YAML contracts beyond the schema and the action surface
- [DSL 4.0 migration design](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-migration.md): differences from 3.2 and the migration policy
- [v4.0.0-rc.5 release notes][rc5]: publication status, compatibility, and verified artifacts

## Related Projects

- [`kubohiroya/tmpose-kamishibai-samples`](https://github.com/kubohiroya/tmpose-kamishibai-samples): sample scripts, images, audio, SB3 projects, and Web stories
- [`kubohiroya/tmpose-kamishibai-docs`](https://github.com/kubohiroya/tmpose-kamishibai-docs): documentation for participants, authors, developers, and workshop staff
- [`kubohiroya/sb3-toolchain`](https://github.com/kubohiroya/sb3-toolchain): SB3 extraction, validation, rebuilding, and embedded-extension management
- [`kubohiroya/turbowarp-tmpose`](https://github.com/kubohiroya/turbowarp-tmpose): pose-recognition extension for TurboWarp

## License

Software and assets copyrighted by this project are licensed under MPL-2.0 unless marked otherwise. See [`LICENSES.md`](LICENSES.md) for third-party works and asset-specific terms. Documentation and samples are governed by the terms in their respective repositories.

[docs]: https://kubohiroya.github.io/tmpose-kamishibai-docs/
[downloads]: https://kubohiroya.github.io/tmpose-kamishibai/downloads/
[rc5]: https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/releases/v4.0.0-rc.5.md
