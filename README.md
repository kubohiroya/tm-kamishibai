# TMPose紙芝居

**ポーズで進めるAIインタラクティブ紙芝居**

TMPose紙芝居は、TurboWarpとTMPoseを利用し、参加者がカメラの前でポーズを取ることで物語を進める紙芝居システムです。このリポジトリには、紙芝居アプリのソース、配布用SB3、公開ページ、および台本とアセットをSB3へ組み込むビルダーがあります。ドキュメントは専用の[`tmpose-kamishibai-docs`](https://github.com/kubohiroya/tmpose-kamishibai-docs)リポジトリで管理します。

## 使ってみる

- [現在公開中のWeb版](https://sqs.prof.cuc.ac.jp/kamishibai/)
- [GitHub Pages版](https://kubohiroya.github.io/tmpose-kamishibai/)
- [サンプル](https://kubohiroya.github.io/tmpose-kamishibai-samples/)

利用方法、台本の書式、利用できるコマンドについては[ドキュメントサイト](https://kubohiroya.github.io/tmpose-kamishibai-docs/)を参照してください。

## npmパッケージ

[`@kubohiroya/tmpose-kamishibai`](https://www.npmjs.com/package/@kubohiroya/tmpose-kamishibai)は、DSL 4.0 YAMLの検証、local preview、自己完結SB3の生成と、3.1／3.2台本の変換を行うCLI／JavaScript APIを提供します。

検証済みバージョンを固定して導入します。

```bash
pnpm add --save-exact @kubohiroya/tmpose-kamishibai@4.0.0
```

```bash
pnpm exec tmpose-kamishibai build-sb3 \
  --base kamishibai.sb3 \
  --script source.txt \
  --assets assets.lock.json \
  --output dist/_sample \
  --profile editor
```

DSL 4.0では、外部YAML正本と`project.source.json`から自己完結SB3を生成できます。有限上限と保存channelは省略できません。

```json
{
  "formatVersion": 1,
  "mode": "external",
  "sourceId": "main",
  "path": "story.k4.yml"
}
```

一般作者向けの最小構成では、YAMLと単一file assetをproject root直下へ置けます。

```text
project-root/
├── project.source.json
├── story.k4.yml
├── hero.svg
├── opening.mp3
└── rescue-pose/
    ├── model.json
    ├── metadata.json
    └── weights.bin
```

```bash
pnpm exec tmpose-kamishibai build-dsl4 \
  --base kamishibai-4-base.sb3 \
  --project-root . \
  --source-manifest project.source.json \
  --output dist/story-4.sb3 \
  --control-profile production \
  --channel bundled \
  --max-source-bytes 262144 \
  --max-asset-file-bytes 16777216 \
  --max-asset-files 256 \
  --max-total-asset-bytes 134217728
```

DSL embedded assetをBase64本文ではなくSB3 rootのcontent-addressed entryとして試す場合は、build開始時に
`--enable-root-binary-entries`を明示します。これは既定OFFです。OFFでは従来のBase64形式を生成するため、
ロールバック時はflagを外して成果物を再buildします。entry形式、対応sbdl version、Packager／session backingの契約は
[DSL 4.0 root binary／Packager契約](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-root-binary-packager-contract.md)を参照してください。

root-entry SB3をTurboWarp Packagerへ渡す場合は、固定`@turbowarp/packager` 3.13.0とbuilder exportの
`packageDsl4WithTurboWarpPackager()`を使用します。Plain HTML／`zip-one-asset`は同じPackager ZIP closureを
`scaffolding.loadProject()`前に登録し、通常ZIP／Electronは`assets/`配下の個別entryをdirect sourceとして登録します。
実行時のPackager objectを差し替えたり、生成HTMLを任意の文字列置換で更新したりしないでください。対応templateが変化した場合、
adapterはbuildをfail closedにします。必要な引数とsurface別の所有権は上記契約書を参照してください。

TurboWarpエディターでSB3を直接開いて実行する成果物は、`--enable-root-binary-entries`を指定せずBase64形式でbuildしてください。
エディターは読み込み後にSB3 ZIP entry sourceを保持しないため、v3 root-entry descriptorだけを持つSB3は直接実行できません。

`project.source.json`の`path`を省略すると、後方互換のためproject root直下の`story.kamishibai.yaml`を使用します。新規sourceの推奨suffixは`.k4.yml`です。別名には`.k4.yml`、`.k4.yaml`、`.kamishibai.yml`、`.kamishibai.yaml`のいずれかで終わるproject root直下のnormalized basenameを指定できます。YAML内のlocal asset pathはproject root基準で、`assets/`や`pose-models/`等の分類directoryは任意です。初回の正常buildでは、台本別remote cacheを分離する`cacheId`と`cacheDatabaseName`をmanifestへatomicに追記し、以後のbuildと台本名変更でも同じidentityを使用します。YAMLがローカル参照する画像・音声・pose modelは生成SB3へ埋め込みます。`delivery: remote`のpose modelは通常のTMPoseディレクトリURLだけでも指定でき、内容を固定したい場合は`file`へローカル化して埋め込みます。integrity／Content-Type／sizeをすべて指定したremote assetは検証metadataだけを格納します。出力はdisk上の候補を共有startup loaderで再検証してからatomicに置換され、失敗時は既存SB3を保持します。

`--enable-source-includes`を使う場合、`--max-source-bytes`は各source fileの上限、`--max-total-source-bytes`はSource Graph全sourceのbyte合計とcomposed canonical sourceの両方の上限です。後者は前者以上でなければならず、builder、source descriptor、disk candidate、runtime loaderは同じcomposed source上限を使用します。

local previewでも同じflagとgraph上限を指定できます。ON時はincluded sourceとlocal assetを含む全体を二回取得し、同じgeneration keyになった場合だけruntimeへstageします。新規sourceは任意のbasename／directoryで`.k4.yml` suffixを使用できます（entry sourceだけはmanifestのroot-level basenameです）。途中保存や一部assetだけが新しい状態は公開しません。詳細は[DSL 4.0 Source Graph Preview](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-source-include-preview.md)を参照してください。

実カメラを使う最終確認は、[DSL 4.0 実Chrome・実カメラ Smoke 手順](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-physical-camera-smoke.md)に従います。自動E2Eはカメラをスタブ化しているため、実機確認の代替にはなりません。

配布用の非埋め込み Standard SB3は、制作・デバッグ用ランナーとして起動します。HTTPSのtop-level
desktop Chrome／Edgeに開き、メニューの「Open」から台本ファイル、または
`project.source.json`を持つproject directoryをread-only選択すると、サーバーを起動せずに
YAML保存を500 ms間隔で監視します。validな保存は
確認ダイアログを出さず、既定の現在actionから自動reloadし、安全に再開できなければscene、台本先頭へ
fallbackします。reload status buttonを押した場合だけ、次回以降の再開位置を変更できます。

project directoryを開いた場合は、YAMLが宣言するlocal file assetを同じrootから安定読込し、
remote assetとSB3内のproject assetも同じgenerationで再解決します。TurboWarp Editorにドロップして
追加したコスチューや音声はSB3側が所有したままで、YAMLの`name`参照から利用できます。
台本ファイル単体でもSB3内project assetとremote assetは利用できますが、隣接local file assetは
読めないためproject directoryを選択します。

`build-dsl4`が台本を埋め込んだ作品SB3は従来どおりproduction modeで起動し、filesystem pickerや
watcherを初期化しません。非対応browserでは、非埋め込みSB3も従来の単発YAML file pickerへ
fallbackします。その場合やasset-only更新まで独立に監視する場合は、次のlocal previewを使用します。

台本を保存するたびに実TurboWarp runtimeへ反映するlocal previewは、次のdevelopment-only commandで起動します。base runtimeとbrowser bundleはmemory上で一度だけbuildし、YAML-only変更でSB3を再buildしません。loopback以外へはbindせず、browser runtimeから認証済みready応答が来るまで起動成功を表示しません。終了は`Ctrl-C`です。

```bash
pnpm exec tmpose-kamishibai preview-dsl4 --watch \
  --base kamishibai-4-base.sb3 \
  --project-root . \
  --source-manifest project.source.json \
  --control-profile production \
  --channel bundled \
  --max-source-bytes 65536 \
  --max-asset-file-bytes 16777216 \
  --max-asset-files 64 \
  --max-total-asset-bytes 67108864 \
  --max-project-bytes 201326592 \
  --max-project-json-bytes 201326592
```

stableかつvalidなYAML変更は保存のたびにblocking dialogを出さず、safe boundaryで自動reloadします。session方針の
既定は現在actionで、replay-safeでなければ現在scene、さらに利用不能ならストーリー先頭へfallbackします。常時表示の
reload status buttonはcommit完了を通知し、押した場合だけ、今回の手動reload位置または次回以降の方針をstory／scene／
actionから設定するdialogを開きます。

`--max-project-bytes`と`--max-project-json-bytes`は省略時192 MiBです。アセット128 MiB、SB3 256 MiB、
展開後`project.json` 256 MiBの推奨上限を超えてpreviewする場合は、値を明示したうえで
`--allow-large-preview-artifacts`を追加してください。確認済みの拡張値にも、アセット512 MiB、SB3／JSON 1 GiBの
絶対上限を適用します。

Source Graphを監視する場合は、上のcommandへ次を追加します。

```bash
  --enable-source-includes \
  --max-source-files 64 \
  --max-total-source-bytes 4194304 \
  --max-include-depth 32
```

buildやpreviewと同じDSL 4.0 frontendで、台本だけを副作用なしに検証できます。上限は省略できません。`pretty`は`filename:line:column`形式を、`json`はversion付き診断envelopeだけを出力し、source本文や絶対pathを含めません。終了statusは正常`0`、source／validation error `1`、CLI usage／internal failure `2`です。

```bash
pnpm exec tmpose-kamishibai validate-dsl4 \
  --input story.k4.yml \
  --max-source-bytes 262144 \
  --format pretty
```

配布profileを使うprojectでは、既存の`project.assets.json`と`project.assets.lock.json`から、
embedded／remote容量、startup／scene別のpreload集合、重複容量、offline readinessを副作用なしに
監査できます。このcommandはremote assetを取得せず、cacheを参照せず、fileを書き換えません。

lockを新規生成または更新する場合は、remote取得を明示的に許可するhostと有限上限を指定します。
redirect先もHTTPS／allowlistを再検証し、既存lockは検証済みcandidateのatomic置換まで変更しません。

```bash
pnpm exec tmpose-kamishibai lock-dsl4-assets \
  --project-root . \
  --source-manifest project.source.json \
  --asset-config project.assets.json \
  --output project.assets.lock.json \
  --allow-host cdn.example.com \
  --max-source-bytes 262144 \
  --max-source-manifest-bytes 16384 \
  --max-asset-file-bytes 16777216 \
  --max-asset-files 256 \
  --max-total-asset-bytes 134217728 \
  --timeout-ms 10000 \
  --max-redirects 3
```

```bash
pnpm exec tmpose-kamishibai audit-dsl4-assets \
  --project-root . \
  --source-manifest project.source.json \
  --asset-config project.assets.json \
  --asset-lock project.assets.lock.json \
  --asset-profile online \
  --max-source-bytes 262144 \
  --max-source-manifest-bytes 16384 \
  --max-asset-config-bytes 65536 \
  --max-asset-lock-bytes 262144 \
  --format pretty
```

remote assetをネットワークなしで配布する場合は、lockのremote providerを再取得・再検証して
content-addressed mirrorへ固定し、embedded providerを追加したoffline用config／lockを生成します。
入力config／lockは変更されず、mirrorとJSONは検証済みcandidateだけがatomicに置換されます。

```bash
pnpm exec tmpose-kamishibai vendor-dsl4-assets \
  --project-root . \
  --asset-config project.assets.json \
  --asset-lock project.assets.lock.json \
  --output-config project.assets.offline.json \
  --output-lock project.assets.offline.lock.json \
  --vendor-dir .kamishibai/vendor/dsl4-assets \
  --allow-host cdn.example.com \
  --max-asset-config-bytes 65536 \
  --max-asset-lock-bytes 262144 \
  --max-asset-file-bytes 16777216 \
  --max-asset-files 256 \
  --max-total-asset-bytes 134217728 \
  --timeout-ms 10000 \
  --max-redirects 3
```

profile設定、lock形式、解決順序、audit出力の詳細は
[DSL 4.0アセット配布プロファイル](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-asset-distribution-profiles.md)を
参照してください。

生成したconfig／lockは、`build-dsl4`で明示的にprofileを選んで接続します。`offline`では
`network: forbidden`とcontent-addressed embedded mirrorが検証され、runtime componentにも同じ
resolved StoryDocumentが保存されます。

```bash
pnpm exec tmpose-kamishibai build-dsl4 \
  --base BASE.sb3 --project-root . \
  --source-manifest project.source.json --output dist/story.sb3 \
  --control-profile production --channel bundled \
  --max-source-bytes 262144 --max-asset-file-bytes 16777216 \
  --max-asset-files 256 --max-total-asset-bytes 134217728 \
  --asset-config project.assets.offline.json \
  --asset-lock project.assets.offline.lock.json \
  --asset-profile offline \
  --max-asset-config-bytes 65536 --max-asset-lock-bytes 262144
```

DSL 4.0の`say`／`think`では、`seconds`と`waitFor: advance`を併記すると、入力または指定秒数の経過の
早い方で吹き出しを終了できます。`characterIntervalSeconds`はgrapheme単位の文字送り、
`startSound`は吹き出し表示開始時に1回再生するsound asset、`characterSound`は1文字ごとのsound assetを
指定します。`startSound`へセリフ音声を指定すると、フルボイスのノベルゲームを構成できます。文字送り中に
入力またはタイムアウトが成立した場合は、残り全文を効果音なしで一括表示して次のactionへ進み、再生中の
`startSound`も停止します。speech soundの停止単位はAsset Managerのasset IDです。同じsound assetを
speechとBGMなどで同時再生せず、用途ごとに別のasset IDを割り当ててください。
`noSoundCharacters`には文字音を鳴らさない文字、`restCharacters`には文字音を鳴らさず長めに休止する
文字を連結して指定します。休止時間は`restCharacterIntervalSeconds`で指定します。文字集合の判定は
本文と同じUnicode grapheme cluster単位です。これらの文字送り設定はトップレベルの`bubbleStyles`へ
名前付きの部分styleとしてまとめ、`say`／`think`の`styles`配列から複数を再利用できます。styleは記載順に
deep mergeされ、後のstyleを優先し、最後にaction内指定を適用します。配列値は連結せず全体を置換します。
style名には内部空白や日本語を使用できますが、前後空白、改行、tab、制御文字は使用できません。
style定義内の`styles`配列から既存styleを合成して、新しい名前付きstyleを定義することもできます。参照先を
順に合成してから定義自身のpropertyを適用し、循環参照、未知参照、重複参照はエラーにします。

```yaml
assets:
  HeroIdle: costume:Hero
  HeroGreetingVoice: sound
  Typewriter: sound
  Next1:
    kind: image
    file: ui/next-1.png
  Next2:
    kind: image
    file: ui/next-2.png
actors:
  Hero: HeroIdle
bubbleStyles:
  Typing base:
    characterIntervalSeconds: 0.05
    noSoundCharacters: '「」'
  日本語 効果音:
    characterSound: Typewriter
    restCharacters: '、。…'
    restCharacterIntervalSeconds: 0.5
    continueIndicator:
      frames: [Next1, Next2]
      frameIntervalSeconds: 0.12
  Hero style:
    styles:
      - Typing base
      - 日本語 効果音
    placement: FOOTER_LIKE
    visualStyle: NARRATION
scenes:
  opening:
    - Hero.say:
        text: こんにちは！
        seconds: 10
        waitFor: advance
        styles:
          - Hero style
        startSound: HeroGreetingVoice
```

`continueIndicator`は`waitFor: advance`で全文の表示が終わってから入力を待つ間だけ、本文末尾に
`frames`のimage assetを順番にループ表示します。`frames`は2枚以上、`frameIntervalSeconds`は正の秒数です。
文字送り中、secondsだけのspeech、入力・timeout・cancel・stop後は表示しません。各frameはstyleを参照する
sceneのasset依存へ含まれます。

DSL 4.0の吹き出し表示は`@kubohiroya/turbowarp-bubble` Compositionが所有します。
`textStyle`は本文レイヤーの`textStyles` ID、`placement`はactor相対16方位または
`HEADER_LIKE`／`CENTER`／`FOOTER_LIKE`、`visualStyle`は吹き出し外形を指定します。
portraitのbase／blink／lip-syncと`continueIndicator`のframe assetもstyleへ宣言でき、参照sceneの
lazy dependencyとして読み込まれます。Bubble 0.4のcoreはホスト非依存の`BubbleTextCapability`だけを参照し、
TurboWarp Runtime HostがSVG Text compositionをadapterで接続します。SVG Textは`Actor.setText`とBubble内部の
本文レイヤーに限って使用し、`Actor.say`／`Actor.think`のsurfaceとlifecycleはBubbleが管理します。

Bubble 0.4では、`maxWidth`と`textLocale`による実測幅ベースの自動改行、`CHARACTER`／`WORD`／
`LINE`／`BLOCK`単位のnative reveal、`voice`／`reveal`／`finish`音声、表示開始・表示中・表示終了
animationを利用できます。`visibleAnimations`は配列順に`handle.animate()`へ接続され、shake、explode、
外形animationを同じsurface上で実行します。native revealと旧`characterIntervalSeconds`系は同じ
effective styleへ混在させず、用途に応じてどちらか一方を選びます。

これらの拡張は起動時固定の`dsl4SpeechAdvanceTypewriter`、`dsl4BubbleAdvanceIndicator`、
`dsl4TurboWarpBubble`、`dsl4TurboWarpBubbleAdvancedPresentation` feature flagが既定OFFです。
Bubble経路ではportraitとindicatorもBubbleが所有します。入力対象や
`seconds`／`waitFor`の組み合わせを含む完全な仕様は
[DSL 4.0 surface仕様](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-surface.md#72-actor-action)を参照してください。

API、アセットマニフェスト、安全設定、出力形式については[メンテナンスガイド](https://kubohiroya.github.io/tmpose-kamishibai-docs/developer-guides/developer-guide/)を参照してください。

### DSL 3.1／3.2から4.0への変換

外部テキストのDSL 3.1／3.2台本を、入力を変更せずDSL 4.0 YAMLへ変換できます。コマンド、pose model
置換、診断、自動変換できない入力、変換後の検証、JavaScript APIは、独立した
[紙芝居DSL 3.2から4.0への変換ガイド](https://kubohiroya.github.io/tmpose-kamishibai-docs/4.0/dsl-author-guides/dsl-3.2-to-4.0-conversion-guide/)を
参照してください。

## DSL 3.2の互換性

tmpose-kamishibai 3.2.xは、冒頭が`kamishibai=3.1`または`kamishibai=3.2`の台本を読み込めます。既存の3.1台本は冒頭を書き換えずに実行でき、新規の台本には`kamishibai=3.2`を推奨します。旧Text Asset構文はdeprecatedですが、移行期間中も表示・更新処理を含めて利用できます。

- `asset=NAME,text`
- `text=NAME:VALUE`
- `textStyle=NAME:PROPERTY:VALUE`
- `action=text:NAME:VALUE`
- 旧Text Assetを参照する`show`および`setSkin`

旧構文を含む台本では、プロジェクトごとに一度`LEGACY_TEXT_ASSET_DEPRECATED`警告を開発者コンソールへ出力しますが、実行は継続します。旧Text Assetは少なくとも3.2系列では維持し、削除する場合は将来のメジャーバージョンで事前に告知します。移行先は[`kubohiroya/turbowarp-svg-text`](https://github.com/kubohiroya/turbowarp-svg-text)です。この機能拡張を組み込んだ3.2プロジェクトでは、旧Text Assetと新しいSVG Textを同じ台本内で併用できます。新規の台本では、名前付きスタイルを共有するSVG Textを使用してください。アプリ自身のメニューやタイトルで使用する内部テキスト表示は、この警告の対象外です。

SVG Textは`./composition` APIを含むnpm package `@kubohiroya/turbowarp-svg-text@0.3.0`（gitHead `05580a6018ebcb078d22334619c533f548a1f7ed`）をexact versionで利用します。台本のシーン定義より前に、背景色、文字色、フォント、相対フォントサイズ、配置、吹き出し方向を名前付きスタイルとして定義します。サイズ`100`は480×360ステージにおける標準14px相当で、ステージ寸法に比例して拡大・縮小します。

```text
svgTextStyle=title:#112233:#ffffff:Noto Sans JP:150:center:up
```

値の並びは`STYLE:BACKGROUND:TEXT_COLOR:FONT:SIZE:ALIGN:DIRECTION`です。`ALIGN`は`left`、`center`、`right`から指定します。`DIRECTION`の16方向は、`up`、`up-up-right`、`up-right`、`right-up-right`、`right`、`right-down-right`、`down-right`、`down-down-right`、`down`、`down-down-left`、`down-left`、`left-down-left`、`left`、`left-up-left`、`up-left`、`up-up-left`です。

方位エイリアスとして`north`、`northeast`、`east`、`southeast`、`south`、`southwest`、`west`、`northwest`の8方位と、`north-northeast`、`east-northeast`、`east-southeast`、`south-southeast`、`south-southwest`、`west-southwest`、`west-northwest`、`north-northwest`を含む16方位を指定できます。また、`0`以上`360`以下の数値と小数角度も指定できます。Scratchのスプライト方向と同じく`0`は上、`90`は右、`180`は下、`270`は左、`360`は`0`と同じ方向です。方向は吹き出しにだけ適用されます。

アクター自身をSVGテキストとして表示するには、アクションで文字列とスタイル名を指定します。文字列中のリテラル`\n`は改行になります。アニメーションは3.2系列の対象外です。

```text
action=Hero:setText:タイトル\nサブタイトル:title
```

アクターの`say`または`think`吹き出しへ名前付きスタイルを適用する場合は、表示秒数の後にスタイル名を指定します。

```text
svgTextStyle=baloonStyle:#ffffff:#222222:Noto Sans JP:120:left:up-right

action=Hero:say:こんにちは:5.0:baloonStyle
action=Hero:think:どうしよう……:5.0:baloonStyle
```

書式は`action=ACTOR:say|think:TEXT:SECONDS:STYLE`です。スタイル名を省略した従来の`action=Hero:say:こんにちは`および`action=Hero:say:こんにちは:5.0`は引き続き`default`スタイルを使用します。

## このリポジトリを開発する

### 必要な環境

- Node.js 22.12.0以上
- pnpm 11

### セットアップ

```bash
pnpm install
```

### 主なコマンド

| コマンド                                  | 内容                                            |
| ----------------------------------------- | ----------------------------------------------- |
| `pnpm run build`                          | 公開ページと配布用SB3を`dist/`へ生成            |
| `pnpm test:quick`                         | 事前生成SB3と重い実VM統合を除き短時間でテスト   |
| `pnpm test` / `pnpm test:full`            | 生成SB3と実VMを含む全テストを実行               |
| `pnpm verify:quick`                       | lint、型検査、Quickテストを実行                 |
| `pnpm verify:full`                        | CI相当の全検証、ビルド、パッケージ検査を実行    |
| `pnpm lint`                               | JavaScriptを検査                                |
| `pnpm typecheck`                          | ビルダーAPIを型検査                             |
| `pnpm sb3:build`                          | `app/`から編集用SB3を`tmp/kamishibai.sb3`へ生成 |
| `pnpm sb3:check`                          | `app/`のSB3ソースを検証                         |
| `pnpm sb3:import -- /path/to/project.sb3` | TurboWarpで編集したSB3を`app/`へ取り込み        |
| `pnpm run deploy`                         | ビルド結果をGitHub Pagesへ公開                  |

日常の実装中は`pnpm verify:quick`を使用し、PR前とCIでは`pnpm verify:full`を使用します。
新しい`test/*.test.mjs`は自動的にQuickとFullの両方へ入り、生成SB3または実VMが必要なテストだけを
`scripts/test/run-suite.mjs`のFull専用一覧へ明示します。Quickは生成物がないclean checkoutでも実行できます。

`pnpm sb3:*`は`devDependencies`へ厳密バージョン固定した`@kubohiroya/sb3-toolchain@0.6.0`を使用します。
CIでも`pnpm verify:full`を通して`pnpm sb3:check`を実行し、同じツールチェインで`app/`を検証します。

GitHub Pagesのバージョン別カードと配布SB3は`scripts/download-catalog.mjs`を単一の正本として
生成します。公開済み系列の入力は`release-sources/<version>/`へ固定し、build dateとSHA-256も
カタログで固定します。このためサイトの再ビルドに完全なGit履歴は不要で、同じversionの配布物が
意図せず変化した場合はビルドを失敗させます。

主な生成先は次のとおりです。

- `dist/`: GitHub Pagesへ公開する入口ページと配布用SB3
- `tmp/kamishibai.sb3`: TurboWarpで編集するためのSB3

## リポジトリ構成

- `app/`: 紙芝居SB3のGit管理上の正本
- `release-sources/`: 公開済みSB3を再生成する不変のversion別source snapshot
- `src/builder/`、`src/dsl4/`、`schema/`、`bin/`: npmで配布するDSL 3.2／4.0ビルダーAPIとCLI
- `site/`: 公開サイトの静的ファイル
- `scripts/`: 公開ページとSB3のビルド処理
- `test/`: 自動テストと最小検証用台本

## ドキュメント

一般向け、紙芝居DSL作成者向け、開発者向け、および体験会資料は、[公開ドキュメント一覧](https://kubohiroya.github.io/tmpose-kamishibai-docs/)から参照できます。原稿、図版、Vivliostyle設定は[`kubohiroya/tmpose-kamishibai-docs`](https://github.com/kubohiroya/tmpose-kamishibai-docs)で管理します。

実装前の設計レビュー資料として、[紙芝居DSL 4.0 設計レビュー草案](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-design.md)をこのリポジトリで管理します。

## 関連プロジェクト

- [`kubohiroya/sb3-toolchain`](https://github.com/kubohiroya/sb3-toolchain): このリポジトリで利用している、SB3の展開・検証・再構築・埋め込み拡張管理のためのツール
- [`kubohiroya/tmpose-kamishibai-samples`](https://github.com/kubohiroya/tmpose-kamishibai-samples): サンプル台本、スプライト、背景、画像、音声、組み込み済みSB3
- [`kubohiroya/tmpose-kamishibai-docs`](https://github.com/kubohiroya/tmpose-kamishibai-docs): 一般向け、DSL作成者向け、開発者向け、および体験会のドキュメント

## ライセンス

個別表示のない、本プロジェクトが著作権を持つソフトウェアおよび素材にはMPL-2.0を適用します。詳細と第三者著作物の扱いは[`LICENSES.md`](LICENSES.md)を参照してください。移設した文書のライセンスは文書リポジトリで管理します。
