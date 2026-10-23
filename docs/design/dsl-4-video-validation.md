# DSL 4.0 動画の実画面検証・残務

2026-10-22の初回報告と、2026-10-23の新publication導線の追試を記録する。Issue #780の追加検証を実施した。動画の基本機能はrc.37で公開済み。
ここに残す追加検証・依存機能との統合は、4.0 GAを待たせる追加要件にはしない。

## 公開済みruntimeを使った検証

Standard SB3 `4.0.0-rc.41`の公開済みファイルを基に、検証台本と動画素材だけを差し込んだ。
runtime実装は変更していない。元SB3のSHA-256は次のとおり。

`7333d53c79deeb61254bbb660b3c9c1c1acf4ff21107f60553bf3bf681b4d867`

Editor / Playerは公開されている
`https://kubohiroya.github.io/turbowarp-extension-data-editor/`の実画面で読み込み、
通常の拡張許可・タイトル操作から再生した。
Packagerは固定した`@turbowarp/packager@3.13.0`が生成したHTMLをローカルHTTPで開いた。
実動画・native media・rendererを使用し、再生ポリシーを許可する起動フラグは使用していない。

環境はmacOS / Darwin 27.2.0、headless Google Chrome 155.0.8059.85と
Playwright 1.64.1のWebKit 27.2。ChromeのWebGL backendはSwiftShader。
Editor / PlayerはOSのfile pickerを避けるためmobile UAのfile-input経路を使用した。
物理Android端末の検証は含まない。

| エンジン | 条件                              | WebM VP8/Opus        | MP4 H.264/AAC        |
| -------- | --------------------------------- | -------------------- | -------------------- |
| Chrome   | Editor、操作後、音声あり / 消音   | 両方成功             | 両方成功             |
| Chrome   | Player、操作後、音声あり / 消音   | 両方成功             | 両方成功             |
| Chrome   | Packager、操作後、音声あり / 消音 | 両方成功             | 両方成功             |
| WebKit   | Editor、操作後、音声あり / 消音   | 両方成功             | 両方成功             |
| WebKit   | Player、操作後、音声あり / 消音   | 両方成功             | 両方成功             |
| WebKit   | Packager、操作後、音声あり / 消音 | 両方成功             | 両方成功             |
| Chrome   | Packager、無操作・消音            | 再生成功             | 再生成功             |
| Chrome   | Packager、無操作・音声あり        | 拒否・診断・解放成功 | 拒否・診断・解放成功 |
| WebKit   | Packager、無操作・消音            | 再生成功             | 再生成功             |
| WebKit   | Packager、無操作・音声あり        | 拒否・診断・解放成功 | 拒否・診断・解放成功 |

操作後24件と無操作8件、合計32件を確認した。前面と背景の2動画を同時に再生し、
映像サイズ、再生時間の進行、loop、native play成功、停止後のpause・src除去を確認した。
Chromeでは音声デコードbyte数も確認した。WebKitではMP4のframe counterが0でも、
映像サイズ・時間進行・実画面の描画を確認できたため、frame counterだけを成功条件にはしない。

無操作の開始はページ内タイマーからタイトル初期化完了後に行った。
再生開始時の`navigator.userActivation.hasBeenActive === false`を記録している。
音声付きの拒否時はnative `NotAllowedError`、`K4-VIDEO-AUTOPLAY`の診断、srcの除去を確認した。

集計前に全32件の成功、page errorなし、停止・拒否後のsrc除去と、
無操作ケースの利用者操作なしをJSONから再確認した。
測定値は[検証データ](../verification/dsl4-video-2026-10-22.json)に保存した。

## 初回ブラウザ検証の境界

以下は2026-10-22初回時点の記録。後続の製品版・実聴・無操作検証はIssue #780に記録済みであり、
新publication導線の現在の結果と残務は末尾の追試記録を参照する。Safariはユーザー指示により対象外。

- WebKitの結果はPlaywright配布エンジンによる。Safari製品版は後続のユーザー指示により検証対象外とする。
  Safari 27.2の`safaridriver`起動確認では設定・認証を要求され、実行できなかった。
  この確認ではRemote Automationの設定変更は行っていない。
- FirefoxはPlaywright配布版の起動が`Could not find profile folder`で失敗した。
  通常の一時profile、`/private/tmp`、workspace内の既存profileの3経路で同じ結果だった。
  製品の動画再生結果は未取得。macOS 27に関する[上流報告](https://github.com/microsoft/playwright/issues/42768)と
  同じ症状だが、このマシンの原因確定とはしない。
- Edge、物理端末、スピーカー実聴は未実施。音声デコードと実聴は分けて扱う。
- Editor / Playerの初回拡張許可・タイトル操作は利用者操作を伴う。
  その結果を、無操作のautoplay成功・拒否の確認には数えない。
- 対象codecは上表の2種類。別codecや全配布方式の統合完了は主張しない。

## 実rendererの描画コストとSprite間挿入の採否

現行DSL 4.0では任意のSprite間への挿入は採用しない。
`front` / `background`と、同じplane内の`zIndex`を維持する。
Spriteの動的な順序と動画のID・順序を結び付ける追加契約、入力の優先順位、
利用する作品の要件を確定してから拡張を検討する。

判断の基礎として、固定した実renderer
`scratch-render#a67f7c9c07d459582c227d4fd3fae8f59d8fc9ce`で現在の経路を測定した。
静止Sprite 100個、480×360ステージ、160×120の動画を320×180へ表示する。
各条件で20 frameをwarm-upし、90回のrequestAnimationFrameを3回測定した。
rendererのdirty判定は通常どおり動作する。

| 条件      | renderer.draw呼出しのP95（ms） | bitmap更新回数 / 約1.5秒 | bitmap更新処理の合計（ms） |
| --------- | -----------------------------: | -----------------------: | -------------------------: |
| 動画なし  |                       0.0〜0.1 |                        0 |                          0 |
| 前面1動画 |                       0.0〜0.1 |                        0 |                          0 |
| 前面4動画 |                            0.0 |                        0 |                          0 |
| 背景1動画 |                       0.5〜0.8 |                       23 |                   2.3〜3.8 |
| 背景4動画 |                       0.2〜0.3 |                       92 |                   1.7〜3.0 |

全15測定でskin / drawableの残留は0、停止・dispose後に全動画のsrcを除去できた。
背景側は動画をbitmapへ反映する経路で、更新回数が動画数に応じて増える。
前面側はnative video overlayのため、このbitmap更新を行わない。

表はこの静止Sprite条件のJavaScript側の測定であり、native decoder・compositorの負荷や
GPU処理完了までの時間を含めた比較ではない。短時間・低解像度・SwiftShaderの値を、
実端末の保証値や動画数に比例する性能式として扱わない。
任意のSprite間挿入の実装・追加コストは測定していない。
そのため、今回の数値を理由に「Sprite間挿入が遅い」とは判断しない。

## 初回時点の統合と受け入れ条件

| 残務                           | 依存・受け入れ条件                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| 対象ブラウザ・実端末の追加検証 | 初回の未検証条件。Safariは対象外、後続の結果はIssue #780と末尾の追試を参照           |
| asset group release / purge    | #775（#773に依存）。共有参照を壊さずdecoder / buffer / Object URL / GPUを解放する    |
| 保存・復元                     | #771。Object URLを保存せず、論理位置・動画状態を復元し、失敗時は現sessionを維持する  |
| 可変viewport                   | #779。前面・背景・座標・拡大縮小・入力を同じviewport契約へ接続する                   |
| segment / 配布方式             | #773 / #775。prefetch、online / hybrid / offlineの準備・失敗・再試行・解放を確認する |

依存IssueのAPIは未実装のため、動画側で同等の仕組みを重複実装しない。
各依存の実装後に接続し、差分ごとに必要な限定検証を行う。

今回の確認では動画port / 背景表示 / sourceの19テスト、native動画と固定rendererの
Chromium E2E 2テストが成功した。全件の`verify:full`は実行していない。
ロールバックは[動画設計](dsl-4-video.md)の公開済み版・API hostの手順に従い、
同じ公開版を差し替えない。

## 新publication導線の実画面追試（2026-10-23）

PR #987のmain `57ebb09f7a8a4e308e5564c5d651de1683285401`からruntimeを生成し、
2章の検証用publication SB3とPackager HTMLを作成した。公開rc.43のSB3を土台にしているが、
今回のruntime・台本を組み込んだ**未リリースの検証fixture**であり、公開rc.43の再検証とは分ける。
DSLは4.0のまま。Safariは対象外。今回の検証で製品ソースの修正は行っていない。

macOS 27.2（26B118）/ arm64の実ウィンドウで、Chrome 155.0.8059.86、Firefox製品版158.0.1、
Edge製品版155.0.4283.62を使用した。FirefoxはPlaywright配布エンジンではなく保存済み製品版を
geckodriver / WebDriver BiDiから起動した。全条件で隔離profile/contextを使用し、headless・mute-audio・
autoplay-policy引数やautoplay許可preferenceの追加は行っていない。OSの音量・出力先も変更していない。

Editor / Playerは公開GUIの通常`project_url`ローダーを使用し、検証SB3への応答だけを差し替えた。
Packagerは`@turbowarp/packager@3.13.0`によるローカルHTTPのHTML（autoplay有効）である。
ネイティブのフォルダ選択からのpublication取り込み、online / hybrid配布、公開後の実配布物は今回の再検証に含めない。

| 製品版ブラウザ | Editor | Player | Packager |  合計 |
| -------------- | -----: | -----: | -------: | ----: |
| Chrome         |    6/6 |    6/6 |      6/6 | 18/18 |
| Firefox        |    6/6 |    6/6 |      6/6 | 18/18 |
| Edge           |    6/6 |    6/6 |      6/6 | 18/18 |

各画面の6条件はWebM（VP8/Opus）/ MP4（H.264/AAC）×「操作後の音声付き再生」
「無操作の消音再生」「無操作の音声付き再生」である。素材のcodec・160×120をffprobeでも照合した。
**動画purge・autoplayの対象54条件、432確認項目が成功**した。

- 操作後音声付き18条件と無操作消音18条件では、前面・背景動画のnative decode、時間・フレーム進行、
  前面音量35（native volume=0.35）、背景muted/loopを確認した。背景は実rendererのbitmap skin / video drawableで描画され、
  DOM overlayの前面動画と区別できた。各ブラウザ・各画面のMP4画像9枚も確認した。
- scene `first` → `purged`で前面のscene-retained動画をpause/src除去した後、URLを解放した。
  現sceneが使う背景の共有URLは保持した。次の`transfer` sceneもSharedを参照し、そのシナリオの`gotoSegment`から次章へ進めた。
  次章VMとの共有期間に同一bytesのURLを維持し、旧章の全video/src・背景drawable/skinを解放した。
- 親VM停止後は全54条件でstage残留0、全videoのpaused=true/src=null/videoWidth=0、動画URL残留0、
  背景video drawable / skin残留0を確認した。srcを参照中のURL revoke、重複revoke、page error / unhandled rejectionは0。
- 無操作音声付き18条件はnative `NotAllowedError`、`K4-VIDEO-AUTOPLAY`、動画と背景描画資源のcleanupを確認した。
  音声付きautoplayの許可・成功を主張する結果ではない。無操作36条件では開始前・native play時・各観測点・停止後の
  `userActivation.hasBeenActive=false`とtrusted入力0を照合した。
- 無操作は試験スクリプトによる既知fixtureの拡張許可・VM開始・タイトル終了を経た条件である。
  ブラウザ画面を完全放置して許可画面から自動開始する意味ではない。操作後条件は試験用開始ボタンのtrusted clickを使用した。
  任意の章選択・履歴移動・読込CancelのUIは追加していない。
- 音声トラックと再生状態の自動観測であり、新規の人による実聴結果は作っていない。以前の実聴18条件は履歴として維持する。

[集計](../testing/evidence/publication-video-20261023/summary.json)、
[全観測結果](../testing/evidence/publication-video-20261023/results.json)、
[fixtureのmanifest・SHA-256](../testing/evidence/publication-video-20261023/fixtures.json)を保存した。
全観測結果のSHA-256は`c703501bcb8d64965da8009ecbfd291d501c3cf5b5d0e0f242e88daf997b2dfc`。
runnerと検証用配布物のローカル作業先は`tmp/publication-video-matrix/`。集計では54件の一意性、
fixture hash、開始条件、解放状態、診断、ブラウザ固有の設定を別途assertした。
製品の全件テストや`verify:full`は再実行していない。

### 環境・予備試行の扱い

Chromeの起動引数を読み出せるよう`--enable-automation`を付けた。予備試行の拡張許可操作の繰返し、
Edge実行パスの空白のpercent-encodingをrunnerで補正した。Shared参照がない章遷移用sceneでは、
次章の準備前にSharedのURLが解放されることを観測した。これはそのsceneの依存がない場合の正しいpurgeであり、
共有の継続確認に使う最終fixtureでは遷移scene自身もSharedを参照するようにした。
これらの予備試行を最終54条件に含めない。Firefoxの予備画像で観測点より後の画面を採取したため、
最終Firefox / Edgeでは画面採取完了までscene進行を止め、ACKにはuser activationを付けなかった。
Firefoxの起動ログにOS sandbox extensionの警告があったが、対象18条件の動画・描画・解放は成功した。

### 修正前の実画面から判明した表示残務

動画purgeの54条件とは別のChrome / Packager / MP4追加1試行で、**保存バーとステージ上端の重なり**を確認した。
1280×960の画面で、保存バーは`(x=0,y=0,w=1280,h=37.5)`、publication stageは`(0,0,1280,960)`、
canvasは`(0,0,480,360)`であり、上端37.5 CSS pxが重なる。タイトル上部の欠けも画面で確認した。
`publication-runtime-host`の通常フローの保存バーと、`publication-vm-stage`のabsolute/inset:0のstageが
同じmountを占有している。今回この表示不具合を修正済みとはしない。
[追加観測](../testing/evidence/publication-video-20261023/layout-probe.json)と
[画面](../testing/evidence/publication-video-20261023/chrome-packager-layout-overlap.png)を残す。
保存バーの領域確保と、publication stageのviewport/resize統合（#779との整合）を残務に追加する。

### 保存バー修正前の残務と切戻し

- 保存バーの重なり・固定480×360のpublication canvasとhost viewportの統合。修正後は3画面の表示・入力・座標を再確認する。
- #775のraw memory / IDB / 原本bundleの寿命、byte budget / LRU / cache prune、全種dedupと各ownerの実解放検証。
  HTMLMediaElementのunloadとrendererのdestroy呼出は確認したが、native decoder buffer・RSS・GPU driver memory・IndexedDB領域の回収の証明にはしない。
- #771の保存復元、#779の可変viewport、実配布物でのonline / hybrid / offlineの組合せと次回リリースへの反映。
- 新たな実聴は未実施。今回の動画purge・Firefox製品版・MP4・音声付きautoplay・背景planeの組合せ検証は完了し、
  この同じ54条件を未検証の残務へ戻さない。Safariは対象外のまま、Issue #780の全体DoDは未完了でOpenを維持する。

今回は製品ソース・生成runtime・公開artifactを変更していない。ローカルの検証fixtureと記録だけであり、
npm/SB3/Pagesの公開・差替え、commit/push/PR/mergeは行わない。
既存機能の切戻しが必要な場合はPR #987のsourceと生成runtimeを一括revertし、公開済み版を差し替えない。

## 保存バーとstageの配置修正（2026-10-23）

前節で確認したPackager保存バーの重なりをローカルで修正した。基準はmain `57ebb09f`で、
`codex/fix-publication-stage-layout`の未コミット修正と再生成runtimeを用いる。公開rc.43のSB3を土台にした
検証用publicationへ今回のruntimeを入れたもので、公開済みrc.43自体の動作結果とはしない。

### 配置と入力の契約

publication rootはstage viewportと保存・診断バーを別のgrid行へ配置する。stageの論理座標は480×360を維持し、
canvasのlayer stack全体と動画overlayを4:3の同じ倍率で拡縮する。pointer targetはcanvasと同じ表示矩形を使う。
ResizeObserverとwindow resizeで再計算し、破棄時に両方を解除する。computed CSS sizeで端数を保持し、
整数clientHeightの丸めによる0.5 pxの欠けを防ぐ。保存バーは長い診断時に折返し・スクロールできる。

保存ボタン内のkeydown / keyup / pointerupは章へ伝播させず、nativeのclick / Enter / Spaceを維持する。
自然終了後のメニューではrootごと非表示にして元のScratchメニューを見せ、再開時はrootを表示する。
初回準備失敗時もrootと候補stageを残さない。任意の章選択・履歴移動・Cancelは追加しない。

Chrome / Packagerの1280×960 CSS pxでは、保存バー`(0,922.5,1280,37.5)`、
stage / canvasはともに`(25,0,1230,922.5)`、保存ボタン全体がバー内に収まった。
修正前37.5 CSS pxの重なりは0になり、タイトル上端も表示できた。

### 実画面と回帰テスト

macOS 27.2 / arm64でChrome 155.0.8059.86、Firefox製品版158.0.1、Edge 155.0.4283.62の
Editor / Player / Packager × WebM / MP4 × 操作後音声付き / 無操作消音 / 無操作音声付きの
**54条件・612確認が成功**した。headless・mute-audio・autoplay許可の上書きは使わない。
Editor / Playerは公開GUIの通常project_url経路でfixture応答だけを差し替え、Packagerは同じSB3から作ったHTMLを使う。

- 再生・purgeの36条件で動画時間とframe、前面音量0.35、背景plane・muted loop、scene purgeとシナリオ章遷移、
  共有URL保持、旧章VMと背景drawable/skin解放、自然終了後の元メニュー表示を確認した。
- 操作後18条件で保存ボタンのmouse / Enter / Spaceから計54件のSB3 bytesを生成し、ZIP signatureを確認した。
  nativeファイル保存ダイアログや保存済みファイルの再読込は今回の範囲に含めない。
  ボタン上のArrowRightでは章が進まない。stageのtrusted pointerは正規のVM入力へ届き、
  canvasの横25%・縦10%がScratch座標(-120,144)になることを確認した。
- 操作後18条件に各2サイズ変更を加えた計36確認で、4:3、canvasとpointer targetの一致、保存バー非重複を確認した。
- 無操作音声付き18条件はnative NotAllowedError・K4-VIDEO-AUTOPLAY・cleanupを確認した。
  無操作36条件は開始前・native play時・観測点・停止後のactivation=false / trusted入力0を照合した。
  音声付きautoplayが許可されたという結果ではない。
- 停止後の全54条件で動画src・URL・stage・背景drawable/skin残留0、参照中revoke・重複revoke・page error /
  unhandled rejection 0。新たな人による実聴結果には加算せず、既存18件を維持する。

[集計](../testing/evidence/publication-layout-fix-20261023/summary.json)、
[全観測結果](../testing/evidence/publication-layout-fix-20261023/results.json)、
[fixture metadata](../testing/evidence/publication-layout-fix-20261023/fixtures.json)と画面15枚を保存した。
全観測結果のSHA-256は`4e7f6ac05a9e10a153a9134308b69269414248dbb35ee8ebdc0fd34042fcf966`。
source・runtime・SB3/HTML・画面のhashを記録し、別の集計処理で54件の一意性と観測値を照合した。
runner・fixture生成・集計のローカル作業先は`tmp/publication-layout-fix/`。

関連unit 6ファイル52件、生成profile整合性2件、Chromium E2E 1件の**計55テスト**が成功。
配置helperの端数・hidden・拡縮済み祖先・observer破棄、初回失敗cleanup・メニュー復帰、
実ブラウザの配置・button入力・pointer座標を回帰対象にした。build・型検査・対象lint/formatも成功。
verify:fullとGitHub CIは実行していない。

### 予備試行とFirefoxの実行頻度

予備試行では保存バーのpercentage max-heightによる切れを修正し、旧fixtureを読み込んだメニュー試行は除外した。
最終runnerはSB3とHTMLのhashを実行前に照合する。Firefoxのsend-keys予備試行では、driverのpollが非同期predicateを
awaitせず、保存完了前のdisabled buttonへ入力していた。pollを修正後、同じ条件のmouse / Enter / Space、
pointer・resize・メニュー復帰が成功した。製品のbutton操作不能としては扱わない。予備試行は最終54条件へ加算しない。

**Firefox製品版の検証は、ユーザー指示によりメジャーバージョンのリリース時だけ実施する。**
通常のPR・CIやプレリリースごとには実行しない。方針変更前に完了した今回の18条件を再利用し、追加実行しない。
日常の限定回帰はChromiumを使用する。既存CIにもFirefoxの起動設定はなく、今回追加したE2EもChromiumのみ。
[実聴手順](../testing/video-listening.md)にも同じ頻度を記録した。Safariは引き続き対象外。

### 現在の残務と切戻し

保存バーの重なりとpublication stageの配置・入力の修正・限定検証は完了したが、未コミット・未公開である。
公開済みrc.43・npm/SB3/Pagesは変更していない。次回公開への反映、実配布物のonline / hybrid / offline、
#775の原本bundle / raw memory / IDB・cache budget / LRU・全owner統合、#771の保存復元、
#779の全体viewport / fullscreen / camera / 入力統合は残る。
動画unloadとrenderer破棄の観測をnative decoder buffer・RSS・GPU driver memory・IDB領域回収の証明と混同しない。
Issue #780は全体DoDが未完了のためOpenを維持する。完了した54条件を未検証の残務へ戻さない。
切戻しは今回の配置helper・host・VM factory・関連テストと3生成runtimeの差分を一括で戻す。
