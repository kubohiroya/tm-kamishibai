# DSL 4.0 アセットのbytes・cache・原本の寿命

関連: [#773](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/773) → [#775](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/775) → [#780](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/780)。
2026-10-23、main `54dea15a`を調査し、`codex/fix-asset-memory-budget`でローカル修正・検証した記録。
未コミット・未公開であり、公開済みrc.46の動作へ読み替えない。

## 既存実装と所有者

| 資源                                | 実装と寿命                                                                                                     | budget / LRUの範囲                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| materialized handle                 | `embedded-asset-lifecycle`とgroupがscene/章の参照を保持し、最後の参照を解放する。失敗したhandleは追跡する      | 非使用handleの保持cacheを設けていない。全owner横断のbyte budgetは未実装                                                                     |
| remote検証済みbytes                 | asset-cache 0.3.0のverified remote cache。scene解放後も補助cacheとしてIDBに残せる                              | byte budget、LRU、TTL、prune/clearは実装済み。全素材のraw memory予算ではない                                                                |
| binary session bytes                | KVS 0.2.0のsession backing。全assetを順次格納・検証した後に原本providerを解放。directは原本を保持              | session/asset/file件数とbytes上限、期限付きleaseと孤立session cleanup。再読込の唯一の原本となるactive sessionへ、補助cacheのLRUを適用しない |
| 原本ZIP/provider                    | `binary-entry-provider`が読み取りと原本cleanup callbackを所有する。session移送成功後、またはdirect終了時に解放 | archive/file/展開bytes上限。今回、解放失敗の追跡・再試行を修正                                                                              |
| 呼出側のraw bytes                   | backingやremote resolverから返したbytesは、呼出側がmaterialization等に用いる独立したコピー                     | cache pruneやsession削除は既に返したコピーを無効化しない。参照の解消とGC/実RSS回収は別                                                      |
| publicationの全章component・起動ZIP | publication snapshotとVM stage factoryが保持。再生・次章準備・SB3再保存に必要                                  | 起動ZIPの圧縮/展開それぞれ64 MiB等の個別上限はあるが、base64・コピー・全章を含む総常駐予算は未統合                                          |
| parsed document                     | publication loaderの上限付きLRU。既定2文書、1〜32で指定                                                        | 文書数の上限であり、上のbytesやdecoded資源のbudgetではない                                                                                  |

remote cacheの既定high waterは`min(256 MiB, 推定quotaの20%)`、low waterはその80%、TTLは30日、
LRU touchの間隔は1時間。これらは利用中モデル・動画等の実メモリ量ではなく、永続化した検証済みbytesを対象とする。
同じ名前のcacheでも、補助remote cacheと再読込を保証するsession原本の削除条件を共通化しない。

## 今回の修正

1. 原本の`releaseEntries`が失敗した場合に`released=true`を確定せず、cleanup callbackを保持する。
   明示release・最終assetの自動releaseの両方で、読み取りを閉じたまま再試行できる。
   同時releaseは一つの処理へ合流し、すべての呼出側が実際のcleanup完了を待つ。
   cleanup callbackを次のmicrotaskで呼び出す。進行中Promiseと失敗時の再試行処理を登録した後に
   sourceのabortを通知し、callbackだけでなく同期abort listenerからのrelease再入も同じ処理へ合流させる。
   callback内から同期的に再入したreleaseも同じ完了/失敗へ合流し、二重cleanup・早期成功を防ぐ。
   最終assetの自動cleanup中も、releaseはpending consumerより先に進行中の解放を参照する。
   自動cleanupの失敗を再入releaseが握り潰してその場で再試行することを防ぎ、明示再試行に委ねる。
   callback失敗後は未解放ownerを保持して再試行し、読み取りは再開しない。
2. App binary backingは、provider/session backingの解放成功後だけ参照を外す。
   失敗は`state: dispose-failed`として残し、未解放ownerへの再試行を許す。成功したownerは再解放しない。
   `disposed`は従来どおり「dispose要求済み」を表し、解放成功の判定にはstateも照合する。
3. dispose後の読取・exportを拒否し、停止と競合して遅れて戻るbytesも返さない。
   exportは各asset readのawait直後とexport確定前にopenを再検査する。
   最後のread自体が成功していても、その完了からexport継続までにdisposeされた場合は
   `K4-BINARY-BACKING-RELEASED-001`で拒否する。既に渡し終えたexportは呼出側の独立したコピーであり、
   backingのdispose後も有効で、export自身の`releaseEntries()`で閉じる。
   呼出側の取消しによるAbortError等をsessionの致命障害へ昇格しない。
   通常のstorage/整合性エラーは従来どおり失敗を通知する。
   KVS 0.2.0はgetの中断も致命障害と扱うため、backendへ渡すsignalはsession終了用に限定する。
   素材取得の取消しでは進行中の有界readの結果を棄却し、共有backingを中断しない。実KVSで取消し後の再読込を検証した。

## 限定検証

- 修正前に追加した原本release/同時release/自動release/backing cleanupの5回帰が失敗、既存15件は成功。
  修正後は同20件が成功した。
- KVS実パッケージとfake-indexeddbを接続。2 sessionのレコード数は`[sessions=2,bundles=4]`、
  一方の解放後は`[1,2]`、両方の解放後は`[0,0]`。他sessionの再読込と、既に返したrawコピーは維持された。
  `maxSessionBytes=1`の拒否後も原本を追跡し、明示cleanupで解放した。
- backing取消し・停止と遅延readの競合も回帰化した。
- 追加レビューで見つかったcallback同期再入（明示/自動releaseそれぞれ成功/失敗の4条件）と
  最後のread後のdispose競合を正式な5回帰へ追加。最初の3件は修正前にすべて失敗した。
  自動cleanup失敗時に再入releaseだけ成功する条件も追加で再現し、進行中解放への合流を修正した。
  最終修正後はprovider/backingの2ファイル29件が成功。
  再入側がcleanup完了前に成功しないこと、両releaseの失敗通知・owner保持・再試行、
  最終read完了後に新exportを返さないことと、既存exportの独立所有を確認した。
- asset-cache実パッケージとfake-indexeddbで、24 bytes上限・LRUの順序・過大素材の非保存・TTL/pruneを検証した。
- Chrome 155.0.8059.86 / headlessで実IndexedDBを検証。
  既存lifecycle fixtureの12回反復でactive materialized handle最大1、最後0、network取得1回。
  scene解放後の補助IDBは1件29 bytes、明示clear後0件。
  別cacheで24 bytes上限・LRU・過大素材非保存・TTL/pruneを確認し、`entries`と`metadata`も直接countして0件を確認した。
  モデルportはfixtureであり、実PoseNet/GPU解放の証明ではない。
- 前回は関連unit/接続/architectureが7ファイル76件、配布profile10件、生成runtime3種の一致・能力profile2件が成功。
  build・型検査・対象lint/format・diff空白検査も成功した。修正前の5回帰失敗、隔離worktreeのdist未生成、
  E2EのSSR dynamic import問題はいずれも上記の修正・手順整備で解消した。
- callback/exportのレビュー追補時点では、関連unit/接続/architectureの7ファイル81件と、3生成runtimeの一致・
  能力profile2件が成功。build・型検査・対象lint/format・diff空白検査も成功した。
  配布profile10件・Chrome native IDB 1件は前回の成功結果を維持し、今回の再実行件数へ加算しない。
  新たな実画面・実聴検証は行っていない。
- abort通知からの再入も3条件（cleanup成功・同期throw・非同期reject）を正式な回帰に追加した。
  修正前は成功条件のみ成功し、失敗2条件でcleanupが2回実行された。
  修正後は再入releaseが実cleanupの完了を待ち、失敗時は最終consumeと同じ診断/原因を受け取る。
  cleanupは1回で止まり、`released=false`とowner保持・読取禁止を維持する。
  後続の明示releaseだけが2回目のcleanupを行い、成功後のreleaseは冪等である。
  provider/backingの2ファイル32件を含む関連unit/接続/architectureの7ファイル84件、
  再生成したruntime3種の一致・能力profile2件、build・型検査・対象lint/format・diff空白検査が成功した。
  既存Chrome/配布profile結果を新しい実行数へ加算せず、実画面・実聴・Firefox/Safari検証は追加していない。
- [Chromeの観測値](../testing/evidence/asset-memory-20261023/chrome-indexeddb.json)。
  回帰は`test/e2e/dsl4-asset-cache-lifetime-chromium.test.ts`でGit管理する。

Firefoxはメジャーバージョンのリリース時だけ、Safari製品版は対象外。今回いずれも起動しない。
verify:full・全体E2Eは実行せず、変更境界のunit/接続・型・静的検証・生成runtime整合性に限定する。
新しいDSL版・有効化用スイッチは追加しない。

## 残務・受け入れ基準

- KVS内部のdisposeは失敗したPromiseを保持する。Appでownerを失わなくしても、KVS内部のIDB削除失敗の
  再試行成功までは保証しない。上位runtime host/platform sessionもdispose失敗を保持するため、
  依存順にcleanup ownerと再試行を統合し、実IDB障害・再試行時のレコードを検証する必要がある。
- publication全章component/起動ZIPの保持・再保存・停止と再開を壊さず、同時候補を含むraw bytes予算を設計・接続する。
  使っていない再構築可能資源だけをLRU退避し、現在章・候補の必須資源や唯一の原本は退避しない。
- 全ownerのmaterialization byte budget、共有integrityによる全種dedup、AudioBuffer/Pose/GPU/カメラ・共通UIの
  実解放と、実配布物online/hybrid/offlineの組合せ検証を継続する。
- 件数・bytes参照・IDBレコードの削除を、OSのRSS、native decoder、GPU driver、物理ディスク領域回収の証明にしない。

#775・#780はOpenを維持する。今回の範囲はローカルの修正・検証と両Issueへの記録であり、
commit/push/PR/merge・npm/SB3/Pages公開は含まない。
切戻しはsource・回帰・文書・3生成runtimeを一式で戻す。公開済み同版artifactは上書きしない。

## 寿命管理修正の公開手順（2026-10-23）

上記の「未コミット・未公開」は実装・検証時点の記録である。ユーザーの公開指示により、
`codex/fix-asset-memory-budget`からmainへのPRで、寿命管理のsource・正式回帰・設計書・
Chrome native IndexedDBの証跡・3生成runtimeを公開する。
関連84件・生成runtime整合性2件と、再レビュー時の既存32件・一時診断4条件の成功結果を用い、
CIとレビューに問題がなければSquash Mergeする。Issue #775・#780全体のDoDは未完了でOpenを維持する。
KVS内部/上位ownerのcleanup再試行、全章/起動ZIPの総常駐予算、全ownerのmaterialization budget/LRU等は
継続残務であり、このPRの完了と区別する。Firefoxはメジャーリリース時のみ、Safariは対象外。
公開済みrc.46・npm/SB3/Pagesは変更しない。切戻しはPRのsource/test/docs/3生成runtimeを一式でrevertする。

PR #996の初回CIでは、章sourceの非同期digestより先に固定100回のイベントループ待機が尽き、
publication hostの停止テストが失敗し、未cleanupの候補が後続fixtureへ干渉した。
40msの実digest遅延で再現し、停止/再起動テストを準備開始通知の期限付き待機とfinally cleanupへ補正した。
対象7件は遅延条件を含めて成功し、型検査・対象lint/formatも成功した。
アプリ本体の追加変更やCI設定変更は行わない。

## 解放再試行の後続修正（2026-10-23〜24）

[KVSからplatform session/runtime hostまでの解放再試行](dsl-4-session-cleanup-retry.md)に、
成立済みsessionの失敗owner保持・成功step非再実行・native IDBでの再試行結果を記録した。
上記のKVS内部/上位owner再試行の残務は、後続のKVS/App PRで進めている。
KVSは未公開ソースでの検証であり、公開済み0.2.0・通常npm依存への反映、作成途中のcleanup失敗、
外側ownerの統合等は引き続き残る。公開済みrc.46へ読み替えない。
