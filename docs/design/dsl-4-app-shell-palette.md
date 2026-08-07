# 紙芝居DSL 4.0 app shell／palette契約

Copyright © 2026 Hiroya Kubo.

文書状態: Issue #265で確定する実装基準

関連Issue: [#199](https://github.com/kubohiroya/tmpose-kamishibai/issues/199)、
[#258](https://github.com/kubohiroya/tmpose-kamishibai/issues/258)、
[#265](https://github.com/kubohiroya/tmpose-kamishibai/issues/265)、
[#266](https://github.com/kubohiroya/tmpose-kamishibai/issues/266)

機械可読な契約:
[`app-shell-contract.json`](../../test/fixtures/dsl4/app-shell-contract.json)

## 1. 結論

標準の台本製作者が追加するTurboWarpブロックは**0個**とします。標準Runtimeは起動、停止、
状態確認に必要な固定block facadeだけをtemplate内部へ保存し、そのblockをpaletteへ表示しません。
作品固有actionをScratchで実装する利用者だけが、別配布のAction Context developer surfaceを明示的に
有効化します。

これは一つの拡張内で「標準作者用／開発者用」の表示profileを切り替える設計ではありません。用途、拡張ID、
起動時flag、成果物を分けます。標準作品へStore、Iterator、JSONPath、診断、preview操作を混入させません。

## 2. 現行3.2からの移行境界

`app/project.source.json`のblock graphを基準にした再計数値は次のとおりです。この値は4.0の目標ではなく、
Scratch側に残っている責務を特定する監査baselineです。

| target                |     block | top-level script | 4.0での扱い                                                                                      |
| --------------------- | --------: | ---------------: | ------------------------------------------------------------------------------------------------ |
| Stage                 |     1,359 |               59 | parser、controller、状態、標準actionをJavaScriptへ移し、150以下の固定shell coordinatorへ置換する |
| Actor                 |       241 |                6 | 汎用runtime scriptを除去し、story actorはadapterから制御する。固定scriptを残す場合も20以下とする |
| prompt                |        12 |                3 | 診断表示をhost presenterへ移し、台本runtimeの状態を所有させない                                  |
| UiItem                |       151 |               11 | 必要な見た目だけを固定presentation targetまたはhost UIとして残す                                 |
| officialWebsiteButton |        15 |                1 | presentation-only targetとして残すかUiItemへ統合する                                             |
| closeTitleButton      |        10 |                1 | presentation-only targetとして残すかUiItemへ統合する                                             |
| Loading               |        13 |                1 | presentation-only targetまたはhost presenterへ置換する                                           |
| LoadingBubbleAnchor   |        10 |                1 | 原則host presenterへ置換し、残す場合もpresentation-onlyとする                                    |
| **合計**              | **1,811** |           **83** | 3.2のblock graphを4.0 runtime coreとして再利用しない                                             |

3.2のStageにはscalar variable 7、list 11、broadcast 23があり、project全体にはscalar variable 13が
あります。4.0のStoryDocument、Source Map、実行位置、scene履歴、runtime variable、asset状態は
JavaScript runtimeが所有し、Scratch variable、list、broadcastを保存形式や内部transportにしません。

## 3. 配布面

| 配布面                     | 拡張ID                               | 標準作品           | palette                   | 用途                                                   |
| -------------------------- | ------------------------------------ | ------------------ | ------------------------- | ------------------------------------------------------ |
| Standard Runtime           | `kubohiroyakamishibairuntime4`       | 読み込み済み       | DSL 4.0 blockは0          | 台本の検証、実行、asset制御と固定shell                 |
| template内部control        | Standard Runtime内                   | 保存済み           | `hideFromPalette: true`   | version、状態、error、内部text設定                     |
| Action Context             | `kubohiroyakamishibai4actioncontext` | 読み込まない       | 8 opcode                  | 作品固有custom actionをScratchで実装するcustomizer向け |
| Structured Data Standalone | `kubohiroyastructdata1`              | 読み込まない       | Store／Iterator／JSONPath | 汎用データ処理を使う開発者向け                         |
| Structured Data debug      | `kubohiroyastructdata1debug`         | 読み込まない       | 診断opcode                | capability開発者向け                                   |
| app shell debug（予定）    | `kubohiroyakamishibai4debug`         | 読み込まない       | shell診断opcode           | template／runtime開発者向け                            |
| development preview host   | 拡張IDなし                           | productionから除外 | DOM／CLI UI               | source watch、reload選択、診断表示                     |

Standard Runtimeが通常の台本製作者へ見せるDSL 4.0 blockは0個です。機能拡張がTurboWarpの
「拡張を追加」画面に現れるかどうかと、作品内paletteへ個別blockを表示するかどうかは別の契約です。

### 3.1 template内部control

4.0.0の内部opcodeを次の4個に固定し、標準配布の`getInfo()`ではすべて
`hideFromPalette: true`にします。

- `versionReporter`
- `statusReporter`
- `lastErrorReporter`
- `setTextValue`

台本製作者はこれらを配置しません。builderがversion付きcanonical templateを複製し、保存済みblockが
存在すること、opcodeが許可listと一致すること、block graph digestが期待値と一致することを検証します。

### 3.2 Action Context developer surface

Action ContextはStandard Runtimeの「作者向けblock」ではなく、作品カスタマイザーが明示的に追加する
別surfaceです。`dsl4CustomActionsEnabled`は起動時固定かつ既定OFFで、Standard startupは自動登録しません。
公開opcodeは次の8個に固定します。

- `whenCustomAction`
- `currentActionName`
- `currentActionTarget`
- `currentActionHasArgument`
- `currentActionArgument`
- `completeCurrentAction`
- `failCurrentAction`
- `gotoFromCurrentAction`

custom handler一件の接続用overheadは演出本体を除き8 block以下とします。複数作品で同じhandlerが繰り返し
必要になる場合は、標準core actionまたはDSL schemaへの昇格を検討します。

## 4. app shellに残す責務

app shellは紙芝居のpresentationと最小のlifecycle入力だけを担当します。

| 要素                    | Scratch固定template                    | Standard Runtime／host                                   |
| ----------------------- | -------------------------------------- | -------------------------------------------------------- |
| title                   | costume、配置、表示／非表示            | 表示状態とstart要求を受け取る                            |
| language menu           | button／labelのpresentationと選択入力  | localeを検証し、shell用文言と作品のlocaleを返す          |
| loading                 | costume／animation                     | asset準備状態と進捗のsemantic valueを返す                |
| error                   | icon／message領域／retry button        | redacted diagnosticとretry可否を返す                     |
| retry                   | button入力                             | sourceの再検証または同じimmutable snapshotの再起動を行う |
| close                   | button入力とtitle presentationへの復帰 | 実行中sessionをstopし、所有resourceを解放する            |
| official site           | 固定button target                      | 既存のWeb Link capabilityで固定HTTPS URLを開く           |
| finished                | costume／次の操作button                | 最終actionのcommit後に終了状態を返す                     |
| pose feedback           | なし                                   | 認識度／チャージの専用DOM表示とlive status               |
| camera preview controls | 固定DOM button／menuとaccessibility    | preview geometry、反転、camera列挙／選択へ接続する       |

language menu、close、official siteはDSL actionではなくapp shellの固定UIです。作品ごとの台本からopcodeや
URLを追加できる経路にしません。Web Link capabilityは標準作品に必要なproduction依存ですが、その
汎用paletteを作者へ表示する必要はありません。

pose feedbackの`presenter` modeはScratch costume、variable、monitorを使いません。Standard app shellの
固定DOM rendererがactor／pose／step、認識度、チャージを、二つのnative `progress`、数値、polite live regionへ
投影します。active pose待機だけを表示し、完了・中止・scene移動・stop・live reloadで値をresetして隠し、
host disposeでDOMを解放します。作者palette／developer paletteのどちらにもblockを追加しません。
`dsl4PoseFeedbackModes=false`または別の`feedback.mode`ではcontainer設定を読まず、rendererを作りません。
`createDsl4StandardAppShell`はStandard Web／editor／Packager／development previewを同じcompositionで
TurboWarp runtime hostへ接続します。`dsl4AppShell`がOFFならruntime host、surface、DOMを検査せず、ONでも
presenter modeになるまでcontainerとlocaleを検査しません。shell disposeはhost-owned presenterを含むruntime
resourceを先に解放し、最後にshell所有DOMを除去します。

camera previewの反転buttonとcamera menuもDSL actionやScratch spriteではありません。Standard production
app shellの固定rendererが台本の`poseRecognition.preview.controls`を投影し、locale対応accessible name、
focus表示、native button／select keyboard操作を提供します。作者palette／developer paletteのどちらにも
blockを追加せず、`dsl4CameraPreviewControls=false`ならrendererとcontrol asset leaseを作りません。
自然終了／fail時はrendererだけを停止して履歴巻き戻しで再開できるようleaseを保持し、明示的な
story stopまたはhost disposeでDOMとleaseを解放します。

| 残す                                           | 機能拡張／hostへ移す                             |
| ---------------------------------------------- | ------------------------------------------------ |
| title、start、loading、finished、errorの見た目 | YAML parse、schema／参照検証、Source Map         |
| start、stop、retryという利用者入力             | StoryDocumentとruntime variable                  |
| finished／failed通知を見た目へ投影する固定接続 | scene／action実行位置と履歴                      |
| 作品固有presentationの任意Scratch script       | assetの先読み、lease、release、dispose           |
| accessibility用の表示状態                      | 標準action dispatchと待機                        |
|                                                | live reload candidate、preview token、bridge状態 |

cloneは見た目の反復表現だけに使用でき、parser、実行位置、履歴、asset leaseを所有しません。cloneごとに
同じruntime scriptを複製する設計は禁止し、固定presentation targetのblock budgetにはclone起動scriptも
含めます。costume、sound、pose modelを含む作品assetの登録、先読み、retention、解放は機能拡張側が所有し、
Scratch targetは登録済みresourceのpresentationだけを担当します。

固定shellは次の順序を持ちます。

```text
feature flag OFF ──> 現行3.2 shell

feature flag ON
  boot/title
      │ start
      v
  validating ──invalid──> error ──retry──> validating
      │ valid
      v
   loading ──failed─────> error
      │ ready
      v
   running <──> waitingAction
      │
      ├─ completed ─────> finished
      └─ failed ────────> error
```

同じruntimeを二つのshellから同時に制御しません。`dsl4Runtime=true`かつapp shell flagがOFFの場合は、
test harnessまたは独自hostがruntimeを所有できるheadless経路とし、3.2 shellと4.0 runtimeを混在させません。

## 5. 定量budget

| 指標                                                      | 目標 | hard limit |
| --------------------------------------------------------- | ---: | ---------: |
| 台本製作者が追加する必須block                             |    0 |          0 |
| 固定テンプレートのDSL接続block                            |   30 |         30 |
| Stage                                                     |  150 |        150 |
| Stage以外の固定shell／presentation target（各target）     |   20 |         20 |
| project全体                                               |  350 |        500 |
| custom handler接続用overhead（各handler、演出本体を除く） |    8 |          8 |
| Stage／global scalar variable                             |   16 |         16 |
| local scalar variable（各target）                         |    4 |          4 |
| project全体のscalar variable                              |   32 |         32 |
| Scratch list                                              |    0 |          0 |
| broadcast                                                 |   16 |         16 |

budgetには固定templateのUI blockを含み、作品固有custom actionの演出本体は別集計します。作者が追加する
必須block 0とScratch list 0は目標値ではなく合否条件です。source、AST、runtime variable、scene履歴、
Object Store referenceをScratch variableやbroadcastへ符号化した実装は、総block数が少なくても不合格です。

## 6. Web、editor、Packager、previewの差

| surface                              | source             | watch／reload UI | 保存成果物                                      |
| ------------------------------------ | ------------------ | ---------------- | ----------------------------------------------- |
| local development preview            | 外部sourceを許可   | あり             | production artifactではない                     |
| TurboWarp editor（preview host経由） | hostが一時的に接続 | 一時的にあり     | bridge、token、candidate、modal状態を保存しない |
| TurboWarp editor（通常読込）         | build済みsnapshot  | なし             | productionと同じ契約                            |
| Web player                           | build済みsnapshot  | なし             | preview codeを含めない                          |
| Packager                             | build済みsnapshot  | なし             | preview codeを含めない                          |

development previewでは、最初に取得した台本がvalidなら確認modalなしで自動起動します。最初の台本が
missingまたはinvalidならruntimeを開始せず、preview shellを残してwatch状態と診断を表示します。
productionではpreview shellへfallbackせず、通常のerror状態へ遷移します。

source変更時のquiesce、candidate検証、再開位置1／2／3の選択、artifact fingerprintはIssue #258と
#266の契約に従います。invalid candidateは現在のimmutable runtimeを置換しません。

## 7. reload選択UI

development previewのreload選択は、次のaccessibility契約を満たすmodal dialogとします。

- 見出しでlabelされた`aria-modal="true"`のdialogとする
- 選択肢1、2、3をbuttonとして表示し、modal表示中だけ`Digit1`、`Digit2`、`Digit3`を受け付ける
- `Tab`／`Shift+Tab`をdialog内に閉じ込め、`Enter`／`Space`でfocus中のbuttonを実行する
- `Escape`は選択せず保留して現在の実行を再開し、dialogを開く前の要素へfocusを戻す
- 初期focusは最初の有効な選択肢とし、有効な選択肢がなければ見出しへ置く
- 選べないbuttonは実際の`disabled`状態とし、`aria-describedby`で理由を関連付ける
- 状態、warning、選択可否を色だけで伝えない
- watch／candidate更新はpolite live region、実行を阻止するerrorはassertive live regionで通知する
- timeoutや暗黙のdefault選択で実行しない

固定のsemantic summaryにはsource表示名、現在／候補integrityの短縮値、検証結果、scene／action／asset数、
現在のscene／action位置、各選択肢の可否と理由、warning数と変更categoryを含めます。台本文、runtime variable、
全文diff、組込みeditorは含めません。

## 8. feature flagとrollback

起動時固定・既定OFFの`dsl4AppShell`は`dsl4Runtime=true`を前提にします。共有Standard shell実装は次を
fixtureで検証します。

- `dsl4AppShell=false`: 現行3.2 shellを変更せず使用できる
- `dsl4Runtime=true, dsl4AppShell=false`: headless／custom hostだけが4.0 runtimeを所有する
- `dsl4Runtime=false, dsl4AppShell=true`: 起動前に設定errorとし、暗黙にruntimeをONにしない
- 未知のflag: 起動前に拒否する
- rollback: `dsl4AppShell=false`へ戻すだけで新shellを登録、表示、保存しない

hidden control、pose feedback以外のpresentation state、preview reload shell／modalは別の責務として分けます。

## 9. builder契約

builderは作品ごとのScratch block graphを生成しません。version付きcanonical templateを入力にして台本とassetを
埋め込み、次を検証します。

1. templateのID、version、block graph digestが許可値と一致する
2. target別／project全体のblock、variable、list、broadcast budgetを満たす
3. Standard Runtimeのvisible DSL 4.0 opcodeが0である
4. template内部controlが許可listだけで、すべてpalette非表示である
5. Standard artifactがAction Context、Structured Data、debug、preview ID／opcodeを含まない
6. sourceだけを変更したbuildで`targets[].blocks`がbyte-equivalentなcanonical JSONになる
7. production artifactにwatch bridge、preview token、reload candidate、modal状態を保存しない

sourceとtemplateのfingerprint、incremental buildとfull rebuildを切り替える条件はIssue #266で実装します。

## 10. 受け入れ基準とrollback

- 台本Aと台本Bのbuildで`targets[].blocks`が同一になる
- 最小台本と全core action台本のどちらも作者追加blockが0になる
- Standard Runtimeのvisible DSL 4.0 blockが0になる
- Action Contextの8 opcodeと各default-OFF flagが機械可読契約と実装manifestで一致する
- Web、通常editor、Packager成果物からpreview shellとdebug surfaceが除外される
- block、variable、list、broadcast budgetをbuild errorとして検出できる
- keyboardだけでreload modalを操作でき、focus、disabled理由、live regionを検証できる
- app shell実装前、または`dsl4AppShell=false`で現行3.2のbuildと実行が変化しない

rollbackは`dsl4AppShell`をOFFにして現行3.2 shellへ戻します。Action Context、Structured Data、debug、
previewはそれぞれ独立した既定OFF surfaceであり、Standard Runtimeのrollback条件へ混在させません。
