# DSL 4.0 Node・local-previewのcleanup所有権

関連: [Issue #1008](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008)。
2026-10-25、main `222fade6`（[PR #1050](https://github.com/kubohiroya/turbowarp-kamishibai-app/pull/1050)）からのローカル追加実装。
実装branchは`codex/fix-local-preview-cleanup-owner`。
以下の検証記録は公開前のローカル実装時点の結果であり、レビュー指摘の修正まで含む。
PR・CI・マージの統合結果はIssue #1008へ追記し、既存Closed状態を維持して完了範囲と残務を区別する。
DSL 4.0・機能スイッチ・依存package版・公開済みartifactを変更しない。

## 依存順と所有対象

| 層                               | 所有対象と解放                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| Node source watcher              | fs.watch handle、quiet timer、進行中read/通知queue                                            |
| transport policy                 | 接続ごとのdisconnect callback、進行中・失敗したdisconnect、認証token                          |
| local-preview host               | source/structure watcher、source protocol port、transport、HTTP応答とserver、配布用bytes/参照 |
| browser stage                    | VM clear/quit、bitmap/audio/renderer/storage、入力listener、stage DOM、base project bytes     |
| browser runtime                  | bridge、stage、menu/title/error UI、Scratch互換環境、保持project bytes                        |
| browser client/bootstrap         | lifecycle/stream abort、reader/lock、runtime、shell、pagehide listener、起動queue             |
| protocol専用client / CLI command | shell/reader/listener、hostとsignal listener。CLI失敗はcleanup handleを例外に載せる           |

[asset pipelineのcleanup所有権](dsl-4-asset-pipeline-cleanup-owner.md)に続く追補であり、#1050統合済み範囲と区別する。
browser bootstrapはclientをそのまま返すので、既存の返却経路からdispose/未解放照会へ接続する。

## 契約

最初のdisposeで通常操作と入力を閉じ、公開Promiseをcallback実行前に登録する。
進行中・同期再入は同じ試行へ合流する。失敗後の次の明示disposeで失敗したstepだけを再試行する。
成功した解放前に参照を消さず、callback成功後にowner/handleを外す。
`hasPendingCleanup()`は参照数や画面の表示状態と区別し、失敗した子を上位へ伝える。

Node watcherはtimer停止・watch close・queue完了待ちを独立stepとして扱う。
停止失敗後に届くtimer/watch callbackは閉鎖状態を確認して新たなreadを始めない。
onResultがdisposeをawaitしても通知待機だけを解除し、遅い通知rejectはonErrorへ残す。
readそのものを強制終了する機能ではない。

transportは既存のtoken・origin・loopback制約を維持する。
disconnectは接続を論理的に閉じてからcallbackを呼び、失敗した接続を台帳へ保持する。
失敗後も通常の発券/接続は再開しない。policy.disposeは進行中失敗へ合流し、後の明示disposeで再試行する。
成功したdispose/接続disconnectのPromise共有は既存契約を維持する。
hostの`beginCleanupAttempt()`接続は、同じ終了試行中のdisconnect失敗を自動再試行しないための内部契約である。

hostは接続の通常参照を閉じても、解放に失敗したwatcher・port・disconnectのownerを保持する。
独立した解放失敗がserver終了や他watcherの解放を止めない。
進行中のsource stage/HTTP body読込の後にも閉鎖/認証状態を確認し、終了後に新たな候補やstreamを開始しない。
構造変更による切断・接続失敗時のcleanupも、同じ保持/再試行経路を使う。
再ビルドが必要な構造変更では、`full-rebuild-required`のevent stream送信を試み、
送信成否と切り離してCLI用observerへ同じイベントを通知してから接続を終了する。
streamへのwriteがthrowしてもCLIへの通知は必ず行い、送信例外自体は握りつぶさない。
CLIは切断より先に再ビルド理由を受け取り、解放成功時は`exitCode: 1`・`reason: full-rebuild`で終了する。
解放も失敗した場合は、通常切断として成功させずcleanup handleを持つ例外で返す。
通知失敗も接続cleanupを妨げず、通知とcleanupが両方失敗した場合は両方の原因を保持する。
送信失敗や複合失敗はhostの`onError`へ報告し、送信に失敗したブラウザが通知を受信したとは扱わない。

stageはVM clear/quit、各platform資源、DOMを別stepで解放する。
clear/quitのどちらかが失敗した場合はVMを保持し、成功した方は繰り返さない。
入力listenerは個別に完了を記録し、removeが失敗しても残存callbackは閉鎖済み入力を処理しない。
runtimeはbridgeからstageへ順に解放し、部分起動時の初回cleanup失敗へ合流する。
起動通知からのdispose待ちは解除し、終了後のruntime通知でUIを復活させない。
Scratch互換環境は実際の復元成功後だけを完了扱いにする。
stageの起動PromiseはDOM操作・platform factoryより先に公開する。
同期factoryからdisposeへ再入した場合も起動中の初回cleanupへ合流し、
cleanup失敗を同じdispose内で再試行せず、次の明示disposeへ残す。
presentation resetも入力解除・VM loadより前に進行中Promiseを公開する。
入力解除の同期動作は維持し、そのcallbackでdisposeを要求した場合は新たなloadを始めない。
loadから同期再入してresetとcleanupが失敗する場合も初回cleanupへ合流し、
失敗したownerの解放を同じdispose内で再実行しない。

clientはabortを起動待ちより先に伝え、進行中runtimeのdisposeも先に開始する。
同じ起動終了中のruntime cleanup失敗は合流し、同じ試行で繰り返さない。
起動がsettleした後でreader/lock、runtime、shell、pagehide listenerを確認し、失敗したownerを残す。
エラー表示は閉鎖後にDOMを作らない。pagehideによる失敗も処理し、明示disposeのrejectを消さない。
protocol専用clientの明示再試行はmoduleの`disposeDsl4LocalPreviewProtocolClient()`で行い、
`hasPendingDsl4LocalPreviewProtocolCleanup()`で照会する。専用再試行UIは追加しない。

CLI commandはsignal listenerとhostを独立stepで解放する。
終了失敗時は`Dsl4CreationFailure.cleanup`へownerを引き渡し、呼出側が原因解消後に再試行できる。
エラーを印字しただけで解放成功とは扱わない。
`dispose()`がresolveしても、終了後の未解放照会がtrueまたは照会不能なら成功扱いにしない。
この場合も同じcleanup handleを例外へ載せ、修復後の明示再試行へ引き渡す。

## 回帰・検証

追加回帰はwatcherの同期/非同期close失敗・timer独立性・通知からのdispose待ち、transportの失敗合流と明示再試行、
実loopback hostのwatcher/protocol複合失敗とserver終了、実browser runtime/stageのrenderer失敗・起動中dispose・Scratch復元、
入力remove/VM clear複合失敗、clientのreader/listener/runtime複合失敗・起動終了・通知待ち、
protocol専用clientの失敗/成功shell保持、CLI host失敗handleを対象にする。
レビュー後に6件を追加した。実host・CLI・event streamを通した再ビルド通知順序を通常終了/解放失敗で確認し、
stageの同期factoryからのdispose再入と初回cleanup失敗を後続factoryの失敗あり/なしで確認する。
CLIはhostのdisposeがresolveしてもpendingが残る条件と、解放後の照会だけが失敗する条件を確認する。
再レビュー後にさらに5件を追加した。実host/CLIではstream writeの送信失敗を注入し、
watcher解放の成功/失敗との組合せで再ビルド理由の通知・異常終了・原因保持を確認する。
resetではVM loadからの同期再入後に同期throw/非同期rejectし、cleanupも失敗する2条件と、
入力解除からの再入で追加loadを始めず解放失敗を再試行可能に保つ条件を確認する。
いずれも初回失敗の可視性・所有権保持・明示再試行を検証し、成功済みstepを繰り返さない。
VM/renderer/DOM/reader等はfixtureを使い、実loopback HTTPと実ブラウザ/native測定を区別する。

初回buildでstageの未解放照会とconnection型の接続不足を検出し、依存先stageを含めて補正した。
CLIの終了cleanupをclosureへ移した際のtimer型注釈も訂正した。
最初のhost6件の失敗はsandboxのlisten EPERMであり、許可されたloopback実行では既存7件が成功した。
途中結果を最終成功件数へ重複加算しない。最終結果と証跡はIssue #1008および`tmp/local-preview-cleanup-owner/`へ記録する。

受け入れ確認:

- [x] 解放失敗後もownerを保持し、明示再試行で失敗stepだけを解放する。通常操作・残存入力は閉じたまま。
- [x] 起動/通知とdisposeの競合、再入、独立した複合失敗、成功stepの非再実行を回帰で確認。
- [x] 初回追加17件・レビュー後の追加6件・再レビュー後の追加5件を含む関連13ファイル171件が成功。うち実loopback hostは12件。生成一致/能力markerの対象2件が成功（31件skip）。
- [x] build後の型検査、対象lint/format、diff空白検査が成功。3種のruntime bundleを再生成した。

初回の160件、前回の166件・#1050の147件、途中実行を上記171件へ重複加算しない。
レビュー後の初回型検査では、追加hostテストのclosure内代入を型推論が追跡できなかったため、
保持対象を型付きの状態オブジェクトへまとめて訂正した。最終の型検査は成功している。
再レビュー後の追加resetテストは、stage作成後のplatform callback差し替えが反映されないfixture設定により初回3件が失敗した。
stage作成前に失敗callbackを登録して訂正し、callback内代入を保持する値の型付けも補正した。最終の回帰・型検査は成功している。
verify:full・外部CI・実ブラウザ検証は実行しない。

[初回の結果と残務](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6395592329)、
[レビュー指摘3件の修正・追加6回帰の結果と残務](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6395989899)、
[通知送信失敗・reset同期再入の修正と追加5回帰の結果・残務](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6396157729)をIssue #1008へ追記済み。

## 残務・受け入れ境界

- factory/loaderがownerを返す前に失敗する全経路のcleanup handle引継ぎ。
  2026-10-25の[次段階のローカル修正](dsl-4-factory-cleanup-handoff.md)でNode/local-previewの接続境界を追加した。
  本書のPR #1052時点の結果と、その後の未公開差分を区別する。handleを返さない依存内部までの完了は推論しない。
- ネイティブReadableStreamがcancel失敗後に再度のcancelを内部へ伝えない場合など、返却handleだけでは再実行できない基盤資源。
- settleしないread/start/reset/release、資源release自体が親disposeをawaitする非協調callbackの強制終了。
- OS socket・watcher・GPU/decoder/AudioBuffer/RSSの実回収測定、失敗owner保持数の上限、budget/LRU長時間測定、画面全体の専用再試行導線。
- SIGKILL・page破棄等でJavaScript実行が停止した後のcleanup完了は保証しない。

Firefoxはメジャーリリース時のみ、Safari対象外。今回実ブラウザ/native回収測定は実行しない。
rollbackは今回のsource/test/設計書と必要な生成runtimeをまとめて戻す。npm・SB3・Pagesの公開や同版差し替えは行わない。
