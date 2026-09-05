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
  requirement. New modules are added as `.ts`; see the Module Checklist for the two hand-written
  JavaScript modules that predate this rule being applied consistently.
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
- **Stricter flags, measured on the current tree:** `exactOptionalPropertyTypes` leaves 33 errors and
  `noUncheckedIndexedAccess` leaves 847. Neither is adopted yet. Do not widen the reported optional
  properties in bulk to clear the first one: a blanket `| undefined` pass touched 138 declarations
  and broke the ordinary type check, because names such as `limits` and `onError` appear in many
  unrelated option types. The one property that was worth widening repository-wide is
  `subtleCrypto`, whose JSDoc always allowed an explicit `undefined`; that is already done.
- **`no-explicit-any` and `no-unsafe-function-type` are `error`, with the existing occurrences held
  in `eslint-suppressions.json` (in progress).** Waiting for the TurboWarp platform boundaries to be
  typed first would have left new code unchecked for the whole burndown, so the rules were switched
  on with ESLint's bulk suppressions instead: a file that already violated them keeps a counted
  suppression, and anything new is an error on the first run. ESLint fails when a suppression is no
  longer needed, so the list can only shrink -- run `pnpm lint:prune-suppressions` after clearing a
  file and commit the smaller list.

  The baseline was 1,275 occurrences over 121 files (865 `any`, 410 `Function`). Do not try to clear
  them with a codemod: replacing every `Record<string, any>` with `Record<string, unknown>` leaves
  890 type errors, and replacing every `Function` with `(...args: unknown[]) => unknown` leaves 276.
  What works is typing the injected boundary once and applying it. `Dsl4SubtleCrypto`
  (`src/dsl4/subtle-crypto.ts`), `Dsl4FileSystem` and `Dsl4FileWatcher`
  (`src/builder/file-system.ts`), and the clock local to `dsl4-preview-watch.ts` removed 138
  `Function` occurrences across the 35 modules that take them by injection, and the only call sites
  that had to change were the two validators whose runtime check TypeScript cannot follow, which now
  cast through `unknown`. That worked because those injected dependencies are `node:fs/promises`,
  `fs.watch` and `crypto.subtle` subsets whose real signatures were already known.

  What is left is a long tail. `Record<string, any>` is still 63% of the remaining `any` and stands
  in for DSL 4.0 story and asset structures that have no TypeScript declarations at all;
  `schema/dsl-4.schema.json` already describes 127 of them and is the obvious source to generate
  from. The remaining `Function` occurrences are per-file callback shapes, not a shared boundary.

- Re-evaluate TypeScript 7 (see Toolchain Decisions).

### Burndown Handover

Everything below is measured on the tree, not estimated. Re-measure before trusting a number that
looks stale; `eslint-suppressions.json` is the authority on what is left.

**Where it stands.** 1,275 occurrences over 121 files at the switch-on, 1,111 over 113 files now
(`any` 839, `Function` 272). The two batches so far were #712, which flipped the rules and typed
the injected `crypto.subtle`, `node:fs/promises`, `fs.watch` and clock boundaries (-138), and #713,
which replaced nineteen inline copies of the source frontend port with `Dsl4SourceFrontend` and
adopted the existing `Dsl4Diagnostic` (-25).

**What is left, by area:**

| Area                                       | Total | `any` | `Function` | Files |
| ------------------------------------------ | ----- | ----- | ---------- | ----- |
| `src/dsl4` (core + browser)                | 470   | 337   | 133        | 46    |
| `src/dsl4/platform` (TurboWarp adapters)   | 267   | 169   | 98         | 34    |
| `src/builder`                              | 240   | 199   | 41         | 30    |
| `scripts/sb3` (extension entry, authoring) | 122   | 122   | 0          | 2     |
| `src/converter`                            | 12    | 12    | 0          | 1     |

Six files carry a quarter of it: `scripts/sb3/dsl4-runtime-extension-entry.ts` (91),
`platform/turbowarp-runtime-host.ts` (62), `object-store/store.ts` (49),
`builder/dsl4-web-preview-shell.ts` (33), `scripts/sb3/dsl4-runtime-authoring-profile.ts` (31),
`builder/dsl4-asset-converter.ts` (30).

**What the remaining `any` actually is.** `Record<string, any>` is 521 of the 839. Classifying each
occurrence by what it annotates: 144 are `as` casts, 307 annotate a named binding, and 70 sit in a
generic position (an array element, a `Map` value, a return type). The named ones do not converge on
one domain — the largest are `asset` 30, then `event` 15, `left` 15, `payload` 15, `root` 9,
`request` 9, `invocation` 7, `state` 7, `project` 7, `target` 7, `document` 6, `storyDocument` 6,
`source` 6, `globalObject` 6, and a long tail of one- and two-occurrence names. Read together they
are three unrelated things: internal protocol payloads that no schema describes, platform objects
from TurboWarp and the DOM, and story- or asset-shaped values.

Only the third is reachable from `schema/dsl-4.schema.json`. Generating types from its 127 `$defs`
is worth doing, but the story- and asset-shaped named bindings come to roughly 55, so it addresses
a minority of the `Record<string, any>`, not the majority.

Two things make it less of a lever than it looks: `ParseSuccess.storyDocument` is already
`Readonly<Record<string, unknown>>` rather than `any`, so the frontend boundary is not the problem;
and the runtime story document is not the schema shape. `createStoryDocument` returns a normalized
`{kind: 'StoryDocument', ..., sourceMap}` whose scenes and actions have been rewritten. A real
`Dsl4StoryDocument` has to be written by hand, and would be the largest correctness win available.

The remaining 272 `Function` occurrences are per-file callback shapes. The shared-boundary trick
that cleared 138 of them in #712 is spent; what is left needs a signature per call site.

**How to run a batch.**

1. Pick a cluster that shares one type, not a directory. The two batches that worked both replaced
   one repeated shape everywhere it appeared.
2. Write the type where its dependencies are legal. The pure DSL 4.0 core forbids `node:` imports,
   which is why `Dsl4SubtleCrypto` is import-free and `Dsl4FileSystem` lives under `src/builder`.
   `test/dsl4-architecture.test.mjs` enforces this and will catch a mistake.
3. `pnpm typecheck` after the replacement, before anything else. The error count is the real size of
   the batch, and it is usually much smaller than the occurrence count once the type is right.
4. `pnpm lint:prune-suppressions`, then commit the smaller `eslint-suppressions.json`.
5. `pnpm verify:pr`.

**Pitfalls, all of them paid for once already.**

- **Do not codemod.** Replacing every `Record<string, any>` with `Record<string, unknown>` leaves
  890 type errors; every `Function` with `(...args: unknown[]) => unknown` leaves 276. Typing one
  injected boundary correctly leaves none.
- **A type-only edit does not churn the release artifact, and introducing a local variable does.**
  Narrowing through a new `const` rewrote the 3.7 MB playback runtime and the candidate hash;
  writing the same narrowing as an in-place cast kept both byte-identical. Prefer the cast in a
  batch that is otherwise types-only, and check with `pnpm sb3:check`.
- **A validator's runtime check does not narrow its return.** `typeof value.open === 'function'` on
  a `Record<string, unknown>` still needs `as unknown as Dsl4FileSystem`. Six sites in the tree do
  this; it is the expected shape, not a smell.
- **An unannotated method inside `Object.freeze({...})` loses its contextual type.** Two producers
  were widening `ok: false` to `boolean` and `severity: 'error'` to `string` behind a
  `Record<string, any>`, so their declared discriminated unions never discriminated. Annotate the
  method, not just the factory's return.
- **Watch for a second shape before unifying.** `dsl4-build`'s three diagnostic producers do not
  share a type: the artifact descriptor and the verifier allow a null `range`, `Dsl4Diagnostic` does
  not.

**Decisions still open.**

- Narrowing the digest inputs from `Uint8Array<ArrayBufferLike>` to `Uint8Array<ArrayBuffer>`, which
  is what Web Crypto's `BufferSource` actually accepts. It propagates up through the public
  integrity and asset-bundle signatures, so `Dsl4SubtleCrypto` declares the wider parameter for now
  and says why.
- Whether `Dsl4Diagnostic` should move out of `source-frontend.ts` to a leaf module. Pure-core
  modules such as `diagnostic-projection.ts` cannot import it today without taking on the frontend's
  whole graph.
- Converting `src/dsl4/block-source-export.js` and `src/builder/dsl4-block-source-export.js` (588
  lines) to TypeScript; see the Module Checklist.

## Module Checklist

Every module Phase 3 converted is TypeScript. Four files under `src/` are JavaScript.

Two are generated and never hand-edited:

- `src/builder/generated/dsl4-playback-runtime-extension.js` — the bundled playback runtime,
  regenerated by `pnpm dsl4:playback-runtime:generate`.
- `src/dsl4/platform/posenet-bundle-assets.js` — the embedded PoseNet model data.

Two are hand-written and still to convert. Both arrived together in
[#700](https://github.com/kubohiroya/tm-kamishibai/pull/700), after Phase 3 had finished, so they
were never part of a conversion batch:

- `src/dsl4/block-source-export.js` — the block-authored source export planner. It is a declared
  pure DSL 4.0 core entry, so its conversion is checked by the architecture suite.
- `src/builder/dsl4-block-source-export.js` — the builder side of the same feature.

They are annotated with JSDoc and type-checked like the rest, because `allowJs` and `checkJs` are
on, so this is a consistency gap rather than an unchecked one. Convert them with the Phase 3 recipe
the next time either needs real work; the rule for anything new stays `.ts`.

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
- **Carried-over looseness.** `any` and `Function` annotations moved across from the JSDoc as-is.
  Both rules are now `error`, and the occurrences that predate the switch are counted in
  `eslint-suppressions.json` rather than left unchecked; see Phase 5.
