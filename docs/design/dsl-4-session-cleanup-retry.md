# DSL 4.0 session解放の再試行と所有権

関連: [#775](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/775) → [#780](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/780)。
2026-10-23〜24実装。実装開始時点の基準はApp main `f2136883`、KVS main `b546b32`。
双方のbranchは`codex/fix-session-cleanup-retry`。KVS → Appの順でPRをmainへ統合する。
App側はrc.47の公開記録を含むmainへ取り込み、生成runtimeを合わせる。
npmのKVS内部修正は未配布であり、リポジトリへの統合と通常npm依存への反映を区別する。

## 依存順と契約

| 所有者                             | 対応                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KVS established direct/IDB backing | dispose要求後のread/lease更新を閉じ、同時呼出・同期再入を同じPromiseへ合流。失敗Promiseは次の明示disposeで再試行可能。source参照は解放成功後に外す                              |
| KVS IDB cleanup                    | session/bundle削除が成功するまでDB接続を保持。閉じた接続はcleanup専用に開き直す。対象sessionだけを削除し、読取には復帰しない                                                    |
| KVS object-backed session          | 削除失敗keyとstoreを保持し、成功keyを次回は削除しない。全key削除後にstoreをreleaseする                                                                                          |
| App binary backing                 | PR #996の失敗owner保持と再試行を利用。KVS内部の再試行と接続する                                                                                                                 |
| platform asset session             | 初回要求から通常wrapper操作を閉じる。pose/camera/binary/lifecycle/input/TM/cache/mediaの成功済みstepは再実行せず、失敗分を保持。遅延資源が残った子ownerだけ再登録               |
| runtime startup/environment        | navigationとenvironment、environment内部の各ownerを別stepとして追跡し、通常の成功stepは除外し、未解放になった子ownerだけ再登録                                                  |
| TurboWarp runtime host             | runtime/inputの終了待ち・session解放・cache heartbeat停止を並行させ、pending inputを先に解放できる経路を維持。失敗分と遅延した未解放子ownerだけを再試行し、操作禁止は解除しない |

Appの`retryable-cleanup`は、通常操作を閉じる`requested`と、進行中/成功済みのattemptを分離する。
Promiseと失敗時の再試行処理をowner呼出より前に登録し、同期callbackからの再入を合流させる。
一つのownerが失敗しても他ownerの解放を継続し、AggregateErrorへ集約する。
失敗後の通常release wrapperは直近の失敗を返し、再試行は明示disposeで行う。
不正な初回dispose理由では操作を閉じず、進行中disposeは同じPromiseを返す。

## 検証

- KVSの追加direct/IDB回帰3件は修正前に失敗。Appのplatform/startup/host追加3件も修正前に失敗した。
- KVSはレビュー追補2件を含む追加6件と既存binary/object-storeの3ファイル23件成功。
  実fake-indexeddbの削除トランザクションをabortし、rollback・接続終了後の再open・他session隔離・呼出側コピーを検証。
  object-backedの失敗key保持はstore doubleで検証し、native OPFS障害の証明とは区別する。
- Appの関連9ファイル170件成功、外部依存接続1件は通常実行ではskip。
  成立済みsessionのcleanup失敗・同期再入・成功ownerの非再実行・明示再試行・通常操作禁止を確認した。
- 未公開KVSソースを指定する接続検証1件成功。KVS→App backing→platform session→runtime startupを接続し、
  IDB削除失敗後に`[sessions=1,bundles=2]`を保持、明示再試行後`[0,0]`を確認。
  media/TMの成功済みreleaseAllは1回だけである。
- 同じ接続テストを公開済みnpm KVS 0.2.0ソースで実行すると、再試行で失敗する。
  **通常npmインストールでKVS内部の修正が使える状態にはまだなっていない。**
- Chrome 155.0.8059.86 / headless、native IndexedDB 1テスト2条件成功。
  削除transactionのabortのみ／abort時に接続もcloseする両方で、
  `[2,2] → 失敗後[2,2] → 一方の再試行後[1,1] → 他方解放後[0,0]`。
  通常readは閉じたまま、他sessionと呼出側コピーは維持。新規の動画実画面・実聴検証には加算しない。
  [観測JSON](../testing/evidence/session-cleanup-20261023/chrome-indexeddb.json)。
- sourceに合わせAppのruntime3種を再生成し、生成物の一致・能力profile2件が成功。
  KVS/Appの型検査・対象lint、Appの対象format・両repoのdiff空白検査も成功した。

接続検証は製品フラグではなく、テスト時だけ未公開の依存ソースを選択する。

```sh
KVS_CLEANUP_SOURCE=/path/to/turbowarp-kvs/src/session-binary-backing.ts \
  node node_modules/vitest/vitest.mjs run --config test/integration/kvs-cleanup.config.ts
KVS_CLEANUP_SOURCE=/path/to/turbowarp-kvs/src/session-binary-backing.ts \
  node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts \
  test/e2e/dsl4-session-cleanup-retry-chromium.test.ts
```

HTTP/Chromeを禁止するsandboxではE2Eを実行可能な環境で行う。HTTP起動エラーを明示通知し、
ブラウザ側検証に15秒の期限を設け、失敗時もbrowser/serverを閉じる。
生成検証とE2EのglobalSetupはどちらもdistへ依存するため、buildと生成検証・E2Eを直列にする。
Firefoxはメジャーリリース時のみ、Safariは対象外。verify:full・全体E2Eは行わない。

## レビュー指摘2件の修正（2026-10-24）

- カメラは通常操作の閉鎖と解放attemptを分離する。`dispose()`の失敗後は次の明示disposeで
  `stopCamera`を再試行し、成功後は同じPromiseを返す。attemptと失敗時のresetは
  stop/cancel callbackより前に登録し、同期再入を合流させる。
  通常の`stop()`は直近の失敗を返し、`start()`やplatform prepareは閉じたままとする。
- platform sessionと実story camera lifecycleを接続する回帰を追加した。
  初回stop失敗時の同期再入、明示disposeの再試行、成功済みpreview/recognitionとmedia/TMの非再実行を確認。
  カメラcompositionの停止失敗を注入したテストであり、物理カメラ・OSの解放検証ではない。
- KVSの初期接続とcleanup用再open接続に共通の接続監視を登録する。
  `versionchange`では、その接続自体をcloseする。dispose要求後の通常readは再開しない。
  元接続の削除abort/close後、再open接続でも2回続けて削除をabortし、各失敗後の
  `[sessions=1,bundles=1]`保持と、その後のDB削除／version 2への更新がblockedにならない2回帰を追加した。
- 新しいDB schemaをこの旧readerが解釈できるとは扱わない。version 2への更新後のcleanupは
  明示エラーを維持し、DB削除後の明示disposeで完了することも確認した。API/schema版は変更していない。
- 追加のカメラ1件とIDB2件は修正前に失敗し、修正後に成功した。
  KVS 23件、App 161件、未公開KVSとの接続1件、既存Chrome native IDB 1件・2条件を確認。
  **新しい連続失敗後のDB削除/更新2条件はfake-indexeddbでの検証であり、nativeブラウザの追加結果には数えない。**
  App runtime3種を再生成した。過去の動画実画面・実聴結果には加算しない。

## 許可待ちdispose後のカメラ解放（2026-10-24）

初回disposeは未回答のカメラ許可を待たない。その完了は、その後に返ってくるstreamまで解放済みという意味ではない。
遅れて起動が完了した場合、カメラownerは新しい解放attemptを登録して停止する。
先のattemptがまだsettle中なら、その結果を待ってから新しい停止を行う。通常操作の閉鎖は解除しない。

遅延停止の失敗は`getCleanupError()`と未解放状態へ保持し、`onCleanupError`へ通知する。
platformの`onCameraCleanupError`を通し、runtime hostの既存`onBackgroundActionError`へ
`command: camera` / `code: K4-STORY-CAMERA-CLEANUP`として伝える。
診断callbackのthrow/rejectはcleanupの所有権を変更しない。通常stopは最新attemptの結果を観測し、
再試行は明示disposeで行う。停止成功でエラーと未解放状態を消し、成功済み資源を再停止しない。

共通cleanupは子ownerの`isPending`を、明示disposeのたびに確認する。
カメラ → platform session → environment → runtime startup → hostの`hasPendingCleanup()`を接続し、
初回disposeが成功済みでも、遅延資源が残ったstepだけを再登録する。
進行中disposeは同じPromiseへ合流し、通常の成功済みmedia/TM/renderer等を再解放しない。
初回完了後に新しい解放要求が生じ得るため、最後のdispose結果だけを将来の資源回収の保証にはしない。

追加回帰は次の5件（項目1は2条件）。

1. 実camera lifecycleで許可待ちdispose → 遅延起動 → 自動停止失敗 → 明示停止の再失敗 → 明示再試行成功。
   初回attemptが成功後／settle中の2条件で、同期再入、通常stopの失敗観測、start禁止、診断observerのrejectを確認する。
2. 実platform sessionで初回dispose成功後の遅延停止失敗を保持し、sessionの明示disposeで回収する。
3. 実runtime hostで初回disposeが成功した後に遅延停止失敗が発生する条件。
4. camera stepの解放後もTM cleanupが進行中で、その間に遅延停止失敗が発生する条件。

関連8ファイル166件、未公開KVS接続1件、生成runtime一致・profile2件を対象とする。
camera compositionと許可応答gateを使う回帰であり、物理カメラ・OS資源の測定ではない。
KVS sourceは今回変更せず、前回の23件・Chrome native IDB 1件2条件の記録を維持する。
Firefoxはメジャーリリース時のみ、Safari対象外。通常npm KVS 0.2.0への内部修正反映と、
publication VM/shell/preview等の外側ownerの統合は引き続き残務とする。

## 未解放状態の照会例外（2026-10-24）

共通cleanupは、通常操作を閉じる`requested`とattemptを登録してから外部の照会・解放callbackを呼ぶ。
照会中の同期disposeも同じattemptへ合流する。直列実行では先行するnavigation解放を済ませてから
環境の未解放状態を照会し、照会の例外によってnavigationの閉鎖が省略されないようにする。

`isPending()`が失敗した場合は、元の例外をAggregateErrorへ集約し、そのownerを未確認として保持する。
解放が必要と既に分かっているownerのcleanupと、他ownerのcleanupは続行する。
未確認状態と解放失敗状態は分離し、成功した解放は照会失敗だけを理由に再実行しない。
明示disposeで未確認ownerを再照会し、falseなら確認完了、trueなら必要な解放を行う。
`hasPendingCleanup()`自身の照会例外は保守的にtrueとし、未確認ownerを解放済みとは扱わない。

照会を持つcleanupは、成功後の明示disposeでも確認用attemptを作る。
進行中の同時呼出・再入は同じPromiseを返し、成功済み資源の解放は繰り返さない。
初回disposeの不正reasonでは閉鎖・照会を開始しない。閉鎖後は再試行成功でも通常操作を再開しない。
startupのsession.startは既存仕様どおり停止済みsnapshotを返し、台本は実行しない。
直接のnavigation、変数書込み、action呼出も拒否する。

追加回帰4件は修正前に失敗し、修正後に成功した。

1. 実runtime startupで、環境の照会例外と同期再入が発生してもnavigationを閉じ、環境の解放を行う。
   明示再試行で照会を回復し、成功済み環境解放を繰り返さず、台本再実行・入力を拒否する。
2. 直列／並列の2条件で、照会と解放の両方が失敗しても他ownerの解放を続け、
   照会だけが失敗する段階を経て明示再試行で完了する。成功ownerの非再実行も確認する。
3. 成功したdisposeの後で照会が失敗してもownerを保持し、照会復旧後のtrueを受けて必要な子ownerだけを再解放する。

関連9ファイル170件、未公開KVSとの接続1件、生成runtime一致・profile2件が対象。
KVS source、依存/lock、DSL版、製品URLのフラグ、公開済みrc.46・rc.47の成果物は変更しない。
今回も物理カメラ・OS資源やnative OPFSの検証結果には加算しない。

## 残務・受け入れ基準

1. KVS差分のレビュー・配布版公開と、App依存/lock固定・runtime再生成・通常npm版での接続検証。
   今回の生成runtimeも依存は公開済み0.2.0のままで、KVSの未公開修正を同梱したものではない。
2. session成立前の失敗（部分IDB/OPFS作成・VM/environment作成失敗）でcleanupも失敗した場合のowner公開と回収経路。
   作成APIがrejectすると再試行handleを返せない既存経路は今回解消していない。
3. publication VM/shell/preview等の外側ownerと、各依存内部のstream/writer abort失敗等の追跡。
   object-backed sessionの成功keyを再削除しないことと、OPFSの全物理資源回収を同一視しない。
4. 全章/起動ZIPのraw bytes総予算、全ownerのmaterialization budget/LRU・dedup、
   AudioBuffer/Pose/GPU/カメラ・共通UIの実解放とonline/hybrid/offlineの組合せ、#771・#779。

#775・#780全体のDoDは未完了でOpenを維持する。IDBの参照/レコード削除はRSS・native decoder・GPU driver・
物理ディスク領域回収の保証ではない。今回はsource・回帰・設計書をPRで統合し、npm/SB3/Pagesの新規公開は行わない。
rollbackはKVS/Appのsource/test/docsとAppの3生成runtimeを一式で戻す。公開済みrc.46・rc.47の成果物は変更しない。
