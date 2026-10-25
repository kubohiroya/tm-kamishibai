# DSL 4.0: factory／loaderの未返却ownerのcleanup引き継ぎ

Issue [#1008](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008)の次段階。
基準mainは`7aad9569`（PR #1052）。2026-10-25のローカル実装・検証を記録する。
各節の完了記録は公開前のローカル実装・検証時点を示す。
PR・CI・マージの統合結果はIssue #1008へ追記し、以下のローカル完了範囲と区別する。
DSL版、依存package版、保持予算、公開済みartifactは変更しない。
新しい有効化スイッチは追加しない。

## 問題と契約

[既存の作成失敗契約](dsl-4-creation-cleanup-owner.md)は、publicationやasset pipelineへ接続済みだった。
Node/local-previewの正常に返却されたownerの解放はPR #1052で統合されたが、
factory／loaderが正常ownerを返さず`Dsl4CreationFailure.cleanup`で部分ownerを渡す経路に抜けがあった。
CLIでは並行factoryの一方が先に失敗すると、もう一方が後から渡すcleanupを見落とし得た。

`createDsl4FailedCreationOwners`は、通常ownerとは別の集合に部分ownerを保持する内部補助である。
同じcleanup handleを複数箇所で観測しても、保持中は一つのentryへ集約する。
完了解放後に同じhandleが新たな未完了資源を知らせた場合は、古い完了entryへ戻さず再登録する。
通常例外や契約外の値に、存在しないcleanupを推測して追加しない。
別bundleのhandleも既存のshape検証で受け取る。任意の`cause`を再帰探索して所有権を重複取得しない。

最初の親cleanupは子の開始済み`completion`へ合流する。未開始なら子の`dispose`を呼ぶ。
失敗または照会不能ならentryを保持し、後続の明示disposeで未完了stepだけを再試行する。
子の失敗でも独立した他ownerの解放を続け、元の作成失敗とcleanup失敗の両方を可視にする。
進行中のreleaseと親disposeが重なる場合は同じ試行へ合流し、同じdispose内で失敗を自動再試行しない。

## 依存順と接続範囲

| 順序 | 境界                             | 保持するもの・失敗時の扱い                                                                                                                                 |
| ---- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 共通の失敗owner集合              | 初回合流、重複排除、遅延登録、照会失敗、明示再試行                                                                                                         |
| 2    | browser stage                    | storage／renderer／audio／bitmap／VM factory、prepareVm、load／resetの部分owner。VMの候補はvalidation前に保持し、契約不備でも返却済みclear／quitを解放する |
| 3    | browser runtime                  | component loader、stage constructor、後続UI factoryの部分owner。stage自体が保持した失敗はstageのcleanupへ合流し、同じ子を別途解放しない                    |
| 4    | Node watcher                     | source／Source Graph／asset loader、watch factory、error listener登録の部分owner。未完了readを待った後に遅れて届いたhandleも回収する                       |
| 5    | local-preview host               | 起動token生成、session準備、接続中のfactory／structure watch生成。起動listenerの例外もstartのrejectへ返し、socketを閉じた後も失敗ownerを保持する           |
| 6    | browser client／protocol wrapper | shell生成・pagehide登録の失敗を、返却前なら例外のcleanupへ渡す。返却後のruntime factory／response loader／stream readの失敗はclientが保持する              |
| 7    | CLI                              | 入力read＋source解決、runtime build＋browser bundleの両factoryをsettleまで待つ。複合失敗の全handleとsignal listener／hostを最終cleanupへ渡す               |

watch生成・listener登録が部分失敗したwatcherは再起動を閉じ、返却済みwatch handleを上書きしない。
sourceの更新候補の読込失敗では、既存の有効な台本状態を作成失敗だけで置き換えない。
watcherが部分ownerを保持した後の失敗は通常のAggregateErrorで伝え、hostが同じhandleを二重取得しない。
transportのtoken生成はcleanup契約のある例外を通常診断だけへ置き換えない。
普通のtoken生成失敗の既存診断は維持する。

clientはJSON読込の部分ownerをfallback診断で捨てない。
stream readが解放中に失敗する場合も、通常cleanupのsettle後に失敗集合をdrainする。
解放中に既に試行したentryは再試行しない。失敗したreader／runtimeとは独立してshellとlistenerを解放する。
返却前の失敗では、shellのエラーcallbackが作った表示もcleanupへ登録する。
protocol wrapperの明示再試行は既存のexported dispose、未返却constructorの再試行は例外のcleanupを使う。
専用の再試行UIは追加しない。

CLIは同期throwもPromiseのsettleへ正規化し、遅い方のfactoryを取りこぼさない。
片方だけが成功した場合は、未採用のSB3／browser bundle bytesをゼロ化する。
両方失敗した場合はAggregateErrorへ両原因を残し、最終cleanupが失敗した場合は
そのcleanup全体を`Dsl4CreationFailure.cleanup`で呼出元へ渡す。

## 回帰と受け入れ確認

初回に追加した正式回帰は47件。以下の218件＋生成確認2件は初回の結果であり、
後述するレビュー指摘2件の追加13回帰を含まない。途中の実行を重複加算しない。

| 対象                    | 追加数 | 主な条件                                                                             |
| ----------------------- | -----: | ------------------------------------------------------------------------------------ |
| 失敗owner集合           |      4 | 別bundle形、重複、初回合流、遅延登録、照会例外、完了handleの再登録                   |
| stage                   |     16 | 7境界それぞれの通常失敗／dispose競合、validation前VM、reset loader                   |
| runtime                 |      3 | 実component loader、stage constructor、stage経由のplatform factory                   |
| watcher／browser client |     13 | 5境界、同期再入、遅延read、未返却shell／listener、runtime factory、JSON／stream read |
| protocol wrapper        |      3 | shell／listenerの未返却失敗、fetch loader失敗                                        |
| CLI                     |      4 | 入力／buildの複合失敗と遅いfactory、成功した兄弟bytesのゼロ化                        |
| 実loopback host         |      4 | token／session／structure／source、socket閉鎖と明示再試行                            |

- [x] 初回cleanupへの合流、失敗owner保持、明示再試行、成功stepの非再実行を確認。
- [x] 同期再入、起動／read／disposeの競合、複合失敗を確認。
- [x] 関連14ファイル218件が成功。うち実loopback hostは16件。
- [x] build後の型検査、変更TSのlint／format、diff空白検査が成功。
- [x] 3種のruntimeを再生成し、生成一致・能力markerの対象2件が成功（31件skip）。

VM、DOM、reader、platformの失敗はfixtureで注入する。hostでは実127.0.0.1 HTTPと通常の台本loaderを使う。
初回の追加テストはSource Graphのflag／limit不足と、hostのHTTP状態・fixtureの失敗位置の想定違いで失敗した。
実際の読込経路へ接続し、指定factoryへの到達もassertして解消した。
これらはfixture修正であり、製品版ブラウザやnative回収の成功記録へ読み替えない。
最終結果と実行ログは`tmp/factory-cleanup-handoff/`へ保存した。
[Issue #1008の結果・残務の追記](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6396623190)は投稿本文と照合し、既存Closed状態の維持も確認した。

## レビュー指摘2件の修正（2026-10-25追補）

初回の完了記録を照合したレビューでは、対象5ファイル58件は成功した一方、追加した3条件が失敗した。
初回218件＋生成確認2件の成功自体は有効だが、次の競合まで検証済みとは扱わない。

1. hostのhandshake待ち中にdisposeすると、connection cleanupの早いdrainが終了した後で
   `Dsl4CreationFailure.cleanup`が届き、未解放ownerがあるままdisposeがresolveしていた。
2. client／watcherの通知待ちだけを閉鎖した後にcallbackが失敗すると、通常catchへ戻らず診断だけになり、
   失敗handleを保持せず明示再試行へ到達できなかった。runtime／protocol wrapperにも同じ接続不足があった。

### 接続準備の終了と後着owner

hostは接続準備のPromiseをfactory呼出し前に登録する。
teardownではprotocol／watcher等の終了処理を先に開始し、接続準備のsettleと並行して待つ。
その後で失敗集合をdrainし、未完了のconnection cleanupも事後確認する。
これにより、handshakeがキャンセルを必要とする場合も終了処理を開始でき、後着ownerを同じdisposeへ合流できる。
作成失敗のcatchはowner登録後に接続準備をsettleしてからteardownへ合流し、相互待ちを作らない。
子の初回cleanupが成功していれば終了を成功でき、cleanupが失敗していれば最初のdisposeからrejectする。

### 通知待ち解除後の失敗

`joinLateFailure`は、呼出元catchへ戻らなくなった失敗handleを保持し、初回cleanupへ一度だけ合流する。
重複通知では進行中／完了済みの同じ初回試行を参照し、子のdisposeを自動で再実行しない。
client／watcher／runtime／protocolは、閉鎖済みobserverの失敗をこの経路へ渡してから診断を通知する。
通常resourceの解放と失敗集合を分け、正常cleanupのsettle後に失敗集合を一度drainする。
公開の未解放照会は両方を含み、進行中のlate releaseと親disposeも同じ試行へ合流する。

dispose完了後に通知が初めて失敗する場合、既にsettleしたdisposeの結果は変更できない。
その時点で失敗を通知し、ownerを保持して`hasPendingCleanup()`をtrueにする。
原因解消後の明示disposeで失敗した子へ再到達できる。
runtime／watcherの親が正常解放後に参照を外していても、子のエラー通知が新しい未完了資源を知らせた場合は
閉鎖済みの子を再び保持する。通常操作を再開せず、解放責任だけを外側のclient／hostへ戻す。
protocolは最初の通知待ち解除後に新しいfetchを開始せず、runtimeも閉鎖後の新しいbridge通知を開始しない。

### 追加回帰と完了条件

- hostのhandshake後着失敗2条件: 子の初回cleanupの成功／失敗、socket閉鎖、失敗ownerの1回の明示再試行。
- 4通知経路（client／watcher／runtime／protocol）それぞれ2条件: 終了処理中／dispose完了後の失敗、初回合流、未解放照会、明示再試行、成功stepの非再実行。
- 同一handleの重複した遅い通知が初回cleanupを再実行しない1条件。
- 外側ownerへの再引き継ぎ2条件: clientが正常解放済みruntimeを保持し直す条件と、実hostが閉鎖済みwatcherの遅いstage通知失敗を保持し直す条件。

追加は計13件、初回からの正式回帰追加は計60件。
最終の関連14ファイル231件と、生成一致・能力markerの対象2件が成功（31件skip）し、計233件。
3生成runtimeを再生成し、build後の型検査・変更TSのlint・対象format・diff空白検査も成功した。
レビューで失敗した同じ再現3条件も成功し、正式回帰へ取り込んだ条件の再確認として233件へ重複加算しない。
初回追加host回帰の型検査は必須`sourceManifestPath`不足で失敗し、fixtureへ明記して解消した。
作業開始時からあった`package.json`／`pnpm-lock.yaml`の依存範囲変更は保持し、本cleanup修正では編集していない。
証跡は`tmp/factory-cleanup-handoff/followup/`。
[レビュー指摘2件の修正結果・残務の追記](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6397027204)を投稿本文と照合し、Issueの既存Closed状態も確認した。
Firefoxはメジャーリリース時のみ、Safari対象外を維持する。

## runtime解放後・親cleanup待ち中の後着owner（2026-10-25再追補）

追加13回帰の再レビューでは、関連71件が成功した一方、別の終了順序で1件の不具合を確認した。
runtimeの正常解放が完了し、親clientがshell等の別cleanupを待っている間に、
runtimeから未解放ownerの通知が届く条件である。clientはruntimeを保持し直すが、
成功済みstepを親cleanupの終了時に再照会していなかったため、
`hasPendingCleanup()`がtrueでも進行中のdisposeを成功として返していた。
前節の231件＋生成確認2件は、この順序までの完了証明にはしない。

clientは通常cleanupと失敗集合のdrainがsettleした後、通常owner集合の未解放状態を再確認する。
後着ownerが残る場合は、そのdisposeをAggregateErrorでrejectして参照を保持する。
照会不能のownerも共通cleanupの安全側の照会に従って未解放と扱う。
同じ試行の中で子を再解放せず、次の明示disposeから未完了のruntimeだけを再試行する。
既存のcleanup失敗はAggregateErrorへ残し、成功済みのshell／reader／listenerは再実行しない。
disposeが既にsettleした後の新しい通知は前節のとおり別の失敗として保持する。

正式回帰を1件追加した（初回から計61件）。shellの解放をgateで止め、runtimeの正常解放後に
失敗ownerを通知し、同時disposeの合流、最初のdisposeのreject、自動再試行しないことを確認する。
さらに明示再試行も一度失敗させ、ownerを保持したまま、原因解消後の明示disposeで解放できることと、
正常解放済みstepの非再実行を確認する。失敗owner／DOM／runtimeの失敗はfixtureで注入する。

- blocked → resolved: 新しい正式回帰は修正前に「期待したrejectがない」で失敗し、修正後に成功した。
- 今回の関連5ファイル55件（client・runtime・protocol・失敗owner集合・cleanup owner）が成功。
  前節の231件や生成確認2件との重複加算はしない。今回変更しない経路の既存結果は、対象ファイルのSHA-256一致を確認して維持する。
- レビューで失敗した同じ再現1条件も成功。正式回帰の再確認であり、上記55件へ重複加算しない。
- build後の型検査、変更TSのlint、対象format、diff空白検査が成功。
- 変更対象はbrowser client・正式回帰・本設計書。生成runtimeと既存の依存範囲変更は編集しない。
  ローカル証跡は`tmp/factory-cleanup-handoff/pending-owner-fix/`。

差分は引き続き未コミット・未公開であり、mainや公開済みrcへの反映を意味しない。
[Issue #1008の再追補](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6397532216)へ、
この修正の受け入れ確認と残務を追記した。
以下の残務・保証範囲と、Firefoxはメジャーリリース時のみ・Safari対象外の方針を維持する。
push・PR作成・マージ、npm／SB3／Pages公開は行わない。
今回の追加修正だけを戻す場合は、この再追補・clientの終了時確認・追加回帰を一式で戻す。

## 残務と限界

- 今回接続したNode/local-preview境界以外を含む、未返却factory／loader全体の継続監査。
  第三者factoryが資源もcleanup handleも返さず通常例外を投げる場合は、依存側の契約変更が必要。
  scratch VM／renderer等のconstructor内部資源や下位KVS作成中のIDB／OPFS等まで回収できたとは扱わない。
- native ReadableStreamが失敗後のcancel再実行を内部へ伝えない場合の資源回収。
- 正常dispose後に新しい未解放資源を得る子ownerは、親へ通知できる契約が必要。
  今回はruntime／watcherから親への通知を接続した。通知せず内部だけで資源を再取得する任意の依存まで保証しない。
- settleしないread／factory／releaseや、資源release自身が親disposeをawaitする非協調callbackの強制終了。
  CLIの並行prepareは両方のsettleを待つため、非協調factoryに対する終了期限は保証しない。
- OS socket／watch、GPU／decoder／AudioBuffer／RSS、物理ディスクの実回収測定。
- 失敗owner保持数の上限、budget／LRUの長時間測定、画面全体の再試行導線。
- SIGKILLやpage破棄など、JavaScript停止後のcleanup完了は保証しない。

Issue #1008の既存Closed状態を維持し、今回のローカル完了範囲と残務を追記する。
Firefoxはメジャーリリース時のみ、Safari対象外。今回実ブラウザ／実聴検証は行わない。
push・PR作成・マージ、npm／SB3／Pages公開は行わない。
rollbackは今回のsource／回帰／設計書／3生成runtimeを一式で戻す。公開済み同版artifactは差し替えない。
