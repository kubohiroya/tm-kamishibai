# 紙芝居DSL 4.0 表層仕様

Copyright © 2026 Hiroya Kubo.

文書状態: Issue #260で合意した実装基準

関連Issue: [#260](https://github.com/kubohiroya/tmpose-kamishibai/issues/260)、
[#264](https://github.com/kubohiroya/tmpose-kamishibai/issues/264)、
[#266](https://github.com/kubohiroya/tmpose-kamishibai/issues/266)、
[#267](https://github.com/kubohiroya/tmpose-kamishibai/issues/267)、
[#284](https://github.com/kubohiroya/tmpose-kamishibai/issues/284)

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

名前付き形式は`kind`に加え、既存の埋め込み名を示す`name`、builder入力内のローカル相対pathを示す
`file`、または検証情報付きの`source`のいずれか一つを持ちます。`name`と`file`は
`delivery: embedded`、`source`は明示的な`delivery: remote`で使用します。

```yaml
assets:
  Ocean:
    kind: backdrop
    file: assets/ocean.svg
    loading: lazy
    retention: story
  HeroHappy:
    kind: costume
    target: Hero
    name: happy
  OpeningSound:
    kind: sound
    name: OpeningSound
    loading: lazy
    retention: story
  救助Pose:
    kind: poseModel
    file: pose-models/rescue
    loading: lazy
    retention: scene
  RemoteOcean:
    kind: backdrop
    delivery: remote
    loading: lazy
    retention: story
    source:
      url: https://cdn.example.com/ocean.webp
      integrity: sha256-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
      contentType: image/webp
      size: 654321
```

`kind`は`backdrop`、`costume`、`sound`、`poseModel`のいずれかです。`costume`は`target`を
必須とします。`file`に絶対path、`.`または`..` path segment、HTTP(S)を含むURIなどの外部URIを
指定できません。`delivery`の省略時と短形式は`embedded`です。builderは`embedded`の参照byte列を
成果物へ埋め込み、ネットワークなしで動作するself-containedなSB3を生成します。

`delivery: remote`はSB3の初期download量を減らす必要がある作品だけが使用するopt-inです。
`source.url`はhostnameを持つ絶対HTTPS URLだけを認め、credentialとfragmentを禁止します。期待するbyte列を固定する`integrity`、MIME typeを固定する
`contentType`、上限検査に使う`size`をすべて必須とします。`integrity`は
`sha256-`に続けて64桁の小文字16進SHA-256を記述します。HTTP、検証情報の省略、`name`または`file`との
併記はschema errorです。

### 3.3 読み込みとメモリ保持方針

アセットには、互いに独立した三つの方針があります。

| field       | 値                    | 管理するもの                                      |
| ----------- | --------------------- | ------------------------------------------------- |
| `delivery`  | `embedded` / `remote` | 正本となるbyte列をどこから供給するか              |
| `loading`   | `eager` / `lazy`      | いつ実行可能なresourceへmaterializeするか         |
| `retention` | `scene` / `story`     | materialize済みresourceをメモリ上でいつまで保つか |

`backdrop`、`costume`、`sound`、`poseModel`の名前付き形式には`loading`と`retention`を指定できます。
`loading`の省略時と短形式は`eager`です。`retention`の既定値は`poseModel`が`scene`、それ以外が
`story`です。未知の値はschema errorとします。モデル数に比例してPoseNet／TensorFlow resourceが
蓄積しないよう、`poseModel`には`retention: scene`を推奨します。

`eager`なremote assetはentry sceneへ入る前に準備します。`lazy`はembedded byte列のdecode、登録、
モデル初期化、またはremote byte列の取得と検証を遅延させます。controllerが次の遷移先sceneを
決定した時点で、そのsceneから直接必要になる未準備のlazy assetを先読みします。scene開始時に準備が
終わっていなければLoading表示で待ちます。`actors`の初期costume、`cover`、`loading`から参照される
assetは起動時に必要となるため、`lazy`でもentry sceneより前に準備します。準備済みassetは紙芝居停止まで
保持するとは限りません。`retention: story`は停止、再起動、session disposeまで保持し、
`retention: scene`はcurrent sceneまたは実際に選択されたnext sceneが必要とする間だけ保持します。

scene遷移は二段階でcommitします。controllerは遷移先を一つに確定してから、そのsceneが必要とするlazy
assetだけを先読みします。準備に失敗した場合はcurrent sceneとそのresourceを維持し、遷移をcommitしません。
準備に成功した場合はcurrent／nextのdependencyを比較し、nextでも必要なresourceは再登録せず、
`retention: scene`でnextが必要としないresourceだけをcommit時に解放します。履歴移動で解放済みsceneへ
戻る場合は永続cacheまたはembedded sourceから再materializeします。poseModelは先読み中にcurrentとselected
nextの最大二つが一時共存し得ますが、訪問済みmodelをすべて保持しません。

### 3.4 runtime境界と失敗

builderはremote assetの検証情報だけをasset bundle manifestへ格納し、byte列をSB3へ格納しません。
controller coreは`fetch`、filesystem、VMへ直接依存せず、既存のasset preload coordinatorを通して
asset lifecycleを呼びます。通常のembedded lifecycleではremote取得を拒否し、hostが
`createDsl4RemoteAssetLifecycle`へ`loadRemoteAsset`を明示的に注入した場合だけremote modeを有効に
できます。

loaderは宣言されたURLと期待値、`AbortSignal`を受け取り、byte列と実際のContent-Typeを返します。
hostは接続先hostのallowlist、timeout、redirect数、stream受信中の最大byte数を制限します。lifecycleは
loaderの返却後、`size`、`contentType`、`integrity`をすべて再検証してからplatform adapterへ登録します。
URL credentialはsource frontendで拒否するため、認証情報を作品へ埋め込む用途には使用できません。
remote `poseModel`のURLは一つのarchiveを指します。host loaderは検証対象となるarchive byte列に加え、
実際のContent-Typeを返します。lifecycleがarchiveのsize・Content-Type・SHA-256を検証した後、trusted
extractorが`model.json`、`metadata.json`、weights fileを展開します。path traversal、duplicate entry、
file数、圧縮前後と展開後の合計byte数へ上限を適用し、各fileをarchive integrityとextractor format versionへ
bindingしてからTMPose adapterへ登録します。loaderが別経路で渡した未検証の展開fileは受理しません。

materialize済みresourceは`retention`に従ってadapterからasset単位でreleaseし、停止・再起動・dispose時は
retentionにかかわらず全件releaseします。
navigationで同じassetの準備を中断した場合、古い処理がsettleしてstale resourceを解放するまで再準備を
開始しないため、同一assetを同時に二重登録しません。準備中は`assets.startup.start`、
`assets.preload.start`、`assets.loading.show`／`assets.loading.hide` eventを発行します。準備失敗時は
対象assetのStoryPathと検証種別ごとの診断codeを表示し、遷移先sceneのactionを一つも実行しません。
offlineへ切り戻す場合は`delivery: embedded`とローカル`file`へ戻します。

### 3.5 IndexedDB永続cache

IndexedDBへ保存した検証済みbyte列の寿命は`retention`とは別に管理します。memory resourceをreleaseしても
永続cacheは削除せず、cacheをclearしても既にmaterialize済みのresourceは直ちに無効化しません。cacheは
最終利用からのTTL、LRU、byte budget、format versionによりboundedに掃除し、保存失敗時は機械可読warningを
返します。remote assetはvalid cache hitならnetworkを呼ばず、missまたは不正recordの場合だけ取得と
再検証を行います。

DSL 4.0は台本をまたいでcacheを共有しません。builderは初回にstable story IDと台本ファイルのbasenameから
次のようなdatabase名を生成し、story manifestへ保存します。

```text
tw-kamishibai-assets-v1--<台本basename由来slug>--<stable-story-id>
```

可読部分にはUnicodeの文字と数字を残し、pathは保存しません。同名台本はstable IDで分離し、台本名を変更しても
manifestに保存済みのdatabase名を継続利用します。database内のidentity metadataとapp shellの管理画面には、
台本表示名、database名、使用量、entry数、最終cleanupを表示し、台本単位でstats、prune、clearを実行できます。
これらを標準作者paletteのblockとしては公開しません。

台本別databaseの一覧とorigin全体の容量管理には、小さな共通catalog database
`tw-kamishibai-cache-catalog-v1`を使用します。catalogが保持するのはdatabase名、stable story ID、表示名、
論理byte数、entry数、最終利用時刻だけで、binary dataやasset keyを保持せず、
台本間のasset参照やdeduplicationには使用しません。各runtime instanceは短期leaseをrenewし、story stop／dispose時に
releaseします。app shellはAsset Managerの`renewVerifiedRemoteStoryCacheLease`をheartbeatとして呼び、停止処理で
`releaseVerifiedRemoteStoryCacheLease`を呼びます。origin全体がhigh-waterを超える場合は、実行中の全tabのleaseを
pinしたまま、最終利用時刻が古い別台本のdatabaseから削除してlow-waterへ戻します。crash等でreleaseされなかった
leaseは期限切れ後に掃除します。TTLを超えて開かれていない台本databaseは、binaryを読み込むことなくcatalogから
列挙してdatabaseごと削除できます。

app shellはcatalogを使って全台本cacheを一覧表示します。`clear`は現在のdatabaseとidentityを残してentryだけを
削除し、「作品のcacheを削除」はdatabaseとcatalog recordを削除します。stats、TTL、LRU、clearの保守走査では
keyと軽量metadataだけを読み、保存済み`ArrayBuffer`を容量計算のためにmaterializeしません。catalogが利用不能でも
現在台本の検証済みcache／memory実行を中止せず、機械可読warningを返します。

runtimeが扱う寿命は次の四段階です。

1. SB3 ZIPまたはremote loaderが供給するsource bytes
2. 台本単位のIndexedDBに保存する検証済みbytes
3. 登録処理中だけ使用する一時`ArrayBuffer`／`File`
4. renderer、audio、TMPose／PoseNetが所有するmaterialized resource

source bytesと一時objectはtransactionまたは登録完了後にapplicationからの参照を破棄してGC対象にします。
物理メモリから即時消去されることは保証しません。2はstorage policy、4は`retention`で解放します。この契約の
runtime／schema接続はIssue #327のmerge条件です。

## 4. 共通設定

表紙、ポーズ認識音、SVG Textは、各値の意味が名前から分かるmappingで記述します。

```yaml
cover:
  backdrop: Beach
  bgm: OpeningSound

poseRecognition:
  idleSound: ClockTicking
  chargeSound: Success

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
| `Actor.pose`    | `{choices, stableId?}`             |

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
    choices:
      - pose: help
        skin: HeroHelp
        sound: Success
      - pose: jump
        skin: HeroHappy
        sound: Success
```

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
