# DSL 3.1 release smoke

This procedure verifies the browser-only paths that the Scratch VM integration tests cannot cover.
Run it against the exact SB3 proposed for publication. A failure in any release-stop item blocks the
release; it is not converted into an exception by updating this record.

## Prepare the candidate

```bash
pnpm install --frozen-lockfile
pnpm run build
node scripts/build-release-smoke-fixtures.mjs
shasum -a 256 dist/downloads/kamishibai.sb3 tmp/release-smoke/*.sb3
```

The generator creates two Player-style copies of the candidate without changing the tracked SB3:

| Fixture                                | `featureDetailedScriptErrors` | Embedded script  | Purpose                    |
| -------------------------------------- | ----------------------------: | ---------------- | -------------------------- |
| `detailed-on-unsupported-version.sb3`  |                        `true` | `kamishibai=4.0` | detailed SVG and safe stop |
| `detailed-off-unsupported-version.sb3` |                       `false` | `kamishibai=4.0` | 3.1.7-compatible fallback  |

`tmp/release-smoke/manifest.json` binds every generated file to the candidate SHA-256. Do not reuse
fixtures after rebuilding the candidate.

## TurboWarp Editor

1. Open `https://turbowarp.org/editor` in a clean browser profile or a new browser session.
2. Select **File → Load from your computer** and choose the candidate SB3.
3. Approve each unsandboxed extension only after checking that it belongs to this project.
4. Confirm that the candidate asks seven times: Asset Manager, TMPose, Text Lines, Runtime
   Expression, Kamishibai Runtime, Async Input, and Web Link. A 3.1.7 artifact without Kamishibai
   Runtime asks six times.
5. Press the green flag. Confirm that the title and menu are readable and that no load-error dialog
   appears.

Record the TurboWarp editor bundle filename shown by the served HTML, browser version, OS, candidate
commit, SB3 SHA-256, permission count, and result. Repeating a test in the same Editor tab does not
prove the initial permission count; reload it in a new session.

## External and embedded scripts

### External

1. Open the generic candidate and close the title screen.
2. Choose **Open file** and select `test/fixtures/manual/pr-44-smoke.txt`.
3. Confirm the title-to-Stars transition, the 30-second wait, and the return to Title.
4. Reload the script and press Right during the wait. Confirm that the wait is interrupted and the
   next scene is reached without leaving animation, input, or audio work behind.

### Embedded

1. Open a Player SB3 created by the builder, or the published `urashima.sb3`, in a new Editor
   session.
2. Press the green flag and close the title screen. No file chooser must appear.
3. Confirm that the first scene is displayed and Space/Right/Down advance according to the script.

## Camera, TMPose, and scene transition

Use a Player story whose script contains a `pose` action and whose model URL is still available.

1. Close the title screen and allow camera access for the story origin.
2. Confirm a live preview and a TMPose skeleton or recognition result. Merely granting permission is
   not sufficient.
3. Perform the expected pose and confirm that the current pose action completes.
4. Confirm that the following scene/backdrop is displayed and that camera preview and recognition
   stop when the story or pose action stops.

Do not record or commit camera frames. Record only the result, browser/origin, model URL, and the
scene labels before and after the transition.

## Detailed diagnostic and safe stop

Open each generated fixture in a new Editor session and press the green flag.

For `detailed-on-unsupported-version.sb3`, confirm all of the following:

- the Stage is covered by an SVG headed `Script error` or `台本エラー`;
- it identifies line 1, code `K31-VERSION-001`, and source `kamishibai=4.0`;
- the story does not start, the camera does not request access, and no actor, input, animation, or
  asset-loading work remains;
- pressing the green flag again clears the previous presentation before presenting the same error.

For `detailed-off-unsupported-version.sb3`, confirm that the detailed SVG is absent and the existing
3.1.7 `invalidScript` fallback is used. This is the rollback check, not an acceptable release mode for
the new diagnostic.

## Packager

1. Package the verified Player SB3 with TurboWarp Packager using the release configuration.
2. Open the output in a browser session that did not run the Editor checks.
3. Repeat the embedded-script, camera/TMPose, and scene-transition checks.
4. Confirm that no Editor-only permission dialog or file chooser appears.

A previously published web build is useful for regression comparison but does not substitute for
packaging the current candidate.

## Release-stop conditions

Stop the release if any of these occurs:

- the candidate cannot be loaded in a fresh TurboWarp Editor session;
- the permission count differs without a reviewed manifest change;
- external or embedded script execution cannot reach its first scene;
- camera preview, TMPose recognition, or the following scene cannot be confirmed;
- the detailed fixture starts the story, requests camera access, leaves background work, or fails to
  show the line-numbered SVG;
- Packager output behaves differently from the verified Player SB3;
- the recorded commit, SB3 SHA-256, and generated-fixture manifest do not identify the same build.

## Result record (2026-08-03)

| Item                       | Environment / artifact                                                                    | Result                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Candidate                  | `3865783`, SHA-256 `31d55f574ee6ac5f7244a9609c69efa74adf8eb141a13cf158e7b37453ed65b3`     | pending expected-pose completion only                    |
| Editor                     | TurboWarp `pentapod`, `editor.6079e10d7d50d3d832ef.js`; Chrome 150.0.7871.187; macOS 27.0 | candidate loaded; title displayed                        |
| Permissions                | candidate in fresh Editor tab                                                             | passed: seven prompts, then no security dialog           |
| Published 3.1.7 comparison | public generic and Player SB3                                                             | passed: six prompts; title/menu displayed                |
| Packager comparison        | current-candidate Urashima Player in an isolated Playwright context                       | passed except expected-pose completion                   |
| External script            | `pr-44-smoke.txt`                                                                         | passed: timed and Right-interrupted paths                |
| Embedded script            | published and current-candidate Urashima Player                                           | passed: Beach, Ocean, and Dragon Castle reached          |
| Camera/TMPose/transition   | Urashima model `https://sqs.prof.cuc.ac.jp/kamishibai/20260630/1and2/` and camera         | live preview/inference and interrupted transition passed |
| Detailed diagnostic        | generated flag ON/OFF fixtures                                                            | passed: ON SVG safe stop; OFF `INVALIDSCRIPT` fallback   |
| Diagnostic restart         | fixed ON fixture from PR #216                                                             | passed: SVG → normal title → same SVG                    |

Playwright selected `pr-44-smoke.txt` through the real file chooser, observed Stars for the 30-second
wait, its normal return to Title, and a separate Right-key interruption. Both runs ended without
remaining runtime threads or extension-managed input/animation work.

The current candidate was combined with the Urashima source and asset manifest by the repository
builder, then packaged as plain HTML with autoplay and the release window title. Its builder manifest
records the candidate SHA-256 above. In a fresh Playwright browser context which had not run the
Editor checks, it opened without a permission dialog, file chooser, console error, or page error.
Camera permission was granted for that context. At the first `help` pose action, TMPose reported a
live 320×240 video track, a loaded model, active inference, a non-empty recognition result, and no
extension error. Right and Down advanced to Ocean and Dragon Castle; after leaving the pose action,
inference and the preview stopped.

The expected `help` pose itself was not produced during this run (the recognizer returned `ride1`), so
pose-driven completion remains unverified. This is the sole remaining release blocker. Do not close
the release-smoke issue or mark the pull request ready until a person performs the expected pose and
confirms that the action completes without a navigation key. No camera frame is retained as release
evidence or committed to the repository.
