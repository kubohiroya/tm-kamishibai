# DSL 4.0 asset ownerの共有・保持予算・解放

関連: [#1008](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008)（[#775](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/775)の残務）。
2026-10-24、基準main `a549ac79`、作業ブランチ `feat/dsl4/asset-owner-budget`。

DSLは4.0のまま。新しい有効化スイッチ・新DSL版・作者向けのgroup構文は追加しない。Safariは対象外。
前提となるgroup・publication・寿命の設計は[Publication・asset group・動画解放の接続](dsl-4-publication-asset-groups.md)と
[アセットのbytes・cache・原本の寿命](dsl-4-asset-memory-lifetimes.md)を参照する。

## 今回の実装

### Object URL owner（`platform/object-url-owner.ts`）

動画adapterが持っていた「同じbytesのURLを共有し、最後のleaseで破棄する」処理を独立したownerへ移した。

| 呼出元 | 共有の鍵                                               | 理由                                                                                    |
| ------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 動画   | MIME + 所有したbytesのSHA-256（ownerが計算）           | 従来どおり、呼出側のintegrity metadataを信用しない                                      |
| 画像   | MIME + lifecycleが検証済みのintegrity（`sha256-`形式） | 準備を同期のまま保つ。integrityがない未検証remoteの画像は共有しない（leaseごとに別URL） |

platform sessionは1つのownerを作り、Asset Manager adapter（target非依存`image`）と既定の動画adapterへ渡す。
publication hostはpublication全体で1つのownerを作り、各章のruntime hostと共有動画adapterへ渡す。
同じ画像・同じ動画は、章をまたいでも1つのURLを共有する。画像と動画は鍵の形式が異なり、互いには共有しない。

Scratchのcostume・backdrop・soundの登録は、Asset Manager compositionが名前（asset ID）で引く契約である。
異なるasset IDの登録をintegrityで1つにまとめると、DSL命令からの参照の意味が変わるため行わない。
これらはasset IDごとの参照カウント（groupとembedded lifecycle）で寿命を管理する。

### materializationの保持予算（`embedded-asset-lifecycle.ts`）

`retention: {maxIdleBytes, maxIdleEntries}`を追加した。所有者のいなくなったhandleを、予算内で再利用用に保持する。

- **既定は両方0で、従来どおり最後の所有者の解放と同時に破棄する。** Standardの既定値は変更しない。
  `maxIdleBytes`だけを指定した場合、`maxIdleEntries`の既定は1024。
- 保持したhandleは所有者を持たない。`getResource`は`null`を返し、使う前に再度`prepare`が必要。
  再`prepare`は再materializeせず同じhandleを再所有し、LRUの順序から外す。
- 予算の単位は、adapterへ渡したmaterialized fileのbytes合計。予算を超えたらLRU（最も前に解放されたもの）から破棄する。
  単体で`maxIdleBytes`を超えるhandleは保持しない。
- rollback（`group-prepare-rollback`）・再試行（`prepare-retry`）・`stale`・全体release・破棄（evict/prune）では保持しない。
- 破棄に失敗したhandleはretired（解放待ち）として追跡を続け、`releaseAssets`の失敗として返す。
  `prune()`・再`prepare`・全体releaseが再試行する。所有者のいるhandleは`prune()`の対象にしない。
- `stats()`は使用中・保持中のhandle数とbytes、解放待ち件数、予算を返す。所有者のいるhandleは破棄できないため、
  使用中bytesは観測値として返し、上限で拒否はしない。

platform sessionは`materializationRetention`を受け取り、`pruneMaterializations()`と`getMaterializationStats()`を公開する。
TurboWarp runtime hostは`objectUrlOwner`・`materializationRetention`をplatform sessionへ渡す。

## 寿命の分離

| 資源                               | 所有者・寿命                                                  | 予算・削除                                                                    |
| ---------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| materialized handle（使用中）      | groupとembedded lifecycleがasset IDごとに参照を数える         | 所有中は破棄しない。`stats()`で観測                                           |
| materialized handle（保持中）      | embedded lifecycleのLRU。所有者なし                           | `retention`のbytes・件数上限。evict・`prune()`・全体releaseで破棄（今回追加） |
| Object URL                         | Object URL ownerのlease。publicationでは章をまたいで共有      | 最後のleaseで破棄（今回、画像にも適用）                                       |
| 呼出側のraw bytesコピー            | materializationに用いる独立コピー                             | 参照の解消とGCに委ねる。cache削除で無効化しない（既存）                       |
| verified remote cache（IndexedDB） | asset-cacheの補助cache。scene解放後も残せる                   | byte budget・LRU・TTL・prune/clear（既存）                                    |
| binary session backing             | KVSのsession。再読込の唯一の原本                              | session/asset/file件数とbytes上限。補助cacheのLRUは適用しない（既存）         |
| 原本ZIP・publication component     | binary entry provider、publication snapshotとVM stage factory | 章source・component・stage archiveの常駐予算を読込時にも適用（下記）          |
| parsed document                    | publication loaderの上限付きLRU                               | 文書数1〜32、既定2（既存）                                                    |

## 採否と判断

- **明示的なgroup指定は採用しない。** 長編fixtureで、4章と48章のpublicationを通読した。
  costume / backdropのskin、soundのAudioBuffer、pose model、動画Object URLのどの最大常駐数も同じで、
  現在章と準備中の候補の2章分を超えなかった。自動生成groupで章数に比例する常駐は起きていない。
  新しい作者向け構文は、この測定で不足が見つかるまで設けない。
- **Standardの保持予算の既定は0に決める。** DSLは資源ごとに`retention: scene`と`retention: story`（既定）を作者が選べる。sceneを離れたら解放する、という作者の宣言を、hostの既定で上書きして保持し続けることはしない。再訪するsceneの素材を手元に残したい場合は、作者が`retention: story`を選ぶ。章をまたぐと、旧章のsessionは丸ごと破棄される。保持予算は、この宣言と独立に再利用を最適化したい独自hostのための仕組みとし、`materializationRetention`で有効化する。
  独自hostは`materializationRetention`で有効化できる。
- 使用中handleのbytes上限は、所有中の資源を破棄できないため強制しない。

## 検証

| 対象                         | 結果                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object URL owner・画像の共有 | 2件。検証済みintegrityの共有、integrityなしの非共有、最後のleaseでの破棄、他ownerのlease拒否。Asset Manager adapterで同じbytesの画像2件が1つのURLを共有し、両方の解放で破棄                                                                                                                                                                                         |
| 保持予算                     | 5件。予算0の即時破棄、再利用時に再materializeしないこと、LRU順のevict、件数上限、予算超過handleの非保持、rollbackの非保持、evict失敗の報告と`prune()`での再試行、全体releaseでの破棄、不正な予算の拒否                                                                                                                                                              |
| 全種のowner解放              | 1件。group解放後、costume / backdropのskin（GPU texture）、soundのAudioBuffer、pose model、動画Object URLが0件。composition・pose・URLは記録用の模擬で、router・lease・lifecycle・groupは製品のmodule                                                                                                                                                               |
| 長編fixture                  | 1件。全種類の資源を持つ4章と48章のpublicationを各章2 sceneずつ通読。最大常駐数が章数によらず一致し、各種0件より多く2章分以下、dispose後は0件                                                                                                                                                                                                                        |
| カメラ・共通UIとの共有owner  | 1件（2026-10-24追補）。実runtime hostの2章が1つのObject URL ownerを共有し、カメラpreview controlsの画像3件を両章で1つずつのURLに共有した。旧章の破棄でcontrolsのDOMは消え、URLは1件も破棄されない。最後の章の破棄で3件とも破棄し、ownerは0件。カメラ本体とcontrolsの単独の解放は既存の`dsl4-story-camera-lifecycle`・`dsl4-camera-preview-controls`・host回帰が扱う |
| 既存回帰                     | quick suite 193ファイル・1,650件、lint・format・型検査、`sb3:check`が成功                                                                                                                                                                                                                                                                                           |

模擬のcompositionでの件数は、native decoder・GPU driver・プロセスRSSの回収を証明しない。

### 実画面の回帰（Chrome / Firefox / Edge）

publicationのObject URL所有者を変更したため、2026-10-23の[publication動画54条件](dsl-4-video-validation.md)を
同じrunner・同じ判定で再実行した。runtimeは本ブランチのsource（commit `123733ce`と同一）から生成した未リリースのfixtureである。

| 製品版ブラウザ       | Editor | Player | Packager |  合計 |
| -------------------- | -----: | -----: | -------: | ----: |
| Chrome 155.0.8059.86 |    6/6 |    6/6 |      6/6 | 18/18 |
| Firefox 158.0.1      |    6/6 |    6/6 |      6/6 | 18/18 |
| Edge 155.0.4283.62   |    6/6 |    6/6 |      6/6 | 18/18 |

各画面はWebM / MP4 ×「操作後の音声付き再生」「無操作の消音再生」「無操作の音声付き再生」。**54条件・432確認が成功**した。
前面・背景plane動画のnative decode、sceneのpurgeで前面動画を停止・src除去してからURLを解放すること、
現sceneの背景が使う共有URLの保持、章をまたぐ同一bytesのURL共有、旧章の全video・背景drawable/skinの解放、
VM停止後の動画URL・描画資源の残留0を確認した。無操作の音声付きはnative `NotAllowedError`と`K4-VIDEO-AUTOPLAY`、cleanupを確認した。
音声付きautoplayの許可・成功や、人による実聴の結果ではない。

Chromeの初回では18件中2件が失敗した。1件は公開Playerのpage error「Cannot resume a closed AudioContext.」で、動画・purgeの全判定は成功していた。
もう1件はPackagerのページ作成時のbrowser target crashである。どちらも単独で1回再実行し、成功した。
前者は2026-10-23の結果には記録がない。今回の変更範囲（Object URL・保持予算）とは別経路のAudioContextの停止順序の可能性があるが、
原因は特定していないため、間欠的なpage errorとして記録する。
[集計](../testing/evidence/owner-budget-20261024/summary.json)、[全観測結果](../testing/evidence/owner-budget-20261024/results.json)、
[fixtureのmanifest・SHA-256](../testing/evidence/owner-budget-20261024/fixtures.json)を保存した。
runnerのローカル作業先は`tmp/owner-matrix/`（gitignore）。

## publicationの常駐予算（2026-10-24追補）

projectは、publicationの全章のsource、各章のcomponent（base64のasset fileを含む）、base64のstage archiveを常に保持する。
これまで、合計の上限は、フォルダからpublicationを作るとき（sourceは`maxTotalAssetBytes`、componentはその2倍）と、
stage archiveの64 MiBに分かれていた。保存済みのSB3を開くときには、合計を検査していなかった。

`platform/publication-resident-budget.ts`で、これを1つの常駐予算にまとめた。値はStandardの作成時の上限と同じで、
既存の作品を新たに拒否することはない。

| 部分          | 上限（stored UTF-8 bytes）     |
| ------------- | ------------------------------ |
| 章source      | 64 MiB                         |
| component     | 128 MiB                        |
| stage archive | 64 MiBのbase64長（約85.3 MiB） |
| 合計          | 上記の和                       |

- `validateDsl4ProjectPublication`が、章を解析する前に予算を検査する。フォルダからの作成、SB3の配布生成、
  publication hostの起動（保存済みSB3を開く場合を含む）のすべてがこの検査を通る。超過は`K4-PUBLICATION-BUDGET-001`で、超えた部分を示す。
- 検証結果の`resident`とpublication hostの`getPublicationState().residentBytes`で、各部分のbytesを観測できる。
- `duplicateAssetBytes`は、前の章のcomponentに同じintegrityのfileがある分のbytesである。現在の保存形式は、章ごとに素材の複製を持つ。
  例として、3章が1つの背景を共有すると、その背景のbase64を3回保持し、2回分が`duplicateAssetBytes`になる。
  複製をなくすには、SB3の保存形式（components間の共有file）を変える必要がある。予算の統合とは別の最適化として扱い、
  [publication formatVersion 2](dsl-4-publication-asset-dedup.md)で解消した（v2では0）。

検証：共有素材を持つ3章のpublicationで重複bytesが2回分になること、各部分（source・component・stage archive・合計）が上限を1 byte超えると
解析前に拒否し、上限ちょうどは通ることを、`test/dsl4-publication-project.test.ts`の2件で確認した。

## ロールバック

ロールバックはsource・回帰・本文書・3生成runtimeをまとめてrevertする。公開済みの同版artifactは差し替えない。
