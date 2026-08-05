# 紙芝居DSL 4.0 表層仕様

Copyright © 2026 Hiroya Kubo.

文書状態: Issue #260で合意した実装基準

関連Issue: [#260](https://github.com/kubohiroya/tmpose-kamishibai/issues/260)、
[#264](https://github.com/kubohiroya/tmpose-kamishibai/issues/264)、
[#266](https://github.com/kubohiroya/tmpose-kamishibai/issues/266)、
[#267](https://github.com/kubohiroya/tmpose-kamishibai/issues/267)

機械可読な構造仕様: [`schema/dsl-4.schema.json`](../../schema/dsl-4.schema.json)

総合例:
[`test/fixtures/dsl4/valid/comprehensive.kamishibai.yaml`](../../test/fixtures/dsl4/valid/comprehensive.kamishibai.yaml)

## 1. 作者体験の最優先原則

通常の台本製作者は、TurboWarpのブロックを追加、複製、接続、修正せず、台本とアセットの
記述だけで標準的な紙芝居を完成できなければなりません。ブロック組立てを減らした分だけ台本を
明示的で読みやすくし、短さのために引数の意味を隠しません。

この原則から、表層構文には次の規則を適用します。

- 一つのactionはキーを一つだけ持つmappingとする
- 引数が一つで意味が明白なactionだけscalar短縮形を認める
- 意味の異なる複数引数には名前付きmappingを使い、位置引数listを認めない
- 同じ意味の要素の集合だけlistを使う
- 標準actionに必要な処理、DSL解釈、状態管理は機能拡張側が担当する
- Scratch Action Registryは作品固有の任意拡張用とし、標準作品には要求しない

単一引数のscalarは、`wait: 1`のように短くても意味が変わらないため採用します。一方、異なる意味の
複数値を位置listにすると、値だけから役割を判断できないため採用しません。scene短形式は通常sceneの
定型的な`actions` nestingを省き、長形式はmetadataとactionを混在させないために併用します。両形式は
検証後に同じ型付きaction引数と`SceneNode`へ正規化します。

## 2. 文書構造

台本はUTF-8で記述した単一のYAML 1.2文書です。トップレベルで使用できるキーは次だけです。
未知のキーは警告ではなくエラーにします。

| キー              | 必須 | 役割                             |
| ----------------- | ---- | -------------------------------- |
| `kamishibai`      | 必須 | 文字列`'4.0'`                    |
| `assets`          | 任意 | 型付きアセットの宣言             |
| `actors`          | 任意 | actorと初期costumeの対応         |
| `cover`           | 任意 | 表紙の背景とBGM                  |
| `textStyles`      | 任意 | SVG Textの名前付きstyle          |
| `variables`       | 任意 | string、number、booleanの初期値  |
| `loading`         | 任意 | 読み込み中の背景とcostume列      |
| `poseRecognition` | 任意 | 待機中と認識成功時の音           |
| `controls`        | 任意 | 環境別の開発・チート機能用keymap |
| `branches`        | 任意 | 順序付き条件分岐                 |
| `scenes`          | 必須 | 一つ以上のscene                  |

識別子にはUnicodeの文字、数字、`_`、`-`を使用できます。先頭は文字または`_`とし、
`.`はactor actionの区切りとして予約します。すべての識別子はUnicode NFCでなければなりません。

YAMLのduplicate key、anchor、alias、merge key、custom tag、複数文書を認めません。実装は
YAMLの構文位置を保持し、schema検証に成功するまでアセット読込などの副作用を開始しません。

表層grammarの概要は次のとおりです。各非終端の具体的なkey、型、必須性はJSON Schemaを正本とします。

```text
document     ::= mapping("kamishibai" => "4.0", "scenes" => scenes, top-level-field*)
scenes       ::= mapping(scene-id => short-scene | long-scene)+
short-scene  ::= sequence(action*)
long-scene   ::= mapping("actions" => sequence(action*), scene-metadata*)
action       ::= mapping(action-name => scalar-args | named-args)  # exactly one key
action-name  ::= global-command | actor-id "." actor-command
```

## 3. アセット

### 3.1 短形式

既にSB3へ埋め込まれたアセットは短形式で参照できます。

```yaml
assets:
  Beach: backdrop
  HeroIdle: costume:Hero
  OpeningSound: sound
```

### 3.2 名前付き形式

名前付き形式は`kind`に加え、既存の埋め込み名を示す`name`またはbuilder入力内のローカル相対pathを
示す`file`のどちらか一方を持ちます。`poseModel`は`file`を必須とします。

```yaml
assets:
  Ocean:
    kind: backdrop
    file: assets/ocean.svg
    loading: lazy
  HeroHappy:
    kind: costume
    target: Hero
    name: happy
  OpeningSound:
    kind: sound
    name: OpeningSound
    loading: lazy
  救助Pose:
    kind: poseModel
    file: pose-models/rescue
    loading: lazy
```

`kind`は`backdrop`、`costume`、`sound`、`poseModel`のいずれかです。`costume`は`target`を
必須とします。`file`に絶対path、`.`または`..` path segment、HTTP(S)を含むURIなどの外部URIを
指定できません。builderは参照されたbyte列を成果物へ埋め込み、実動作環境でネットワーク取得を
必要としないself-containedなSB3を生成します。

### 3.3 読み込み方針

`backdrop`、`costume`、`sound`、`poseModel`の名前付き形式には`loading: eager | lazy`を
指定できます。省略時と短形式は`eager`です。

`lazy`は成果物へのbyte列の埋め込みを省略する指定ではありません。decode、登録、モデル初期化など、
実行可能にするための準備を遅延させる指定です。controllerが次の遷移先sceneを決定した時点で、
そのsceneから直接必要になる未準備のlazy assetをbackgroundで先読みします。scene開始時に準備が
終わっていなければLoading表示で待ち、失敗時はscene actionを実行せず診断を表示します。
準備済みassetは紙芝居停止までcacheします。

## 4. 共通設定

表紙、ポーズ認識音、SVG Textは、各値の意味が名前から分かるmappingで記述します。

```yaml
cover:
  backdrop: Beach
  bgm: OpeningSound

poseRecognition:
  idleSound: ClockTicking
  chargeSound: Success
  sequence:
    confidenceThreshold: 0.5
    fullConfidenceHoldSeconds: 1
    idleChargePerSecond: 0
  selection:
    accumulationPerSecond: 1
    decayPerSecond: 0.9
    scoreThreshold: 0

textStyles:
  title:
    background: '#112233'
    color: '#ffffff'
    font: Noto Sans JP
    size: 150
    align: center
    direction: up
```

`variables`の初期値はstring、number、booleanだけです。object、array、nullは認めません。

`sequence`は`Actor.pose.steps`を順番に成立させる対象pose専用チャージです。
`fullConfidenceHoldSeconds: 1`はconfidence 1.0で完了まで1秒、0.5なら約2秒を意味します。
`selection`は`poseInputToChangeScene`が候補から1件を選ぶ時間減衰付き蓄積スコアであり、
`sequence`のチャージとは状態を共有しません。省略した数値には上の例の値を既定値として使います。

sequenceの進捗は、対象poseのconfidenceが`confidenceThreshold`以上なら
`confidence / fullConfidenceHoldSeconds × elapsedSeconds`、未満なら
`idleChargePerSecond × elapsedSeconds`を加え、1以上で成立します。selectionは各poseについて
`previous × decayPerSecond^elapsedSeconds + confidence × accumulationPerSecond × elapsedSeconds`
を計算し、最大scoreが`scoreThreshold`以上になったposeを1件だけ選びます。

二つの認識modeは排他です。`Actor.pose`のsequenceを優先し、sequence開始時に実行中の
selection待機があればcancelします。sequence中に開始されたselection待機は購読せず、sequence
終了後にだけ開始します。この間のselection eventでscene遷移してはいけません。

selectionの有効期限は`poseInputToChangeScene`の1回のaction実行です。開始時に以前のselection
待機を解除し、selection用の蓄積scoreを0へresetしてから購読します。同じruntimeでselectionを
重ねた場合は直近の1回だけを残し、以前の待機を自動cancelします。候補決定、scene移動、巻き戻し、
停止、live reload、`Actor.pose`開始、runtime解放で失効し、同じsceneへ再入場した場合も新しい
selectionとしてscore 0から開始します。selectionのresetでsequenceのstep進捗は変更しません。

## 5. 環境別keymap

開発用の巻き戻しや早送りは固定キーをシステム的に占有せず、台本の環境別keymapで割り当てます。

```yaml
controls:
  keymaps:
    development:
      Space: navigation.nextAction
      ArrowLeft: history.previousAction
      ArrowUp: history.previousScene
      ArrowDown: history.nextScene
    production:
      Space: navigation.nextAction
```

キー名はlayoutに依存する文字ではなく`KeyboardEvent.code`です。modifierとの組合せを認めません。
ある環境のkeymapにhistory commandを割り当てなければ、その環境では巻き戻しが無効です。
同じ実行状態でnavigation keyと作品内の`keyInputToChangeScene`が衝突する場合はエラーにします。
各profileは継承、merge、fallbackを行わない完全なkeymapです。builderは`controlProfile`を必須入力として
一つ選び、指定省略、unknown profile、台本内のprofile欠落をbuild errorにします。runtime途中でprofileを
切り替えません。

巻き戻しはscene遷移の実行履歴を使います。台本の実行位置を表すruntime stateは移動先に合わせて
変更しますが、作品変数など、それ以外のruntime stateは巻き戻しません。

## 6. 分岐とscene

分岐規則は記述順に評価し、最後の一件を必ず`else`にします。`if`と遷移先を同じmappingへ置きます。

```yaml
branches:
  rescueResult:
    - if: 'score == 1'
      goto: seaRoute
    - if: takeSeaRoute
      goto: seaRoute
    - else: ending
```

scene固有設定がなければaction列を直接書きます。`poseModel`などを持つ場合は長形式を使います。

```yaml
scenes:
  opening:
    - stage: Beach
    - wait: 1

  rescue:
    poseModel: 救助Pose
    actions:
      - stage: Ocean
      - branch: rescueResult
```

## 7. Core action

### 7.1 Global action

| action                    | 引数                                        |
| ------------------------- | ------------------------------------------- |
| `stage`                   | backdrop ID、または`{backdrop, stableId?}`  |
| `bgm` / `sound`           | sound ID、または`{sound, stableId?}`        |
| `wait`                    | 秒数、または`{seconds, stableId?}`          |
| `transition`              | `{effect, seconds, stableId?}`              |
| `goto`                    | scene ID、または`{scene, stableId?}`        |
| `branch`                  | branch ID、または`{branch, stableId?}`      |
| `keyInputToChangeScene`   | `KeyboardEvent.code`からscene IDへのmapping |
| `touchInputToChangeScene` | actor IDからscene IDへのmapping             |
| `poseInputToChangeScene`  | pose IDからscene IDへのmapping              |

`transition`は見た目の効果だけを実行し、scene遷移を暗黙に行いません。scene移動には別の`goto`、
`branch`または入力actionを使います。

### 7.2 Actor action

| action          | 引数                               |
| --------------- | ---------------------------------- |
| `Actor.show`    | `{skin, x, y, scale, stableId?}`   |
| `Actor.moveTo`  | `{x, y, seconds, stableId?}`       |
| `Actor.say`     | `{text, seconds, stableId?}`       |
| `Actor.setSkin` | skin ID、または`{skin, stableId?}` |
| `Actor.setText` | `{text, style, stableId?}`         |
| `Actor.pose`    | `{steps, stableId?}`               |

```yaml
- Hero.show:
    skin: HeroHappy
    x: 0
    y: -60
    scale: 30
- Hero.say:
    text: 助けに行こう
    seconds: 2
- Caption.setText:
    text: おしまい
    style: title
- Hero.pose:
    steps:
      - pose: help
        skin: HeroHelp
        sound: Success
      - pose: jump
        skin: HeroHappy
        sound: Success
- poseInputToChangeScene:
    help: ending
    jump: retry
```

`Actor.pose.steps`は配列の全要素を上から順に実行します。各stepは`skin`を先に適用し、`pose`の
チャージ完了を待ち、`sound`を鳴らしてから次へ進みます。`skin`と`sound`は省略できます。
`poseInputToChangeScene`は同時に待つ候補であり、最初に選ばれた1件だけのsceneへ移動します。

一つのaction mappingに複数のaction keyを置けません。`stableId`は任意ですが、指定した場合は
文書全体で一意にします。独自actionのschemaと登録契約はIssue #264で定義します。

入力actionへ`stableId`を付ける場合は、遷移mappingを`routes`の下へ移します。

```yaml
- keyInputToChangeScene:
    stableId: routeSelection
    routes:
      Digit1: rescue
      Digit2: ending
```

## 8. 検証境界

JSON Schemaは型、必須項目、未知key、actionの引数形を検証します。意味検証は次を追加で検証します。

- 参照するscene、branch、actor、style、assetが定義済みであること
- 参照assetの`kind`とcostumeの`target`が利用箇所に合うこと
- branchの`else`が一件だけ存在して末尾にあること
- `stableId`が文書全体で一意であること
- `file`が安全なローカル相対pathであること
- 識別子がUnicode NFCであること
- keymapと作品内入力に衝突がないこと

構造または意味検証が失敗した場合、runtimeはscene actionやasset準備を開始しません。
現在のschemaとfixtureは表層契約を固定するための実装基準であり、DSL 4.0 runtimeが利用可能になった
ことを意味しません。

初期実装で固定する診断codeは次です。Source Mapによる行・列・関連位置はparser実装時に加えます。

| code                    | 意味                                        |
| ----------------------- | ------------------------------------------- |
| `K4-YAML-*`             | YAML構文または禁止機能                      |
| `K4-VERSION-001`        | versionが文字列`4.0`ではない                |
| `K4-SCHEMA-001`         | 引数型、必須field、構造がschemaと一致しない |
| `K4-SCHEMA-UNKNOWN-KEY` | schemaにないkey                             |
| `K4-ID-INVALID`         | 識別子の文字規則違反                        |
| `K4-KEY-UNSUPPORTED`    | 未対応keyまたはmodifier combination         |
| `K4-REF-001`            | 参照先が未定義                              |
| `K4-REF-002`            | asset kindが利用箇所と一致しない            |
| `K4-REF-003`            | costume targetがactorと一致しない           |
| `K4-ASSET-001`          | `file`が安全なローカル相対pathではない      |
| `K4-BRANCH-001`         | branchの末尾が`else`ではない                |
| `K4-STABLE-ID-001`      | `stableId`が文書内で重複                    |
| `K4-KEY-001`            | navigation keymapと作品内key inputが衝突    |

入力byte数、YAML node数、nesting深度、scalar長、scene数、sceneごとのaction数、asset数、診断数には
資源上限を設け、超過を`K4-RESOURCE-LIMIT`で停止します。具体値は対象端末でのparser benchmarkを行う
実装Issueで決定し、schema互換性を変えずに安全側へ設定可能なruntime policyとします。
