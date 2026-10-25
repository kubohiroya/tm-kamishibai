# DSL 4.0 asset pipeline内部のcleanup所有権

関連: [Issue #1008](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008)。
2026-10-25、main `c287cbe0`（[PR #1045](https://github.com/kubohiroya/turbowarp-kamishibai-app/pull/1045)）を前提とするローカル追加実装。
branchは`codex/fix-asset-pipeline-cleanup-owner`。実装・再レビュー時点では未コミット・未公開で保持した。
その後のユーザー指示に基づき、最新mainへ取り込み、CI/レビュー確認後にSquash Mergeする。
公開統合の結果とmerge SHAはIssue #1008の追補へ記録し、既存Closed状態を維持する。
DSL版・機能スイッチ・依存package版・公開済みartifactを変更しない。

公開準備ではmain `a17bdf03`（rc.56公開記録まで）へ載せ直し、競合したauthoring bundleを再生成した。
production narrative/playbackはこのmainと同一であり、公開済みrc.56のartifactを差し替えない。

## 依存順と所有対象

| 層                     | 保持する資源/失敗                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| decoder validator      | 返却されたimage/audio decoderのrelease、検証失敗時のcleanup handle                                     |
| snapshot watch         | stable readのfirst/second、candidate/active、失敗した一時read、timer/AbortController、進行中readと通知 |
| browser asset adapter  | validator結果、providerのraw bytes/decoder、失敗readのcleanup handle、watch                            |
| asset transaction      | 返却済み/不正なprepared generation、rollback/release、factory失敗handle、旧generation、adapter         |
| asset protocol         | disconnect途中の候補deferと、既に閉じて未解放を保持するtransactionへの引継ぎ                           |
| browser asset pipeline | protocol disconnectとtransaction終了の独立step、失敗した子、進行中の通知                               |

上位shellとの接続は[builder cleanup設計](dsl-4-builder-preview-cleanup-owner.md)を引き継ぐ。
今回の追加は返却された資源と既存`Dsl4CreationFailure`のhandleを持つ失敗が対象である。
handleを返さない第三者factory内部の未返却資源まで所有できることを意味しない。

## 所有権と明示再試行

`asset-cleanup-owners.ts`は非同期read/prepare中に成立した資源を動的に登録する。
各資源の解放stepは既存のretryable/creation cleanup契約を使い、成功stepだけを完了にする。
release関数、decoder、prepared generation、providerのownerを失敗前に削除しない。
進行中/同期再入のreleaseは公開済みの同じPromiseへ合流する。
成功した資源は台帳から外し、失敗した資源はそのstepと例外を保持する。

`beginCleanupAttempt()`は、親から子へ同じ終了試行の境界を先に伝える内部接続である。
通常操作を開き直すAPIではなく、利用者の新しい操作・DSL構文・有効化スイッチを追加しない。
親disposeの時点で進行中だったrelease、またはその試行中に初めて行ったreleaseには合流し、
その失敗を同じ試行内で自動再試行しない。失敗確定後の次の明示disposeでのみ再試行する。

各ownerの最初のdispose要求で通常操作を閉じる。失敗後も閉じたままで、snapshot/未解放照会/disposeは継続できる。
公開dispose Promiseをabort・解放callbackより前に登録し、同時要求と同期再入を同じ試行へ合流させる。
独立stepの失敗でも他stepは継続する。子の未解放照会が例外を投げても解放を試し、未確認状態を保持する。
`hasPendingCleanup()`から上位shellまで未解放状態を接続する。
専用再試行UIは追加せず、呼出側が原因を解消して同じownerのdisposeを再度呼ぶ。

## read・decoder・provider

validatorはdecoder releaseを成功前に完了済みへしない。
検証が失敗した場合、cleanupが成功すれば元の検証例外を維持し、失敗すれば`Dsl4CreationFailure.cleanup`へ所有権を渡す。
上位readはその初回completionへ合流し、同じ失敗の場で再試行しない。

watchはstable readの両方の結果を受け取った時点で登録する。
second readや安定判定の失敗、stale generation、observer失敗でも一時資源を捨てない。
read由来の`Dsl4CreationFailure`は、first/secondの解放失敗と例外を集約する前に台帳へ登録する。
同じcleanup handleを重複登録せず、初回completionへ合流した後は明示disposeで再試行する。
解放失敗後も台帳へ残し、disposeの進行中read待ち後に遅れて成立した資源も確認する。
read/inspectがAbortSignalを無視しても、返却されるまでの待機と返却後の解放は継続する。
応答しないread/decoder自体を強制終了する機能ではない。

watchのtimer停止と資源解放は独立して行う。停止APIが失敗しても資源を解放し、
遅れて来たtimer callbackは閉鎖状態を確認してpollやtimer再登録を始めない。
旧候補のsupersede解放待ち後にも閉鎖/世代を再確認し、staleになったreadを回収する。
dispose後に候補を再代入したり、新しい候補通知を発行したりしない。

providerの通常読取はadapter閉鎖時とrelease開始時に拒否する。
raw bytesはrelease開始時に破棄し、decoder解放が失敗してもproviderのownerは残す。
provider mapから外すのはdecoder cleanup成功後である。
readの失敗時も、adapterの台帳と失敗handleから明示再試行できる。
watch解放・provider解放・root/source参照破棄は独立stepとし、成功済みdecoderを再解放しない。
`providerCount`と未解放状態は区別する。timerだけが失敗した場合はproviderCount=0でも未解放=trueになり得る。

## prepared generation・protocol・pipeline

transactionはprepareの戻り値を検証する前に、既知のrollback/releaseを所有する。
factory失敗handleの初回completionへ合流し、無効な戻り値/prepare失敗とcleanup失敗が重なっても保持する。
候補のrollback/release/provider破棄は別stepとし、成功したstepを後の再試行で繰り返さない。
cleanupを始めた候補はcommitできず、失敗した候補や旧generationは台帳に残る。
旧generationの解放失敗で、新しいcommit済みgenerationを巻き戻さない。

disposeは進行中prepareへabortを通知し、queueがsettleしてから遅い戻り値と失敗ownerを回収する。
終了後に成立したgenerationはactivateしない。直接transactionを終了した後にactivateが戻っても採用せず、rollback/releaseする。
adapter終了は独立して試し、通常操作は閉じたまま、成功済みadapter終了を繰り返さない。
transactionが閉じた後はproviderの最終解放をadapter.disposeが所有するため、古い候補へのdiscardを新たに発行しない。

pipelineは最初に同じ終了試行をtransaction→adapter→watchへ伝え、`stopPreparation()`で新規prepareを閉じ、
進行中prepareへabortを伝えてからprotocol.disconnectを開始する。
この先行停止はtransaction全体のdisposeとは分け、既にqueueへ入ったcommit/deferの順序と通知を維持する。
停止後にprepareが正常に返しても候補として採用せず、rollback/releaseする。
prepareが失敗handleを返す場合も初回cleanup失敗に合流し、後のdisposeへ保持する。真のAbortError等はonErrorへ残す。
開始済みprotocol処理は既存queueでsettleさせ、transaction終了はその後に進める。
disconnectの候補deferが失敗してもtransaction終了を継続する。
後のdisconnect再試行では、既に閉じて未解放を保持するtransactionへdeferを再送せず、接続参照を終了させる。
transactionの失敗ownerは子のdisposeへ残すため、この引継ぎで解放成功を仮定しない。
失敗したdisconnect/transactionのstepだけを、後のpipeline.disposeで再試行する。

## 通知と終了取消し

watch/transaction/pipelineの通知は通常時に完了待ちする。
終了要求はその通知待機だけを解除するため、staged通知から同じpipelineのdisposeをawaitしても相互待ちしない。
terminal通知は発行でき、通知Promiseの遅いrejectは既存onErrorへ渡す。
通知待ちの解除は、資源のrelease/prepare/activate自体の強制終了を意味しない。

#1045の親閉鎖＋専用取消し型の契約を維持し、エラー一般を握り潰さない。
真のactivate/rollback/release/adapter終了失敗は、返された操作Promise・disposeのreject・未解放状態に残す。

## 回帰と検証記録

`test/dsl4-asset-cleanup-owner.test.ts`の正式29件で次を検証する（初回23件＋再レビュー修正6件）。

- validatorの同期/非同期release失敗・再入合流、検証失敗時のcleanup handle引継ぎ。
- watchのactive資源解放失敗、timer停止失敗と古いcallback、second read失敗時のfirst解放、遅いread解放失敗の初回合流、observerからのdispose待ち。
- 実adapterのdecoder失敗とprovider保持、検証失敗handleの引継ぎ、timerだけ失敗した場合の成功済みdecoder非再実行。
- transactionのdefer rollback失敗、不正な戻り値、子の照会例外、旧generation失敗とcurrentの独立解放、遅いactivate、factory失敗handle、遅延prepareの正常/解放失敗とabort通知からの再入、通知待ちと遅いreject。
- 実pipelineでprotocol/transactionをまたぐ候補cleanup失敗の初回合流と後の明示再試行、staged通知内からのdispose完了待ち。
- 実Web shell/surfaceと実pipeline/transaction/adapterを接続し、generation解放失敗後にshell.disposeから明示再試行しても解放済みDOMを復活させないこと。coordinatorとDOMはfixtureを使用し、実ブラウザ検証とは区別する。
- 再レビュー追加6件: second readの失敗handleとfirst cleanup失敗の同時保持・明示再試行、旧候補解放待ち中のdispose（stale read解放成功/失敗の2件）、実pipeline経由の協調prepare中断（遅いgeneration解放成功/失敗の2件）、中断後のfactory失敗handleと初回cleanup合流・明示再試行・真のAbortErrorの可視性。

既存transaction回帰は、永久にrollbackが失敗してもdisposeが成功するという旧期待を訂正した。
新契約では未解放を保持してrejectし、原因を解消した後の明示disposeで成功することを確認する。
初回の既存52件はこの旧期待1件が失敗した。新規18件の初回はtimer callback漏れ1件、
通知後のdispose完了待ちが不足するfixture2件を検出し、製品/fixtureを区別して訂正した。
新規fixtureのParseResultの型絞込みも訂正した。
これらの途中失敗を最終成功結果へ加算せず、Issueのblockedログと完了記録を照合する。

初回完了時は正式23件を含む関連14ファイル141件が成功した。
その後のレビューで、複合失敗時のhandle喪失、pipeline経由のprepare abort未到達、終了後の候補復活の3件を検出した。
追加した最初の5条件が修正前にすべて失敗することを確認した。
最初のpipeline修正でtransaction全体のdisposeを先行させたところ、既存のdefer通知4件とactivation失敗の扱い1件が失敗した。
prepare停止のみ先行する構成へ訂正し、既存テストの期待を緩めずに解消した。さらにfactory失敗handleの1件を追加した。
再レビュー修正後の最終検証は、正式29件を含む関連14ファイル147件が成功した。
runtime3種を再生成し、変更はauthoring bundleのみ。production narrative/playbackはmain `c287cbe0`と同一である。
生成一致/能力markerの対象2件（31件skip）、build後の型検査、対象lint/format、diff空白検査も成功した。
従来の#1045の112件や今回の途中実行を最終結果へ重複加算しない。
証跡は`tmp/asset-pipeline-cleanup-owner/`へ保存する。
[結果と残務をIssue #1008へ追記済み](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6394702803)。
このリンクは初回完了記録であり、今回の3件の修正と147件の結果は[再レビュー修正の完了記録](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6395059159)へ追補済み。

## 残務とrollback

- node watch/transport・local-preview host/browser wrapperの返却済みownerの保持/再試行は、[次のローカル追補](dsl-4-local-preview-cleanup-owner.md)で接続する。これは#1050や公開済みartifactには含まれない。さらに外側の未返却ownerと画面全体の専用再試行導線は残る。
- cleanup handleを返さない第三者factory/inspector内部の未返却資源、下位KVS作成途中のIDB/OPFS・stream/writer。
- native GPU/decoder/AudioBuffer/RSSの実回収測定。資源callbackの成功/参照破棄を、ブラウザ/OSの実回収と同一視しない。
- settleしないread/prepare/activate/releaseや、資源release自体が自分の親disposeをawaitする非協調callbackの強制終了。
- 失敗owner保持数の上限、継続的失敗を含む長時間のbudget/LRU運用測定、専用cleanup再試行UI。

今回の内部所有権の接続を、上記すべての境界/実測の完了へ拡張しない。
Firefoxはメジャーリリース時のみ、Safari対象外。今回は実ブラウザ/native測定を追加しない。
rollbackは今回のsource/test/設計書/生成runtimeを一式で戻す。npm・SB3・Pagesを公開せず、公開済み同版artifactは差し替えない。
