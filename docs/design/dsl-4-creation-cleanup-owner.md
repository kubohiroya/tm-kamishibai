# DSL 4.0: owner成立前の失敗とcleanupの所有権

Issue [#1008](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008)の追加修正。
基準mainは`c187e895`（成立済みownerの修正を統合したPR #1027）。
本記録の差分は未コミット・未公開であり、公開済みrc.49/rc.50への反映を意味しない。
DSL版・依存版・idle保持予算0は変更せず、有効化スイッチも追加しない。

## 問題と受け渡し契約

prepare/factoryが正常な戻り値を返す前に失敗し、そのcleanupも失敗すると、
従来は例外の診断だけが残り、部分作成資源の再解放先が呼出元から失われた。
同期platform factoryでは非同期cleanupのrejectionも再試行経路へ公開していなかった。

`Dsl4CreationFailure`を`AggregateError`の派生として定義する。
`cause`は元の作成失敗、`errors`は作成失敗と確認済みcleanup診断、`cleanup`は部分ownerである。
部分ownerには次の3操作を持たせる。

| 操作                  | 意味                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------- |
| `completion`          | 開始済みの直近cleanup試行のPromise。未開始ならnull。再試行はしない                    |
| `hasPendingCleanup()` | 失敗・未確認・遅延資源が残るかの照会。再試行はしない                                  |
| `dispose(reason?)`    | 同時・同期再入は同じPromiseへ合流。失敗通知後の別の明示呼出しは未完了stepだけを再試行 |

`Dsl4CreationFailure`、`Dsl4CreationCleanup`、`createDsl4CreationCleanup`、
`getDsl4CreationCleanup`はDSL 4の公開moduleから利用できる。
注入factoryが別bundleの同じ契約を使う場合も、nameとcleanupのメソッド・completion型を確認して受け取る。
通常例外や契約外・照会不能の例外は部分ownerとして扱わず、元の例外を保持する。

同期factoryは同期のまま例外を投げ、cleanupをすぐ開始する。
非同期cleanupの結果は`cleanup.completion`に残す。未処理rejectionは抑止するが、
結果を成功に置き換えず、呼出元がそのPromiseから診断を取得できる。
同期に作った`errors`配列へ、後から発生した非同期診断が追記される契約ではない。
async factoryは初回cleanupを待ち、成功かつ遅延資源もなければ元の作成例外をそのまま返す。
失敗または遅延資源があれば部分ownerを持つ例外で返す。

## 親ownerへの合流と再試行

親が子の作成失敗を受けた最初のcleanupでは、子の開始済み`completion`へ合流する。
失敗を上位へ伝えるだけで子の`dispose()`を再呼出ししない。
他ownerのcleanupは子の失敗後も継続し、作成例外とcleanup診断の両方を残す。
後続の明示disposeだけが失敗stepを再試行する。

`createDsl4RetryableCleanup`でcallback実行前に進行中Promiseを登録するため、
cleanup callbackからの同期再入も同じ試行を共有する。callback自身が親の完了をawaitする循環は許容しない。
成功済みstepは再実行しない。任意の未解放照会がある子は、成功後でも遅延資源が残れば保持する。
照会が失敗した場合も未確認ownerとして保持し、他stepの解放を続ける。

## 接続した境界

- platform asset session: 返却前に記録したcomposition/backingを逆順に解放する。
  同期・非同期の失敗を部分ownerへ残し、同じ同期factory内で独立stepの解放を開始する。
- TM・SVG Text・Bubble: compositionを受け取った後の検証やstyle初期化が失敗した場合も、
  その`releaseAll`を部分ownerへ保持する。正常なadapterが返る前の穴を塞ぐ。
- TurboWarp environment: 注入factoryの部分owner、返却済みhost port候補、scene coordinator、
  各presentation/input port、asset sessionを解放対象として保持する。
- runtime startup: 不正environmentやnavigation作成のthrow/診断による拒否でもenvironmentを保持する。
  navigationの拒否診断は作成失敗のcauseに残す。
- publication asset prepare: groupとsessionの独立cleanupを部分ownerへ引き継ぐ。
- publication VM prepare: 隠れたstageのDOM設定・host作成・初回scene準備の失敗時も、
  既知のstage/hostと、注入factoryが返した部分ownerを保持する。

publication loaderは、正常な`Dsl4PreparedSegment.value`がまだなくても、例外の部分ownerを所有集合へ登録する。
失敗ownerはparsed documentのLRUやcurrentとは別に保持する。
候補prepare失敗ではcurrentを変えず、現在の章の実行状態・入力の所有権を維持する。

初回章で失敗したpublication factoryは、loaderとlayoutのcleanupを持つ例外を呼出元へ返す。
内部の`disposeAfterFailure(error)`は初回試行へ合流するための閉鎖操作で、
通常の明示`dispose()`による再試行と区別する。候補失敗時に現在のpublicationを閉じるためには使わない。
dispose要求がprepare中に先行した場合やcleanup callbackから再入した場合も、
後から判明した部分ownerの初回試行を同じdisposeへ合流させる。
成功したcleanupでもカメラ許可待ちなどがあれば保持し、遅延停止失敗を上位の明示disposeで再試行する。

## 検証と限界

回帰は同期/非同期factoryのcleanup失敗、失敗の継続と明示再試行、他stepの解放継続、
cleanup再入・同時dispose、prepare中のdispose、初回/候補章の失敗、未成立章の遅延カメラを扱う。
カメラ許可・停止、compositionの失敗、章VMは模擬である。
製品のloader、asset session、runtime startup、environment/host、camera lifecycleを使用するが、
物理カメラやnative GPU/decoder/RSS回収を測定した結果ではない。

残務は以下に限定せず、完了範囲と分けて追跡する。

- shell/previewなどさらに外側のownerとエラー受信後の保持・操作導線。
  今回は再試行可能な例外契約とpublicationへの接続であり、一般利用者向け再試行UIを追加していない。
- 資源もcleanup handleも返さず通常例外だけを投げる第三者factoryの内部資源。
  そのfactory自身の契約変更が必要で、呼出元だけでは回収できない。
- 下位KVSの作成途中IDB/OPFS、stream/writerなど、handleを公開していない依存内部の解放再試行。
- native GPU/decoder/RSS・物理ディスク回収の測定、応答しないprovider/prepareの強制終了。
  未回答要求や連続解放失敗で保持するowner数をidle LRU予算で制限する保証はない。

Issue #1008のClosed状態は維持し、結果と残務を追加コメントに記録する。
push・PR作成・merge・npm/SB3/Pages公開は行わない。
Firefoxはメジャーリリース時のみ、Safariは対象外。今回のブラウザ検証は行わない。
rollbackは本修正のsource・回帰・文書・3生成runtimeを一式で戻し、公開済み同版artifactは上書きしない。

## ローカル検証の完了記録

- blocked → resolved: 同期/非同期platform factoryとenvironmentの3回帰は、修正前にcleanup handle欠落で失敗した。
  修正後に成功し、下位から上位への合流・明示再試行・遅延owner・検証前候補の解放を追加確認した。
- 最終の関連15ファイル242件が成功。これとは別に3生成runtimeのsource一致・能力profileの2テストが成功し、計244件。
  後者は対象を選んだため31件をskipした。全体suiteの成功件数として数えない。
- build、型検査、変更TSのlint、対象format、diff空白検査が成功。
  3生成runtimeを再生成し、dist側のコピーもバイト一致。依存・公開版の変更はない。
- 中間の型検査はclosure内の絞り込み、補助テストはAggregateErrorの入れ子とfixtureの失敗位置の想定を補正して解消。
  最終実行で未処理エラーはない。全体verify:full・全体E2E・新しい実画面/実聴は行っていない。
- ローカル証跡: `tmp/creation-cleanup-owner/`。[Issue #1008の完了記録](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6385528361)へ結果と上記の残務を追記済み。

## レビュー2件の修正（2026-10-25追補）

前項とIssue #1008の10月24日の完了記録にある244件成功は、その時点の結果である。
レビューでは、成立済みSVG platformを含むenvironmentの作成失敗と、初回章commit失敗が不足していた。
既存8ファイル195件は成功したが、追加追試3条件が失敗した。
この2境界の明示再試行・初回cleanup合流まで検証済みとする記録は、次の修正・正式回帰で補正する。

### SVG platformの閉鎖と解放完了

SVG platformの`releaseAll()`は、通常操作を閉じることとcompositionの解放完了を分離する。
最初の要求で通常操作を閉じ、同期throw/非同期rejectを`createDsl4RetryableCleanup`へ保持する。
非同期の返り値も上位へ返すため、environmentの部分ownerがcleanup失敗を検出・保持できる。
同時呼出しとcomposition解放callbackからの同期再入は同じPromiseへ合流し、
失敗通知後の明示呼出しは実compositionへ再到達する。成功後はcompositionを再解放しない。
`hasPendingCleanup()`で未完了状態を照会でき、解放の再試行は行わない。

`setText`はactorの解決待ちから戻った後も閉鎖を確認する。
dispose開始前に受け付けた操作でも、解決待ち中に閉鎖された場合は新しいskinを作らない。
解放失敗後も通常操作は再開しない。

### 初回commit/取消しcleanupへの合流

prepareが値を返した後のcommit/取消し失敗も、既知のprepared ownerに対する初回release試行を
失敗例外と対応付ける。cleanup失敗は元の例外と併せてAggregateErrorへ保持し、
cleanup成功でも遅延ownerが残る場合は、その成功した初回試行を対応付ける。
文字列等の例外で対応付けが必要な場合はErrorのcauseへ元の値を保持する。
完全解放済みの場合は対応付けず、元の例外を維持する。

起動失敗処理の`disposeAfterFailure(error)`は、この対応付けを用いて初回試行へ合流する。
prepare例外の部分ownerと同様、呼出元へ失敗を通知する前の暗黙再試行を行わない。
その後の通常の`dispose()`だけが、残っているprepared ownerを再試行する。
既に登録されたownerを利用し、同じ資源を解放する別ownerを所有集合へ追加しない。
cleanup進行中のdispose・同期再入は、従来どおりcallback前に登録したrelease Promiseへ合流する。

### 正式回帰と公開範囲

- SVGの同期/非同期失敗の2条件を実environment作成失敗から確認する。
  初回失敗・明示再試行失敗・次の明示再試行成功と、他compositionの成功step非再実行を検証する。
- SVG単体の同期/非同期失敗2条件で、通常操作の閉鎖、再入・同時呼出しのPromise共有、成功後の非再実行を確認する。
  さらにactor解決待ち中のdisposeで新規skinを作らない1条件を追加した。
- 初回publication commit失敗2条件で、最初のcleanupへ合流して呼出元へhandleを返すこと、
  元のcommit失敗とcleanup診断の保持、再試行成功/継続失敗、成功済みstageの非再実行を確認する。
- loaderではcommit/取消し/文字列例外と、cleanup失敗/成功後の遅延ownerを組み合わせた6条件を追加した。
  失敗した初回試行だけでなく、成功した初回試行への合流も確認する。

最初の正式7条件は修正前にすべて失敗し、修正後に成功した。関連4ファイル152件が成功。
この追加修正も未コミット・未公開で、IssueのClosed状態を維持する。
上記のshell/preview・非公開の第三者factory内部資源・下位IDB/OPFS・native資源計測の残務は変わらない。
push・PR作成・merge・npm/SB3/Pages公開は行わず、Firefoxはメジャーリリース時のみ、Safari対象外を維持する。

今回の最終検証は関連4ファイル152件、compiled publication接続5件、
3生成runtimeのsource一致・能力profile2件、計159件が成功。
後者の31件は対象選択によるskipで、全件検証へ加算しない。
build・型検査・変更対象lint/format・diff空白検査が成功し、3生成runtimeとdist側コピーも同期した。
前回の244件へ重複加算せず、無変更部分は前回結果を利用する。全体verify:full・E2E・実画面/実聴は行っていない。
今回の証跡はローカル`tmp/creation-cleanup-owner/fix-review/`に保存する。

[Issue #1008のレビュー修正完了記録](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008#issuecomment-6389525493)へ結果と残務を追記済み。

## 公開準備と再レビュー（2026-10-25）

上記の未コミット・未公開という記述は、各検証時点の状態である。
ユーザーの明示承認を受け、本差分をcommit・push・PR化し、CI/レビュー確認後にSquash Mergeする手順へ進める。
merge結果はIssue #1008へ記録し、npm/SB3/Pagesの新規公開はこの手順へ含めない。

再レビューは追加指摘なし。関連157件と、非同期cleanupの待機中の同時呼出し・commit失敗cleanup中の
先行disposeを含む追加追試3条件が成功した。追加追試はローカル証跡へ保存し、正式テストと区別する。

最新main `f3a5db14`（rc.51準備・sealed password入力）を取り込み、同じ28ファイルの修正範囲を維持する。
競合したruntime hostのimportはsealed側とcleanup側の両方を保持し、生成runtime3種は統合後のsourceから再生成した。
sealed password入力・artifact、startup・host、publication・SVGの接続8ファイル188件と型検査が成功した。
それ以前の244件・159件等へ重複加算しない。依存版・配布物・公開済み同版artifactは差し替えない。
公開準備の証跡はローカル`tmp/creation-cleanup-owner/publish/`に保存する。

## shell / previewへの引き継ぎ（2026-10-25、ローカル追補）

Standard shell生成時のhost・タイトルDOMと、TurboWarp previewのnavigation/input初期化にも
creation cleanup契約を接続した。子の初回cleanupへ合流し、外側の失敗伝播で自動再試行しない。
返却済みの遅延preview sessionは、失敗した初期化ownerと遅延成立したsessionを保持する。
詳細・対象回帰・さらに外側の未対応ownerは[外側cleanup設計](dsl-4-outer-cleanup-owner.md)を参照。
本追補はmain `a96d7692`後の未コミット差分であり、#1033やrc.51の公開済み成果物の完了記録とは区別する。

### shell / previewレビュー2件の補正（2026-10-25）

起動直後disposeで未開始の表示resetを開始しないよう、初期化本体の先頭にも閉鎖判定を追加した。
loadingのcleanupはhideによる描画から分離し、app側interval・既知DOM・位置復元を独立追跡する。
描画例外と停止/DOM解放失敗の併発時も、通常操作を閉じたまま明示再試行する。
正常animationと開始済みreset待ちも回帰で維持する。
以前の172件・生成runtime2件の結果は本追補前の記録であり、
[追加5回帰と補正後の契約](dsl-4-outer-cleanup-owner.md#レビュー2件の修正2026-10-25ローカル追補)を参照。
上記はローカル検証時点の記録。その後、ユーザーの指示に基づくPRで統合し、CI・レビュー・merge結果はIssue #1008へ記録する。
