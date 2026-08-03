# TMPose紙芝居 アプリ・教材・ツールチェインガイド

Copyright © 2026 Hiroya Kubo. この文書は[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)で提供します。

<p class="application-guide-kicker">アプリ、物語、体験会教材、DSL、SB3開発を8ページでつなぐ</p>

<p class="application-page-label">1 / 8　アプリ概要</p>

TMPose紙芝居（tmpose-kamishibai）は、TurboWarpで作られた紙芝居にcamera映像を重ね、
参加者のポーズやkey・touch入力で物語を進める「参加型」AI紙芝居アプリです。
作品はテキストの`kamishibai=3.1`台本として記述し、絵・音・動き・分岐を組み合わせます。

<figure class="application-hero"><img src="../images/image60.png" alt="参加型AI紙芝居 Version 3.1と表示されたTMPose紙芝居のタイトル画面"><figcaption>同じアプリに台本と素材を読み込むことで、異なる物語を上演できます。</figcaption></figure>

<div class="application-value-grid"><section><strong>見る</strong><span>絵・台詞・音・animationで物語を伝える</span></section><section><strong>動く</strong><span>cameraの前でポーズを取り、登場人物へ働きかける</span></section><section><strong>作る</strong><span>台本と素材を差し替え、自分たちの作品へ育てる</span></section></div>

<p class="application-callout"><strong>中心となる考え:</strong> AIはポーズを認識し、programは判定結果を物語のsceneへ接続します。参加者自身の動きが、次の場面を開く入力になります。</p>

<p class="application-source">出典: <a href="https://kubohiroya.github.io/tmpose-kamishibai/">TMPose紙芝居 公式サイト</a>、<a href="https://github.com/kubohiroya/tmpose-kamishibai">tmpose-kamishibai README</a></p>

## 一つの台本を四つの形で届ける {#application-delivery .application-sheet .unnumbered}

<p class="application-page-label">2 / 8　アプリ概要</p>

アプリ本体は汎用のSB3です。作品固有の`kamishibai=3.1`台本とassetを読み込み、
事前検査、Loading、scene実行、入力待ち、画面更新を共通の流れで扱います。

<figure class="application-flow"><figcaption>作品から上演まで</figcaption><div><span>台本・画像・音声</span><b>→</b><span>preflight検査</span><b>→</b><span>asset登録・Loading</span><b>→</b><span>scene実行</span></div></figure>

<div class="application-columns"><section><p class="application-subhead">共通runtime</p><ul><li>Asset Managerがlocal素材とURL素材を名前で管理</li><li>Kamishibai Runtimeが実行前に台本を検査</li><li>TMPoseとAsync Inputが入力をscene遷移へ渡す</li><li>不正な台本は行番号付きSVG診断として画面表示</li></ul></section><section><p class="application-subhead">四つの成果物</p><dl><dt><code>generic</code></dt><dd>起動後に台本を選ぶ汎用版</dd><dt><code>editor</code></dt><dd>TurboWarpで編集できる版</dd><dt><code>player</code></dt><dd>作品を埋め込んだ実行専用版</dd><dt>Web版</dt><dd>browserから直接開く公開版</dd></dl></section></div>

<p class="application-callout"><strong>設計上の利点:</strong> 物語を替えてもruntimeを作り直す必要がありません。作品と実行基盤を分離するため、体験会では素材と台本の編集に集中できます。</p>

<p class="application-source">出典: <a href="03-user-guide.md">操作説明書</a>、<a href="07-internal-specification.md">内部仕様書</a>。過去版との差分は<a href="history.md"><code>history.md</code></a>を参照してください。</p>

## 浦島太郎を「参加する物語」にする {#urashima-experience .application-sheet .unnumbered}

<p class="application-page-label">3 / 8　浦島太郎による具体例</p>

公開サンプル「浦島太郎」では、観客がcameraの前で物語に合うポーズを取り、
主人公や登場人物の行動に参加します。画面の「ポーズをとろう！」が、見る時間から動く時間への合図です。

<figure class="application-hero application-urashima-hero"><img src="../images/image01.png" alt="カメラ映像に浦島太郎とカメを重ね、ポーズをとろう！と表示しているTMPose紙芝居のアプリ画面"><figcaption>camera映像、背景、Actor、認識UIを同じstage上へ重ねた上演画面。</figcaption></figure>

<div class="application-storyline"><span>カメを助ける</span><b>→</b><span>カメに乗る</span><b>→</b><span>竜宮城で踊る</span><b>→</b><span>玉手箱を開く</span><b>→</b><span>結末を演じる</span></div>

<p class="application-callout"><strong>具体例の役割:</strong> 昔話の順序は保ちながら、要所をpose入力に置き換えます。物語を知っている人にも、アプリが「何を認識し、何を変えるか」が伝わります。</p>

<p class="application-source">出典: <a href="https://kubohiroya.github.io/tmpose-kamishibai-samples/stories/urashima/">浦島太郎 公開サンプル</a>、<a href="https://kubohiroya.github.io/tmpose-kamishibai/">TMPose紙芝居 公式サイト</a></p>

## ポーズをsceneの出来事へ変換する {#urashima-script .application-sheet .unnumbered}

<p class="application-page-label">4 / 8　浦島太郎による具体例</p>

台本は、表示する素材、待つ入力、次のsceneを順に宣言します。TMPoseの認識結果は
単なる分類名ではなく、story runtimeが待っている入力eventとして扱われます。

<figure class="application-flow"><figcaption>参加者の動きが物語へ届くまで</figcaption><div><span>身体のポーズ</span><b>→</b><span>TMPoseで分類</span><b>→</b><span>Async Inputで待機</span><b>→</b><span>scene actionを再開</span></div></figure>

<div class="application-columns"><section><p class="application-subhead">台本側の指定</p><pre><code>kamishibai=3.1\nsceneLabel=ride-turtle\nTMPoseURL=https://…/model.json\naction=pose:ride,0.8\naction=scene:dragon-palace</code></pre><p>scene、pose名、信頼度、遷移先を作品の言葉で記述します。</p></section><section><p class="application-subhead">runtime側の処理</p><ol><li>sceneの背景とActorを表示</li><li>指定modelを読み込んで認識開始</li><li>poseが閾値を超えるまで待機</li><li>認識を止め、次のactionへ進む</li><li>skip時も同じ終了処理で片付ける</li></ol></section></div>

<p class="application-callout"><strong>演出の要点:</strong> 一つのposeを長く待つ場面では、promptや効果音で「今何をすればよいか」を伝えます。key・touch入力も併設できるため、会場条件に合わせた代替操作を用意できます。</p>

<p class="application-source">出典: <a href="https://kubohiroya.github.io/tmpose-kamishibai-samples/stories/urashima/urashima.txt">浦島太郎 台本</a>、<a href="04-dsl-manual.md">紙芝居DSLファイル作成マニュアル</a></p>

## 体験会教材が結ぶ三つの技術 {#workshop-concepts .application-sheet .unnumbered}

<p class="application-page-label">5 / 8　体験会教材説明</p>

2026年8月1日版の親子AIプログラミング体験会は、画像生成AI、ポーズ認識AI、
AIではないprogramを一つの作品へ組み合わせます。何を人が決め、どこをAIが助け、
どこをprogramが確実に実行するかを、制作と上演の両方から学ぶ教材です。

<figure class="application-workshop-overview"><img src="../images/image10.png" alt="参加型AI紙芝居を構成する画像生成AI、ポーズ認識AI、プログラムの役割を7段階で説明する体験会教材"><figcaption>教材の全体図。考える・描く・登録する・ポーズする・認識する・結果を渡す・物語が動く、を一枚で示します。</figcaption></figure>

<div class="application-value-grid"><section><strong>人</strong><span>物語、絵、使うpose、台本の順序を考える</span></section><section><strong>AI</strong><span>画像を生成し、camera映像のposeを分類する</span></section><section><strong>program</strong><span>assetを表示し、判定結果どおりにsceneを進める</span></section></div>

<p class="application-source">出典: <a href="../workshops/2026-08-01/tmpose-kamishibai-20260801.md">親子AIプログラミング体験会教材 2026年8月1日版</a></p>

## 絵から上演までを一周する {#workshop-cycle .application-sheet .unnumbered}

<p class="application-page-label">6 / 8　体験会教材説明</p>

教材は完成品を眺めるだけではなく、下絵、画像生成、認識training、TurboWarpへの登録、
台本編集、上演testまでを一つの制作cycleとして体験させます。

<div class="application-image-grid"><figure><img src="../images/image11.png" alt="片手を上げて片膝を曲げた棒人間のポーズ下絵"><figcaption>考える・描く</figcaption></figure><figure><img src="../images/image25.png" alt="棒人間の下絵をもとに乙姫のポーズ画像を生成する画面"><figcaption>画像をつくる</figcaption></figure><figure><img src="../images/tmpose-training.png" alt="TMPoseのトレーニング進捗画面"><figcaption>ポーズを学習する</figcaption></figure><figure><img src="../images/turbowarp-costumes.png" alt="TurboWarpにPrincessとpose画像をcostumeとして登録した画面"><figcaption>costumeへ登録する</figcaption></figure></div>

<div class="application-cycle"><span>poseを設計</span><b>→</b><span>人物画像を生成</span><b>→</b><span>認識modelをtraining</span><b>→</b><span>台本とassetを編集</span><b>→</b><span>上演して改善</span></div>

<p class="application-callout"><strong>教材としての狙い:</strong> 入力画像、training data、判定閾値、台本の指定を変えると結果も変わります。うまく動かない理由を一つずつ切り分けること自体が、AIとprogramの違いを理解する学習になります。</p>

<p class="application-source">出典: <a href="../workshops/2026-08-01/tmpose-kamishibai-20260801.md">体験会参加者用教材</a>、<a href="../workshops/2026-08-01/tmpose-kamishibai-staff-20260801.md">体験会スタッフ向け資料</a></p>

## 紙芝居DSL 3.1が物語をデータにする {#dsl-31 .application-sheet .unnumbered}

<p class="application-page-label">7 / 8　DSL 3.1説明</p>

紙芝居DSL 3.1は、一行を`command=value`として記述する人間可読の台本形式です。
画像や音声をasset名へ登録し、sceneごとにActor、text、入力、分岐、transitionを並べます。

<div class="application-columns"><section><p class="application-subhead">宣言するもの</p><ul><li><code>asset</code>: URLやSB3内costume・sound</li><li><code>sceneLabel</code>: 分岐先を表すscene名</li><li><code>actor</code>: 表示位置、costume、animation</li><li><code>action</code>: text、pose、入力待ち、遷移</li><li><code>registerBranch</code>: runtime変数による条件分岐</li></ul></section><section><p class="application-subhead">3.1の実行pipeline</p><ol><li>versionとcommand構造をpreflight</li><li>参照先・address・条件式を検査</li><li>Loading用assetを先に登録</li><li>通常assetを登録して進捗表示</li><li>sceneとactionを順に実行</li></ol></section></div>

<pre class="application-code"><code>kamishibai=3.1\nasset=Hero,costume:Actor:hero1\nsetLoadingBackdrop=loadingBackground\nsceneLabel=start\nactor=Hero,0,-80,100\ntext=ui.prompt:Pose!\naction=pose:rescue,0.8\ntransition=fadeToWhite</code></pre>

<p class="application-callout"><strong>安全な失敗:</strong> 不明command、存在しないasset、壊れた条件式は、cameraや音声を開始する前に検出します。問題のcode、行・列、source抜粋をSVG文字で示し、台本を実行しません。</p>

<p class="application-source">出典: <a href="04-dsl-manual.md">DSL作成マニュアル</a>、<a href="05-command-reference.md">コマンドリファレンス</a>。2.0からの変更は<a href="history.md"><code>history.md</code></a>を参照してください。</p>

## sb3-toolchainがSB3を検証可能なsourceへ変える {#sb3-toolchain .application-sheet .unnumbered}

<p class="application-page-label">8 / 8　sb3-toolchain説明</p>

`@kubohiroya/sb3-toolchain`は、binary ZIPであるSB3をGitで差分確認できるsourceへ展開し、
検証済みの同一入力から決定的なSB3を再構築するNode.js toolchainです。このrepositoryでは
検証したcommitを開発時依存へ固定し、local開発とCIの両方で同じtoolchainを使います。

<figure class="application-flow application-toolchain-flow"><figcaption>このrepositoryでのsource-of-truth</figcaption><div><span>TurboWarpで編集したSB3</span><b>→</b><span><code>pnpm sb3:import</code></span><b>→</b><span><code>app/</code>の展開source</span><b>→</b><span><code>check</code>・test・build</span><b>→</b><span>配布SB3</span></div></figure>

<div class="application-columns"><section><p class="application-subhead">日常のworkflow</p><dl><dt><code>pnpm sb3:check</code></dt><dd>asset参照、hash、拡張mappingをoffline検証</dd><dt><code>pnpm sb3:build</code></dt><dd>固定順・timestamp・圧縮でSB3を再生成</dd><dt><code>pnpm sb3:extensions:status</code></dt><dd>上流拡張の更新候補だけを確認</dd></dl></section><section><p class="application-subhead">機能拡張の管理</p><ul><li>commitとSHA-256で埋め込みJSの由来を固定</li><li><code>sync</code>は固定commitから復元</li><li><code>update</code>は更新をtransactionとして適用</li><li>複数拡張のbundleは任意設定で、元JSとIDを保持したまま一つのpermission単位にできる</li></ul></section></div>

<p class="application-callout"><strong>再現性の境界:</strong> release build中にnetwork依存の<code>sync</code>や<code>update</code>を暗黙実行しません。更新は別のreview可能な変更として行い、固定sourceをcommitしてからbuildします。</p>

<p class="application-source">出典: <a href="https://github.com/kubohiroya/sb3-toolchain/tree/2c82aaf02f605564f79efe8ff3bbd8f1a78d6fe9">sb3-toolchain 固定commit 2c82aaf</a>、<a href="https://github.com/kubohiroya/sb3-toolchain/blob/2c82aaf02f605564f79efe8ff3bbd8f1a78d6fe9/docs/workflows.md">推奨workflow</a>、<a href="https://github.com/kubohiroya/sb3-toolchain/blob/2c82aaf02f605564f79efe8ff3bbd8f1a78d6fe9/docs/source-format-v1.md">展開source形式</a></p>

DSLとアプリの版ごとの差分は[`history.md`](history.md)を参照してください。
