# DSL 3.1／3.2からDSL 4.0への移行仕様

## 1. 目的と境界

`convert-dsl4`は、既存のDSL 3.1／3.2台本を読み、可読なDSL 4.0 YAML候補とsource位置付き診断を生成する
runtime外の移行toolです。4.0 parserは3.1／3.2構文を受理せず、3.1／3.2 runtimeも変更しません。

変換元は常に不変です。正常時だけ新しい出力をatomicに置換し、error時はpartial YAMLを返さず既存出力を
維持します。CLIは本repositoryの`@kubohiroya/tmpose-kamishibai/converter`と
`tmpose-kamishibai convert-dsl4`で公開します。

DSL 3.1は、3.2.3 runtimeが維持する3.2互換grammarとして解釈し、
`K4-CONVERT-VERSION-31-COMPAT` warningを必ず返します。これは4.0 runtimeへlegacy parserを追加する意味では
ありません。warningと生成YAMLを確認してから、元作品とは別名の4.0成果物をbuildします。

DSL documentのversionは文字列`4.0`とのexact matchであり、minor negotiationや`4.x`受理は行いません。
packageのpatch／minor更新で許されるのは、既存4.0 documentの構文、正規化結果、実行意味を変えない修正と、
既存schemaで表現済みのoptional capability追加だけです。旧parserが解釈できないsyntaxや既存nodeの意味変更は
新しいDSL versionと明示converterを必要とし、4.0 parserへfallbackしません。converter packageを更新して出力や
warningが変わる場合は、生成物を上書きせずdiff／preview後に採用します。

## 2. 判定分類

| 分類            | converterの結果                   | 作者が行うこと                               |
| --------------- | --------------------------------- | -------------------------------------------- |
| 自動            | YAMLを生成しdiagnosticなし        | schema-validな結果をpreviewする              |
| warning付き自動 | YAMLを生成し元行付きwarningを返す | warningごとに意味が保存されたか確認する      |
| 手動            | errorを返しYAMLを生成しない       | 指示されたsource／assetを直して再実行する    |
| 変換不能        | errorを返しYAMLを生成しない       | 4.0で表現を再設計するか3.2 runtimeを継続する |

「手動」は情報が揃えば作者が4.0 sourceへ置換できるもの、「変換不能」は旧runtimeの偶発挙動、独自Scratch
変更、曖昧な構文など、converterが同じ意味を保証できないものです。converterは推測で値を捨てません。

## 3. top-level command対応表

| 3.1／3.2 command                          | 4.0 node                                   | 分類            | 主な診断／条件                                                     |
| ----------------------------------------- | ------------------------------------------ | --------------- | ------------------------------------------------------------------ |
| `kamishibai=3.2`                          | `kamishibai: "4.0"`                        | 自動            | 重複／unknown versionは`K4-CONVERT-VERSION-*`                      |
| `kamishibai=3.1`                          | `kamishibai: "4.0"`                        | warning付き自動 | `K4-CONVERT-VERSION-31-COMPAT`                                     |
| `asset` backdrop／costume／sound          | `assets.<id>`                              | 自動            | SB3内project asset名へ変換                                         |
| remote／cache `asset`                     | なし                                       | 手動            | `K4-CONVERT-ASSET-REMOTE`／`K4-CONVERT-ASSET-ADDRESS`              |
| Text Asset `asset`                        | なし                                       | 手動            | `K4-CONVERT-LEGACY-TEXT`。4章に従いSVG Textへ移行                  |
| `actor`                                   | `actors.<id>`                              | 自動            | actorと初期skin参照を検証                                          |
| `cover`                                   | `cover.backdrop`／`cover.bgm`              | 自動            | positional listを名前付きfieldへ変換                               |
| `setRuntimeVariable`                      | `variables.<id>`                           | warning付き自動 | scalar型推論を`K4-CONVERT-VARIABLE-TYPE`で通知                     |
| `setLoadingBackdrop`／`setLoadingCostume` | `loading`                                  | 自動            | 両方が必要。片方だけなら手動修正                                   |
| `setPoseRecognitionSound`                 | `poseRecognition.idleSound`／`chargeSound` | 自動            | 2 sound必須。単一soundは手動修正                                   |
| `svgTextStyle`                            | `textStyles.<id>`                          | 自動            | 4.0のfont／align／direction制約を検証                              |
| `text`／`textStyle`                       | なし                                       | 手動            | app shell `ui.*`だけwarning付きで省略。それ以外は旧Text Asset移行  |
| `registerBranch`                          | `branches.<id>[]`                          | 自動            | 条件／遷移先数とRuntime Expressionを検証                           |
| `sceneLabel`／`---`                       | `scenes.<id>`／scene終端                   | 自動            | actionを宣言順に保持                                               |
| `TMPoseURL`                               | scene `poseModel`＋`assets` poseModel      | 自動            | 既定はlazy remote。`--pose-models`指定時だけexact local embedded化 |
| 3.2標準の次action操作                     | `controls.keymaps.production.Space`        | 自動            | build可能な完全profileとして`navigation.nextAction`へ固定         |
| unknown top-level command                 | なし                                       | 変換不能        | `K4-CONVERT-COMMAND-UNSUPPORTED`                                   |

`TMPoseURL`はnetwork取得せず、そのURLを通常のremote poseModelとして保持します。内容固定やoffline実行が
必要な場合だけ、別途localへ取得したmodel directoryを`--pose-models`でexact replacementし、SB3へ
embedded化します。converter自身はnetwork取得やcache lookupを行いません。

3.2には4.0の名前付きcontrol profile宣言がないため、converterは`production` profileを生成し、`Space`を
`navigation.nextAction`へ割り当てます。生成物はそのまま`build-dsl4 --control-profile production`へ渡せます。
別のkeymapが必要な作品は、変換後に完全profileとして置き換えます。

`asset`のID、project asset名、`sceneLabel`は別名へ置換せず、その文字列を4.0へ保持します。空白、`.`、`/`、
制御文字を含む場合、生成YAMLは必要なquoted scalar escapeを自動で使用します。actor名などaction構文の
一部になるIDは、`.`区切りを曖昧にしないため従来のDSL ID規則を維持します。

`setRuntimeVariable=startSceneIndex`の非default値、scene内variable宣言、互換runtimeで偶然受理された不正な
arityや曖昧なcolon区切りは、意味を推測せずerrorにします。

## 4. action対応表

| 3.1／3.2 action                | 4.0 action                         | 分類／補足                                                |
| ------------------------------ | ---------------------------------- | --------------------------------------------------------- |
| `stage`                        | `stage`                            | 自動                                                      |
| `bgm`                          | `bgm`                              | 自動                                                      |
| `sound`                        | `sound`                            | 自動                                                      |
| `wait`                         | `wait`                             | 自動                                                      |
| `transition`                   | `transition: {effect, seconds}`    | warning付き自動。時間を0秒へ明示化                        |
| Actor `show`                   | `Actor.show: {skin, x, y, scale}`  | 自動。costume target補正時はwarning                       |
| Actor `setSkin`                | `Actor.setSkin`                    | 自動。3.2のscale指定も`{skin, scale}`として保持            |
| Actor `hide`                   | `Actor.hide: {}`                   | 自動                                                      |
| Actor `setLayer`               | `Actor.setLayer`                   | 自動。`front`／`back`／相対layer数を保持                   |
| Actor `loop`                   | `Actor.loop.steps[]`               | 自動。skinと各表示秒数をbackground loopとして保持          |
| Actor `say`／`think`           | `Actor.say/think: {text, seconds}` | 時間指定は自動。空文字の永続speechは0秒のclearへ変換       |
| Actor `moveTo`                 | `Actor.moveTo: {x, y, seconds}`    | 自動                                                      |
| SVG Text `setText`             | `Actor.setText: {text, style}`     | 自動                                                      |
| Actor `pose`                   | `Actor.pose.steps[]`               | 自動＋手動model mapping。各stepを順序どおり保持           |
| `branch`                       | `branch`                           | 自動                                                      |
| `keyInputToChangeScene`        | code→scene mapping                 | 自動。`KeyboardEvent.code`相当だけを受理                  |
| `touchInputToChangeScene`      | actor→scene mapping                | 自動                                                      |
| 旧Text Asset `show`／`setSkin` | なし                               | 手動。SVG Text actorの`setText`／通常actor actionへ再設計 |
| 独自action／不正arity          | なし                               | 変換不能。`K4-CONVERT-ACTION-UNSUPPORTED`等               |

空でない永続speechとstyle付きspeechは、終了条件やpresentationを推測せず引き続き手動移行とします。
空文字の`Actor.say:`／`Actor.think:`だけは3.2で吹き出しを消去する操作なので、`text: ""`、`seconds: 0`へ
決定的に変換します。

custom Scratch block、Scratch variable／broadcastへ直接依存する作品固有code、block順に依存する副作用は台本
sourceだけから検出できません。converter成功後も作品固有blockをレビューし、必要ならDSL4 custom actionとして
明示登録します。

## 5. 旧Text AssetからSVG Textへの手動移行

旧Text Assetは初期値、style、target costume、`text`／`textStyle` commandとactor actionに状態が分散するため、
安全な自動変換をしません。たとえば次の入力は`K4-CONVERT-LEGACY-TEXT`で停止します。

この診断は移行上の警告内容を伝えますが、機械可読severityは`error`です。warningだけにして不完全なYAMLを
出力すると文字や表示状態を黙って失うため、手動置換が完了するまでblocking diagnosticとして扱います。

```text
asset=Caption,text
actor=Caption,Caption
text=Caption:おしまい
textStyle=Caption:title
sceneLabel=ending
action=Caption:show
```

作者はSVG Text targetとして使うproject costume／actorを用意し、意味と表示styleをYAMLへ明示します。

```yaml
assets:
  CaptionSurface:
    kind: costume
    target: Caption
    name: CaptionSurface

actors:
  Caption: CaptionSurface

textStyles:
  title:
    background: '#ffffff'
    color: '#222222'
    font: Noto Sans JP
    size: 120
    align: center
    direction: up

scenes:
  ending:
    - Caption.setText:
        text: おしまい
        style: title
    - Caption.show:
        skin: CaptionSurface
        x: 0
        y: 0
        scale: 100
```

変換後に、旧`show`／`hide`／`setSkin`の意図、初期文字列、style、吹き出しとの違いを人が確認します。移行が
済むまでconverterは旧Text Assetを黙って除去せず、YAMLをcommitしません。

## 6. 追加block 0契約

converterとsource packagingはScratch blockを生成、削除、並べ替えません。変換YAMLをSB3のsource componentへ
格納する前後で、全`targets[].blocks`はdeep-equalでなければなりません。通常の台本製作者が移行のために追加
する必須Scratch blockは0です。

`test/fixtures/converter/block-zero-project.json`を正本fixtureとし、Stageの既存start blockと作品固有actor
blockを持つprojectへ実際の変換結果を埋め込み、targetごとのblock graphと総block数が変化しないことを検証
します。custom actionへ手動移行する作品だけは、その作品固有handler blockを作者が明示的に追加します。

## 7. 検証・rollback

生成YAMLは4.0 source frontendでschema／semantic validationし、warningはsource line／columnと安定codeを保持
します。変換元は上書きせず、生成物も別名の4.0 SB3としてbuildします。変換結果に問題があれば新規YAML／SB3
だけを破棄し、元の3.1／3.2作品を3.2 runtimeで継続できます。
