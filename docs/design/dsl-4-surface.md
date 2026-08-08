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

| キー              | 必須 | 役割                              |
| ----------------- | ---- | --------------------------------- |
| `kamishibai`      | 必須 | 文字列`'4.0'`                     |
| `assets`          | 任意 | 型付きアセットの宣言              |
| `actors`          | 任意 | actorと初期costumeの対応          |
| `cover`           | 任意 | 表紙の背景とBGM                   |
| `textStyles`      | 任意 | SVG Textの名前付きstyle           |
| `speechStyles`    | 任意 | say／thinkの名前付き文字送りstyle |
| `variables`       | 任意 | string、number、booleanの初期値   |
| `loading`         | 任意 | 読み込み中の背景とcostume列       |
| `poseRecognition` | 任意 | 待機中と認識成功時の音            |
| `controls`        | 任意 | 環境別の開発・チート機能用keymap  |
| `branches`        | 任意 | 順序付き条件分岐                  |
| `scenes`          | 必須 | 一つ以上のscene                   |

actor、style、variable、branch、action、parameterなど、DSL構文上の識別子にはUnicodeの文字、数字、
`_`、`-`を使用できます。先頭は文字または`_`とし、`.`はactor actionの区切りとして予約します。
これらの構文識別子はUnicode NFCでなければなりません。

asset IDとscene IDはScratch上の名前をそのまま保持できる、空でない文字列です。空白、`.`、`/`、
Unicodeの正規化形式、C0制御文字、DELを含められます。YAML sourceでは必要に応じてdouble-quoted scalarの
escapeを使います。parser、converter、runtimeは値をtrim、NFC変換、alias化しません。`__proto__`など
object pollutionを生じるmapping keyは、文字種とは別の安全境界として引き続き拒否します。

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

名前付き形式は`kind`に加え、既存の埋め込み名を示す`name`、project root基準のローカル相対pathを示す
`file`、または検証情報付きの`source`のいずれか一つを持ちます。`name`と`file`は
`delivery: embedded`、`source`は明示的な`delivery: remote`で使用します。

```yaml
assets:
  Ocean:
    kind: backdrop
    file: ocean.svg
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
    file: rescue-pose
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
  LivePose:
    kind: poseModel
    delivery: remote
    loading: lazy
    retention: scene
    source:
      url: https://teachablemachine.withgoogle.com/models/example/
```

`kind`は`backdrop`、`costume`、`sound`、`poseModel`のいずれかです。`costume`は`target`を
必須とします。`file`に絶対path、`.`または`..` path segment、HTTP(S)を含むURIなどの外部URIを
指定できません。`delivery`の省略時と短形式は`embedded`です。builderは`embedded`の参照byte列を
成果物へ埋め込み、ネットワークなしで動作するself-containedなSB3を生成します。

`delivery: remote`はSB3の初期download量を減らす必要がある作品だけが使用するopt-inです。
`source.url`はhostnameを持つ絶対HTTPS URLだけを認め、credentialとfragmentを禁止します。poseModelは
TMPose 3.2と同じdirectory URLを`url`だけで指定できます。この通常モードは取得時点のmodel内容を正本とし、
`model.json`、`metadata.json`、model manifestが宣言するweights fileをlazy取得します。

内容を固定する場合はmodel directoryをlocalへ取得して`file`で指定し、SB3へembedded化します。remoteの
ままbyte列を検証する場合は、期待するbyte列を固定する`integrity`、MIME typeを固定する`contentType`、
上限検査に使う`size`を三つとも指定します。`integrity`は`sha256-`に続けて64桁の小文字16進SHA-256を
記述します。三項目の一部だけの指定、poseModel以外での検証情報省略、HTTP、`name`または`file`との
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

builderはremote assetのURLと、指定されていれば検証情報だけをasset bundle manifestへ格納し、byte列を
SB3へ格納しません。
controller coreは`fetch`、filesystem、VMへ直接依存せず、既存のasset preload coordinatorを通して
asset lifecycleを呼びます。通常のembedded lifecycleではremote取得を拒否し、hostが
`createDsl4RemoteAssetLifecycle`へ`loadRemoteAsset`を明示的に注入した場合だけremote modeを有効に
できます。

loaderは宣言されたURL、指定されていれば期待値、および`AbortSignal`を受け取り、byte列と実際の
Content-Typeを返します。
hostは接続先hostのallowlist、timeout、redirect数、stream受信中の最大byte数を制限します。lifecycleは
verified remoteではloaderの返却後、`size`、`contentType`、`integrity`をすべて再検証してからplatform
adapterへ登録します。
URL credentialはsource frontendで拒否するため、認証情報を作品へ埋め込む用途には使用できません。
検証情報付きremote `poseModel`のURLは一つのarchiveを指します。host loaderは検証対象となるarchive
byte列に加え、実際のContent-Typeを返します。lifecycleがarchiveのsize・Content-Type・SHA-256を検証した後、trusted
extractorが`model.json`、`metadata.json`、weights fileを展開します。path traversal、duplicate entry、
file数、圧縮前後と展開後の合計byte数へ上限を適用し、各fileをarchive integrityとextractor format versionへ
bindingしてからTMPose adapterへ登録します。loaderが別経路で渡した未検証の展開fileは受理しません。
通常の裸URL poseModelはarchiveを要求せず、同じdirectory配下の三fileをhost loader経由で取得します。
この経路は内容同一性を主張しないため、verified remote cacheへ保存しません。

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
返します。verified remote assetはvalid cache hitならnetworkを呼ばず、missまたは不正recordの場合だけ取得と
再検証を行います。
裸URL poseModelはsession内のmaterialize済みresourceだけを再利用し、解放後の再materializeではURLから
現在のmodelを取得します。

DSL 4.0は台本をまたいでcacheを共有しません。builderは初回にstable story IDと台本ファイルのbasenameから
次のようなdatabase名を生成し、story manifestへ保存します。

```text
tw-kamishibai-assets-v1--<台本basename由来slug>--<stable-story-id>
```

`project.source.json`ではstable IDを`cacheId`、生成済みdatabase名を`cacheDatabaseName`として保持します。
正常な初回buildが両fieldをatomicに追記し、生成SB3のsource descriptorにも`cacheIdentity`として埋め込みます。
runtime hostは埋め込みidentityを正本として使用し、異なるidentityの外部注入を拒否します。

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
列挙してdatabaseごと削除できます。lease取得とcatalog更新は一つのtransactionで行い、database deleteは先に
排他的なdeletion markerを取得します。明示deleteはcurrent runtimeのleaseを自動解除せず、story stop／disposeと
lease releaseの完了後だけ実行します。

TurboWarp runtime hostは作品実行中だけ既定30秒間隔でleaseをrenewし、終了、停止、disposeでheartbeatを解除して
leaseをreleaseします。hostの非palette APIはcurrent storyのstats／prune／clearとcatalogのlist／prune／deleteを
公開し、app shell管理画面はこのAPIを使用します。

他のactive台本が使用しているbytesはcurrent台本の実効cache上限から差し引きます。active leaseをpinした結果、
新しいassetをorigin全体のhigh-water内へ格納できない場合は、検証済みbytesをmemory上で使用してIndexedDBへの
書き込みを省略し、`ASSET_CACHE_ORIGIN_BUDGET_PINNED` warningを返します。

app shellはcatalogを使って全台本cacheを一覧表示します。`clear`は現在のdatabaseとidentityを残してentryだけを
削除し、「作品のcacheを削除」はdatabaseとcatalog recordを削除します。stats、TTL、LRU、clearの保守走査では
keyと軽量metadataだけを読み、保存済み`ArrayBuffer`を容量計算のためにmaterializeしません。catalogが利用不能でも
現在台本の検証済みcache／memory実行を中止せず、機械可読warningを返します。story DBのwrite／delete／clearは
単調増加するstats revisionを更新し、catalogは別tabから遅れて到着した古いentry／byte数を採用しません。

runtimeが扱う寿命は次の四段階です。

1. SB3 ZIPまたはremote loaderが供給するsource bytes
2. 台本単位のIndexedDBに保存する検証済みbytes
3. 登録処理中だけ使用する一時`ArrayBuffer`／`File`
4. renderer、audio、TMPose／PoseNetが所有するmaterialized resource

source bytesと一時objectはtransactionまたは登録完了後にapplicationからの参照を破棄してGC対象にします。
物理メモリから即時消去されることは保証しません。2はstorage policy、4は`retention`で解放します。この契約の
実ブラウザ検証には`test/fixtures/dsl4/browser/remote-cache-retention.html`を使います。repository rootを
HTTPで配信してfixtureを開くと、12回のposeModel再materializeで同時保持数が1、解放後が0、IndexedDBが
1 entry／archive byte数のまま増えないこと、および明示cleanup後に0 entry／0 bytesとなることを表示します。
runtime／schema接続はIssue #284で実装済みです。TMPose 1.6.1の`releasePoseModel()`／`releaseAll()`は
classifierとPoseNet双方のdispose完了を待ちます。

self-contained 4.0 SB3の`binary-entry`形式は明示opt-inです。runtime startupへ渡すproviderは
`releaseAfterLastAsset: false`で作成し、全assetのtransaction commit後にproduct backingが一度だけreleaseします。
永続keyはstable story ID／asset ID／bundle integrityを組み合わせ、provider解放後のscene再訪はIndexedDBだけから
再materializeします。editorは`createExportBundle()`で同一descriptor／integrityの一時entry集合を再構築でき、保存後は
`releaseEntries()`でその参照を破棄します。cache miss、quota、unavailable、abort時にnetwork fallbackは行いません。
互換用Base64形式とDSL 3.2は変更せず、`assetBundleFormat`省略時は従来どおりBase64 loaderを使用します。

real Chromiumのpose memory fixtureは24回のscene再訪で最大20 logical tensors／196,608 bytes、解放後0、
classifier／PoseNet dispose各24回を確認します。JavaScript heapのfixture上限はpeak増加32 MiB、CDP強制GC後は
baseline + 8 MiBです。WebGL／WASM allocatorが解放済み領域をpoolへ残すことは許容し、process memoryの即時縮小は
合格条件にしません。

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
  feedback:
    mode: scratchMirror
  navigation:
    allowSkip: false
  preview:
    mirroring: mirrored

textStyles:
  title:
    background: '#112233'
    color: '#ffffff'
    font: Noto Sans JP
    size: 150
    align: center
    direction: up

speechStyles:
  novel:
    characterIntervalSeconds: 0.05
    characterSound: Typewriter
    noSoundCharacters: '「」'
    restCharacters: '、。…'
    restCharacterIntervalSeconds: 0.5
```

`variables`の初期値はstring、number、booleanだけです。object、array、nullは認めません。

`textStyles.direction`はSVG Text compositionと同じ16方位を受理します。4方位に加えて
`up-up-right`、`up-right`、`right-up-right`、`right-down-right`、`down-right`、
`down-down-right`、`down-down-left`、`down-left`、`left-down-left`、`left-up-left`、
`up-left`、`up-up-left`を使用できます。

`speechStyles`は`Actor.say`／`Actor.think`の文字送りpresentationだけを名前付きで再利用します。
各styleは`characterIntervalSeconds`を必須とし、`characterSound`、`noSoundCharacters`、
`restCharacters`、`restCharacterIntervalSeconds`を指定できます。本文、完了条件、吹き出し開始時の音声は
セリフごとに異なるため、`text`、`seconds`、`waitFor`、`startSound`をstyleへ含めません。

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

`feedback.mode`は`Actor.pose.steps`のsequence進捗をどこへ投影するかを選びます。

- `scratchMirror`: JavaScriptを正本とし、0〜100の認識度／進捗をScratch変数へ一方向投影する
- `scratchBinding`: Scratch側の有限な0〜100の変更を定義済みtick境界で取り込む
- `presenter`: Scratch変数を使わず、app shellの専用presenterへsemantic stateを通知する

`presenter`はapp shellが所有するDOM rendererです。対象actor／pose／stepを文字で示し、認識度と
チャージを別々のnative `progress`と数値で表示します。領域にはaccessible nameを付け、状態変化を
`role="status"`のpolite live regionでも通知するため、色だけには依存しません。文言のlocaleは
台本ではなくapp shellの起動時optionで与えます。Scratch variable、monitor、palette blockは作成・参照しません。
visualなprogressと数値は各tickで更新しますが、live regionはphase、actor、pose、stepのいずれかが変化した
場合だけ更新します。同じphaseの連続tickを読み上げqueueへ追加しません。

`waiting`／`charging`の間だけ表示し、`completed`／`cancelled`では値を0へ戻して領域を隠します。terminal
状態自体はlive regionへ通知してから保持し、次のactive eventで更新します。scene移動、skip、abort、stop、
live reload、runtime disposeはpose actionの最終`cancelled`を同じrendererへ通し、host disposeではDOMと
live regionを解放します。追加の開発者observerはpresenterと独立して通知し、一方の例外やrejectで他方または
pose実行を停止しません。

Scratch方式はStageの非cloud scalar変数「ポーズ認識」「チャージ」を使い、0〜1のsemantic
stateを0〜100へ投影します。`scratchMirror`はScratch側の書換えを読みません。
`scratchBinding`は各pose計算tickの開始時に1回だけ両変数をatomicにsampleし、そのtickの
confidence積分前に反映します。Scratch VMがnumeric inputをstringで保持する場合に限り、十進数と
等価なstringも数値化します。空文字、非数文字列、NaN、Infinity、0〜100範囲外、hex等は
pair全体を取り込まず、直前のJavaScript投影値へ戻します。同tick内に同じ変数へ複数回書かれた場合は、
Scratch runtimeの決定済み実行順による最終値をtick境界でsampleします。variable setterのwrapやwrite回数の
追跡は行わないため、通常のScratch last-write-wins semanticsを変更しません。completed／cancelledの
terminal eventではbindingを無効にして両変数を直ちに0へ戻し、platform sessionのdisposeでも0 resetします。
platformは0〜100の既存Stage variable slider monitorをvariable IDで一意に解決します。両monitorは
adapter startupで両変数を0、両monitorを非表示へ初期化し、waiting／chargingのactive期間だけ表示します。
completed／cancelledは非同期sound cleanupより先に0／非表示へ戻し、disposeでも同じcleanupを行います。

presenterはplatform renderer、TurboWarp runtime hostの明示的な`poseFeedbackPresenter` option、および
4つのdelivery surfaceで共有する`createDsl4StandardAppShell`から接続します。Standard shellは
`dsl4AppShell`が有効なときだけruntime hostを所有し、`dsl4PoseFeedbackModes=true`かつ台本が
`feedback.mode: presenter`の場合だけcontainerを遅延生成して同じrendererへ渡します。

| surface              | source channel | Standard接続         | ownership                                                  |
| -------------------- | -------------- | -------------------- | ---------------------------------------------------------- |
| Web player           | bundled        | `webPlayer`          | production shellがsessionごとの固定DOM領域を所有する       |
| 通常TurboWarp editor | unbundled      | `regularEditor`      | editor shellがsessionごとの固定DOM領域を所有する           |
| Packager             | bundled        | `packager`           | package済みproduction shellが同じconsumerを使用する        |
| development preview  | unbundled      | `developmentPreview` | preview shellが新sessionのDOMを所有し、dispose時に破棄する |

surface固有の暗黙modeは設けません。flag OFF、別のfeedback mode、DSL 3.1／3.2ではpresenter optionの
container／localeを検査せず、DOMを生成しません。shell disposeはruntime hostを先に停止・解放し、その後に
所有DOMを除去します。

省略時は`scratchMirror`です。runtime内部のsemantic eventは`phase`、`target`、`pose`、`stepIndex`、
0〜1の`confidence`／`progress`だけを持ち、Scratch variable ID、DOM、TurboWarp monitorを持ちません。
開始時、各計算tick、完了、cancelで通知し、scene移動、停止、live reload、disposeでは最終`cancelled`を
通知して一時状態を残しません。

`navigation.allowSkip`はfeedback方式と独立し、省略時は`false`です。`false`ではpose待機中の
`navigation.nextAction`で成立を迂回せず、`true`では待機をcancelしてcleanup後に次actionへ進みます。
`false`で拒否されたkeymap入力はDOM eventを消費せず、`setSkin`やstep soundなどpose待機外の処理は
従来どおりnavigation可能です。policy有効時の受理commandは同じ同期dispatch境界で処理し、historyと
`navigation.nextAction`の混在連打でも到着順を変更しません。
停止、close、runtime dispose等のlifecycle操作はどちらでも妨げません。初版のstate eventとconsumerは
起動時固定・既定OFFの`dsl4PoseFeedbackModes`配下で段階導入し、OFFでは現行sound-only動作を維持します。

`preview.mirroring`はcamera preview canvasのstory既定で、`mirrored | unmirrored`の二値です。
省略時は`mirrored`として従来の表示を維持します。scene固有の上書きは長形式sceneの
`posePreview.mirroring`に記述します。runtimeはsceneへ入場するたびにeffective値を
`scene.posePreview.mirroring ?? poseRecognition.preview.mirroring`として適用するため、上書きのない
sceneへ移ると必ずstory既定へ戻り、前sceneの値をstickyにしません。

この値が変更するのはpreview canvasの表示transformだけです。recognitionへ渡すframeの
`flipHorizontal`、pose confidence、sequence／selectionの計算と成立時刻は変更しません。実行時接続は
`@kubohiroya/turbowarp-tmpose/composition`の`setPreviewMirroring`だけを使い、Standalone block opcodeや
paletteを呼びません。起動時固定・既定OFFの`dsl4PosePreviewMirroring`がOFFなら新methodを検査・呼出し
せず、現行のmirrored表示を維持します。ONでmethodが不足する場合はstartupでfail closedにします。

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

Web版、TurboWarp editor、Packagerはkeymapを個別に解釈しません。builderが固定した同一の
`controlProfile`、canonical resolved keymap、そのintegrity、history有効化結果をruntime startupで
検証し、同じnavigation sessionへ渡します。surface shellが担当するのは検証対象projectと
`KeyboardEvent`の接続だけです。Web版とPackagerのstandard Compositeは`bundled` channel、
Standalone runtimeを直接読み込むTurboWarp editor fixtureは`unbundled` channelを使いますが、
storage pathの違いによってcommand、時系列scene visit、future切捨て、非位置変数の扱いを変えません。

`test/fixtures/dsl4/cross-surface-navigation.json`を3 surface共通の受け入れfixtureとし、同じSB3
round-trip、keymap、巻き戻し操作列、期待結果を適用します。surface固有のfallback keymapや暗黙bindを
追加してはいけません。

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
    posePreview:
      mirroring: unmirrored
    actions:
      - stage: Ocean
      - branch: rescueResult
```

pose preview mirroringのsurface境界は次のとおりです。いずれも台本値を個別解釈せず、同じschema、
StoryDocument、scene-entry consumerを使います。

| surface              | source channel | 適用条件                                          |
| -------------------- | -------------- | ------------------------------------------------- |
| Web player           | bundled        | build/startupで`dsl4PosePreviewMirroring=true`    |
| 通常TurboWarp editor | unbundled      | DSL 4.0 hostがflag ONで明示接続された場合だけ     |
| Packager             | bundled        | package済みruntimeの起動時flagがONの場合だけ      |
| development preview  | unbundled      | preview hostが同じ起動時flagをONにしたsessionだけ |

development preview専用の暗黙上書きは設けません。flag OFF時とDSL 3.1／3.2 SB3は対象外で、TMPoseの
既存mirrored表示、recognition入力、Standalone paletteを変更しません。

camera preview操作UIは`poseRecognition.preview.controls`で任意に構成します。`mirroring`は
`showMirrored`／`showUnmirrored`のtarget-state icon、`cameraMenu`はmenu trigger iconを、それぞれ
target非依存`kind: image` assetとして参照します。両controlは8 anchor位置と0〜1のopacityを持ち、同じ
anchorでは`mirroring`、`cameraMenu`の順に並びます。暗黙の標準iconはなく、control省略時はDOMも上流APIも
生成しません。iconは`loading: eager`だけを許可します。

app shell rendererはpreview表示矩形を追跡し、camera停止、preview非表示、runtimeの自然終了／failで
controlを隠してlistenerを外します。自然終了／failでは履歴からの巻き戻しのためDOMとasset・
Object URL leaseを保持し、`navigation.reposition`／`runtime.resume`でrendererを再開します。明示的な
story stopまたはhost disposeでDOMとleaseを解放します。反転は`setPreviewMirroring`成功後だけiconを
commitします。camera menuはopenごとに
再列挙し、`default | front | back | {deviceId}`を`listCameraDevices`／`selectCamera`へ渡します。opaqueな
device IDはsession内のmenu mappingだけに保持し、StoryDocumentやruntime variableへ保存しません。
`dsl4CameraPreviewControls`は起動時固定・既定OFFです。OFFではcontrol assetをstartup materialize対象から
除外し、renderer optionと上流camera methodを検査・呼出ししません。`mirroring` controlを有効にした
sessionでは#387のstory／scene effective mirroringも同時に適用し、scene入場など外部の反転変更をtarget-state
iconへ反映します。

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

| action                     | 引数                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Actor.show`               | `{skin, x, y, scale, stableId?}`                                                                                                                                             |
| `Actor.hide`               | `{stableId?}`                                                                                                                                                                |
| `Actor.setTransparency`    | 0〜100、`{transparency, stableId?}`、または`{from, to, seconds, background?, stableId?}`                                                                                     |
| `Actor.moveTo`             | `{x, y, seconds, easing?, stableId?}`                                                                                                                                        |
| `Actor.say`／`Actor.think` | `{text, seconds?, waitFor?, style?, characterIntervalSeconds?, startSound?, characterSound?, noSoundCharacters?, restCharacters?, restCharacterIntervalSeconds?, stableId?}` |
| `Actor.setSkin`            | skin ID、または`{skin, scale?, stableId?}`                                                                                                                                   |
| `Actor.setLayer`           | `front`／`back`／相対layer数、または`{layer, stableId?}`                                                                                                                     |
| `Actor.loop`               | `{steps: [{skin, seconds}, ...], stableId?}`                                                                                                                                 |
| `Actor.setText`            | `{text, style, stableId?}`                                                                                                                                                   |
| `Actor.pose`               | `{steps, stableId?}`                                                                                                                                                         |

`Actor.say`と`Actor.think`は、`seconds`または`waitFor: advance`の少なくとも一方を指定します。
`seconds`だけなら吹き出しの表示開始から指定秒数後、`waitFor`だけならステージのprimary pointer入力または
修飾キーを伴わないany key入力後に完了します。両方を指定した場合は入力とタイムアウトのうち先に成立した方で
完了します。入力待機は吹き出しを表示した直後のmicrotaskで有効になり、そのactionを開始した同じ入力を
再利用しません。

`style`にはトップレベルの`speechStyles`で宣言したIDを指定します。styleを指定したactionでは、
`characterIntervalSeconds`、`characterSound`、`noSoundCharacters`、`restCharacters`、
`restCharacterIntervalSeconds`をインライン指定できません。既存のインライン形式はstyleを指定しない場合に
引き続き使用できます。runtime controllerはstyleを共通speech引数へ解決してからActor portへ渡すため、
platform adapterはstyle registryを参照しません。style内の`characterSound`は、そのstyleを参照したsceneの
asset依存として扱います。

`characterIntervalSeconds`を指定すると、Unicode grapheme cluster単位で1文字ずつ表示します。実行環境は
`Intl.Segmenter`を提供しなければならず、未提供の場合はcode point単位へfallbackせず開始前に失敗します。
`startSound`は最初の吹き出し内容を表示した直後に1回再生するsound asset IDです。セリフを読んだ音声を
指定してフルボイスにでき、speech完了、入力、タイムアウト、cancelのいずれでも再生を停止します。
`characterSound`は`characterIntervalSeconds`と組み合わせるsound asset IDで、実際に1文字ずつ表示した
各文字に対して再生します。`startSound`と`characterSound`は併用できます。文字送りの途中で入力または
タイムアウトが成立した場合、残り全文を効果音なしで一括表示してから次のactionへ進みます。
`noSoundCharacters`は`characterSound`を鳴らさない文字を連結した文字列です。
`restCharacters`は対象文字を無音にし、その文字を表示してから次の文字を表示するまでの間隔を
`restCharacterIntervalSeconds`へ置き換えます。両方の文字列は本文と同じUnicode grapheme cluster単位で
判定します。`noSoundCharacters`は`characterSound`と、`restCharacters`は
`restCharacterIntervalSeconds`と組み合わせ、いずれも`characterIntervalSeconds`による文字送りが必要です。
休止中に入力、タイムアウト、cancelが発生した場合は休止を即座に解除し、残り全文を一括表示する場合は
文字別の休止も効果音も適用しません。
sound停止はAsset Managerのasset ID単位です。speechに指定したsound asset IDはそのspeechが排他的に
使用し、BGMや別presentationとの同時再生には別のasset IDを割り当てます。terminal cleanupは、その
speechが実際に再生を開始したasset IDだけを停止します。
`dsl4SpeechAdvanceTypewriter`は起動時固定・既定OFFで、OFFでは従来の
`Actor.say: {text, seconds}`だけを受理します。

```yaml
- Hero.show:
    skin: HeroHappy
    x: 0
    y: -60
    scale: 30
- Hero.setTransparency: 50
- Hero.setTransparency:
    from: 0
    to: 50
    seconds: 1
    background: true
- Hero.moveTo:
    x: 100
    y: -60
    seconds: 1.5
    easing: easeInOut
- Hero.say:
    text: 助けに行こう
    seconds: 8
    waitFor: advance
    style: novel
    startSound: HeroGreetingVoice
- Hero.think:
    text: どうしよう……
    waitFor: advance
    startSound: HeroThinkingVoice
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

`Actor.moveTo.easing`は`linear | easeIn | easeOut | easeInOut`から選びます。省略時は従来どおり
`linear`です。easingはX/Yへ同じ比率で適用し、0秒またはactionのskip時は即座に終点へ確定します。

`Actor.setTransparency`はScratch／TurboWarpの「幽霊の効果を指定値にする」へ一対一で対応します。
`0`は完全不透明、`50`は「幽霊の効果を50にする」、`100`は完全透明です。値の反転や換算は
行いません。

`from`、`to`、`seconds`を指定すると、透明度を`from`から`to`まで線形に変化させます。
`background`を省略するか`false`にすると、変化が完了するまでactionを待つforeground動作です。
`true`にすると、`from`を同期適用した直後に次actionへ進み、変化をbackgroundで続けます。
foreground・backgroundのどちらも、途中でスキップ、停止、再開始、破棄された場合は、`to`を
同期適用してtimerを回収してから処理を続けます。同じactorへ新しい透明度変化を開始する場合も、
先の変化をその`to`へ確定してから新しい`from`を適用します。`to`の適用に失敗した場合は
進行中の変化を保持してスキップを行わず、次のスキップまたはlifecycle境界で適用を再試行します。

`Actor.hide`はScratch／TurboWarpのvisible stateを`false`にし、透明度effectとは混同しません。次の
`Actor.show`は同じactorを再表示します。`Actor.setSkin.scale`はskin適用後に正のサイズ百分率を設定します。
`Actor.setLayer`の`front`／`back`は絶対位置、数値は正なら前方、負なら後方への相対移動です。

`Actor.loop.steps`は先頭skinを直ちに適用し、各`seconds`後に次のskinへ進むbackground loopです。step数と
duration数を同じ構造に固定し、少なくとも一つのdurationを正数にします。同じactorの`setSkin`、runtime停止、
またはenvironment破棄でloop timerを回収します。

`Actor.pose.steps`は配列の全要素を上から順に実行します。各stepは`skin`を先に適用し、`pose`の
チャージ完了を待ち、`sound`を鳴らしてから次へ進みます。`skin`と`sound`は省略できます。
`poseInputToChangeScene`は同時に待つ候補であり、最初に選ばれた1件だけのsceneへ移動します。

一つのaction mappingに複数のaction keyを置けません。`stableId`は任意ですが、指定した場合は
文書全体で一意にします。

入力actionへ`stableId`を付ける場合は、遷移mappingを`routes`の下へ移します。

```yaml
- keyInputToChangeScene:
    stableId: routeSelection
    routes:
      Digit1: rescue
      Digit2: ending
```

## 8. Custom action

Custom actionは作品固有の工夫をScratch blockで加える任意機能です。標準作品はAction Registryが空でも
全core actionを実行でき、台本製作者にcustom action blockを要求しません。

```yaml
- Hero.wave:
    stableId: firstWave
    arguments:
      speed: fast
      count: 3
```

target actorとaction名を`Actor.action`で表し、異なる役割を持つ引数は`arguments`内のnamed mappingで
表します。位置listは許可しません。引数がないactionは`Hero.wave: {}`と書きます。外側で許可するkeyは
`arguments`と`stableId`だけです。

台本をparseする前にTurboWarp adapterがcustom action用hatを検出し、一つの不変な
`ActionRegistrySnapshot`を生成します。各登録は次を持ちます。

```json
{
  "name": "wave",
  "target": "actor",
  "parameters": [
    {"name": "speed", "type": "string", "required": true},
    {"name": "count", "type": "number", "required": false}
  ],
  "quiesce": "finish-only",
  "source": {"targetId": "...", "hatBlockId": "..."}
}
```

parameter typeは初版では`string`、`number`、`boolean`に限定します。`required`を省略してsnapshotを
生成する場合は`true`へ正規化します。台本の未宣言引数、必須引数の欠落、型不一致は実行前のerrorです。

`quiesce`はlive reload時のhandler停止契約であり、`finish-only`または`cancel-replay-safe`を取ります。
省略時は副作用を重複させない安全側の`finish-only`へ正規化します。この値はhatのdeveloper向け設定で
宣言し、台本製作者が作品ごとに指定する項目にはしません。

action名とparameter名は通常のDSL ID規則とUnicode NFCに従います。短いaction名を許可し、namespaceは
必須にしません。その代わりproject内でaction名を一意にし、同名handler、parameter重複、全core action名
との衝突をRegistry Snapshot生成時に拒否します。登録済みactionだけを受理し、runtimeは動的なport名を
作らず、固定`customAction` portへname、target、argumentsを渡します。

## 9. 検証境界

JSON Schemaは型、必須項目、未知key、actionの引数形を検証します。意味検証は次を追加で検証します。

- 参照するscene、branch、actor、style、assetが定義済みであること
- 参照assetの`kind`とcostumeの`target`が利用箇所に合うこと
- branchの`else`が一件だけ存在して末尾にあること
- `stableId`が文書全体で一意であること
- `file`が安全なローカル相対pathであること
- 構文識別子がUnicode NFCであり、asset／scene IDが空でないこと
- keymapと作品内入力に衝突がないこと
- custom actionが登録済みで、引数がRegistry parameter宣言と一致すること

構造または意味検証が失敗した場合、runtimeはscene actionやasset準備を開始しません。
現在のschemaとfixtureは表層契約を固定するための実装基準であり、DSL 4.0 runtimeが利用可能になった
ことを意味しません。

初期実装で固定する診断codeは次です。Source Mapによる行・列・関連位置はparser実装時に加えます。

| code                     | 意味                                           |
| ------------------------ | ---------------------------------------------- |
| `K4-YAML-*`              | YAML構文または禁止機能                         |
| `K4-VERSION-001`         | versionが文字列`4.0`ではない                   |
| `K4-SCHEMA-001`          | 引数型、必須field、構造がschemaと一致しない    |
| `K4-SCHEMA-UNKNOWN-KEY`  | schemaにないkey                                |
| `K4-ID-INVALID`          | 構文識別子の文字規則違反、または空のliteral ID |
| `K4-KEY-UNSUPPORTED`     | 未対応keyまたはmodifier combination            |
| `K4-REF-001`             | 参照先が未定義                                 |
| `K4-REF-002`             | asset kindが利用箇所と一致しない               |
| `K4-REF-003`             | costume targetがactorと一致しない              |
| `K4-ASSET-001`           | `file`が安全なローカル相対pathではない         |
| `K4-BRANCH-001`          | branchの末尾が`else`ではない                   |
| `K4-STABLE-ID-001`       | `stableId`が文書内で重複                       |
| `K4-KEY-001`             | navigation keymapと作品内key inputが衝突       |
| `K4-COMMAND-UNSUPPORTED` | Action Registryにないcustom action             |

入力byte数、YAML node数、nesting深度、scalar長、scene数、sceneごとのaction数、asset数、診断数には
資源上限を設け、超過を`K4-RESOURCE-LIMIT`で停止します。実装済み上限、必須explicit上限、benchmarkに
基づくfrontend提案値、診断の切詰めとredactionは
[`DSL 4.0 式評価・資源上限・診断境界`](dsl-4-expression-limits-diagnostics.md)を正本とします。
