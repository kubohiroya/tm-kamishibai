# DSL 4.0 shell / previewのcleanup所有権

関連: [Issue #1008](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008)。
2026-10-25、main `a96d7692`を前提とするローカル追加実装。
branchは`codex/fix-outer-cleanup-owner`。初回実装・レビュー時点ではローカル差分として保持した。
その後、ユーザーの指示に基づき本差分をPRでmainへ統合する。CI・レビュー・merge結果はIssue #1008へ記録する。
今回のmain統合にnpm/SB3/Pagesの新規公開は含めず、公開済みrc.51に含まれるという記録ではない。

## 今回接続したowner

| 境界                      | 失敗後の保持と再試行                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Standard app shell        | host・progress・loading・title・pose mountを独立stepとして解放。失敗stepを保持し、次の明示`dispose()`で再試行               |
| Standard shell生成失敗    | 戻り値検証前に返されたhostを保持。タイトル構築も生成guard内に置き、失敗時は`Dsl4CreationFailure.cleanup`へ移譲              |
| タイトル                  | mount・style変更・listener登録の前にcleanupを登録。失敗したlistener解除・DOM除去・位置復元を追跡                            |
| progress表示              | DOMとcursor style・dataset・mount位置を別stepとして解放。失敗したDOM参照を捨てず、操作は初回disposeから閉じる               |
| loading表示               | app側がintervalを保持し、停止・upstream/既知root解放・mount位置復元を独立stepで追跡。描画更新に依存せず明示再試行           |
| 成立済みTurboWarp preview | navigation sessionとenvironmentを別stepとして追跡し、子の`hasPendingCleanup()`も引き継ぐ                                    |
| 遅延preview session       | 初期化Promiseをcallback実行前に登録。dispose中に後から成立したsessionも、公開済みのcleanup試行が回収                        |
| preview初期化失敗         | 環境生成・navigation生成/拒否・input接続での失敗をcreation cleanup契約に接続。遅延wrapperも失敗ownerを保持                  |
| navigation / keymap input | sessionを先に閉じてinput・controller・履歴を独立解放。inputも解除失敗前に通常入力を閉じ、部分的なlistener登録のtargetを保持 |

## 呼出契約

`dispose()`の要求後は通常操作へ戻らない。shellのタイトルボタン・公開操作、previewの起動・action・変数操作、
残ったinput listenerによる実行を閉じる。cleanupの失敗は終了操作の失敗であり、再起動の許可ではない。

同時呼出・子callbackからの再入は、同じ進行中Promiseへ合流する。shellは従来のsnapshot返却を維持するため、
公開Promiseも子cleanupを呼ぶ前に登録する。失敗が確定した後の新しい明示`dispose()`を再試行として扱う。
成功済みstepは繰り返さず、未解放状態の照会で遅延資源が見つかった子だけ再登録する。
照会例外も未解放として保持し、他のstepの解放を続ける。

生成失敗では、[owner成立前cleanup契約](dsl-4-creation-cleanup-owner.md)に従い、
親は子の初回`completion`へ合流する。失敗伝播を理由に子を即座に再disposeしない。
呼出側は例外を`getDsl4CreationCleanup(error)`で読み、`cleanup.dispose()`で明示再試行できる。
遅延previewは返却済みsession自身からも再試行できる。初期化中に要求されたdisposeは子の初回cleanupへ合流し、その失敗を返す。
初期化失敗が確定した後の明示disposeは、保持した子のcleanupを再試行する。

初期化中disposeは、応答のある初期化処理がsettleするまで待つ。成立したsessionを先に記録してから
通常操作を拒否するため、遅延したownerを失わない。応答しないproviderの強制終了は行わない。

loading adapterは固定依存`@kubohiroya/turbowarp-app-shell@0.3.1`の「dispose開始時に閉じる」契約を補う。
描画を行う`hide()`はcleanupから呼ばない。upstreamへ渡すframeは先頭の1枚までとし、内部intervalを
作成させず、app側がanimationのinterval handle・frame列・indexを所有する。frame要素は
公開された`attributes.frame`へ付けた`data-dsl4-loading-frame`から取得する。
通常のtickはframeだけを更新し、backdropを書き換えない。再設定/非表示化で古いintervalを停止する。

初回disposeで描画操作を閉じ、frame列を外す。停止に失敗してintervalが残ってもcallbackは描画しない。
interval停止・upstream/既知root解放・元のmount位置復元は別stepであり、停止失敗でもDOM除去・位置復元を続ける。
handleは停止成功後だけ外し、失敗が確定した後の明示disposeで再試行する。成功済みの独立stepは繰り返さない。
upstream dispose開始後のDOM除去・位置復元の失敗も、保持したrootと元の位置から回収する。
依存更新時にはframe要素の取得、正常animation、描画/停止/DOM失敗の回帰を実行する。

## 検証範囲

`test/dsl4-outer-cleanup-owner.test.ts`と`test/dsl4-turbowarp-runtime-host.test.ts`に追加回帰を置く。
同期/非同期host失敗、同時/同期再入、失敗したタイトルDOMの保持と操作閉鎖、生成途中のlistener登録失敗、
child初回cleanup合流、遅延子owner、progressの独立解放、loadingのtimer停止失敗とDOM除去失敗を検証する。
previewは成立済み・factory失敗・input接続失敗・初期化中dispose・input解除失敗で、成功済みposeの
非再実行、未解放media/inputの明示再試行、失敗後の入力閉鎖を確認する。

これらは製品moduleとDOM/composition doubleを接続した回帰であり、物理GPU/decoder/RSSや
実カメラ・実スピーカーの回収測定ではない。ブラウザ実画面・実聴の追加結果には数えない。
初回実装では追加17件を含む関連11ファイル172件、生成runtime一致・能力profileの対象2件が成功した。
これはレビュー追補の修正前の記録であり、下記の新しい5回帰を含まない。
全体verifyや全体E2Eは実行していない。
詳細ログは`tmp/outer-cleanup-owner/`、完了記録はIssueの運用ログへ残す。
Firefoxはメジャーリリース時のみ、Safari対象外。今回ブラウザは起動しない。

## レビュー2件の修正（2026-10-25、ローカル追補）

- previewは初期化本体の開始時にもdisposedを検査する。同一tickの`start()`→`dispose()`では
  resetを開始せず、共有stageへ副作用を出さない。reset開始後にもdisposed判定を維持する。
  既存の開始済みreset待ち回帰は、callbackが実際に開始した合図を待ってからdisposeし、
  reset完了までdisposeが待機することを確認する条件へ補強した。
- loadingは停止のために`hide()`を使っていたため、frameの描画setter例外で解放が止まった。
  上記のinterval所有へ変更し、描画に依存しないcleanupと独立した失敗stepの再試行へ修正した。
  描画例外のみ／timer停止失敗併発／DOM除去失敗併発の3条件、通常のframe切替・更新・非表示化、
  起動直後disposeの計5回帰を追加。timer停止失敗時の同期再入も既存回帰へ追加した。
- 修正前は不具合の4条件（直後disposeと描画失敗3条件）が失敗することを確認した。
  補正後は追加5件を含む関連11ファイル177件、再生成runtime3種の一致/能力profileの対象2件が成功した。
  build・型検査・対象lint/format・diff空白検査も成功。以前の172件へ重複加算しない。
  Issue #1008へ結果を追記し、以前の完了記録の対象外条件であったことも明記する。

## 残務とrollback

- 初回実装後のWeb Preview残務のうち、live-reload session・protocol/bridge/coordinator・source adapterはPR #1039で統合済み。builder shell・reload surface/overlay/policyは[次のローカル追加実装](dsl-4-builder-preview-cleanup-owner.md)で対応する。asset pipeline/adapter内部、さらに外側のwrapperと画面全体の再試行導線は残る。
- cleanup handleを返さずに失敗する第三者factory内部（loading presenter自身の生成途中を含む）は、返却前の資源をアプリから回収できない。下位owner側で契約を整える必要がある。
- 下位KVSの作成途中IDB/OPFS・stream/writer、native資源回収の測定、応答しないprepareの強制終了、連続失敗owner数の上限は従来どおり残る。
- 通常の終了APIが再試行契約を返す境界を整えた段階であり、専用の「cleanup再試行」画面ボタンは追加していない。

rollbackは今回のsource・test・設計書・生成runtimeを一式で戻す。
DSL版・機能スイッチ・依存package版・公開済み同版artifactを変更しない。

## 公開・統合時の検証前提（2026-10-25）

修正後の再レビューは追加指摘なし。対象2ファイル97件の再実行と追加追試5条件が成功した。
追加追試は通常setLoadingのsrc例外、tickのdisplay例外、位置復元失敗後の再試行、
通常interval置換のclearIntervalからdisposeへ再入、start/action予約直後のdisposeを確認した。
この5条件はローカル追試であり、正式回帰177件へ加算しない。
生成runtime3種は前回の生成一致/能力profile2件を検証したハッシュと一致した。
最新mainの取り込みで前提が変わる箇所だけを追加検証し、結果をIssue #1008へ追記する。

## Web Preview側の追補（2026-10-25）

次のローカル追加実装では、live-reload sessionのruntime/factory失敗owner、source protocol portの接続、
protocol/bridge/coordinatorとsource timer/listenerの終了契約を依存順に接続した。
詳細と残るbuilder shell/reload surface・asset pipeline等の境界は
[Web Preview cleanup所有権](dsl-4-web-preview-cleanup-owner.md)を参照する。
この追補は初回実装・レビュー時には未コミット・未公開であり、前節の#1036のmain統合済み範囲やrc.53の公開記録と区別する。
その後、ユーザーの指示に基づきWeb Preview側の追補をPR #1039でmain `c240ad9a`へ統合し、結果をIssue #1008へ記録済み。

Web Preview追補の追加レビューで見つかった通知待ち・終了直後操作・終了通知再入・遅延resumeの4件も、
同じローカル差分で補正した。初回の114件にはこれらの条件を含まず、補正後の結果と区別してIssue #1008へ記録する。

上位builder shell・reload surface/overlay/policyの追加対応は
[builder cleanup所有権](dsl-4-builder-preview-cleanup-owner.md)を参照する。この追加差分は未コミット・未公開で保持し、前節の統合済み範囲とは区別する。

上位builder側のレビュー2件（startの重複root通知、並行終了時のasset→surface通知）も同じローカル差分で補正した。
完了範囲と追加回帰は[builder cleanup設計書](dsl-4-builder-preview-cleanup-owner.md)を参照する。
転送済みasset候補のstaged通知とdisposeの競合も同設計書で補正する。
終了取消しの専用型と親の閉鎖を照合し、正常取消しと真のapply/ack/cleanup失敗を区別する。
この追加差分も未コミット・未公開であり、asset pipeline内部全体の解放再試行を完了したことにはならない。
非同期staged通知で実driverがprotocol待ちへ進んだ後の終了も、pipeline側の待ち直後の閉鎖検査へ接続した。
正常取消しと真のactivate/protocol失敗の区別を含む追加6件・関連112件の結果は同じbuilder設計書を参照する。
上位builder追補の未公開状態は各実装/レビュー時点の記録であり、その後のユーザー指示による公開統合は同設計書へ記録する。

次のローカル追加では、decoder/watchからbrowser asset adapter・transaction・pipelineまでの内部cleanup所有権と明示再試行を接続した。
契約・回帰・残務は[asset pipeline内部のcleanup所有権](dsl-4-asset-pipeline-cleanup-owner.md)を参照する。
この追加は#1045統合済み範囲や公開済みrc.55に含まれず、外側wrapper/第三者factory/native回収等の残務とは区別する。
