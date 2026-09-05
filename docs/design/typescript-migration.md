# TypeScript Migration

This document defines how `tm-kamishibai` moves from JavaScript with JSDoc types to TypeScript, using
the same toolchain the TurboWarp extension repositories already use (`@kubohiroya/sb3-toolchain`,
Vite, Vitest, `typescript-eslint`).

The migration is incremental. Every phase keeps `pnpm verify:pr` green, so `main` is releasable at
all times and no phase depends on a long-lived branch.

## Target State

| Concern           | Before                                  | After                                                    |
| ----------------- | --------------------------------------- | -------------------------------------------------------- |
| Source language   | `.js` with JSDoc, checked by `checkJs`  | `.ts`, `strict`                                          |
| Published surface | `src/**/*.js` referenced from `exports` | `dist/**` compiled by `tsc`, with `.d.ts`                |
| Test runner       | `node --test` over `test/*.test.mjs`    | Vitest over `test/*.test.{mjs,ts}`                       |
| Lint              | ESLint core rules on `.js`              | ESLint core rules on `.js`, `typescript-eslint` on `.ts` |
| Site output       | `dist/`                                 | `site-dist/` (so `dist/` is the package build)           |
| Browser bundling  | `esbuild` invoked from `src/builder`    | Vite (Phase 4)                                           |

Reference repositories for the conventions used here: `kubohiroya/turbowarp-local-preview` (plain
TypeScript library), `kubohiroya/turbowarp-svg-text` (library plus Vite extension bundle), and
`kubohiroya/vite-plugin-turbowarp-extension`.

## Execution Model

The single most important consequence of the migration is that **Node can no longer execute the
sources directly**. A `./foo.js` specifier does not resolve to `foo.ts` outside a TypeScript-aware
loader, so the repository is organized as follows:

- `bin/**` and `scripts/**` import the compiled package from `dist/`. Every `package.json` script
  that runs them starts with `pnpm run build:lib`.
- `test/**` runs under Vitest, which resolves `../src/foo.js` to `src/foo.ts` transparently. Tests
  therefore keep running against sources, with no build step in the inner loop
  (`pnpm exec vitest run <file>`).
- **Anything a browser loads over HTTP reads `dist/`.** The local preview host serves modules from
  the directory that contains its own file, and the Chromium fixtures under `test/fixtures/dsl4/`
  import module paths directly, so both must resolve to compiled JavaScript — a browser cannot load
  a `.ts` module. The browser-driven suites in `test/e2e/` therefore import the compiled package
  rather than `src/`.
- The `dist/` build also carries generated artifacts that are never part of the TypeScript program;
  `scripts/build-lib.mjs` copies them after `tsc` (currently
  `builder/generated/dsl4-playback-runtime-extension.js`).

### Cost to Budget For

The DSL 4.0 browser bundle is produced from the compiled package, so **any batch of module
conversions changes the generated playback runtime and the release candidate hash**. Each migration
change therefore ends with:

```bash
pnpm dsl4:playback-runtime:generate
pnpm sb3:build
pnpm sb3:check
```

The byte differences observed so far are limited to minifier identifier allocation — the bundle stays
semantically identical — but the checked-in 3.7 MB artifact and `release-metadata/<version>.json` are
rewritten every time. Consider grouping module conversions into larger batches to keep that churn
down, and re-verify the artifact on CI (Linux) rather than trusting a local rebuild alone.

## Toolchain Decisions

- **TypeScript 6.** `typescript-eslint` does not support TypeScript 7
  ([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)),
  and linting the migrated language matters more than the native compiler's speed. Revisit the
  TypeScript 7 upgrade once `typescript-eslint` supports it.
- **Node 22.18 or later is required of contributors.** `scripts/` imports `.ts` modules directly and
  Node runs them through its own type stripping, unflagged from 22.18.0. `engines.node` states the
  requirement. New modules are added as `.ts`; the only JavaScript left in `src/` is generated.
- **`allowJs` + `checkJs` stay on** for the whole migration so `.js` and `.ts` modules coexist and
  every JavaScript module keeps its current level of checking.
- **`strict: true`** matches the previous `tsconfig.builder.json`. The stricter flags the reference
  repositories use (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) are deferred to
  Phase 5, when no JavaScript is left to fix.
- **Vitest replaces `node --test`.** All 152 test files used the same `import test from 'node:test'`
  shape, so the switch was mechanical. The only behavioural differences were on the test context:
  `TestContext.after` became `onTestFinished`, and `TestContext.diagnostic` became the awaited
  `annotate`. `node:assert/strict` keeps working unchanged inside Vitest tests.

## Phases

### Phase 0 — Toolchain (done)

- Added `vite`, `vitest`, `typescript-eslint`, `@eslint/js`; pinned `typescript` to `^6.0.3`.
- `tsconfig.json` (type-check, replaces `tsconfig.builder.json`) and `tsconfig.build.json` (emit).
- `vitest.config.ts` for `test/*.test.{mjs,ts}` and `vitest.e2e.config.ts` for the serial Chromium
  suites; `scripts/test/run-suite.mjs` drives Vitest and still enforces the Full-only test list.
- ESLint flat config keeps the existing JavaScript rules and adds `typescript-eslint` for `.ts`.
- Site output moved from `dist/` to `site-dist/`.
- Fixed the JSDoc type errors that TypeScript 6 reports and TypeScript 7 did not.

### Phase 1 — `dist/` as the published and executed surface (done)

- `scripts/build-lib.mjs` (`pnpm build:lib`) compiles `src/` to `dist/` with declarations and copies
  generated artifacts.
- `exports` publishes `./dist/**` with `types`, `files` ships `dist/`, and `bin/` plus `scripts/`
  import the compiled package.
- `scripts/verify-package.mjs` asserts the compiled layout; `pnpm pack:smoke` verifies the tarball.

### Phase 2 — Pilot (done)

Six leaf modules converted end to end: `builder/errors`, `builder/hash`, `dsl4/move-easing`,
`dsl4/source-filename`, `dsl4/story-path`, `dsl4/object-store/freeze`.

The pilot surfaced two categories of follow-up work that recur in every later batch:

1. **Real type findings.** `dsl4/platform/turbowarp-crossfade-platform.js` passed an unvalidated
   `string` into `applyDsl4MoveEasing`; with a real union type it now validates first.
2. **Repository tooling that assumes `.js` paths.** `test/dsl4-architecture.test.mjs` walks the
   module graph by file path and needed a `.js` → `.ts` resolution fallback. Expect more of these.

### Phase 3 — Module conversion (done)

All 177 hand-written modules under `src/` are TypeScript. The conversion ran bottom-up through the
dependency layering, one layer per batch, so a `.ts` module never imported an unconverted one
through an untyped boundary.

Recipe used for each batch, and for any module added later:

1. Convert the modules: `git mv foo.js foo.ts`, turn JSDoc annotations into TypeScript signatures,
   keep relative specifiers as `./x.js` (NodeNext resolution maps them to `./x.ts`).
2. Fix the type errors the new signatures surface in callers. Prefer narrowing at the call site over
   widening the converted module's types back to `unknown`.
3. Rename the covering test files to `.ts` in the same change and type their fixtures.
4. `pnpm typecheck && pnpm lint && pnpm format && pnpm test:quick`.
5. Regenerate the runtime artifact and release candidate (see "Cost to Budget For").

Batches stayed at one layer so the generated-artifact churn remained reviewable. The mechanical
part of steps 1 and 2 — JSDoc `@param`/`@returns`/`@type`/`@typedef` tags into TypeScript
signatures, inline casts, and class field declarations — was done with throwaway codemods; the
remaining type errors were resolved by hand, which is where the real findings surfaced.

### Phase 4 — Vite for browser bundling (done)

The DSL 4.0 runtime extension is built by `@kubohiroya/vite-plugin-turbowarp-extension@0.3.0`, which
owns the extension contract: one JavaScript chunk, no leftover module syntax, exactly one
`Scratch.extensions.register(...)` call, the header, the prelude, and the wrapper.

`inlineDynamicImports` is deprecated in Vite 8; the local preview bundle uses
`codeSplitting: false`, which this repository can rely on because it pins Vite 8.

Untyped dependencies are handled so they stop being untyped on their own: `@kubohiroya/sb3-toolchain`
is migrating to TypeScript, so its import sites carry `@ts-expect-error` rather than an ambient
`declare module`. An ambient declaration would win over the package's own types and keep the whole
API `any` after they ship; the directive instead becomes an unused-directive error the day types
land, which is the signal to delete it.

Both programmatic `esbuild` builds now run through Vite's programmatic `build()`, and `esbuild` is
gone from `dependencies` (Vite brings its own):

- **DSL 4.0 runtime extension** (`scripts/sb3/dsl4-downloadable-release.mjs`) — a plugin build.
  The header carries the bundled component notices, so it replaces the plugin's own metadata lines,
  and the two vendored UMD runtimes are passed as the prelude, which the plugin places above the
  strict-mode wrapper and checks for module syntax.
- **Local preview bundle** (`src/builder/dsl4-turbowarp-browser-bundle.ts`) — an ES library build
  with a ported plugin for the reviewed webpack inline loaders (`raw-loader!`, `base64-loader!`,
  `ify-loader!` with `brfs`, and the disabled external-worker specifiers).

**The minifier choice is load-bearing, and `terser` is the one that works.** The plugin indents the
wrapped source by two spaces, while `esbuild` and Oxc write `"\n"` string constants as template
literals holding a real newline — indenting then rewrites every such constant to `"\n  "`. Built
that way, the bundled `yaml` lexer stops recognising line breaks and every DSL 4.0 story fails to
parse, with no build-time signal; the release suite catches it, but nothing earlier does. `terser`
does not produce those literals, so the artifact is correct, and it mangles module-level names in
the plugin's `es` output, so the bundle is no larger than the previous `iife` build. Reported as
[issue #16](https://github.com/kubohiroya/vite-plugin-turbowarp-extension/issues/16); until it is
fixed, changing `build.minify` here needs the full release suite, not just a green build.

One more property of this layout: `dist/` is what the runtime extension entry imports, so a stale
`dist/` silently ships stale behaviour into the generated artifact. Regenerating the runtime runs
`build:lib` first.

Two behaviours had to be reproduced explicitly, and both are load-bearing:

- Virtual module identifiers carry no file extension, or Vite's CSS pipeline claims a `.css` module
  that `raw-loader!` produced and fails on it.
- Inline-loader modules expose `module.exports`, not `export default`: the pinned packages
  `require()` them, and an ESM default export reaches scratch-render's shader compiler as an
  object instead of GLSL text.

Measured cost: the local preview bundle grew from 12.80 MB to 15.14 MB (+18%). It is built on demand
for `tm-kamishibai preview` and is not part of any release artifact.

### Phase 5 — Tighten

- **Convert `test/` (149 files, ~62k lines).** This is its own project, not a tail of Phase 3, and
  the numbers below were measured rather than estimated. Renaming the suites and running the Phase 3
  codemods leaves **5,931 type errors** under the same `strict` settings `src/` uses, and **4,339**
  with `noImplicitAny` disabled. Unlike `src/`, there is no lever: the tests carried no JSDoc, so
  the codemods contribute almost nothing, and typing the six shared helpers in `test/helpers/`
  — the only real seams — removed just ~200 of them. The remainder is per-file judgment, dominated by
  ad-hoc fixtures meeting the now-strict `src/` signatures (`TS2339`/`TS2345`), values narrowed by
  an assertion the type system does not see (`TS18047`), and `unknown` from `JSON.parse` and
  `Object.values` (`TS18046`). Convert it file by file with real fixture types; a mechanical pass
  that sprinkles `!` and `as any` produces green output without type safety, and two attempts at
  automating the `!` insertion mis-scoped the assertion (`map.get!(key)` for `map.get(key)!`).
- **`scripts/**`, `site/**`, and `bin/**` are now type-checked (done).** The two modules Vite
  bundles — `scripts/sb3/dsl4-runtime-extension-entry.ts` and
  `scripts/sb3/dsl4-runtime-authoring-profile.ts` — are TypeScript, because they are shipped source
  rather than tooling. The remaining Node-run scripts are still `.mjs` and are checked as JavaScript
  through JSDoc annotations; convert one when it next needs real work, and add new ones as `.ts`,
  which Node runs directly through its own type stripping — that is why `engines.node` requires
  22.18.0. Untyped dependencies carry
  `@ts-expect-error` at their import sites rather than an ambient declaration.
- **Keep `allowJs` and `checkJs`.** They are what type-checks the remaining `scripts/**/*.mjs`,
  `site/site-shell.js` and `bin/tm-kamishibai.mjs`. Dropping them would silently remove those files
  from the program before they are converted.
- **`exactOptionalPropertyTypes` is on (done).** The 33 errors were all one shape: an option was
  forwarded as an explicit `undefined` into a property the callee declares optional. Two fixes,
  chosen per site:
  - **Omit the key at the call site** — `...(x === undefined ? {} : {x})` — wherever absence is what
    the caller means. Ternaries that produced `undefined` (`x.length > 0 ? x : undefined`) became the
    same shape, and `asset-snapshot-watch` now `delete`s a consumed `release` callback instead of
    assigning `undefined` to it.
  - **Declare `?: T | undefined`** on the callee, for the ten properties whose function already
    treats `undefined` as absent — `diagnostic()` re-emits `storyPath` through
    `...(storyPath ? {storyPath} : {})`, `createDsl4JsonPathEngine` drops `limits` into
    `normalizeLimits`, and so on.

  Widening a callee's whole option bag is still the wrong move, and the numbers say so: one such
  pass over six option types broke the ordinary type check in six places and pushed the
  `exactOptionalPropertyTypes` count from 23 back up to 29.

- **`noUncheckedIndexedAccess` leaves 205 errors** and is not adopted yet, but the measurement
  changed what the work is. 687 of the original 854 are not array or record lookups at all: they are
  member calls on the `Record<string, Function>` placeholders the JSDoc sources used for
  collaborator objects (119 of them across `src/` and `scripts/`). Under the flag every member of an
  index signature is possibly undefined, so the errors are really a report of untyped boundaries —
  the same work that gates re-enabling `@typescript-eslint/no-explicit-any` and
  `no-unsafe-function-type`. Replace a placeholder with an interface naming the members the caller
  actually uses, keeping the runtime validator that already checks them; the reload overlay went
  from 35 errors to 7 that way, and the named types immediately surfaced real nullability the index
  signature had hidden (an optional `storage`, a nullable debug state). Guarding individual lookups
  is the right fix only for the remaining genuine indexing.

  Done so far, 854 down to 205: the reload overlay, the web preview shell, the platform asset
  session, the pose and media action ports, the camera preview controls, the DSL 3.2 converter, the
  preview layout coordinator, the live reload session, the runtime controller, the asset converter,
  the TurboWarp runtime host with the preview session and startup helper that share its navigation
  session, the CLI argument parser, the authoring profile's limits, the media sniffer, the asset
  reload transaction and pipeline, and the actor action port. Two shapes recur.
  Where a validator lists members inline, an interface next to it names them. Where a validator
  takes a method-name array, `validateCompositionMethods` in
  `src/dsl4/platform/composition-contract.ts` is generic over those literals, so the result is keyed
  by the names that were checked and asking for an unchecked one is a compile error — which is how
  `createAudioVoice` turned up: the runtime host calls it, no validator required it, and it is
  genuinely optional, so the helper grew an `Optional` parameter to say so.

  The genuine lookups have their own two shapes, both settled in the DSL 3.2 converter: reading a
  split command argument that a length check above already required (an `argumentAt` helper that
  returns the empty string, which flows into the same diagnostics an empty argument would), and
  destructuring after such a check (defaults on the bindings), and reading `arguments_[index]`
  inside a loop the argument count already bounds (the same empty-string default, which would be
  rejected as an unknown option). A runtime dispatch table like the
  runtime controller's `port` keeps its index signature — it looks methods up by name and already
  handles a missing one — but its element type is now a call signature rather than `Function`.

  Where several modules drive the same collaborator, the interface belongs beside it:
  `Dsl4NavigationSessionSurface` in `src/dsl4/navigation-session-surface.ts` is what the runtime
  host, the preview session, and the startup helper share, and
  `src/dsl4/platform/composition-contract.ts` holds the validator the ports and the asset session
  share.

  The cheapest fix is to stop looking the value up: a `for (const id of Object.keys(assets))` loop
  that immediately reads `assets[id]` becomes `for (const [id, asset] of Object.entries(assets))`,
  which cleared thirteen errors in the local asset reader alone and the same shape in four other
  modules.

  Byte-level parsers are their own case, settled in the media sniffer: each read has a length check
  right above it, so the read carries a default and a comment saying why the default is
  unreachable. A `null` collaborator that exists between `start()` and `dispose()` gets a
  `requireProtocol()`-style accessor that throws, rather than the `!` the migration warns about.

  A limit bag is a third recurring shape: `resolveFrontendLimits` builds its result from the
  entries of the default limits, so its return type is those defaults, and four signatures that
  took `Readonly<Record<string, number>>` now name every limit they read.

  The runtime controller is the clearest case of the flag reporting a design fact rather than a
  style problem: `currentAction()` returns nothing once a scene runs past its last action, and the
  callers were written as though it always had one. It returns `| null` now, and the three callers
  say which case they are — the action context throws, because it is only built while an action
  runs; the failure record and the dispatch loop bind the action once and branch, which also closes
  the gap where two `currentAction()` calls could disagree.

  A validator that builds its result — `Object.fromEntries(methods.map(...))` in the browser stage
  platform — needs no interface at all: make the method list `as const` and the result is
  `Record<(typeof methods)[number], …>`.

  What is left is a long tail: about 60 files with five to ten errors each, no cluster larger than
  that, and every one of them an instance of a shape above. The six shapes, for reference:
  name a validated collaborator; key a validated record by the checked method names; name a limit
  bag after its defaults; iterate `Object.entries` instead of looking the key back up; read a
  bounded array with a default and say why it is unreachable; guard a nullable collaborator with an
  accessor that throws.

- Re-enable `@typescript-eslint/no-explicit-any` and `no-unsafe-function-type` once the TurboWarp
  platform boundaries have real types.
- Re-evaluate TypeScript 7 (see Toolchain Decisions). Still blocked as of 2026-09-05:
  `typescript-eslint@8.69.0` declares `typescript: '>=4.8.4 <6.1.0'`.

## Module Checklist

Every module under `src/` is TypeScript. The two files that remain JavaScript are generated and
never hand-edited:

- `src/builder/generated/dsl4-playback-runtime-extension.js` — the bundled playback runtime,
  regenerated by `pnpm dsl4:playback-runtime:generate`.
- `src/dsl4/platform/posenet-bundle-assets.js` — the embedded PoseNet model data.

The conversion followed the dependency layering (Layer 0 modules import nothing else in `src/`,
and a Layer _n_ module's deepest dependency sits in Layer _n-1_), one layer per batch, with the
type checker, ESLint, the full Vitest suite, and the release snapshot verified after each batch.

### What the conversion changed beyond types

- **Real defects.** `turbowarp-crossfade-platform` applied an unvalidated easing string; it now
  validates before use.
- **Repository tooling that assumed `.js` paths.** The contract suites resolve modules through
  `test/helpers/module-path.mjs`, which also accepts the `.ts` module a `.js` path names.
- **Browser-facing suites.** `test/e2e/`, `test/fixtures/dsl4/`, and the local preview host suite
  load the compiled package, because a browser cannot execute a `.ts` module.
- **Carried-over looseness.** `any` and `Function` annotations moved across from the JSDoc as-is;
  `@typescript-eslint/no-explicit-any` and `no-unsafe-function-type` stay off until Phase 5 types
  the TurboWarp platform boundaries properly.
