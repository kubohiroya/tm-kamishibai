# TM Kamishibai

English | [日本語](README.ja.md)

**Participatory AI storytelling driven by body poses**

TM Kamishibai is an interactive storytelling system in which participants move a story forward by posing in front of a camera. It uses TM for pose recognition and TurboWarp for authoring and playback, turning scripts and assets into stories that run on the Web or as SB3 projects.

This repository contains the runtime, DSL, CLI and JavaScript APIs, distributable SB3 projects, and the public website. The [documentation site](https://kubohiroya.github.io/tm-kamishibai-docs/) is the source of truth for operating instructions, author guides, command references, troubleshooting, and migration notes.

![TM Kamishibai showing Urashima Taro and a turtle over a camera feed while pose recognition advances the story](site/images/image01.png)

[Project website](https://kubohiroya.github.io/tm-kamishibai/) · [Try the Web app](https://sqs.prof.cuc.ac.jp/kamishibai/) · [Download an SB3](https://kubohiroya.github.io/tm-kamishibai/downloads/) · [Read the documentation](https://kubohiroya.github.io/tm-kamishibai-docs/) · [Explore samples](https://kubohiroya.github.io/tm-kamishibai-samples/)

## What You Can Build

- Advance a story through participant poses, keyboard input, and stage touches
- Describe scenes, branches, dialogue, motion, audio, and pose recognition in YAML or the 3.1/3.2 text DSL
- Preview scripts in TurboWarp and export self-contained SB3 stories for distribution
- Automate validation, live preview, SB3 builds, legacy DSL conversion, and asset distribution with the CLI
- Invoke DSL 4.0 core actions from TurboWarp blocks or the JavaScript API

## Choose a Version

|                 | 3.2.3                                           | 4.0.0-rc.12                                                   |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Status          | Stable and currently recommended                | Release candidate                                             |
| Best for        | Workshops, stable use, existing 3.1/3.2 stories | Evaluating YAML authoring, browser workflows, and the CLI/API |
| Script format   | 3.1/3.2 text DSL                                | DSL 4.0 YAML                                                  |
| Get it          | [Downloads][downloads]                          | [Downloads][downloads] or the npm `next` tag                  |
| Read on updates | [Published documentation][docs]                 | [4.0 release notes][rc12]                                     |

If you are unsure, use 3.2.3. Version 4.0.0-rc.12 is a public candidate for evaluating the 4.0 authoring workflow and APIs before the stable release. Published 3.1 and 3.2 stories continue to work without migrating to 4.0.

## Try It First

Open the [published Web app](https://sqs.prof.cuc.ac.jp/kamishibai/) or the [Urashima Taro sample](https://kubohiroya.github.io/tm-kamishibai-samples/stories/urashima/web/) to try a story in your browser. Allow camera access, then follow the on-screen instructions and perform the requested poses.

To open a project in TurboWarp, download an SB3 for the series you need from the [downloads page][downloads]. Materials for running an event are organized on the [workshops page](https://kubohiroya.github.io/tm-kamishibai-docs/workshops/).

## Start Authoring

### Use 3.2 for stable workshops

Use 3.2.3 when you need the stable path for an event or an existing 3.1/3.2 story. Download the 3.2 SB3, open it in the [TurboWarp Editor](https://turbowarp.org/editor), and follow the [published documentation][docs] for the classic text DSL and workshop flow.

### Use 4.0 for YAML projects

Use 4.0.0-rc.12 when you want to evaluate YAML authoring, browser live preview, and the current CLI/API. The Standard SB3 can open a `.k4.yml` story file or a project directory, validate changes, live preview them, and build a distributable SB3.

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

For practical scripts, asset references, pose models, branches, speech bubbles, browser requirements, and troubleshooting, continue with the [DSL 4.0 author guide](https://kubohiroya.github.io/tm-kamishibai-docs/dsl-author-guides/dsl-4.0-author-guide/) and the [sample repository](https://github.com/kubohiroya/tm-kamishibai-samples).

## CLI Quick Start

The [`@kubohiroya/tm-kamishibai`](https://www.npmjs.com/package/@kubohiroya/tm-kamishibai/v/4.0.0-rc.12) CLI is intended for CI, reproducible builds, larger projects, and distribution-profile management. Use Node.js 22.18.0 or later and pnpm 11, and install the exact version you have validated.

```bash
pnpm add --save-exact @kubohiroya/tm-kamishibai@4.0.0-rc.12
pnpm exec tm-kamishibai --help
pnpm exec tm-kamishibai validate-dsl4 --input opening.k4.yml --format pretty
pnpm exec tm-kamishibai preview-dsl4 --watch --base kamishibai-4-base.sb3 --project-root .
pnpm exec tm-kamishibai build-dsl4 --base kamishibai-4-base.sb3 --project-root . --output dist/my-story.sb3
pnpm exec tm-kamishibai convert-dsl4 --input legacy-story.txt --output opening.k4.yml
```

See the [maintainer guide](https://kubohiroya.github.io/tm-kamishibai-docs/developer-guides/developer-guide/) for the complete command reference, exit statuses, and release workflow.

## How It Works

```text
YAML + assets
    ↓
source frontend (parse, schema, semantic validation)
    ↓
browser preview / CLI build
    ↓
self-contained SB3
    ↓
TurboWarp runtime + TM
```

Preview, validation, build, and runtime loading use the same StoryDocument and diagnostics. Local assets are embedded in the story SB3; remote assets declare integrity and a distribution profile; failed builds preserve existing output and replace it only with a validated candidate.

Implementation details live in the repository design docs:

- [DSL 4.0 surface specification](https://github.com/kubohiroya/tm-kamishibai/blob/main/docs/design/dsl-4-surface.md): YAML contracts, action surface, resource limits, model initialization, and pose overlay
- [DSL 4.0 processing architecture](https://github.com/kubohiroya/tm-kamishibai/blob/main/docs/design/dsl-4-processing-architecture.md): source frontend, StoryDocument, runtime boundaries, and diagnostics
- [Asset distribution profiles](https://github.com/kubohiroya/tm-kamishibai/blob/main/docs/design/dsl-4-asset-distribution-profiles.md): local, remote, embedded, and offline asset behavior
- [Capability bundle and release contract](https://github.com/kubohiroya/tm-kamishibai/blob/main/docs/design/dsl-4-capability-bundle-release.md): pinned extension packages, embedded IDs, artifact provenance, and rollback policy
- [DSL 3.1/3.2 to 4.0 migration](https://github.com/kubohiroya/tm-kamishibai/blob/main/docs/design/dsl-4-migration.md): conversion classes, warnings, and legacy artifact policy

The current 4.0 candidate uses `@kubohiroya/turbowarp-tm@2.0.0` and the `kubohiroyatm` embedded TM extension ID. Older package names, CLI names, URLs, and SB3 IDs appear only in historical releases and migration notes.

## Develop This Repository

Requirements:

- Node.js 22.18.0 or later. The build scripts import TypeScript modules directly and rely on the
  type stripping that Node runs unflagged from 22.18.0.
- pnpm 11
- A desktop environment capable of running TurboWarp when changing SB3 or browser integration

This repository is written in TypeScript. Add new modules as `.ts`, including scripts under
`scripts/`; the only JavaScript files kept in `src/` are generated artifacts. Convert a file you
have to edit rather than extending it in JavaScript.

Setup:

```bash
pnpm install --frozen-lockfile
pnpm verify:quick
```

Common checks:

| Command             | Purpose                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `pnpm verify:quick` | Lint, type-check, and run the lightweight tests during development     |
| `pnpm verify:full`  | Run the CI-equivalent SB3, full test, E2E, site, and package checks    |
| `pnpm format`       | Check formatting with Prettier                                         |
| `pnpm test`         | Run the full unit and integration suite                                |
| `pnpm run build`    | Build the site and fetch verified Release SB3 assets into `site-dist/` |
| `pnpm build:lib`    | Compile `src/` into the published `dist/` package                      |
| `pnpm sb3:check`    | Regenerate and verify the current DSL 4.0 release candidate            |
| `pnpm pack:smoke`   | Verify the installable npm package contents                            |

## Documentation

- [Published documentation](https://kubohiroya.github.io/tm-kamishibai-docs/): operating instructions, author guides, command references, troubleshooting, migration notes, and workshop materials
- [Documentation source](https://github.com/kubohiroya/tm-kamishibai-docs): source documents and issues
- [v4.0.0-rc.12 release notes][rc12]: publication status, compatibility, verified artifacts, and rollback
- [Issue tracker](https://github.com/kubohiroya/tm-kamishibai/issues): bugs, proposals, implementation scope, acceptance criteria, and rollback plans

## Related Projects

- [`kubohiroya/tm-kamishibai-samples`](https://github.com/kubohiroya/tm-kamishibai-samples): sample scripts, images, audio, SB3 projects, and Web stories
- [`kubohiroya/tm-kamishibai-docs`](https://github.com/kubohiroya/tm-kamishibai-docs): documentation for participants, authors, developers, and workshop staff
- [`kubohiroya/sb3-toolchain`](https://github.com/kubohiroya/sb3-toolchain): SB3 extraction, validation, rebuilding, and embedded-extension management
- [`kubohiroya/turbowarp-tm`](https://github.com/kubohiroya/turbowarp-tm): pose-recognition extension for TurboWarp

## License

Software and assets copyrighted by this project are licensed under MPL-2.0 unless marked otherwise. See [`LICENSES.md`](LICENSES.md) for third-party works and asset-specific terms. Documentation and samples are governed by the terms in their respective repositories.

[docs]: https://kubohiroya.github.io/tm-kamishibai-docs/
[downloads]: https://kubohiroya.github.io/tm-kamishibai/downloads/
[rc12]: https://github.com/kubohiroya/tm-kamishibai/blob/main/docs/releases/v4.0.0-rc.12.md
