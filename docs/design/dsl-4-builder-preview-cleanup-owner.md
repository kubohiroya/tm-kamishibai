# DSL 4.0 builder shell・reload UIのcleanup所有権

関連: [Issue #1008](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008)。
2026-10-25、初回実装・再レビューはmain `c240ad9a`（[PR #1039](https://github.com/kubohiroya/turbowarp-kamishibai-app/pull/1039)）を前提とした。
branchは`codex/fix-builder-preview-cleanup-owner`。以下のローカル検証記録を経て、ユーザーの公開指示に基づきcommit・push・PR作成・CI/レビュー確認後のSquash Mergeへ進める。
既存Closed Issueの追加運用ログとして完了範囲と残務を記録する。公開済みrc.53/rc.55への反映を意味しない。
DSL版・機能スイッチ・依存package版は変更しない。

## 依存順と所有対象

| owner             | 今回の対象                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| reload policy     | acknowledgement timer、subscriber、進行中/予約済みreload、通知待ち、generation/diagnostic参照                                             |
| reload overlay    | policy/debug subscription、toolbarボタン、DOMとdocumentのlistener、pointer capture、root DOM                                              |
| reload surface    | policy/overlay、resize/orientation/fullscreen listener、ResizeObserver、driver/diagnostic/watch参照                                       |
| Development shell | candidate dialogのlistener、focus復元、root DOM、view参照                                                                                 |
| CLI shell         | Development shell、reload surface、root DOM                                                                                               |
| Web shell         | Development shell、coordinator、reload surface、返却済みasset pipeline、open listener、root DOM、source queueのsettleとproject/source参照 |

下位session・protocol/bridge/coordinator/source adapterの契約は
[Web Preview cleanup所有権](dsl-4-web-preview-cleanup-owner.md)を引き継ぐ。
返却済みasset pipelineを保持する変更から、pipeline/transaction/adapter内部すべての再試行が可能になったとは推論しない。

## 終了と明示再試行

最初のdispose要求で通常操作を閉じ、失敗後も閉じたままとする。snapshot取得・未解放照会・disposeは継続できる。
通知/DOM listenerは解除自体に失敗しても閉鎖後の入力を処理しない。
Web/CLIの委譲操作も入口で閉鎖を確認し、子の解放開始前に新しい操作を渡さない。
CLIの候補選択callbackも親の閉鎖を確認するため、rootのremoveからの再入でも章の再起動を指示しない。

`preview-owner-cleanup.ts`はsetup中に各解放stepを登録し、dispose開始後は登録を閉じる。
共通retryable cleanupで独立したstepを並行に開始し、失敗しても他stepを継続する。
失敗したstepと照会不能な子は保持し、失敗が確定した後の明示disposeで再試行する。
成功済みstepは繰り返さない。子の任意の`hasPendingCleanup()`を照会し、後から未解放が見つかった子も再試行できる。
照会例外でも通常の解放を試し、未知状態の確認を後の試行へ残す。

policy/surface/Web/CLI shellはsnapshotを返す公開Promiseを、子の解放callbackより前に登録する。
同時呼出と同期再入は同じPromiseへ合流し、試行中に自動で再試行しない。
overlayとDevelopment shellのdisposeも`Promise<void>`を返す。
通常の同期DOM/listener解除は呼出中に開始し、非同期失敗を含む成否は返されたPromiseをawaitして確認する。
両者を所有する上位shell/surfaceはそのPromiseをcleanupに接続する。

専用の再試行ボタンは追加しない。失敗原因を解消した後、呼出側が同じownerの`dispose()`を再度呼ぶ。
失敗Promiseの再awaitは新しい試行を始めない。

## 作成途中の失敗

DOM rootは属性設定・mountの前、listenerはaddEventListenerの前、ResizeObserverはobserveの前に解放を登録する。
返却された子はcontract検証の前に登録する。不正な戻り値でもdisposeを持つ子を捨てない。
setup/検証失敗時は既知の独立ownerの解放を開始し、`Dsl4CreationFailure.cleanup`へ所有権を渡す。
呼出側は`cleanup.completion`から初回の結果を確認し、その失敗が確定した後で`cleanup.dispose()`を明示再試行できる。
子factoryの`Dsl4CreationFailure`は初回completionへ合流し、同じ失敗を初回処理内で自動再試行しない。
cleanup handleを返さない第三者factory内部の未返却リソースは、この契約で所有したことにはならない。

## 進行中処理との競合

policyはdispose時に予約済みreloadの入口を閉じ、実行中driverのsettleを待つ。
遅いack/rejectやclock callbackからのdisposeでgeneration・success・diagnosticを復活させない。
acknowledgement timerの停止失敗後にcallbackが届いても、通知やtimer再設定を行わない。

通常はonState/subscriberの通知完了を待つが、終了要求で通知の完了待ちだけを解除する。
通知から同じpolicyのdisposeをawaitしても、通知とoperation queueの相互待ちを作らない。
通知Promiseのrejectは終了後もonErrorへ渡す。通知ごとの待機登録は通常完了時/終了時に削除する。
これはdriverやprovider自体の強制終了ではなく、driverのsettle待ちは継続する。

Web shellは子の解放を開始してからasset source queueのsettleを待つ。
source読込/更新のrejectは既存のonErrorへ渡し、cleanupの恒久的な失敗理由にはしない。
資源解放の失敗は子owner側の独立stepとして保持する。
終了後のsource/root/diagnostic通知を採用せず、poll/buildの各await境界でも閉鎖を確認する。
終了後のdistribution build stateは無効とし、新しいproject/source handleを返さない。

root通知はcoordinatorのsource adapterからの`onProjectRoot`だけに統一する。
shellの`start()`から同じ非同期root設定を別に起動しない。root observerの完了/失敗は、
coordinatorから返るstart Promiseの経路で呼出側が確認する。これによりhandshake→root通知→source開始の順序を保ち、
終了と競合したroot通知のrejectを未処理にしない。observer後の閉鎖検査で、終了後のsource処理や参照再保持を防ぐ。

asset pipelineにはsurface本体ではなく、候補・diagnostic・watch状態を渡す3メソッドの通知bridgeを貸す。
所有権とdisposeはshellだけが持つ。bridgeは親が閉じた後の新しい通知を転送しないため、
実pipeline/watchの正常な終了通知が並行終了中のsurfaceへ届いて操作エラーにならない。
surface本体とshellの公開操作は引き続き閉鎖検査を行う。
実際のcleanup失敗・onErrorは隠さず、独立した解放と失敗ownerの明示再試行を維持する。

候補の転送開始だけでなく、転送済みPromiseが終了と競合する境界もbridgeが扱う。
policy/surfaceの閉鎖検査と、実asset pipelineのreload driverの終了検査は、
`TypeError`の派生型`Dsl4PreviewReloadDisposedError`を返す。
型は副作用のない`preview-reload-cancellation.ts`で定義し、policy・surface・pipeline・借用bridgeで共有する。
親shellが閉じていて、この型で転送済み候補がrejectした場合だけ、借用bridgeは正常な終了取消しとして完了する。
親が開いている場合は同じ型でもrejectを維持し、public surface/shellの閉鎖後操作も引き続き拒否する。
メッセージ文字列・`TypeError`全般・`AbortError`・親のdisposedだけで失敗を捨てない。
driverのrejectは元の例外を維持し、不正なackは閉鎖検査に先立って検証するため、終了と重なっても真の失敗として残る。
この取消し処理は資源解放の成功を代替せず、cleanupの失敗owner保持・明示dispose再試行は従来どおり必要になる。

実pipelineのreload driverは開始時と`protocol.whenIdle()`完了直後に自身の閉鎖を確認する。
非同期staged observerが待機中に親を終了しても、閉じたpipelineからcommitを発行しない。
これはprotocolのdisconnect/stale/schema/capabilityエラーを一括して取消しへ変換する処理ではない。
待ち自体のreject、閉鎖していないpipelineのprotocol失敗、開始済みcommitの失敗・不正ackはそのまま失敗として残す。
commit開始後にdisposeされた場合は、既存のprotocol queueでcommit→disconnectの順にsettleさせる。
transactionがactivate失敗をfailed ackへ変換する既存契約も維持し、driverは未承認commitをonErrorへ渡す。

## 回帰と検証

初回の正式回帰は`test/dsl4-builder-preview-cleanup-owner.test.ts`の35件。

- timer停止失敗・同時呼出・同期再入、onState/subscriberからのdispose待ち、通知の通常待ちと終了後reject。
- 遅いdriver ack/reject・予約済み候補、実surfaceのdriver待ち、clock callbackでの終了。
- subscription/toolbarの同期・非同期失敗、pointer capture・listener・DOM失敗後の独立再試行と入力閉鎖。DOM解除でcaptureが自動解除された場合も確認。
- geometry listener/ResizeObserverの解放失敗、observe/add途中失敗、解除APIのないtargetを登録前に拒否。
- Development shellのfocus・listener・DOM解放失敗と操作閉鎖、部分登録時のcreation cleanup、focus復元からdisposeした後のchoice通知抑止。
- Web/CLIの同期・非同期子解放失敗、同期再入、戻り値検証失敗、子factory初回cleanup合流。
- coordinator/asset/surfaceの独立解放、子の照会例外と後から発生した未解放の再試行。
- 終了直後/進行中pollからのbuild抑止、遅いsource/rootの不採用、asset更新のresolve/rejectとcleanup失敗の分離。

関連12ファイル計153件を確認した。最終のpointer captureとfocus再入の補正後は影響する4ファイル61件を再実行し、残る8ファイル92件は直前の成功前提を維持した。build・型検査・対象lint/format・diff空白検査も成功した。
authoring runtimeを再生成し、production narrative/playback profileの同一性と生成一致・能力markerの対象2件も成功した。
[初回の結果と残務をIssue #1008へ記録済み](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6392290062)。初回21件中のfixture不備2件は訂正済みで、製品の入力検証は維持した。
途中の21/26/28件や146件は最終結果へ重複加算しない。
実ブラウザやnative回収の測定ではない。Firefoxはメジャーリリース時のみ、Safari対象外。今回はブラウザを起動しない。

## レビュー2件の補正（2026-10-25）

上記の初回35件・関連153件は当時の成功結果であり、startの重複root Promiseと、
実asset pipeline/surfaceの並行終了は検証していなかった。
追加レビューでは5条件中2条件が失敗し、未処理rejectionと正常終了時の不要なonErrorを再現した。
これらを前回の完了記録の対象外条件として補正する。

`test/dsl4-web-preview-shutdown-regression.test.ts`へ正式回帰10件を追加した。

- observer未指定でstart直後にdisposeし、呼出側がstart/disposeのPromiseを受け取るだけで未処理rejectionが残らないこと。
- observer待ち中の終了後にresolve/rejectする2条件。root通知は1回で、終了後のsource処理は0回。
- observerからのdispose、通常のroot準備失敗、通常の遅延observer完了。失敗はstartへ返し、正常なroot通知を重複させないこと。
- 実pipeline・実surfaceによる未起動/active/失敗surfaceの3条件。watch終了通知が実際に発生しても不要なonErrorは0件。
  activeではproviderを生成してgenerationを適用し、解放後のproviderCount=0とgeneration releaseを確認する。
  surface失敗後は同じownerの明示disposeで再試行し、成功した実pipelineは再実行しない。
- bridgeの通常時の3通知転送、終了後の通知遮断、真のcleanupエラーの保持と明示再試行。

今回の正式回帰は初回35件と追加10件の合計45件。影響する7ファイル76件、生成一致/能力markerの対象2件、
build後の型検査・対象lint/format・diff空白検査が成功した。前の153件へ単純加算した実行結果として報告しない。
初回の追加回帰ではactive fixtureにroot通知とcapability交渉が不足し、2回の実行で同じ1条件が失敗した。
製品のroot通知順序・capability gateを維持してfixtureを訂正し、10件の成功を確認した。
レビューの再現script2件もbuildしたdistで再実行し、未処理rejection/正常終了時onErrorはともに0件だった。
[今回の補正結果と残務をIssue #1008へ記録済み](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6393637732)。
残るasset pipeline内部の失敗owner再試行まで、このbridge修正で完了したとは推論しない。

## 転送済み候補の終了取消しの補正（2026-10-25）

前節の追加10件・関連76件は、終了後の新規通知とsettle済みgenerationの終了を確認した結果であり、
実pipelineのstaged通知時点ですでに転送された候補が終了する条件は含まれていなかった。
再レビューでこの条件を実pipeline/transaction/adapter・実surface/policyの組合せで再現し、
解放自体は成功しても正常な取消しがonErrorへ流れることを確認した。今回、上記の型付き取消しで補正する。

`test/dsl4-web-preview-shutdown-regression.test.ts`へ次の7件を追加した。

- 実pipelineの`preview.asset.staged`通知からdisposeする1件。候補転送済み（surface revision=1）、試行中のdispose合流、
  activate=0、rollback/release各1回、deferred通知、providerCount=0・pendingReleaseCount=0・未解放なし・不要なonError=0を確認する。
- 実surfaceの進行中applyが終了後に正常完了する1件と、Error・終了と同じ文言のTypeError・AbortErrorで失敗する3件。
  正常完了の取消しだけを吸収し、実際の失敗は同じ例外をonErrorへ渡し、successを復活させない。
- 親が開いたまま子surfaceだけが閉じた1件。型が一致してもbridgeはrejectを維持する。
- policy終了と重なって不正なackが返る1件。validation失敗を取消し型へ変換しない。

初回実行は既存10件＋新規6件の16件中11件が成功し、新規5件のテスト照合に不備があった。
snapshot内のpolicy位置と、終了済みの後続disposeではなく試行中の同じPromiseへ合流する契約に合わせて訂正した。
製品のcleanup契約は変更していない。その後、親が開いた条件1件を追加した最終17件が成功した。

最終検証は関連10ファイル106件（追加7件を含むshutdown17件、上位owner35件、policy6件、surface5件、overlay12件、
Web shell11件、実pipeline3件、browser component5件、local browser5件、adapter contract7件）が成功した。
buildしたdistで元のstaged競合再現scriptも成功し、errors=[]・providerCount=0・pendingReleaseCount=0・未解放なしだった。
runtime3種を再生成してauthoring bundleだけが変更され、production narrative/playbackはmain `c240ad9a`と同一。
生成一致/能力markerの対象2件（31件skip）、build後の型検査、対象lint/format、diff空白検査も成功した。
検証中、取消し型をpolicy経由でimportした初案はproduction bundleの初期化順まで変化させたため、
専用モジュールへ分離して再生成・再検証し、production同一性を維持した。
前節の76件や153件へ途中実行を重複加算しない。証跡は`tmp/builder-preview-cleanup-owner/transferred-candidate/`。
[結果と残務をIssue #1008へ追記済み](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6393820039)。
既存Closed状態を維持し、push・PR作成・merge・公開は行わない。
今回は実ブラウザ・native回収測定を行っていない。Firefoxはメジャーリリース時のみ、Safari対象外。

## protocol待ち中の終了取消しの補正（2026-10-25）

前節の106件・追加7件は同期staged通知からの終了を含むが、非同期通知中に実driverがprotocol待ちへ進んだ条件を含まない。
再レビューでは、staged observerで非同期処理を待ってからdisposeすると、切断後にdriverがcommitを続けて
`Asset protocol is disconnected`をonErrorへ流すことを、エラー注入なしで再現した。
解放自体は成功していたが、正常取消しの境界が不足していたため、上記のdriver入口/待ち直後の閉鎖検査で補正した。

正式回帰を次の6件追加した（同期stagedの既存1件は維持）。

- microtask待ち・setImmediate待ち・apply開始を観測して待つ3種類の非同期staged通知からdisposeする。
  最初の2条件は実pipeline/surfaceを差し替えず、3番目も実driverを観測wrapperで包むだけである。
  不要なonError=0、commit未開始/activate=0、rollback/release各1回、providerCount=0・pendingReleaseCount=0、
  dispose試行の合流、surfaceの候補参照とDOMの解放を確認する。通知内ではdisposeを要求し、その完了は外側でawaitする。
- 実pipelineのcommit-started通知からdisposeした後にactivateが失敗する1件。
  commit-failedイベントとonErrorを維持し、取消し型へ変換しないことを確認する。
- 単体pipelineの保持済みdriverを終了後に呼ぶ1件は専用取消し型で拒否し、
  閉鎖していないpipelineの候補をdeferした後に呼ぶ1件は真の「候補なし」失敗として呼出側へ返す。

最終検証はshutdown21件・実pipeline5件を含む関連10ファイル112件が成功した。
初回の対象2ファイル24件も成功し、途中失敗はない。前節の106件や途中実行を重複加算しない。
buildしたdistで、レビュー時の正常取消し再現3条件と、実activate失敗の追試1条件も全件成功した。
正式回帰112件へローカル追試を加算しない。
runtime3種を再生成してauthoring bundleだけが変更され、production narrative/playbackはmain `c240ad9a`と同一。
生成一致/能力markerの対象2件（31件skip）、build後の型検査・変更source/testのlint・対象format・diff空白検査も成功した。
最後にcommit未開始の照合を明示したshutdown21件も再実行して成功し、他9ファイルの成功前提は維持した。
前回からの上位builder差分を含め16ファイルを未コミットで保持し、npm・SB3・Pagesを公開しない。
取消し分類の追加から、asset pipeline/transaction/adapter内部のcleanup失敗owner再試行まで完了したとは推論しない。
証跡は`tmp/builder-preview-cleanup-owner/protocol-wait-cancellation/`。
[結果と残務をIssue #1008へ追記済み](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6394139263)。
既存Closed状態を維持し、Firefoxはメジャーリリース時のみ、Safari対象外とする。

## mainへの公開統合（2026-10-25）

ユーザーの公開指示に基づき、`codex/fix-builder-preview-cleanup-owner`からmainへ本差分を統合する。
各節の「未コミット・未公開」「push・PR作成・mergeを行わない」は、初回実装と各再レビュー時点の記録である。
公開前にrc.55の準備・公開記録を含むmain `5cb488c8`を取り込む。
重複した生成authoring runtimeは最新sourceから再生成し、production narrative/playbackは同mainとの同一性を確認する。
既存の関連112件・再レビュー72件と追試6条件を前提に、最新main取り込み後の対象検証とCI・レビューを確認してSquash Mergeする。
PR・merge SHA・最終の検証結果・残務はIssue #1008の公開統合ログに記録する。
この統合は公開済みrc.55のartifactを差し替えず、npm・SB3・Pagesの新規公開を含めない。

## 残務とrollback

- asset pipeline/transaction・browser asset adapter内部のcleanup失敗時の所有権・明示再試行。
- node watch/transport、local-preview host/browser wrapper等のさらに外側の終了境界と画面全体の再試行導線。
- cleanup handleを返さない第三者factory内部、下位KVS作成途中のIDB/OPFS・stream/writer、native GPU/decoder/RSSの回収測定。
- settleしないdriver/provider/factory/handshake等の強制終了、失敗owner保持数の上限、専用再試行UI。

rollbackは今回のsource/test/設計書/生成authoring runtimeを一式で戻す。
今回npm・SB3・Pagesを公開せず、公開済みartifactは差し替えない。
