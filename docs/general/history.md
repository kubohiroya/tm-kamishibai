# 紙芝居DSL 2.0から3.1への変更履歴

Copyright © 2026 Hiroya Kubo. この文書は[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)で提供します。

対象DSL: `kamishibai=2.0` → `kamishibai=3.1`\
文書化日: 2026年7月27日

この文書は、2.0向けの旧ドキュメントと3.1の現行仕様を比較し、台本作者・教材作成者・開発者が把握すべき差分をまとめたものです。中間バージョンごとの導入時期は区別せず、2.0から3.1までの累積差分として記載します。

## 次期リリース

タイトル画面の日本語／英語テキストを、ロケール別backdropではなくAsset Managerの実行時テキスト資産として表示する構成へ変更しました。言語変更時は同じtitle用spriteを更新し、`Title-en`は使用しません。

SB3読込直後からAsset Managerの初期化完了までは、英語固定の`Title` backdropと公式Webサイトボタンをフォールバック表示します。初期化完了後は文字なしの`TitleRuntime`へ切り替えるため、Asset Managerの初期化に失敗してもタイトル画面が空になりません。

## 3.1.6リリース

3.1.6では、Title画面へパッケージversionとビルド日を自動的に埋め込み、公式Webサイトへの導線、ライセンス、開発者情報を整理しました。アプリ固有のOpen、Reload、About、LanguageとTitle／About画面は、Scratch／TurboWarp標準の表示言語を初期値として日本語と英語を切り替えられます。Languageメニューで選んだ言語は保存され、次回起動時に優先されます。

矢印キーでシーンやactionをスキップした場合も、フェード、画像、移動など状態を持つactionは最終状態を反映してから次へ進みます。別のactionで開始したBGMは、無関係な待機actionをスキップしても継続します。

ポーズ認識の待機率を表すランタイム変数`poseIdle`の既定値は、不要な待機を挟まない`0`へ変更しました。

## 3.1.5リリース

3.1.5では、`setPoseRecognitionSound=認識中の音,認識成立時の音`のように、ポーズ認識中の音に加えて認識成立時の音を指定できるようにしました。2つ目の音はランタイム変数`poseRecognitionSound2`へ保存され、ポーズが成立したときにScratch変数「ポーズ認識」を更新する直前に再生されます。

2つ目の音を省略する従来の書式も引き続き利用できます。その場合は`poseRecognitionSound2`を削除し、前の台本の設定を持ち越しません。

## 3.1.4リリース

3.1.4では、アセット読込中の背景を指定する`setLoadingBackdrop`と、ポーズ認識中の効果音を指定する`setPoseRecognitionSound`を追加しました。Loading背景を省略した場合は組み込みの真っ黒な背景を表示し、アセット読込中にタイトル画面を残しません。

ポーズ認識音はAsset Managerへ登録した音声アセットを使います。認識開始時に再生し、認識成功またはスキップで停止します。台本を切り替えたときは設定をリセットし、次の台本へ効果音を持ち越しません。generic SB3に残っていた未使用の`Actor/pop`と`Loading/Chirp`は本番成果物から削除し、テスト専用fixtureへ移しました。

## 変更の概要

2.0は、シーンを先頭から順番に再生し、背景、登場人物、セリフ、音、移動、ポーズ認識を組み合わせる構成でした。

3.1では、この基本機能を維持しながら、次の機能を追加・拡張しました。

| 分類 | 2.0 | 3.1 |
|---|---|---|
| バージョン宣言 | `kamishibai=2.0` | `kamishibai=3.1` |
| アセット | 外部URLと明示的なプロジェクト内アセット | 短縮指定、`backdrop`、テキストアセットを追加 |
| シーン進行 | 原則として記述順 | ラベル、条件、キー入力、タッチ入力による遷移を追加 |
| 状態管理 | DSLから利用する明示的な仕組みなし | ランタイム変数を追加 |
| 画面効果 | 背景の即時切り替え | フェードアウト／フェードアップを追加 |
| アニメーション | スキンの個別切り替え | 画像・音のループ／一回再生を追加 |
| 画面上の文字 | 吹き出し中心 | テキストアセットの表示・時系列更新と、ポーズ案内の台本定義を追加。アプリUIは日本語／英語を選択可能 |
| アセット読込表示 | 固定のHatching画像（旧データ上は`Hatchling`） | `Loading`へ改名し、優先読込する複数画像と通常アセットだけの進捗表示を追加 |
| アクター表示 | スキン、位置、サイズをすべて指定 | スキン省略形、スキンとサイズの同時変更を追加 |

## 追加したトップレベルコマンド

### `setRuntimeVariable`

```text
setRuntimeVariable=変数名:値
```

Temporary Variablesのランタイム変数を台本から設定できるようにしました。開始シーンを指定する予約変数 `startSceneIndex` や、条件分岐で参照する状態の初期化に使います。

```text
setRuntimeVariable=startSceneIndex:1
setRuntimeVariable=takeSeaRoute:true
```

### `registerBranch`

```text
registerBranch=分岐名:条件1,条件2,...:シーンラベル1,シーンラベル2,...
```

Runtime Expressionで評価する条件と移動先を登録できるようにしました。条件は左から順に評価され、最初に真になった条件と同じ位置のシーンラベルが選ばれます。

```text
registerBranch=chooseRoute:takeSeaRoute,true:ocean,home
```

### `sceneLabel`

```text
sceneLabel=シーンラベル
```

シーンへ一意の名前を付けられるようにしました。条件分岐、キー入力、タッチ入力の移動先として使います。

### scene 0の`text`

```text
text=ui.prompt:ポーズをとろう！
```

ポーズ案内を台本から定義できるようにしました。`ui.prompt`はランタイムが自動登録する予約済みテキストアセットです。物語開始時に既定値へ戻してからscene 0の定義を適用するため、前に実行した台本の文言は残りません。

ファイル読込、再読込、タイトル表示、言語選択、台本エラーとタイトル画面はアプリ側の日本語／英語定義から表示します。初回は標準の`（言語）`ブロックで判定し、メニューから選んだ言語はlocalStorageへ保存します。過去の資料に記載されていた`text=ui.open:`、`text=ui.reload:`、`text=ui.about:`、`text=ui.invalidScript:`は、台本読込前のUIには適用できないため現行仕様から除外しました。

シーン直下の`text=テキストアセット名:文字列`も互換性のため利用できますが、アクション列より先に処理されます。時系列に沿ったテキスト更新には、次節の`action=text:...`を使用します。

### `setLoadingBackdrop`

```text
setLoadingBackdrop=loadingBackground
```

アセット読込中のステージ背景を指定できるようにしました。指定背景を最初に読み込み、完了直後に表示します。Loading用背景は進捗の分子・分母から除外されます。省略時は組み込みの真っ黒な背景を表示し、タイトル画面をLoading中に残しません。

### `setLoadingCostume`

```text
setLoadingCostume=loading1,loading2,loading3
```

アセット読込中に表示する画像アセットを複数指定できるようにしました。指定アセットを通常アセットより先に読み込み、通常アセットの読込番号に応じて循環表示します。吹き出しの`完了数 / 総数`からLoading用アセット自身は除外します。省略した台本は組み込みのLoadingコスチュームを使います。

### `setPoseRecognitionSound`

```text
setPoseRecognitionSound=Clock Ticking
```

ポーズ認識開始から終了まで鳴らす音声アセットを台本から指定できるようにしました。省略時は無音です。generic SB3に残っていた未使用の`Actor/pop`と`Loading/Chirp`は本番成果物から削除し、テスト専用fixtureへ移しました。

## 追加したアクション

### グローバルアクション

| アクション | 用途 |
|---|---|
| `action=transition:fadeOut` | ステージを段階的に暗くする |
| `action=transition:fadeUp` | ステージを段階的に明るくする |
| `action=transition:reset` | ステージの明るさ効果を標準値へ戻す |
| `action=transition:fadeToWhite` | ステージを段階的に白くし、白飛び状態を保持する |
| `action=transition:fadeFromWhite` | 白飛び状態からステージの明るさを標準値へ戻す |
| `action=text:テキストアセット名:文字列` | アクション列のその位置でテキストを更新する |
| `action=branch:分岐名` | 登録済みの条件を評価して別シーンへ移動する |
| `action=keyInputToChangeScene:キー一覧:ラベル一覧` | 物理キーの入力先に応じて別シーンへ移動する |
| `action=touchInputToChangeScene:アクター一覧:ラベル一覧` | アクターへのポインター／タッチ入力に応じて別シーンへ移動する |

キー入力とタッチ入力はバックグラウンドで待機します。入力項目と移動先ラベルは、同じ個数を同じ順番で指定します。

### アクターアクション

| アクション | 用途 |
|---|---|
| `action=アクター名:loop:アセット一覧:秒数一覧` | 画像・音声アセットをバックグラウンドで繰り返す |
| `action=アクター名:sequence:アセット一覧:秒数一覧` | 画像・音声アセットをバックグラウンドで一回だけ順番に再生する |

`loop`はアセット数と秒数の個数をそろえます。`sequence`の秒数はアセット数より1つ少なくします。どちらも待ち時間に `0` を使うことで、画像と音などを同時に開始できます。

## 変更・拡張した既存仕様

### アセット識別子

3.1では、プロジェクト内アセットを短く指定できるようにし、ステージ背景の識別子を `backdrop` に統一しました。また、ランタイムテキストをアセットとして扱えるようにしました。

| 種類 | 2.0の代表的な書式 | 3.1の書式 |
|---|---|---|
| 外部画像・外部音声 | `asset=名前,https://...` | 変更なし |
| コスチューム | `asset=名前,costume:スプライト:コスチューム` | 従来形に加え、`costume`、`costume:スプライト` を追加 |
| ステージ背景 | `asset=名前,background:背景` | `backdrop` または `backdrop:背景` |
| スプライトの音 | `asset=名前,sound:スプライト:音` | 従来形を継続 |
| ステージの音 | `asset=名前,sound:@stage:音` | 従来形に加え、`sound` を追加 |
| テキスト | なし | `text` または `text:テキスト名` |

短縮指定では、アセット名と同名のコスチューム、背景、音、テキストを参照します。

### `show`

従来の書式に加え、スキン名を省略して初期スキンまたは現在のスキンを使えるようにしました。

```text
# 2.0から継続する書式
action=Hero:show:Hero-normal:0,-60,30

# 3.1で追加した省略形
action=Hero:show:0,-60,30
```

### `setSkin`

スキン切り替えと同時にサイズを変更できる書式を追加しました。

```text
action=Hero:setSkin:Hero-surprised:45
```

### シーンの実行モデル

2.0の記述順による進行を維持しつつ、3.1では次の仕組みで任意のシーンへ移動できるようにしました。

- `startSceneIndex`による開始シーン指定
- `sceneLabel`による移動先の命名
- `registerBranch`と`branch`による条件分岐
- `keyInputToChangeScene`によるキー入力分岐
- `touchInputToChangeScene`によるタッチ入力分岐

## 廃止・置換した記法

| 2.0の記法 | 3.1での扱い |
|---|---|
| `kamishibai=2.0` | `kamishibai=3.1`へ変更する |
| `asset=Beach,background:beach` | `asset=Beach,backdrop:beach`へ変更する |
| `action=Actor:setCostume:costume1` | 3.1のリファレンス対象外。コスチュームを`asset`で登録し、`setSkin`で切り替える |
| コメントだけで表したシーン名 | 遷移先にする場合は`sceneLabel`を追加する |

`actor`、`cover`、`TMPoseURL`、`stage`、`wait`、`bgm`、`sound`、`hide`、`say`、`think`、`setScale`、`setPosition`、`moveTo`、`setLayer`、`pose`の基本的な役割は3.1でも継続しています。

## 移行例

### バージョン2.0

```text
kamishibai=2.0
asset=Beach,background:beach
asset=Hero,costume:Hero:normal
asset=Opening,sound:@stage:opening
actor=Hero,Hero
cover=Beach,Opening
---
# scene 1
action=stage:Beach
action=Hero:show:Hero:0,-60,30
action=Hero:say:こんにちは！:2
```

### バージョン3.1

```text
kamishibai=3.1
setRuntimeVariable=startSceneIndex:1
setRuntimeVariable=takeSeaRoute:true
registerBranch=chooseRoute:takeSeaRoute,true:ocean,home
asset=Beach,backdrop
asset=Ocean,backdrop
asset=Home,backdrop
asset=Hero,costume
asset=Opening,sound
asset=Narration,text
asset=loading1,https://example.com/loading1.png
asset=loading2,https://example.com/loading2.png
setLoadingCostume=loading1,loading2
text=ui.prompt:ポーズをとろう！
actor=Hero,Hero
actor=Narration,Narration
cover=Beach,Opening
---
sceneLabel=opening
action=transition:fadeOut
action=stage:Beach
action=transition:fadeUp
action=Hero:show:0,-60,30
action=Narration:show:Narration:0,120,100
action=text:Narration:どちらへ進みますか？
action=Hero:say:こんにちは！:2
action=branch:chooseRoute
---
sceneLabel=ocean
action=stage:Ocean
---
sceneLabel=home
action=stage:Home
```

## バージョン2.0台本の移行チェックリスト

- [ ] 先頭を`kamishibai=3.1`へ変更した
- [ ] `background:`を`backdrop:`へ変更した
- [ ] プロジェクト内アセットの参照先が存在することを確認した
- [ ] `setLoadingCostume`を使う場合、指定名がすべて画像の`asset=`として定義されている
- [ ] `setCostume`を使っている箇所を`asset`と`setSkin`へ置き換えた
- [ ] 必要なシーンへ重複しない`sceneLabel`を付けた
- [ ] `startSceneIndex`の既定値`1`を確認し、別の開始シーンが必要な場合だけ設定した
- [ ] 必要に応じてscene 0の`text=ui.prompt`でポーズ案内を定義した
- [ ] シーン内の時系列テキスト更新を`action=text:...`で記述した
- [ ] 分岐の条件数と移動先ラベル数をそろえた
- [ ] キー／タッチ入力の項目数と移動先ラベル数をそろえた
- [ ] すべての分岐先ラベルが存在することを確認した
- [ ] 3.1対応アプリで先頭から全経路を再生確認した

## 一般ドキュメントで修正した範囲

3.1への更新では、DSL仕様だけでなく、一般ドキュメント全体の説明も次のように修正しました。

| 文書 | 主な修正内容 |
|---|---|
| `03-user-guide.md` | 3.1の分岐、入力、フェード、アニメーション、テキスト、Loading表示、用途別成果物、アプリUIの言語選択を追加 |
| `04-dsl-manual.md` | 3.1のファイル構造、全追加コマンド、Loading設定、scene 0のポーズ案内、時系列テキスト、移行・テスト手順を追加 |
| `05-command-reference.md` | アセット識別子、トップレベルコマンド、Loadingの優先読込と進捗、グローバル／アクターアクション、予約ポーズ案内、エラー例を更新 |
| `01-executive-summary-adult.md` | 3.1の機能、状態管理、分岐、Loading表示、用途別成果物を利用者向けの説明へ反映 |
| `02-executive-summary-kids.md` | アニメーション、文字表示、分かれ道、Loadingの数字、Web版とSB3の使い分けをやさしい説明で追加 |
| `06-developer-guide.md` | Asset Manager、Loadingの実行順、Temporary Variables、Runtime Expression、Async Input、用途別成果物と公開構成を整理 |

詳細な書式は`04-dsl-manual.md`と`05-command-reference.md`を参照してください。
