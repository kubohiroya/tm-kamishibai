# DSL 4.0 Web Previewのsession / protocol / bridgeのcleanup所有権

関連: [Issue #1008](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008)。
2026-10-25、main `48192566`（PR #1036）を前提とするローカル追加実装。
branchは`codex/fix-web-preview-cleanup-owner`。初回実装・レビューでは未コミットのローカル差分として保持した。
その後、ユーザーの指示に基づき本差分をコミット・pushしてPRでmainへ統合する。CI・レビュー・merge結果はIssue #1008へ記録する。
今回の統合にpackage/SB3/Pagesの新規公開は含めない。
公開済みrc.53に今回の修正が含まれるという記録ではない。

## 依存順と今回の境界

| owner                                    | 今回の変更                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| live-reload session → runtime            | factoryの返却直後、検証・start・置換の前にownerを登録。current以外の候補・不正な戻り値・start失敗も保持し、cleanup成功後にだけ参照を外す |
| live-reload session → factory失敗cleanup | `Dsl4CreationFailure`の初回completionへ合流。失敗ownerを保持し、後の明示disposeで再試行                                                  |
| source protocol port → connection        | connectedと接続解放の所有権を分離。handshake待ち・disconnect例外・不正ackの後も所有し、有効なdisconnect ackを得るまで捨てない            |
| protocol → live-reload candidate         | 終了済みruntimeに対するdisconnect再試行ではcandidateのresumeを行わず、接続解放を完了できる                                               |
| runtime bridge → port / live-reload      | 子の`hasPendingCleanup()`を接続し、失敗した子だけを再試行。portのstage完了待ちとruntimeのstopを並行に進める                              |
| source adapter → timer / listeners       | 同期dispose APIを維持。timer停止・visibilitychange解除・pagehide解除・root等の参照破棄を独立に試し、失敗stepだけを再試行                 |
| coordinator → source / port              | source終了失敗でもport終了を継続。子の未解放照会を引き継ぎ、成功済みの子を繰り返さない                                                   |

これはWeb Preview全体の終了導線が完了したという意味ではない。
上位のbuilder shell・reload surface、asset pipelineなどは下記の残務に分ける。
DSL版・新しい有効化スイッチ・依存package版は変更しない。

## 共通の終了契約

最初のdispose要求で通常操作を閉じる。cleanup失敗後も操作を再開せず、終了APIからだけ再試行する。
非同期ownerの同時呼出・子callback内からの同期再入は、子の解放を始める前に公開した同一Promiseへ合流する。
失敗確定後の新しいdisposeは新しい試行となり、成功済みstepは再実行しない。
子の`hasPendingCleanup()`で未解放が見つかった場合は、以前のdispose Promiseが成功していても再度解放できる。
照会例外は共通のretryable cleanup契約に従い未確認ownerとして保持する。

source adapterは既存の同期APIを維持するため、同期再入中は同じ試行のsnapshotを返し、解除stepを重ねて実行しない。
初回の終了status通知を呼び出す間も試行中として扱う。通知からの同期disposeで、失敗stepを初回の例外が返る前に再試行しない。
外側coordinatorは先に公開Promiseを登録してから同期sourceを解放する。
sourceのpagehide handlerは終了失敗をonErrorへ通知し、ownerは明示dispose用に残す。
listenerはaddEventListenerを呼ぶ前に登録先を記録し、部分登録してから例外を投げた場合も解除できる。

## 進行中処理とdispose

live-reloadは既知runtimeのstop/disposeを開始してから、dispose要求時点の操作queueを待つ。
queueの完了後、遅れて返ったruntimeやfactory失敗cleanupを同じ試行で回収する。
同じ失敗ownerをその試行内で自動再試行することはない。
factory・旧章cleanupのawait後にも閉鎖状態を調べ、終了中の候補をstartしたりcurrentへ採用したりしない。
quiesce完了後の処理も閉鎖状態を調べ、候補や旧stateを復活させない。
失敗したruntimeのstopとdisposeは独立stepであり、stop失敗でもdisposeを試す。

portは接続中だったhandshakeのsettleを待ってからdisconnectする。handshakeが接続を成立させた後で失敗する可能性も含め、
接続の不在を単にconnected=falseから推論しない。disconnectのtransport例外・ack検証例外の両方で参照を残す。
遅いcommit/defer ackはdispose後のstatusをconnectedへ戻さない。
通常はonEventの完了を待つが、dispose要求時には通知の完了待ちだけを解除する。
protocol本体と操作queueの終了待ちは継続する。これによりstage/commit/defer/disconnect等のonEventが
自分のownerのdisposeをawaitしても、通知と終了処理の相互待ちを作らない。
終了後も通知PromiseのrejectはonErrorへ通知し、未処理rejectionにしない。
通知待ちの登録は通常完了時に削除し、終了時も全件解除する。終了まで未解決の共通Promiseへ通知数分のreactionを蓄積しない。
bridgeがportだけを待ってからruntimeを止めると、quiesce待ちで終了が詰まることがあるため、両方を並行に解放する。

coordinatorはhandshake待ちの後とsource stageの前後で閉鎖状態を調べ、終了後にsource開始や最新source結果の再保持を行わない。
commit/deferもcoordinator自身の入口で閉鎖を調べる。子portのdisposeが始まる前のmicrotaskでも、終了要求後の操作をtransportへ通さない。
live-reloadのdefer/discardCandidate/無効source処理はresumeのawait後に閉鎖状態を再確認する。
quiesce失敗時のstop完了後も同様に確認し、終了status・candidate・diagnosticを遅い処理で上書きしない。
sourceもproject root通知待ちの後に閉鎖状態を調べ、終了後にlistenerを登録しない。
読込中に届いたmanifest・status・diagnosticも終了済みownerを復活させない。

## 回帰と確認範囲

`test/dsl4-web-preview-cleanup-owner.test.ts`に次を追加する。

- runtimeのstop/dispose失敗、同時呼出・同期再入、成功stepの非再実行。
- 遅延factory、戻り値検証失敗、初回start失敗、factory失敗cleanupの初回合流と明示再試行。
- 旧runtimeと候補の両方のcleanup失敗、旧runtime解放待ち中のdispose。
- 子の未解放照会、disconnect例外/不正ack、遅延handshake・commit ack。
- 実bridge/protocol/live-reload接続の終了失敗と再試行、quiesce中の終了がruntime停止で進むこと。
- sourceのtimer/listener個別失敗、部分的listener登録、同期再入、project root/handshake待ち中の終了。
- source cleanup失敗でもcoordinatorのprotocol解放が進み、次回は失敗sourceだけを再試行すること。

既存のlive-reload/quiesce、protocol/port、bridge、source adapter、builderのWeb Preview/preview shell、
local browser runtime・runtime componentと接続して通常経路の互換性も確認する。
製品moduleとtransport/runtime/DOM/timerのdoubleを用いた回帰であり、実ブラウザ・native資源回収の測定ではない。
Firefoxはメジャーリリース時のみ、Safari対象外。今回はブラウザを起動しない。
検証結果・初回テスト期待値の訂正・残務はIssue #1008の運用ログへ追記し、詳細ログは`tmp/web-preview-cleanup-owner/`へ保持する。

## 検証結果とレビュー4件の補正（2026-10-25）

初回実装では新規正式回帰27件を含む関連11ファイル114件が成功した。
この結果には、イベント通知からのdispose待ち、dispose直後のcommit/defer、失敗後の終了通知からの再入、
遅延resumeとdisposeの競合が含まれていなかった。追加レビューでは6条件の追試で4件の不具合を再現した。
以前の完了記録は、上記の条件まで保証する根拠にはしない。

今回の補正では、次を正式回帰へ追加する。

- connect/stage/commit/defer/disconnect通知からdisposeをawaitする5条件。
- 通常通知は引き続き完了待ちすること、終了後の通知失敗をonErrorへ渡すこと、
  実bridgeの通知から終了を待ち、失敗したruntimeだけを後の明示disposeで再試行できること。
- coordinatorのdispose直後のcommit/deferを拒否し、transportの変更操作が0回である2条件。
- timer/listener/両方の解放失敗後、終了通知からの同期再入では試行が増えず、後の明示disposeで成功する3条件。
- defer/discardCandidate/無効sourceのresumeが遅れてresolve/rejectする6条件。
- quiesce同期失敗・非同期失敗・不正tokenに対するstop待ち中のdisposeで終了状態を維持する3条件。

補正後は、追加22条件を含む本ファイル49件と、関連11ファイルの合計136件が成功した。
レビュー時に失敗したローカル追試6条件も全件成功したが、正式136件へは加算しない。
生成runtime3種を再生成し、authoring bundleだけが変更された。生成一致・能力markerの対象2件
（31件skip）、build・型検査・対象lint/format・diff空白検査も成功した。
追加回帰の修正前実行は19件中14件失敗・5件成功で、commit/defer通知2件のack fixture不備を含む。
fixtureは入力typeのspread上書きを訂正し、製品のack検証は維持した。
結果と残務、途中失敗とfixture訂正を区別してIssue #1008へ記録する。
初回の27件・114件や途中結果は、新しい結果へ重複加算しない。
初回実装と再レビュー時点では未コミット・未公開の10ファイルを保持した。
公開・統合時は検証済み差分と最新mainの前提を照合し、変更した範囲だけ追加検証する。

## 残務とrollback

- 上位のbuilder Web Preview/preview shell・reload surface/overlay・reload policyの所有権接続と、画面全体の終了/明示再試行導線。
- asset pipeline/transactionとbrowser asset adapterの終了失敗・解放再試行。source adapterの終了契約からasset owner全体の完了を推論しない。
- node watch/transportとlocal-preview host/browser wrapperの上位終了境界。これらの通常接続テストは、障害注入による全ownerの解放保証を意味しない。
- cleanup handleを返さない第三者factory内部、下位KVSの作成途中IDB/OPFS・stream/writer、native GPU/decoder/RSS回収測定。
- 応答しないfactory/provider/handshake/quiesceの強制終了、連続失敗owner数の上限。Promiseがsettleしなければ終了待ちは継続する。
- 専用のcleanup再試行ボタンは追加しない。現時点はsession/bridge/coordinatorのdisposeから明示再試行する。

rollbackは今回のsource/test/設計書/生成runtimeを一式で戻す。公開済み同版artifactは差し替えない。
Issueの既存Closed状態は維持し、上記の追加完了範囲と残務を運用ログで区別する。
