# DSL 4.0 動画とasset purgeの統合準備

関連Issue: [#780](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/780)、依存: [#775](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/775) → [#773](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/773)。

2026-10-23時点。基準mainは`a92c0459102b0d5301010a70c2810bdda65ac936`。本修正の作業ブランチは`fix/video/purge-cleanup`。公開済みrc.43には含まれない。

## 依存の実装状況

#775・#773はOpen。mainには`prepareGroup` / `releaseGroup`、PublicationManifest、segment loaderの契約・実装がまだない。format契約のPR #783や動画基本機能のPR #944は、これらの実装完了を意味しない。group purgeの完了判定は保留する。

既存の接続先は`asset-preload-coordinator.ts`のscene retention判定、`embedded-asset-lifecycle.ts`の`releaseAssets`、`platform-asset-session.ts`のmaterializationである。次のsceneでも必要なアセットIDは選択的解放から除外される。これはgroup DAGや共有参照カウンターの実装ではない。

## 今回の修正と受け入れ基準

- `video-action-port.releaseAssets`は対象アセットIDを使う全領域に解放を試み、1領域の失敗で後続領域を放置しない。終了待ちはAbortErrorでキャンセルする。通常の解放ではpause、src除去、decoder unload、描画解放を行う。
- hostの選択的解放・全解放は共通関数`releaseDsl4PlaybackAssets`を通す。動画、音声、アセット本体の順に解放を試み、途中の失敗も集約して返す。camera preview controlsの有無の両経路に接続する。
- 対象外のアセットID・直接URLの領域は選択的解放から除外する。共有動画のmaterializationを保持することと、通常のscene境界をまたいで再生を継続することは別である。
- アセット所有のObject URLは全対象動画の解放を試みた後に破棄する。元bundleのbytesは別の寿命で保持し、再prepareできる。
- playback runtime生成物も更新し、ソースとの一致を検証する。DSLは4.0のままで、新しい構文・有効化用スイッチは追加しない。

失敗時も残るcleanupを試みることを保証する。decoder・renderer・URL破棄API自体が失敗した場合の資源消滅は保証できず、エラーを返す。group遷移失敗時のtransactionalな旧状態保持の代替にはしない。

## 検証

| 対象                   | 結果・検証範囲                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修正前の選択的解放     | 先頭領域の`load()`失敗を注入し、2領域目のsrcが残る回帰を再現。修正後成功                                                                                                                                                            |
| 関連unit・接続テスト   | 5ファイル97件成功。動画17件、purge接続4件、背景描画1件、host64件、asset lifecycle11件                                                                                                                                               |
| purge接続4件のfixture  | 実DSL frontend・bundle検証・embedded lifecycle・adapter・port・scene coordinatorを接続。media/renderer/URLは模擬。共有アセット保持、待ちキャンセル、反復6回のmaterialization、描画・frame callback解放、複数cleanup失敗の通知を確認 |
| Chrome native media    | 対象1件成功。WebMを実デコードし、同一アセット2領域のsrc除去後のObject URL破棄、終了待ちのキャンセル、直接URL動画の継続を確認                                                                                                        |
| Chrome実WebGL renderer | 既存の対象1件成功。動画のSprite背面描画とGPU資源解放を確認。group purgeの実装結果とは数えない                                                                                                                                       |
| 生成runtime            | authoring/playback profile整合性の対象1件成功。再生成したplayback bundleと新規生成結果が一致                                                                                                                                        |
| 型・静的検証           | build:lib、型検査、対象lint/format、diffの空白検査が成功                                                                                                                                                                            |

Chromeはheadlessでの対象E2Eであり、3製品版の実画面・音声付きautoplay・人による実聴の再検証ではない。既存の無操作24条件・実聴18条件の結果を維持し、今回の自動検証を加算しない。Safariは対象外。

## 残務と進め方

1. #773のPublicationManifest・segment providerと、#775のgroup契約・DAG・共有参照管理・transactional prepare/releaseを実装する。
2. それらの実APIへ今回の選択的解放を接続し、共有参照中の動画、遷移失敗・再試行、online/hybrid/offlineを検証する。
3. materialization・decoder/GPU、元bundle、memory/IndexedDB、cache budget/LRUの寿命を分けて検証する。今回のURL数・描画オブジェクト数の計測を、実プロセスのbuffer容量・メモリリークやIDB purgeの証明に使わない。
4. 本修正後も#780のgroup purge全体のDoDは未完了を維持する。保存復元#771・可変viewport#779も別の依存として残る。

ロールバックは本差分と対応する生成runtimeを一緒に戻す。公開済みnpm・SB3・Playerの同版差し替えは行わない。
