# DSL 4.0 動画の実画面検証・残務

2026-10-22、Issue #780の追加検証を実施した。動画の基本機能はrc.37で公開済み。
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

## ブラウザ検証の境界

- WebKitの結果はPlaywright配布エンジンによる。Safari製品版の検証は継続する。
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

## 残る統合と受け入れ条件

| 残務                           | 依存・受け入れ条件                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| 対象ブラウザ・実端末の追加検証 | Firefox起動環境、Safari / Edge、実聴、Editor / Playerの無操作条件を記録する          |
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
