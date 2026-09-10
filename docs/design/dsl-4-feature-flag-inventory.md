# DSL 4.0 feature flag inventory

追跡 Issue: [#794](https://github.com/kubohiroya/tm-kamishibai/issues/794)（GA 前の flag 棚卸し）。gate: [#782](https://github.com/kubohiroya/tm-kamishibai/issues/782)（4.0 GA release gate）。親 Epic: [#636](https://github.com/kubohiroya/tm-kamishibai/issues/636)。

`src/dsl4/feature-flags.ts` の 21 個の flag それぞれについて、**「出荷 profile で ON」か「意図して OFF」かを 1 行の根拠つきで確定させる。** 4.0 を正式版と呼ぶ前に、実装と test を伴ったまま暗転している在庫を無くすのが目的で、新機能の作業ではない。

## 判定基準

flag を ON にするかどうかは次の 1 点だけで決めている。

> **その capability が OFF のままだと、4.0 を正式版として説明したときに嘘になるか。**

「実装が済んでいるから」は ON の理由にならない。逆に、OFF が設計上の既定（作者が明示的に opt-in する種類の摘み）であれば、実装が完成していても OFF のままにする。

## 1. Standard production profile で ON — 13 個

`dsl4StandardProductionFeatureFlags`。Web Player、Packager、embedded Standard SB3 が共通で持つ。

| flag                         | 根拠                                                                       |
| ---------------------------- | -------------------------------------------------------------------------- |
| `dsl4Runtime`                | runtime そのもの。他の全 capability の前提                                 |
| `dsl4CrossfadeTransitions`   | scene 遷移の既定表現。OFF は素の切替になり作品の見た目が変わる             |
| `dsl4AppShell`               | title／menu／error 表示を持つ shell。OFF では上演の外枠が無い              |
| `dsl4PoseFeedbackModes`      | pose 認識の feedback。Teachable Machine 連携作品の中心機能                 |
| `dsl4SpeechAdvanceTypewriter`| 台詞送り。OFF では全文が一度に出る                                         |
| `dsl4TurboWarpActionSurface` | core action の block palette。台本を block から駆動する入口                |
| `dsl4TurboWarpStateSurface`  | **読み取り専用の state surface。下記 §3 参照**                             |
| `dsl4ExpressionRuntimeState` | **式評価への runtime state 供給。下記 §3 参照**                            |
| `dsl4PosePreviewMirroring`   | **camera preview の左右反転。下記 §3.1 参照**                              |
| `dsl4CameraPreviewControls`  | **camera preview の操作 UI。下記 §3.1 参照**                               |
| `dsl4BroadcastMessageAndWait` | **broadcast action。下記 §3.2 参照**                                      |
| `dsl4TurboWarpBubbleAdvancedPresentation` | **bubble の reveal／audio／motion。下記 §3.2 参照**            |
| `dsl4TurboWarpStoryVariableWrite` | **story variable の書き込み。下記 §3.3 参照**                          |

## 2. development profile で追加 ON — 4 個

`dsl4NonEmbeddedDevelopmentFeatureFlags` が §1 に足す。非 embedded Standard SB3（作者向け runner）専用で、出荷される作品には載らない。

| flag                           | 根拠                                                     |
| ------------------------------ | -------------------------------------------------------- |
| `dsl4WebPreviewAdapter`        | Web Preview の本体                                       |
| `dsl4BrowserDistributionBuild` | browser 上での配布物 build                               |
| `dsl4PreviewReloadOverlay`     | reload 状態の overlay 表示                               |
| `dsl4Debugger`                 | debugger。作者向け runner だけが持つ                     |

## 3. 今回 ON にした 7 個の根拠

`dsl4TurboWarpStateSurface` と `dsl4ExpressionRuntimeState` は **どちらも読み取り専用** で、台本の意味を変えない。story variable への**書き込み**は `dsl4TurboWarpStoryVariableWrite` が引き続き OFF で塞いでいる（§4）。

OFF のままだと、実装済みの surface が出荷版で次のように死んでいた。

- `scripts/sb3/dsl4-runtime-extension-entry.ts` の `applicationStatusReporter` が常に `'ready'` を返す
- 同じく `canNavigateToPreviousAction`／`canNavigateToNextAction` が常に `false` を返す。action history が実装されているのに block からは到達不能
- `runtimeVariableSnapshot` が常に `null`

ON にすると、`createDsl4TurboWarpRuntimeVariableBlockSurface` の**読み取り 17 block** が palette に出る。`setStoryVariable`、`changeNumberStoryVariable`、`lastStoryVariableWriteAccepted` の 3 つは `writeVisible` 側なので出ない。

2 つを同一 PR で ON にしたのは選択ではなく制約で、`resolveDsl4FeatureFlags` が `dsl4ExpressionRuntimeState` に `dsl4TurboWarpStateSurface` を要求している。片方だけの PR は不変条件で落ちる。

### 3.1 pose preview mirroring と camera preview controls

`dsl4PosePreviewMirroring` は camera preview canvas の**左右反転だけ**を切り替える（`mirrored | unmirrored`）。recognition へ渡す frame の `flipHorizontal`、confidence、sequence／selection の判定は変更しない。`dsl4CameraPreviewControls` はその反転 button と camera menu を app shell の固定 renderer が描くかどうかを決める。

ON にした理由は、**schema が受理する記法が実行時に黙殺されていた**こと。`poseRecognition.preview.mirroring`、scene 単位の `posePreview.mirroring`、`preview.controls` はいずれも `schema/dsl-4.schema.json` が受理し、validation も通る。しかし flag が OFF だと `applyPosePreviewMirroring` が冒頭で return し、control asset は `excludedStartupAssetIds` で startup materialize から外れる。**診断は出ない。** 作者が書いた指定が警告なしに無効化される状態だった。

依存は揃っていた。`@kubohiroya/turbowarp-tm` 2.0.0 が `setPreviewMirroring`、`listCameraDevices`、`selectCamera`、`getCameraSelection`、`getActiveCamera`、`isCameraRunning` を提供し、`platform-asset-session.ts` が flag ON のとき port を組み、`turbowarp-runtime-host.ts` が配線する。`resolveDsl4FeatureFlags` にこの 2 flag の不変条件は無い。

**`dsl4PosePreviewMirroring` は runtime port の契約を変える。** `runtime-controller.ts:233` は fail closed で、flag ON なら port は `setPosePreviewMirroring` を必ず実装していなければ startup で TypeError になる。これは設計文書が意図した挙動（method 欠落時は fail closed）だが、Standard profile を使って**自前の port を渡す呼び出し側**は実装を迫られる。§1 の他の flag には無い性質なので、embedder 向けの release note に書く。

`dsl4CameraPreviewControls` 側に fail-closed の port 要求は無い。control は story 側の opt-in で、`preview.controls` を書かなければ DOM も上流 API も生成しない。

### 3.2 broadcast action と advanced Bubble style

`dsl4BroadcastMessageAndWait` は Scratch broadcast へ message を 1 つ送り、全 receiver の完了を待つ action。`dsl4TurboWarpBubbleAdvancedPresentation` は bubbleStyle の 5 key（`reveal`、`audio`、`showAnimation`、`hideAnimation`、`visibleAnimations`）を許可する。

**どちらも schema が正式に公開している記法**である。`broadcastMessageAndWaitAction` は action の `oneOf` に入っており、advanced な bubbleStyle key も `bubbleStyle` の properties に並んでいる。flag OFF ではそれらを書いた台本が起動時に拒否されるため、**schema が広告しているものを runtime が実行できない**状態だった。§3.1 の 2 つは黙殺、この 2 つは拒否という違いはあるが、作者から見た問題は同じ。

`dsl4BroadcastMessageAndWait` の OFF は `docs/design/dsl-4-migration.md` が 3.x からの手動移行先という位置づけを与えていたことに由来するが、それは設計上の好みであって技術的制約ではなかった。依存は `dsl4Runtime` だけで、ON にして落ちる test は 1 件も無かった。

`dsl4TurboWarpBubbleAdvancedPresentation` の据え置き理由は [#776](https://github.com/kubohiroya/tm-kamishibai/issues/776)／[#777](https://github.com/kubohiroya/tm-kamishibai/issues/777) との重なりだったが、重なるのは両 Issue の **GA 後区画**（audio ownership、typewriter と rich text の両立）であって GA ゲート区画（BGM 停止・音量、ruby）ではない。GA を止める理由にはならないと判断した。

### 3.3 story variable の書き込み

`dsl4TurboWarpStoryVariableWrite` は `setStoryVariable`、`changeNumberStoryVariable`、`lastStoryVariableWriteAccepted` の 3 block を足す。§3 の他の flag と違い、これは **schema の記法が効かない問題ではない**。4.0 の schema に変数代入の記法はそもそも無い。

runtime は完成していた。`queueVariableWrite`／`commitVariableWrites` が `set`／`change`、未宣言変数名と型不一致の `K4-VARIABLE-WRITE-*` 拒否、**action 成功時だけ commit（generation 不一致は破棄）** まで持っており、block handler も配線済みだった。ON にするだけで動く。

ON にした判断の理由は、**動く capability を伏せたままにする方が高くつく**こと。4.0 の `variables` は宣言できて `branches` から読めるのに書き換える手段が一つも無く、状態を持つ物語が書けなかった。

**ただし残る問題がある。** [#770](https://github.com/kubohiroya/tm-kamishibai/issues/770) が指摘するとおり `core-action-manifest.ts` に代入系の core action が無いため、**台本 YAML からは今も書けない。** block を置く必要がある以上、`docs/design/dsl-4-design.md` §1.2 のゼロブロック原則（作者が block を足さず台本だけで完成できること）は満たせていない。この PR が閉じたのは「変数を書き換える手段が一つも無い」状態であって、原則の充足ではない。

#770 が YAML の口を足すとき、この 3 block を残すか畳むかを決める。畳む場合、この flag は削除対象になる。

### 3.4 既知の粗さ

`runtime-controller.ts:358` の advanced Bubble style 拒否は、素の `TypeError` で **K4 診断 code を持たない**。同じ種類の拒否である `K4-RUNTIME-BROADCAST-FLAG-001` とは品質が揃っていない。Standard profile では両 flag が ON になったのでこの経路は出荷版では通らないが、flag を OFF にした独自 composition では今も code 無しで落ちる。

### 3.5 SB3 candidate hash

`scripts/sb3/dsl4-runtime-extension-entry.ts:298` が `resolveDsl4FeatureFlags(dsl4StandardProductionFeatureFlags)` を読むため、この profile を変えると release source が変わる。今回 `4.0.0-rc.12` の candidate を `2424468c…` から `d689f8d0…` へ更新した。

**development profile も同じく hash を動かす。** `scripts/sb3/dsl4-runtime-authoring-profile.ts` が `dsl4NonEmbeddedDevelopmentFeatureFlags` を読み、それが同じ SB3 へ入るため。実測で確認済み。つまり **flag を profile へ入れる PR は、production／development のどちらであっても candidate hash の更新を伴う。**

## 4. 意図して OFF — 3 個

実装と test は在るが、出荷 profile では ON にしない。理由は flag ごとに異なる。

### 4.1 作者向けの DSL surface を持たない — 2 個

| flag                               | 根拠                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `dsl4SessionBinaryBacking`         | `docs/design/dsl-4-root-binary-packager-contract.md` が起動時固定・既定 OFF と明記。IndexedDB を使う配備方針の摘みで、OFF は `policy: disabled` 相当 |
| `structuredDataIntegrationEnabled` | `docs/design/dsl-4-iterator-jsonpath.md` が Kamishibai 内部統合を Standalone 有効化と分けて既定 OFF と規定      |

### 4.2 development profile 候補 — 1 個

| flag                            | 根拠                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `dsl4WebPreviewAssetLiveReload` | preview 専用で、出荷される作品の意味に影響しない。contract fixture（`test/fixtures/dsl4/asset-live-reload-contract.json`）と rollback 手順が揃っている。`dsl4NonEmbeddedDevelopmentFeatureFlags` へ入れるかを別 PR で判断する |

## 5. profile ではなく呼び出し側で ON — 1 個

`dsl4SourceIncludes` はどの profile にも入っておらず、builder／CLI／preview の 7 箇所が `{dsl4Runtime: true, dsl4SourceIncludes: true}` と直に立てている（`src/builder/dsl4-build.ts`、`dsl4-asset-lock.ts`、`dsl4-block-source-export.ts`、`dsl4-asset-audit.ts`、`cli.ts` の 2 箇所、`src/dsl4/preview-source-graph-generation.ts`）。

これは **意図的にこの形のままにする。** include 解決は build 経路の capability であって、runtime の上演 capability ではない。production profile へ入れると、include を使わない上演 session にも立ってしまう。

## 6. 解消した乖離

`docs/design/dsl-4-surface.md:842` の表は Web player の適用条件を「build/startup で `dsl4PosePreviewMirroring=true`」と書いていたが、その条件を満たす profile が存在しなかった。**§3.1 で production profile へ入れたので、この行は実態と一致した。**

同じ表の他 3 行（通常 TurboWarp editor、Packager、development preview）は「起動時 flag が ON の場合だけ」という条件文で、Standard profile が ON になったことで満たされる。

なお `standard-app-shell.ts:20` は `webPlayer`／`regularEditor`／`packager`／`developmentPreview` の 4 surface を受理値として持つが、**出荷経路で実際に渡されるのは `packager` と `regularEditor` の 2 つだけ**で、`webPlayer` は test と fixture にしか現れない（`scripts/sb3/dsl4-runtime-extension-entry.ts:1288` が唯一の production 呼び出し）。flag は surface 非依存の起動時固定値なので上の表の意味は保たれるが、surface ごとに条件を変えたくなった時点でこの構造を見直す必要がある。
