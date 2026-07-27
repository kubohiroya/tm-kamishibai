# 紙芝居DSL 2.0から3.1への変更履歴

対象DSL: `kamishibai=2.0` → `kamishibai=3.1`\
文書化日: 2026年7月27日

この文書は、2.0向けの旧ドキュメントと3.1の現行仕様を比較し、台本作者・教材作成者・開発者が把握すべき差分をまとめたものです。中間バージョンごとの導入時期は区別せず、2.0から3.1までの累積差分として記載します。

## 1. 変更の概要

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
| 画面上の文字 | 吹き出し中心 | テキストアセットの表示・時系列更新と、プロンプト／メニュー文言の台本定義を追加 |
| アセット読込表示 | 固定のHatching画像（旧データ上は`Hatchling`） | `Loading`へ改名し、優先読込する複数画像と通常アセットだけの進捗表示を追加 |
| アクター表示 | スキン、位置、サイズをすべて指定 | スキン省略形、スキンとサイズの同時変更を追加 |

## 2. 追加したトップレベルコマンド

### 2.1 `setRuntimeVariable`

```text
setRuntimeVariable=変数名:値
```

Temporary Variablesのランタイム変数を台本から設定できるようにしました。開始シーンを指定する予約変数 `startSceneIndex` や、条件分岐で参照する状態の初期化に使います。

```text
setRuntimeVariable=startSceneIndex:1
setRuntimeVariable=takeSeaRoute:true
```

### 2.2 `registerBranch`

```text
registerBranch=分岐名:条件1,条件2,...:シーンラベル1,シーンラベル2,...
```

Runtime Expressionで評価する条件と移動先を登録できるようにしました。条件は左から順に評価され、最初に真になった条件と同じ位置のシーンラベルが選ばれます。

```text
registerBranch=chooseRoute:takeSeaRoute,true:ocean,home
```

### 2.3 `sceneLabel`

```text
sceneLabel=シーンラベル
```

シーンへ一意の名前を付けられるようにしました。条件分岐、キー入力、タッチ入力の移動先として使います。

### 2.4 scene 0の`text`

```text
text=ui.prompt:ポーズをとろう！
text=ui.invalidScript:エラー：不正な台本ファイル
text=ui.open:ファイルをひらく
text=ui.reload:もういちど
text=ui.about:このアプリについて
```

ポーズ案内、台本エラー、ファイル読込、再読込、タイトル表示の文言を台本から定義できるようにしました。これら5つはランタイムが自動登録する予約済みテキストアセットです。物語開始時に既定の英語文言へ戻してからscene 0の定義を適用するため、前に実行した台本の文言は残りません。

シーン直下の`text=テキストアセット名:文字列`も互換性のため利用できますが、アクション列より先に処理されます。時系列に沿ったテキスト更新には、次節の`action=text:...`を使用します。

### 2.5 `setLoadingCostume`

```text
setLoadingCostume=loading1,loading2,loading3
```

アセット読込中に表示する画像アセットを複数指定できるようにしました。指定アセットを通常アセットより先に読み込み、通常アセットの読込番号に応じて循環表示します。吹き出しの`完了数 / 総数`からLoading用アセット自身は除外します。省略した台本は組み込みのLoadingコスチュームを使います。

## 3. 追加したアクション

### 3.1 グローバルアクション

| アクション | 用途 |
|---|---|
| `action=transition:fadeOut` | ステージを段階的に暗くする |
| `action=transition:fadeUp` | ステージを段階的に明るくする |
| `action=transition:reset` | ステージの明るさ効果を標準値へ戻す |
| `action=text:テキストアセット名:文字列` | アクション列のその位置でテキストを更新する |
| `action=branch:分岐名` | 登録済みの条件を評価して別シーンへ移動する |
| `action=keyInputToChangeScene:キー一覧:ラベル一覧` | 物理キーの入力先に応じて別シーンへ移動する |
| `action=touchInputToChangeScene:アクター一覧:ラベル一覧` | アクターへのポインター／タッチ入力に応じて別シーンへ移動する |

キー入力とタッチ入力はバックグラウンドで待機します。入力項目と移動先ラベルは、同じ個数を同じ順番で指定します。

### 3.2 アクターアクション

| アクション | 用途 |
|---|---|
| `action=アクター名:loop:アセット一覧:秒数一覧` | 画像・音声アセットをバックグラウンドで繰り返す |
| `action=アクター名:sequence:アセット一覧:秒数一覧` | 画像・音声アセットをバックグラウンドで一回だけ順番に再生する |

`loop`はアセット数と秒数の個数をそろえます。`sequence`の秒数はアセット数より1つ少なくします。どちらも待ち時間に `0` を使うことで、画像と音などを同時に開始できます。

## 4. 変更・拡張した既存仕様

### 4.1 アセット識別子

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

### 4.2 `show`

従来の書式に加え、スキン名を省略して初期スキンまたは現在のスキンを使えるようにしました。

```text
# 2.0から継続する書式
action=Hero:show:Hero-normal:0,-60,30

# 3.1で追加した省略形
action=Hero:show:0,-60,30
```

### 4.3 `setSkin`

スキン切り替えと同時にサイズを変更できる書式を追加しました。

```text
action=Hero:setSkin:Hero-surprised:45
```

### 4.4 シーンの実行モデル

2.0の記述順による進行を維持しつつ、3.1では次の仕組みで任意のシーンへ移動できるようにしました。

- `startSceneIndex`による開始シーン指定
- `sceneLabel`による移動先の命名
- `registerBranch`と`branch`による条件分岐
- `keyInputToChangeScene`によるキー入力分岐
- `touchInputToChangeScene`によるタッチ入力分岐

## 5. 廃止・置換した記法

| 2.0の記法 | 3.1での扱い |
|---|---|
| `kamishibai=2.0` | `kamishibai=3.1`へ変更する |
| `asset=Beach,background:beach` | `asset=Beach,backdrop:beach`へ変更する |
| `action=Actor:setCostume:costume1` | 3.1のリファレンス対象外。コスチュームを`asset`で登録し、`setSkin`で切り替える |
| コメントだけで表したシーン名 | 遷移先にする場合は`sceneLabel`を追加する |

`actor`、`cover`、`TMPoseURL`、`stage`、`wait`、`bgm`、`sound`、`hide`、`say`、`think`、`setScale`、`setPosition`、`moveTo`、`setLayer`、`pose`の基本的な役割は3.1でも継続しています。

## 6. 移行例

### 6.1 2.0

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

### 6.2 3.1

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
text=ui.invalidScript:エラー：不正な台本ファイル
text=ui.open:ファイルをひらく
text=ui.reload:もういちど
text=ui.about:このアプリについて
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

## 7. 2.0台本の移行チェックリスト

- [ ] 先頭を`kamishibai=3.1`へ変更した
- [ ] `background:`を`backdrop:`へ変更した
- [ ] プロジェクト内アセットの参照先が存在することを確認した
- [ ] `setLoadingCostume`を使う場合、指定名がすべて画像の`asset=`として定義されている
- [ ] `setCostume`を使っている箇所を`asset`と`setSkin`へ置き換えた
- [ ] 必要なシーンへ重複しない`sceneLabel`を付けた
- [ ] `startSceneIndex`の既定値`1`を確認し、別の開始シーンが必要な場合だけ設定した
- [ ] 必要に応じてscene 0の`text=ui.*`でプロンプト／メニュー文言を定義した
- [ ] シーン内の時系列テキスト更新を`action=text:...`で記述した
- [ ] 分岐の条件数と移動先ラベル数をそろえた
- [ ] キー／タッチ入力の項目数と移動先ラベル数をそろえた
- [ ] すべての分岐先ラベルが存在することを確認した
- [ ] 3.1対応アプリで先頭から全経路を再生確認した

## 8. 一般ドキュメントで修正した範囲

3.1への更新では、DSL仕様だけでなく、一般ドキュメント全体の説明も次のように修正しました。

| 文書 | 主な修正内容 |
|---|---|
| `01-user-guide.md` | 3.1の分岐、入力、フェード、アニメーション、テキスト、Loading表示、用途別成果物、変更可能なUI文言を追加 |
| `02-dsl-manual.md` | 3.1のファイル構造、全追加コマンド、Loading設定、scene 0のUI文言、時系列テキスト、移行・テスト手順を追加 |
| `03-command-reference.md` | アセット識別子、トップレベルコマンド、Loadingの優先読込と進捗、グローバル／アクターアクション、予約UI文言、エラー例を更新 |
| `04-executive-summary-adult.md` | 3.1の機能、状態管理、分岐、Loading表示、用途別成果物を利用者向けの説明へ反映 |
| `05-executive-summary-kids.md` | アニメーション、文字表示、分かれ道、Loadingの数字、Web版とSB3の使い分けをやさしい説明で追加 |
| `06-developer-guide.md` | Asset Manager、Loadingの実行順、Temporary Variables、Runtime Expression、Async Input、用途別成果物と公開構成を整理 |

詳細な書式は`02-dsl-manual.md`と`03-command-reference.md`を参照してください。
