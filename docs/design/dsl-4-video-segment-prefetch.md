# DSL 4.0 動画のsegment prefetchと配布方式

関連: [#1012](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1012)（[#780](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/780)の残務）。
依存: [#773](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/773)のsegment loader・配布方式、
[#1008](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008)のowner共有・保持予算。
2026-10-24、作業ブランチ `feat/dsl4/video-segment-prefetch`（`feat/dsl4/asset-owner-budget`の上）。

DSLは4.0のまま。新しい有効化スイッチ・新DSL版・作者向け構文は追加しない。Safariは対象外。

## 方針

prefetchは**次章の動画を検証済みのIndexedDB cacheへ入れるだけ**で、materializeしない。
Object URLも、`video`要素も、VMも作らない。bytesは検証後に捨てる。
次章へ遷移すると、候補sessionは同じcacheを通常どおり読み、cache hitになる。

| 配布方式 | 章source                             | 動画                                 | prefetchの動作                                  |
| -------- | ------------------------------------ | ------------------------------------ | ----------------------------------------------- |
| offline  | archive entryだけ                    | embedded（SB3内のbytes）             | 文書だけ。動画は対象外で、networkを一切読まない |
| online   | networkだけ。失敗は遷移の失敗        | remote（URL・integrity・size・type） | 文書と、次章のentry sceneが使うremote動画       |
| hybrid   | networkを先に読み、失敗したらarchive | remoteとembeddedの混在               | 文書と、remote動画だけ。embedded動画は対象外    |

embedded動画は既に手元にあるため、先読みしても効果がない。実際の準備（Object URLの作成）は、従来どおり遷移の候補準備で行う。
章の作成で一番重いのはVMとruntime hostの作成だが、その先行作成は2章分を常駐させ続けることになるため、今回は行わない。

## 実装

### core（`publication-video-prefetch.ts`）

- `dsl4SegmentVideoPrefetchTargets(segmentId, document)`は、章のentry scene（最初のscene）とstartupが使う動画のうち、
  `delivery: remote`で`url`・`integrity`・`size`・`contentType`が揃ったものを返す。後のsceneの動画、embedded動画、動画以外のremote資源は返さない。
- `createDsl4PublicationVideoPrefetch`の`prefetchNext(segmentId)`は、manifestの`next`にある各章について、
  文書を読んでtargetを求め、注入された`resolveRemoteVideo`を順に呼ぶ。
- prefetchは助言的な処理である。失敗は資源ごとに`failed`として報告し、例外は投げない。
  後の章の処理は続け、遷移時には各資源を改めて解決する。
- 新しい`prefetchNext`は前回分を中断し、`cancel()`も同様に中断する。中断した資源は`cancelled`として報告する。
- publication loaderの`prefetch`は、cacheへ入れた文書を返すようにした（従来は戻り値なし）。

### platform（`publication-video-prefetch-resolver.ts`、`publication-runtime-host.ts`）

- `createDsl4VerifiedVideoPrefetchResolver`は、章のruntime hostがplatform sessionへ渡すのと同じcache identity・
  `verifiedRemoteCacheOptions`で`createVerifiedRemoteBinaryCache`を作り、`resolve`する。読込は既存の`loadRemoteAsset`を使う。
  networkから読んだのに保存されなかった（`cacheWrite`が`stored`でない）場合は`K4-PUBLICATION-PREFETCH-002`の失敗にする。
  cache identityのない章は`K4-PUBLICATION-PREFETCH-001`。終了時にstory cacheのleaseを解放し、runtimeのleaseを保持しない。
- publication hostは、入口の章と遷移後の章が確定するたびに、その章の`next`をprefetchする。
  結果は`onEvent({type: 'publication.prefetch', segmentId, assetId, status, error?})`で通知する。
- 章の遷移を始めるとprefetchを中断する。候補sessionが同じ動画を読むため、並行して読むと重複するだけだからである。
  遷移に失敗して元の章が残る場合は、その章の`next`をprefetchし直し、再試行でcache hitになるようにする。
  停止・破棄でも中断する。
- `loadRemoteAsset`がないhostでは、remote動画を読めないため、そのtargetを`failed`として報告する（文書のprefetchは行う）。

## 遷移時の待ち・失敗・再試行・取消し

候補の準備・commit・失敗時の扱いは[Publication・asset group・動画解放の接続](dsl-4-publication-asset-groups.md)の契約のままである。

- prefetch済みのonline章は、遷移時にnetworkが切れていてもcache hitで開始できる。
- prefetchしていない（または失敗した）online章では、networkが切れていると候補の動画準備が失敗する。現在の章と、その再生中の動画URLは保持される。
  network回復後の再試行で遷移できる。
- 候補準備中の取消しでは候補だけを解放し、現在の章の動画を保持する。

## 検証

| 対象                     | 結果                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| target抽出・助言的な処理 | 3件。entry sceneのremote動画だけを対象にすること、資源ごとの失敗報告と後続章の継続、observerの例外の隔離、最終章、中断・置換で読込のsignalが中断されること                                                                                                                            |
| 検証済みcacheへの保存    | 1件。fake-indexeddbで保存後、networkを切ってもsessionと同じidentityのcacheでhit。改ざんbytesは保存しない。identityなしの失敗                                                                                                                                                          |
| 配布方式ごとの遷移       | 4件。offline（章source・動画ともnetwork 0）、online（prefetch後はnetwork切断でも遷移、prefetchなしでは動画準備が失敗して現章の動画を保持し、回復後に再試行で成功）、hybrid（archive fallback、remote動画だけを先読み、候補の取消しで現章を保持）                                      |
| publication hostの接続   | 2件。入口の章の確定後に次章のremote動画を保存してcache hitになること、停止で実行中のprefetchを中断し`cancelled`を報告すること                                                                                                                                                         |
| Chrome（実IndexedDB）    | E2E 1件。Chrome 155.0.8059.86 / headlessで実IndexedDBと実fetch。取消したprefetchは`cancelled`を報告し何も保存しない。完了後は1件2,215 bytesを保存し、遷移相当の読込はnetworkなしでcache hit。cacheのbytesから作ったObject URLを`video`が64×48でnative decodeした。動画の読込は1回だけ |

Chrome以外の行では、loader・group・lifecycle・verified cache・Object URL ownerは製品のmoduleで、media・renderer・IndexedDBは模擬である。
回帰は`test/e2e/dsl4-video-segment-prefetch-chromium.test.ts`、観測値は[chrome-indexeddb.json](../testing/evidence/video-prefetch-20261024/chrome-indexeddb.json)。
既存のquick suite 194ファイル・1,660件、lint・format・型検査、`sb3:check`も成功した。

## 残務・ロールバック

- Standard Editor / Player / Packagerの公開導線で、remote動画を含むpublicationの実配布物を作る経路は、
  現状、章sourceをSB3内に持つofflineのprovider（`mode: 'offline'`）である。online・hybridの章sourceを配布する導線は#773の残務に含まれる。
- VM・runtime hostの先行作成（章そのものの先読み）は、常駐メモリとの比較測定をしてから判断する。

ロールバックはsource・回帰・本文書・3生成runtimeをまとめてrevertする。公開済みの同版artifactは差し替えない。
