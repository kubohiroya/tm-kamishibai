# TMPose紙芝居 機能拡張ガイド

Copyright © 2026 Hiroya Kubo. この文書は[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)で提供します。

<p class="extension-overview-kicker">全16ページ。15個の機能拡張を一覧し、2〜16ページで1つずつ詳しく見る</p>

`kamishibai=3.1`台本を動かす現行アプリは、次の15機能拡張を
`app/project.source.json`の順に読み込みます。名前を選ぶと、その拡張の解説ページへ移動します。

<nav class="extension-index-grid" aria-label="機能拡張一覧">
<a href="#extension-consoles"><strong>Consoles</strong><code>sipcconsole</code><span>実行状況をbrowser consoleへ記録</span></a>
<a href="#extension-temporary-variables"><strong>Temporary Variables</strong><code>lmsTempVars2</code><span>処理中の一時状態を共有・保持</span></a>
<a href="#extension-text-operators"><strong>Text</strong><code>strings</code><span>台本の文字列を検索・分割・整形</span></a>
<a href="#extension-asset-manager"><strong>Asset Manager</strong><code>kubohiroyaassetmanager</code><span>画像・音声・文字とLoadingを管理</span></a>
<a href="#extension-tmpose"><strong>TMPose</strong><code>tmpose</code><span>camera映像からポーズを認識</span></a>
<a href="#extension-local-storage"><strong>Local Storage</strong><code>localstorage</code><span>台本とUI言語をbrowserへ保存</span></a>
<a href="#extension-text-lines"><strong>Text Lines</strong><code>kubohiroyatextlines</code><span>台本を行単位のlistへ展開</span></a>
<a href="#extension-runtime-expression"><strong>Runtime Expression</strong><code>kubohiroyaruntimeexpression</code><span>分岐条件を安全に評価</span></a>
<a href="#extension-kamishibai-runtime"><strong>Kamishibai Runtime</strong><code>kubohiroyakamishibairuntime</code><span>台本を事前検査しSVG診断を表示</span></a>
<a href="#extension-async-input"><strong>Async Input</strong><code>kubohiroyaasyncinput</code><span>key・touch・pose入力を競合待機</span></a>
<a href="#extension-more-timers"><strong>More Timers</strong><code>lmsTimers</code><span>複数の名前付きtimerを計測</span></a>
<a href="#extension-files"><strong>Files</strong><code>files</code><span>端末からTXT台本を選択</span></a>
<a href="#extension-animated-text"><strong>Animated Text</strong><code>text</code><span>文字をstage上へ描画・演出</span></a>
<a href="#extension-translate"><strong>Translate</strong><code>translate</code><span>viewerの言語を取得</span></a>
<a href="#extension-web-link"><strong>Web Link</strong><code>kubohiroyaweblink</code><span>許可されたHTTPSリンクを開く</span></a>
</nav>

<p class="extension-overview-note">各ページは、役割、主要機能、このアプリでの利用、注意点、出典を同じ順で掲載します。Gallery拡張、SB3埋め込み拡張、project内拡張を含み、版と固定commitは2026年8月4日時点です。</p>

<p class="extension-source extension-overview-source">呼出し関係とLoadingを含むアセット読込は<a href="https://kubohiroya.github.io/tmpose-kamishibai/docs/general/07-internal-specification/">内部仕様書</a>、更新手順は<a href="https://kubohiroya.github.io/tmpose-kamishibai/docs/general/06-developer-guide/">メンテナンスガイド</a>、版ごとの差分は<a href="https://kubohiroya.github.io/tmpose-kamishibai/docs/general/history/"><code>history.md</code></a>を参照してください。</p>

DSLとアプリの版ごとの差分は[`history.md`](history.md)で確認できます。

## Consoles {#extension-consoles .extension-sheet}

<p class="extension-meta"><span>Gallery</span><code>sipcconsole</code><span>開発支援</span></p>

ブラウザーの開発者ツールへ、実行状況やエラーを種類別に出力する拡張です。画面上の利用者向け
メッセージとは分けて、開発者が台本解析や実行順を追跡するために使います。

<figure class="extension-flow"><figcaption>紙芝居アプリから開発者ツールまで</figcaption><div><span>台本解析・実行</span><b>→</b><span>log / error / debug</span><b>→</b><span>ブラウザーconsole</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>consoleの消去と通常ログの出力</li><li>information、warning、error、debugの出力</li><li>ログのgroup化と処理時間の計測</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li>開始時に古いconsoleを消去</li><li>command、asset、sceneの処理をjournalへ記録</li><li>台本や実行時の異常をerrorとして記録</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> consoleは通常のアプリ画面には表示されません。利用者へ示す台本エラーはKamishibai RuntimeのSVG診断を使います。</p>

<p class="extension-source">出典: <a href="https://extensions.turbowarp.org/">TurboWarp Extension Gallery</a>、<a href="https://github.com/TurboWarp/extensions/blob/9c0ae4f045dfb021cf329ea1ea6e595502c56a8a/extensions/-SIPC-/consoles.js">Consoles配布ソース</a></p>

## Temporary Variables {#extension-temporary-variables .extension-sheet}

<p class="extension-meta"><span>Gallery</span><code>lmsTempVars2</code><span>状態管理</span></p>

Scratch変数を増やさずに、実行中だけ存在する名前付きの値を保持する拡張です。1本の処理だけで
使うthread variableと、project全体で共有するruntime variableを使い分けられます。

<figure class="extension-flow"><figcaption>2種類の一時変数</figcaption><div><span>custom block呼出し</span><b>→</b><span>thread variable</span><b>／</b><span>runtime全体</span><b>→</b><span>runtime variable</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>thread単位の設定、加算、参照、存在確認</li><li>runtime全体の設定、加算、参照、削除</li><li>緑の旗と「すべてを止める」でruntime値を初期化</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li>scene、skip、pose、UIの共有状態をruntime変数に保存</li><li>台本1行の分解結果やloop indexをthread変数に保存</li><li>Runtime ExpressionとAsync Inputの値の受渡し</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> 永続保存には使えません。再起動後も残す台本とUI言語はLocal Storageへ保存します。</p>

<p class="extension-source">出典: <a href="https://extensions.turbowarp.org/">TurboWarp Extension Gallery</a>、<a href="https://github.com/TurboWarp/extensions/blob/9c0ae4f045dfb021cf329ea1ea6e595502c56a8a/extensions/Lily/TempVariables2.js">Temporary Variables配布ソース</a></p>

## Text {#extension-text-operators .extension-sheet}

<p class="extension-meta"><span>Gallery</span><code>strings</code><span>文字列処理</span></p>

文字の切り出し、検索、分割、置換、比較などを追加する演算拡張です。紙芝居アプリでは、
`key=value`形式の台本を小さなブロックの組合せで解析する基盤になります。

<figure class="extension-flow"><figcaption>台本1行をcommandへ変換</figcaption><div><span>asset=Hero,...</span><b>→</b><span>検索・分割・trim</span><b>→</b><span>key + value</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>部分文字列、文字数、位置の取得</li><li>区切り文字や正規表現による分割・置換</li><li>前方／後方一致、厳密比較、空白除去</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li>command名と引数の分離</li><li>asset addressやaction引数の整形</li><li>scene区切り、ラベル、比較式の補助解析</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> このページのTextは文字列演算の<code>strings</code>です。画面に文字を描くAnimated Textとは別の拡張です。</p>

<p class="extension-source">出典: <a href="https://extensions.turbowarp.org/">TurboWarp Extension Gallery</a>、<a href="https://github.com/TurboWarp/extensions/blob/9c0ae4f045dfb021cf329ea1ea6e595502c56a8a/extensions/text.js">Text配布ソース</a></p>

## Asset Manager {#extension-asset-manager .extension-sheet}

<p class="extension-meta"><span>埋め込み</span><code>kubohiroyaassetmanager</code><span>0.4.1</span></p>

Web上の画像・音声、SB3内のcostume・backdrop・sound、実行時テキストを1つの名前付き登録簿で
扱う拡張です。登録後は素材の置き場所を意識せず、同じasset名で表示・再生できます。

<figure class="extension-flow"><figcaption>公式ガイドの「名前付き登録簿」の図を再構成</figcaption><div><span>URL・project素材・text</span><b>→</b><span>名前付きasset登録簿</span><b>→</b><span>Stage・sprite・音声</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>外部素材の取得、IndexedDB cache、種類判定</li><li>画像・動的テキストの表示と音声再生</li><li>actorのloop／sequenceとLoading用assetの優先処理</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li>台本の全assetを登録し、Loading進捗を通知</li><li>Stage、Actor、prompt、menu、titleを描画</li><li>BGM、効果音、pose認識音を再生・停止</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> project内参照は<code>costume:Sprite:name</code>、<code>backdrop:name</code>、<code>sound:Sprite:name</code>を正確に指定します。外部URLの完了待ちはPromiseで行います。</p>

<p class="extension-source">出典: <a href="https://kubohiroya.github.io/turbowarp-asset-manager/ja/">Asset Manager図解ガイド</a>、<a href="https://github.com/kubohiroya/turbowarp-asset-manager/tree/c55e65787eed21d2e70b96a28dd6705d118f9995">固定commit c55e657</a></p>

## TMPose {#extension-tmpose .extension-sheet}

<p class="extension-meta"><span>埋め込み</span><code>tmpose</code><span>1.4.0</span></p>

Teachable Machine Poseモデルとカメラ映像を接続し、現在のポーズ名と信頼度をTurboWarpの値として
返す拡張です。プレビューの位置・透明度を設定し、認識の開始と停止を明示的に制御できます。

<figure class="extension-flow"><figcaption>公式ガイドの認識pipelineを再構成</figcaption><div><span>camera frame</span><b>→</b><span>Teachable Machine Pose</span><b>→</b><span>pose名 + confidence</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>model URLの設定と非同期load</li><li>camera、preview、predictionの独立した開始・停止</li><li>現在のpose、pose別confidence、計測時間、最新errorの取得</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li><code>TMPoseURL</code>からscene用modelを読み込む</li><li>指定poseが閾値を超えるまで認識を反復</li><li>skip、scene終了、stop時に認識とcameraを停止</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> camera権限とHTTPS環境が必要です。model本体とTensorFlow／Teachable Machine libraryの取得にはnetwork接続を使います。</p>

<p class="extension-source">出典: <a href="https://kubohiroya.github.io/turbowarp-tmpose/ja/">TMPose図解ガイド</a>、<a href="https://github.com/kubohiroya/turbowarp-tmpose/tree/08fe0cf9da061b1eba75297b8ee187d68549eed4">固定commit 08fe0cf</a></p>

## Local Storage {#extension-local-storage .extension-sheet}

<p class="extension-meta"><span>Gallery</span><code>localstorage</code><span>永続保存</span></p>

ブラウザーが提供する保存領域に、project固有のnamespaceで文字列を保持する拡張です。通常の
Scratch変数と異なり、ページを閉じて次回起動した後も値を読み戻せます。

<figure class="extension-flow"><figcaption>sessionをまたぐ保存</figcaption><div><span>台本・UI言語</span><b>→</b><span>project namespace</span><b>→</b><span>次回起動で読出し</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>名前付き値の保存、読出し、削除</li><li>projectごとのnamespace分離</li><li>別windowによる変更eventの検出</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li>最後に開いた外部台本を保存</li><li>利用者が選んだUI言語を保存</li><li>green flag後に保存値を読み、title／menuを再構成</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> 小さな設定やsave data向けです。同じprojectを複数tabで開く場合は、後から保存したwindowが値を上書きする可能性があります。</p>

<p class="extension-source">出典: <a href="https://extensions.turbowarp.org/local-storage">Local Storage公式ドキュメント</a>、<a href="https://github.com/TurboWarp/extensions/blob/9c0ae4f045dfb021cf329ea1ea6e595502c56a8a/extensions/local-storage.js">配布ソース</a></p>

## Text Lines {#extension-text-lines .extension-sheet}

<p class="extension-meta"><span>埋め込み</span><code>kubohiroyatextlines</code><span>0.1.1</span></p>

長いtextを改行位置で分割し、行数・指定行・Scratch listとして扱う拡張です。LF、CRLF、CRを
同じ改行として扱うため、台本を作成したOSに依存せず同じ行構造を得られます。

<figure class="extension-flow"><figcaption>公式ガイドの「1入力から3結果」の図を再構成</figcaption><div><span>複数行text</span><b>→</b><span>改行を正規化</span><b>→</b><span>行数・1行・list</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>改行規則を統一して行数を数える</li><li>1始まりの番号で指定行を取得</li><li>選択したScratch listを行の配列で置換</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li>runtime変数<code>script</code>を<code>lines</code> listへ展開</li><li>物理行を保ったままpreflightと実行へ渡す</li><li>台本エラーの行番号を元sourceへ対応付ける</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> list書込みブロックは既存項目へ追記せず、全項目を新しい行で置き換えます。</p>

<p class="extension-source">出典: <a href="https://kubohiroya.github.io/turbowarp-text-lines/ja/">Text Lines図解ガイド</a>、<a href="https://github.com/kubohiroya/turbowarp-text-lines/tree/8655d764cf3af0d783ba6f138086db927abd3570">固定commit 8655d76</a></p>

## Runtime Expression {#extension-runtime-expression .extension-sheet}

<p class="extension-meta"><span>埋め込み</span><code>kubohiroyaruntimeexpression</code><span>0.2.0</span></p>

Temporary Variablesのruntime変数を、JavaScriptに似た制限付き条件式から安全に参照し、
真偽値を返す拡張です。任意codeを実行せず、許可された比較・論理・算術だけを評価します。

<figure class="extension-flow"><figcaption>公式ガイドの条件評価flowを再構成</figcaption><div><span>runtime variables</span><b>→</b><span>制限付きparser</span><b>→</b><span>true / false</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>比較、論理、算術、括弧を使う条件式</li><li><code>vars["名前"]</code>による空白・日本語名の参照</li><li>構文だけを検証する副作用のないAPI</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li><code>registerBranch</code>の条件をscene移動時に評価</li><li>台本preflightで式の構文errorを検出</li><li>上から最初にtrueになったscene labelを選択</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> 代入、関数呼出し、propertyアクセス、任意JavaScriptは許可しません。Temporary Variablesを先に読み込みます。</p>

<p class="extension-source">出典: <a href="https://kubohiroya.github.io/turbowarp-runtime-expression/ja/">Runtime Expression図解ガイド</a>、<a href="https://github.com/kubohiroya/turbowarp-runtime-expression/tree/7e2bd99fa57fa9f0cbe6b91306b4c53322f00aa3">固定commit 7e2bd99</a></p>

## Kamishibai Runtime {#extension-kamishibai-runtime .extension-sheet}

<p class="extension-meta"><span>project内</span><code>kubohiroyakamishibairuntime</code><span>DSL診断</span></p>

紙芝居DSL 3.1を実行前に検査し、失敗時に分類済みの診断情報とSVG error画面を作る、このproject
専用の拡張です。正常な台本の実行はStageのcustom block群へ任せます。

<figure class="extension-flow"><figcaption>preflightから安全停止まで</figcaption><div><span>DSL source + project</span><b>→</b><span>version・command・参照検証</span><b>→</b><span>実行許可／SVG診断</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>version、command、action、scene参照の検証</li><li>Asset Manager addressと条件式syntaxの事前確認</li><li>code、行・列、該当sourceを含むSVG診断生成</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li><code>startStory</code>直後、assetやcameraの副作用前に実行</li><li>診断runtime変数へ構造化errorを保存</li><li>異常時にbackground workを止め、promptへSVGを表示</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> DSL parser／実行器の置換ではありません。preflightを通過した後のsceneとactionはSB3内のStageが実行します。</p>

<p class="extension-source">出典: <a href="https://kubohiroya.github.io/tmpose-kamishibai/docs/general/07-internal-specification/">紙芝居アプリ内部仕様書</a>、<a href="https://github.com/kubohiroya/tmpose-kamishibai/blob/96b1fe66e052f10da2938389f98fd15c95fcfdee/app/extensions/kubohiroyakamishibairuntime.js">Kamishibai Runtimeソース</a></p>

## Async Input {#extension-async-input .extension-sheet}

<p class="extension-meta"><span>埋め込み</span><code>kubohiroyaasyncinput</code><span>0.2.0</span></p>

key、sprite／actorのtouch、任意構成では蓄積poseを、Temporary Variablesのruntime変数更新と
broadcastへ接続する拡張です。入力を待つscriptを増やさず、どのscriptからも最新値を読めます。

<figure class="extension-flow"><figcaption>公式ガイドの入力binding図を再構成</figcaption><div><span>key・touch・pose</span><b>→</b><span>target所有listener</span><b>→</b><span>runtime変数 → broadcast</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>KeyboardEvent.codeによるkey binding</li><li>sprite／clone／actor名へのpointer binding</li><li>値の代入または算術更新後にmessageを送信</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li>物理keyからscene labelを選ぶ</li><li>画面上のActor touchからsceneを移動</li><li>cover、scene境界、stop時にlistenerを解除</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> runtime変数は先に初期化します。登録はtargetごとに所有され、target削除・緑の旗・stopで片付けられます。</p>

<p class="extension-source">出典: <a href="https://kubohiroya.github.io/turbowarp-async-input/ja/">Async Input図解ガイド</a>、<a href="https://github.com/kubohiroya/turbowarp-async-input/tree/3ecd7ff406b86fd957333ae4978cec118322ebd1">固定commit 3ecd7ff</a></p>

## More Timers {#extension-more-timers .extension-sheet}

<p class="extension-meta"><span>Gallery</span><code>lmsTimers</code><span>時間管理</span></p>

標準timerを1個だけでなく、文字列で名付けた複数のtimerとして並行管理する拡張です。開始・reset、
値の取得、pause、resume、削除をtimer名ごとに行えます。

<figure class="extension-flow"><figcaption>名前付きtimerのlife cycle</figcaption><div><span>start / reset</span><b>→</b><span>経過秒を読む</span><b>→</b><span>条件成立 → remove</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>複数timerの作成とreset</li><li>経過時間、pause状態、存在の取得</li><li>pause、resume、増減、全削除</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li><code>wait</code> actionの終了時刻を判定</li><li>glide、fade、brightness遷移の進捗を計算</li><li>action完了またはskip時にtimerを削除</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> actionごとに衝突しないtimer名を作り、正常終了とskipの両方で削除します。</p>

<p class="extension-source">出典: <a href="https://extensions.turbowarp.org/">TurboWarp Extension Gallery</a>、<a href="https://github.com/TurboWarp/extensions/blob/9c0ae4f045dfb021cf329ea1ea6e595502c56a8a/extensions/Lily/MoreTimers.js">More Timers配布ソース</a></p>

## Files {#extension-files .extension-sheet}

<p class="extension-meta"><span>Gallery</span><code>files</code><span>ファイル入力</span></p>

利用者が選択またはdrag & dropしたlocal fileを、textまたはdata URLとしてprojectへ渡す拡張です。
browserのfile pickerをTurboWarp Stage上の選択UIと組み合わせ、cancel時もscriptを終了できます。

<figure class="extension-flow"><figcaption>外部台本を開く経路</figcaption><div><span>click / drag & drop</span><b>→</b><span>file picker + FileReader</span><b>→</b><span>台本text</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>拡張子／MIME typeを指定したfile選択</li><li>textまたはdata URLとして読出し</li><li>download filename付きのfile保存</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li>title／menuの「ファイルを開く」から<code>.txt</code>を選択</li><li>選択結果をruntime変数<code>script</code>へ渡す</li><li>選択後にpreflightと通常のstory開始経路へ合流</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> file pickerは利用者操作から開始する必要があります。cancel時は空文字になり、保存済み台本を勝手に置き換えません。</p>

<p class="extension-source">出典: <a href="https://extensions.turbowarp.org/">TurboWarp Extension Gallery</a>、<a href="https://github.com/TurboWarp/extensions/blob/9c0ae4f045dfb021cf329ea1ea6e595502c56a8a/extensions/files.js">Files配布ソース</a></p>

## Animated Text {#extension-animated-text .extension-sheet}

<p class="extension-meta"><span>Gallery</span><code>text</code><span>文字描画</span></p>

spriteへ文字専用のrenderer skinを作り、font、色、幅、配置、outlineとanimationを設定する拡張です。
Scratch LabのAnimated Text実験と互換性のあるblockをTurboWarpで利用できます。

<figure class="extension-flow"><figcaption>文字列からStage上のskinまで</figcaption><div><span>本文 + style</span><b>→</b><span>Canvas text skin</span><b>→</b><span>spriteで表示・animate</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>文字列を折り返してsprite skinへ描画</li><li>font、color、幅、align、outlineの設定</li><li>typing、rainbow、zoom、shake等のanimation</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li>Asset Managerのruntime text assetの描画backend</li><li>title、menu、prompt、台本errorの文字表示</li><li>DSLの<code>action=text:</code>で指定animationを開始</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> 文字列演算のText（ID:<code>strings</code>）とは別です。renderer APIを使うためTurboWarp実行環境が必要です。</p>

<p class="extension-source">出典: <a href="https://extensions.turbowarp.org/">TurboWarp Extension Gallery</a>、<a href="https://github.com/TurboWarp/extensions/blob/9c0ae4f045dfb021cf329ea1ea6e595502c56a8a/extensions/lab/text.js">Animated Text配布ソース</a></p>

## Translate {#extension-translate .extension-sheet}

<p class="extension-meta"><span>TurboWarp標準</span><code>translate</code><span>表示言語</span></p>

Scratch／TurboWarpのTranslate拡張です。文章を指定言語へ翻訳するblockに加え、viewerがeditorで
選んでいる言語名を返すreporterを持ちます。このアプリでは後者だけを利用します。

<figure class="extension-flow"><figcaption>viewer言語を初期UIへ反映</figcaption><div><span>editorの表示言語</span><b>→</b><span>language reporter</span><b>→</b><span>English / 日本語UI</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>textを対応言語へ翻訳</li><li>viewerが選択中の表示言語を取得</li><li>localeに応じた言語menuを提供</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li>green flag時の既定UI言語を判定</li><li>保存済みUI言語がない場合だけ初期値として利用</li><li>app shellの英語／日本語文言を選択</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> 台本文やUI文言をnetwork翻訳していません。利用者が選べるUI言語はアプリ側で定義したEnglish／日本語です。</p>

<p class="extension-source">出典: <a href="https://github.com/TurboWarp/scratch-vm/blob/c4823421cb7c17d8d8a89878851ce1668c26a21f/src/extensions/scratch3_translate/index.js">固定scratch-vmのTranslate実装</a>、<a href="https://github.com/TurboWarp/scratch-vm/tree/c4823421cb7c17d8d8a89878851ce1668c26a21f">TurboWarp scratch-vm固定commit</a></p>

## Web Link {#extension-web-link .extension-sheet}

<p class="extension-meta"><span>project内</span><code>kubohiroyaweblink</code><span>外部navigation</span></p>

受け取ったHTTPS URLを検証し、新しいbrowser tabで開く、このproject専用の小さな拡張です。
任意schemeを許可せず、公式Webサイトへの明示的なnavigationだけをTurboWarp blockから実行します。

<figure class="extension-flow"><figcaption>安全な外部linkの経路</figcaption><div><span>公式site URL</span><b>→</b><span>HTTPS validation</span><b>→</b><span>noopener付きnew tab</span></div></figure>

<div class="extension-columns"><section><p class="extension-subhead">主な機能</p><ul><li>URLを絶対URLとしてparse</li><li>protocolが<code>https:</code>であることを検証</li><li><code>noopener,noreferrer</code>を付けてnew tabを開く</li></ul></section><section><p class="extension-subhead">このアプリでの利用</p><ul><li>titleの公式Webサイトbuttonから呼び出す</li><li>package metadataのhomepageをruntime変数経由で渡す</li><li>通常のscene actionからは呼び出さない</li></ul></section></div>

<p class="extension-note"><strong>注意:</strong> HTTP、file、javascriptなどHTTPS以外のURLはerrorにします。browserのpopup policyにより、利用者clickから実行します。</p>

<p class="extension-source">出典: <a href="https://kubohiroya.github.io/tmpose-kamishibai/docs/general/07-internal-specification/">紙芝居アプリ内部仕様書</a>、<a href="https://github.com/kubohiroya/tmpose-kamishibai/blob/96b1fe66e052f10da2938389f98fd15c95fcfdee/app/extensions/kubohiroyaweblink.js">Web Linkソース</a></p>
