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
  --max-source-bytes 1048576 \
  --max-asset-file-bytes 16777216 \
  --max-asset-files 256 \
  --max-total-asset-bytes 134217728
```

`project.source.json`の`path`を省略すると、後方互換のためproject root直下の`story.kamishibai.yaml`を使用します。新規sourceの推奨suffixは`.k4.yml`です。別名には`.k4.yml`、`.k4.yaml`、`.kamishibai.yml`、`.kamishibai.yaml`のいずれかで終わるproject root直下のnormalized basenameを指定できます。YAML内のlocal asset pathはproject root基準で、`assets/`や`pose-models/`等の分類directoryは任意です。初回の正常buildでは、台本別remote cacheを分離する`cacheId`と`cacheDatabaseName`をmanifestへatomicに追記し、以後のbuildと台本名変更でも同じidentityを使用します。YAMLがローカル参照する画像・音声・pose modelは生成SB3へ埋め込み、`delivery: remote`を明示したassetは検証metadataだけを格納します。出力はdisk上の候補を共有startup loaderで再検証してからatomicに置換され、失敗時は既存SB3を保持します。

`--enable-source-includes`を使う場合、`--max-source-bytes`は各source fileの上限、`--max-total-source-bytes`はSource Graph全sourceのbyte合計とcomposed canonical sourceの両方の上限です。後者は前者以上でなければならず、builder、source descriptor、disk candidate、runtime loaderは同じcomposed source上限を使用します。

local previewでも同じflagとgraph上限を指定できます。ON時はincluded sourceとlocal assetを含む全体を二回取得し、同じgeneration keyになった場合だけruntimeへstageします。新規sourceは任意のbasename／directoryで`.k4.yml` suffixを使用できます（entry sourceだけはmanifestのroot-level basenameです）。途中保存や一部assetだけが新しい状態は公開しません。詳細は[DSL 4.0 Source Graph Preview](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-source-include-preview.md)を参照してください。

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
  --max-total-asset-bytes 67108864
```

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
  --max-source-bytes 1048576 \
  --format pretty
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
本文と同じUnicode grapheme cluster単位です。これらの文字送り設定はトップレベルの`speechStyles`へ
名前付きでまとめ、`say`／`think`の`style`から再利用できます。`text`、`seconds`、`waitFor`、
`startSound`はactionごとに指定します。styleを使うactionに文字送り設定を重ねて指定することはできません。
既存のインライン指定も引き続き使用できます。

```yaml
assets:
  HeroIdle: costume:Hero
  HeroGreetingVoice: sound
  Typewriter: sound
actors:
  Hero: HeroIdle
speechStyles:
  novel:
    characterIntervalSeconds: 0.05
    characterSound: Typewriter
    noSoundCharacters: '「」'
    restCharacters: '、。…'
    restCharacterIntervalSeconds: 0.5
scenes:
  opening:
    - Hero.say:
        text: こんにちは！
        seconds: 10
        waitFor: advance
        style: novel
        startSound: HeroGreetingVoice
```

この拡張は起動時固定の`dsl4SpeechAdvanceTypewriter` feature flagが既定OFFです。入力対象や
`seconds`／`waitFor`の組み合わせを含む完全な仕様は
[DSL 4.0 surface仕様](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-surface.md#72-actor-action)を参照してください。

API、アセットマニフェスト、安全設定、出力形式については[メンテナンスガイド](https://kubohiroya.github.io/tmpose-kamishibai-docs/developer-guides/developer-guide/)を参照してください。

### DSL 3.1／3.2から4.0への変換

外部テキストのDSL 3.1／3.2台本を、DSL 4.0 YAMLへ明示的に変換できます。DSL 3.1は、3.2.3が
維持する互換grammarとしてwarning付きで解釈します。入力ファイルは変更せず、変換に成功した場合だけ
出力をatomicに作成または置換します。

```bash
pnpm exec tmpose-kamishibai convert-dsl4 \
  --input source.txt \
  --output story.kamishibai.yaml \
  --pose-models pose-models.json
```

3.1／3.2の`TMPoseURL`はremote URLのまま4.0へ移せません。ポーズを使う台本では、URLとlocal
`poseModel` assetの対応をJSONで明示します。converterはURLを取得せず、指定したproject-relative
pathだけを台本へ記録します。

```json
{
  "https://example.com/models/rescue/": {
    "id": "RescuePose",
    "file": "rescue-pose",
    "loading": "lazy"
  }
}
```

asset、actor、cover、runtime variable、loading、pose recognition sound、SVG Text style、branch、
scene、およびDSL 4.0 coreに対応するactionを変換します。3.1互換解釈、型推論、costumeのlogical actorへの
付け替え、旧DSLに秒数指定がないtransitionには、元ファイルの行・列を含むwarningを標準エラー出力へ表示します。

意味を保てない次の入力は、変換結果を部分出力せずerrorにします。

- 旧Text Asset、remote／cache asset
- 秒数なしの永続`say`／`think`、style付き`say`／`think`、`hide`など意味を保って自動変換できないaction
- 4.0で必須のcharge soundがないpose recognition設定
- local model置換がない`TMPoseURL`、空のpose名、要素数が異なるbranch／key／touch inputのparallel list
- 最後の無条件遷移がないbranch

3.1／3.2の`Actor:pose`は候補選択ではなく、pose名の順にすべて成立させる4.0
`Actor.pose.steps`へ変換します。skin／soundの不足要素は旧runtimeと同じく省略扱い、pose数を超える余分な
要素はwarning付きで除外します。Async Inputによる候補1件選択は3.1／3.2テキストDSLのactionではなく
SB3 block graph側の機能であるため、このconverterは`poseInputToChangeScene`を推測生成しません。

headerの`poseRecog`は`sequence.confidenceThreshold`へ変換します。旧runtimeが0.1秒ごとに100を目標として
`confidence × poseCharge`を加えるため、`poseCharge`は
`sequence.fullConfidenceHoldSeconds = 10 / poseCharge`へ変換します。`poseIdle=0`はそのまま変換
できますが、非zero値は旧runtimeだけがconfidenceを乗算するため、意味を変えず自動変換できません。
scene内の`setRuntimeVariable`と、1以外の`startSceneIndex`も4.0 coreに同等の実行位置がないため
errorにします。

対応表、判定分類、旧Text AssetのSVG Text移行例は
[DSL 4.0移行仕様](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-migration.md)を
参照してください。

JavaScriptから副作用なしで変換する場合は、package exportを利用できます。

```js
import {convertDsl32ToDsl4} from '@kubohiroya/tmpose-kamishibai/converter';

const result = convertDsl32ToDsl4(sourceText, {sourceId: 'source.txt'});
if (result.ok) console.log(result.yaml);
```

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

`pnpm sb3:*`は`devDependencies`へcommit固定した`@kubohiroya/sb3-toolchain`を使用します。
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
