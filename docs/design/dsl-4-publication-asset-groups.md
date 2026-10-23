# DSL 4.0 Publication・asset group・動画解放の接続

関連: [#773](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/773) → [#775](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/775) → [#780](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/780)。2026-10-23、基準main `81cb14cc`、作業ブランチ `feat/dsl4/video-asset-groups`。

本ページはPR #979時点の記録である。後続のStandard組込み・実画面検証は[DSL 4.0 Standard publication導線と所有権](dsl-4-standard-publication.md)を参照する。

後続のローカル修正では、章遷移をシナリオの`gotoSegment`から行い、現在章の`next`だけを許可する。
章順の前章・公開entry pointへの暗黙の途中移動は撤去する。任意章選択・Open・Cancel UIは設けず、
ユーザーによる過去状態の復元はセーブポイントからのロードという別契約に限定する。

#979時点の実装はruntime APIとasset ownerの接続である。Standard Editor / Player / Packagerのpublication選択・生成・実行導線への組込みは未完了。既存の単一StoryDocumentをpublicationへ自動変換しない。DSLは4.0のままとし、有効化用URLスイッチや新しいフィーチャーフラグは追加しない。Safariは検証対象外。

## 依存順と担当

| 層                                                  | 担当・契約                                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| #773 / `publication-manifest.ts`                    | 独立したPublicationManifestV1。publication ID・title・entry segment・公開entry points・章順・分岐先・source descriptor。既存format indexへ登録 |
| #773 / `publication-loader.ts`                      | source provider、完全なimmutable DSL 4.0文書の遅延読込・位置解決・上限付きLRU document cache・候補準備後のcurrent切替                          |
| #775 / `asset-group-lifecycle.ts`                   | 保持scopeの既定group生成、DAG・cycle検査、共有asset ID参照、prepare / release / replaceの直列化                                                |
| #775 → #780 / `publication-asset-loader.ts`         | segmentごとのsession・groupと共有video ownerを接続。sceneでは使用中の動画を保持し、segment切替では候補を準備してから旧ownerを解放              |
| #780 / platform video adapter・既存playback cleanup | bytesのSHA-256とMIMEに基づくURL共有、最後のleaseの解放、動画の停止・src除去・decoder unload・描画解放後のURL破棄                               |

配布はsource descriptorとprovider、読込はprefetchと文書cache、保持はgroupとasset ownerが担当する。archiveのentryやHTTP URLを、資源の所有権・保持scopeとして流用しない。

## PublicationManifestV1

トップレベルは`formatVersion: 1`、`id`、`title`、`entrySegment`、`entryPoints`、`segments`。segmentsの配列順を章順とし、各要素は`id`、`title`、`next`、`source`を持つ。`next`は分岐先IDの配列である。未知のキー・版、重複ID、不明な参照を拒否する。

sourceは`entry`（相対archive path）、`size`（UTF-8 bytes、1 MiB以下）、`integrity`（`sha256-`と64桁hex）、任意の`url`。path traversalと、資格情報・fragment付きのURLを拒否する。最大4,096 segments。ハッシュ対象はcanonical化前のsource bytesであり、asset bundleのbase64 SRIなど別のformatと混同しない。

`createDsl4PublicationSourceProvider`はarchive entry readerとHTTPへ接続する。offlineはnetworkを呼ばない。onlineはURLがある場合その取得失敗を返し、hybridは検証済みlocal entryへfallbackできる。remote streamは宣言sizeを超えたら中断する。providerとloaderの両境界でsize・SHA-256を検査し、検証済みsourceもfrontendで構文・意味を検証してから採用する。

`readEntry`は既存SB3/ZIP readerを渡す接続契約であり、publication入りSB3/ZIPをStandard builderが生成できるという意味ではない。

## 準備・commit・失敗

1. 指定segmentのsourceを読んで検証し、完全なimmutable StoryDocumentを得る。起動時に他segmentを一括parseしない。prefetchは文書だけで、動画をmaterializeしない。
2. `{segmentId, sceneId, actionPath}`を対象文書に照合する。sceneまたはactionが存在しない位置を別の場所へ黙って移さない。
3. 候補sessionのgroupを準備する。既定のscene groupとboot依存、訪問済みsceneのstory-retained資源を扱う。lazyなstory資源を全て起動時に読むことはしない。
4. 読込・検証・資源準備・取消しの検査が全て成功したら、loaderのcurrent参照を更新する。
5. 旧sessionを解放する。commit後のcleanup失敗は`cleanupError`で成功した遷移と分けて返す。既に不可逆な解放を行った後で「旧状態へ戻った」と偽らない。

準備失敗・取消しでは新たに取得したassetだけをrollbackし、旧groupの参照を保持する。rollback自体の失敗も集約して返す。group操作・scene操作・loader操作はそれぞれ直列化され、失敗した操作で後続のqueueを停止させない。

原本bundle、asset materialization、document cacheは別寿命である。非使用groupを保持するmaterialization cacheは今回作らず、最後の所有権がなくなった資源を解放する。document cacheの既定上限は2、指定範囲は1〜32。切替準備中は現在の文書と候補が共存する。

## platformへの接続条件

`createDsl4PublicationAssetLoader`の`createSegmentSession`は、完全な文書から準備用sessionを作り、`lifecycle`、公開する`value`、`dispose()`を返す。第4引数の`owners.video`をplatform session / runtime hostの`videoAssetAdapter`へ渡すと、publication内のsegment間で動画のURLを共有できる。動画ごとのleaseは別objectであり、asset IDを維持する。最後のleaseまでURLを破棄しない。

publication loaderの`videoAssetAdapter`にはホストが用意した共有ownerを渡す。coreはownerを不透明な値としてfactoryへ引き渡し、platform adapterをimportしない。

sessionのlifecycleは動画port・音声port・base asset cleanupを含めたものを渡す。group managerはそのsessionから専有して取得するassetを管理する。同じ資源を、group管理外の旧scene coordinatorから同時にreleaseしない。候補factoryは現sessionのVM・描画・登録状態を変更せずに準備できる必要がある。

今回検証したatomicなcommitはloaderとgroup ownerの状態である。Standard VM・GUI・既存runtime controllerの所有権切替、読み込み画面・タイトル・coverへの接続までを保証するものではない。この組込みを残務として明示する。

## 検証結果

| 対象                               | 結果                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 形式・loader                       | 16件。fail-closed、integrity・size・無効文書、安定位置、60segment・cache上限、prefetch、失敗/cancel/retry、commit後cleanupError                                                 |
| online/hybrid/offline              | 上記16件内のprovider fixture。各20segment、ZIP entry readerと模擬HTTPを接続。offline network 0、hybrid fallback、文書上限を確認。配布生成物の実offline起動試験ではない          |
| group                              | 8件。DAG/cycle、共有参照、prepare失敗/cancel/rollback失敗、直列化、200groupでactive資源のみ準備                                                                                 |
| 動画adapter                        | 4件。異なるID・同じbytesの共有、最後の解放、異なるbytesの分離、他adapterの所有権拒否、取消し、URL生成失敗と再試行。旧adapterで共有回帰の失敗を確認                              |
| publicationと実asset lifecycle接続 | 4件。実frontend・bundle検証・embedded lifecycle・video port・groupを接続。scene purge、24segment反復、失敗/cancel/retry時の旧再生保持、cleanupError。media/renderer/URLは模擬   |
| platform session                   | 追加1件を含む16件。複数session間のvideo ownerを共有し、最終leaseまでURLを保持                                                                                                   |
| 関連回帰                           | 上記と既存host・embedded/remote lifecycle・video等を合わせ12ファイル167件成功                                                                                                   |
| Chrome native                      | 既存の対象1件を拡張。同一assetの共有groupと、別asset IDの実WebM bytes / Object URL共有を検証。一方解放後に他方の実デコード・時間進行が続き、最後の解放でsrc除去後のrevokeを確認 |
| Chrome実WebGL renderer             | 対象1件成功。group release後、Spriteのskin/drawableを残して動画skin/drawable残留0。前面・背景動画のsrc除去をURL破棄より先に確認                                                 |
| 生成runtime                        | playback runtimeを再生成し、profile整合性1件成功                                                                                                                                |

関連unit・接続167件、Chrome 2件、生成整合性1件で計170件成功。build:lib・型検査・対象lint/formatも確認済み。verify:fullは実行しない。Chromeはheadless自動検証で、全製品画面・MP4・音声付きautoplay・実スピーカーの追試ではない。過去の無操作24条件・実聴18条件を維持し、今回の結果を新規実聴へ加算しない。

URL数や描画資源数はnative decoderのbuffer容量・実プロセスのメモリリーク・IDB purgeを証明しない。解放API自体が失敗した場合は他の解放も試みて失敗を返すが、資源が消えたとは断定しない。

## #979時点の残務・ロールバック

- #773: publication変数とsegment変数の型付き引継ぎ、cover、Standardの選択・segment実行・VM切替、publicationのSB3/ZIP生成、segment preview/build/live reload、実配布物のonline/hybrid/offline検証。
- #775: 上記のStandard接続と単一所有者への統合、raw memory / IndexedDB / 原本bundleの寿命分離、byte budget・materialization LRU・cache prune、AudioBuffer / Pose / GPU各ownerの実解放検証。動画以外の資源を含む全体DoDは未完了。
- #780: Standard Editor / Player / Packagerのpublication導線でgroup purgeを検証する。保存復元#771、可変viewport#779、初回確認ボタンの再発時診断は別途継続する。

3 IssueはOpenを維持する。本実装は公開済みrc.43には含まれず、同版の配布物を差し替えない。ロールバックはsourceと生成playback runtimeを一緒にrevertする。後続の公開時も既存版のartifactを書き換えない。
