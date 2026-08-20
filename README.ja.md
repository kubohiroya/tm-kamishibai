# TMPose紙芝居

[English](README.md) | 日本語

**ポーズで物語に参加する、AIインタラクティブ紙芝居**

TMPose紙芝居は、カメラの前で取ったポーズをきっかけに、登場人物、背景、音声、セリフ、分岐を進める参加型の紙芝居システムです。ポーズ認識にはTMPose、作品の編集と実行にはTurboWarpを使い、台本とアセットからWeb／SB3形式の作品を作れます。

このリポジトリでは、紙芝居ランタイム、DSL、CLI／JavaScript API、配布用SB3、公開サイトを開発しています。操作方法や台本リファレンスの正本は[ドキュメントサイト](https://kubohiroya.github.io/tmpose-kamishibai-docs/)です。

![カメラ映像の上に浦島太郎とカメを重ね、ポーズ認識で紙芝居を進めている画面](site/images/image01.png)

[公式サイト](https://kubohiroya.github.io/tmpose-kamishibai/) · [Web版を体験する](https://sqs.prof.cuc.ac.jp/kamishibai/) · [SB3をダウンロードする](https://kubohiroya.github.io/tmpose-kamishibai/downloads/) · [作り方を読む](https://kubohiroya.github.io/tmpose-kamishibai-docs/) · [サンプルを見る](https://kubohiroya.github.io/tmpose-kamishibai-samples/)

## このプロジェクトでできること

- 参加者のポーズ、キー入力、画面タッチで物語を進める
- YAMLまたは3.1／3.2テキストDSLで、シーン、分岐、セリフ、動き、音声、ポーズ認識を記述する
- TurboWarp上で台本をプレビューし、配布できる自己完結SB3を作る
- CLIで検証、live preview、SB3生成、旧DSL変換、アセット配布を自動化する
- DSL 4.0のcore actionをTurboWarpブロックまたはJavaScript APIから呼び出す

## どの版を使うか

|                      | 3.2.3                                | 4.0.0-rc.8                                   |
| -------------------- | ------------------------------------ | -------------------------------------------- |
| 状態                 | 安定版・現在の推奨                   | リリース候補                                 |
| 向いている用途       | 体験会、安定運用、既存の3.1／3.2作品 | YAML台本、ブラウザ制作、CLI／APIの先行検証   |
| 台本                 | 3.1／3.2テキストDSL                  | DSL 4.0 YAML                                 |
| 入手先               | [ダウンロードページ][downloads]      | [ダウンロードページ][downloads]／npmの`next` |
| 変更時に確認する文書 | [公開ドキュメント][docs]             | [4.0リリースノート][rc8]                     |

迷った場合は3.2.3を使ってください。4.0.0-rc.8は正式版前の公開候補であり、安定運用よりも4.0の制作フローやAPIを検証したい場合に適しています。公開済みの3.1／3.2作品は、4.0へ移行しなくても引き続き利用できます。

## まず体験する

ブラウザですぐ試す場合は、[公開中のWeb版](https://sqs.prof.cuc.ac.jp/kamishibai/)または[「浦島太郎」のサンプル](https://kubohiroya.github.io/tmpose-kamishibai-samples/stories/urashima/web/)を開きます。カメラの利用を許可し、画面の案内に従ってポーズを取ってください。

作品ファイルをTurboWarpで開く場合は、[ダウンロードページ][downloads]から使用する系列のSB3を取得します。体験会で使う資料は[ワークショップ一覧](https://kubohiroya.github.io/tmpose-kamishibai-docs/workshops/)から選べます。

## DSL 4.0で作品を作る

### ブラウザだけで作る

4.0.0-rc.8のStandard SB3には、台本の選択、検証、live preview、配布用SB3生成までを行う作者用ランナーが入っています。

1. [4.0のSB3をダウンロード][downloads]し、[TurboWarp Editor](https://turbowarp.org/editor)で開く。
2. 緑の旗を押し、メニューの「開く」から台本ファイルまたはproject directoryを選ぶ。
3. 外部エディターでYAMLやlocal assetを編集する。正常な保存は検証後に自動反映される。
4. メニューの「配布用SB3を作る」から、台本とアセットを埋め込んだ作品SB3を保存する。

project directoryの監視には、File System Access APIを利用できるdesktop版Chrome／Edgeのtop-level HTTPS環境が必要です。nativeの保存先pickerを利用できない場合、成果物はbrowser downloadとして保存します。その他の非対応操作では、単一ファイル選択または後述のCLIを使います。詳しい画面操作、ブラウザ条件、エラーへの対処は[DSL 4.0作者ガイド](https://kubohiroya.github.io/tmpose-kamishibai-docs/dsl-author-guides/dsl-4.0-author-guide/)を参照してください。

### projectの最小構成

DSL 4.0 projectは、project root直下の`.k4.yml`台本一つだけでも成立します。画像・音声・
pose modelなどのassetも同じproject root以下に置けます。分類用directoryの名前は任意です。

```text
my-story/
└── opening.k4.yml
```

root直下の`.k4.yml`が一つだけなら、そのfileを自動選択するため`project.source.yml`は不要です。
台本を二つ以上置く場合は、固定file名に頼らず、`project.source.yml`またはCLIの`--source`で
entry sourceを選択します。

```text
my-story/
├── project.source.yml
├── opening.k4.yml
└── alternate-ending.k4.yml
```

```yaml
path: opening.k4.yml
```

`project.source.yml`の全項目を省略できます。

| 項目                           | 必須 | 値／省略時の扱い                                                                 |
| ------------------------------ | ---- | -------------------------------------------------------------------------------- |
| `formatVersion`                | 任意 | `1`                                                                              |
| `mode`                         | 任意 | `external`                                                                       |
| `sourceId`                     | 任意 | `main`。CLIの`--source-id`を指定すると上書きします。                             |
| `path`                         | 任意 | 固定既定名なし。`--source`、`path`、root直下で唯一の`*.k4.yml`の順に選択します。 |
| `cacheId`, `cacheDatabaseName` | 任意 | 既定では未設定。明示する場合は二つを必ず同時に指定します。                       |

空またはcommentだけのmanifestも、全項目の既定値を適用する有効な入力です。CLIにもmanifestにも
source指定がない場合、root直下の`.k4.yml`が0件または複数なら曖昧な選択をせずerrorになります。
manifestが存在しない場合に暗黙生成することもありません。

project入力では`project.source.yaml`と`project.source.json`も利用でき、`project.source.yml`の後に
この順で探索します。このREADMEの推奨例は`.yml`表記に統一します。

最小の`.k4.yml`台本は、versionと一つ以上のsceneを持ちます。

```yaml
kamishibai: '4.0'

controls:
  keymaps:
    production:
      Space: navigation.nextAction

scenes:
  opening:
    - wait: 1
    - goto: ending
  ending: []
```

`scenes`はsource上の記述順が通常の実行順です。sceneを自動で並べ替えるformatterを使わず、現行実装では数字だけのscene IDも避けてください。正式な契約と既知制約は[DSL 4.0表層仕様](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-surface.md#21-scenes-mappingの順序)にあります。

`Actor.say`／`Actor.think`の終了条件を再利用する場合は、トップレベルの`bubbleClosePolicies`に
`seconds`、`waitFor: advance`、または両方を定義し、actionから`closePolicy`名で参照します。表示用の
`bubbleStyles`とは独立しており、action内の`seconds`／`waitFor`との併用はできません。

より実用的な台本、アセット参照、ポーズモデル、分岐、吹き出しについては[作者ガイド](https://kubohiroya.github.io/tmpose-kamishibai-docs/dsl-author-guides/dsl-4.0-author-guide/)と[サンプルリポジトリ](https://github.com/kubohiroya/tmpose-kamishibai-samples)を参照してください。

### CLIで検証・preview・buildする

[`@kubohiroya/tmpose-kamishibai`](https://www.npmjs.com/package/@kubohiroya/tmpose-kamishibai/v/4.0.0-rc.8)のCLIは、CI、再現可能なbuild、大規模project、配布profileの管理に向いています。Node.js 22.12.0以上とpnpm 11を使用し、検証するversionを固定して導入します。

```bash
pnpm add --save-exact @kubohiroya/tmpose-kamishibai@4.0.0-rc.8
pnpm exec tmpose-kamishibai --help
```

台本だけを検証します。

```bash
pnpm exec tmpose-kamishibai validate-dsl4 \
  --input opening.k4.yml \
  --format pretty
```

project全体を監視し、ブラウザでpreviewします。

```bash
pnpm exec tmpose-kamishibai preview-dsl4 --watch \
  --base kamishibai-4-base.sb3 \
  --project-root . \
  --control-profile production \
  --channel bundled
```

同じ入力から自己完結SB3を生成します。

```bash
pnpm exec tmpose-kamishibai build-dsl4 \
  --base kamishibai-4-base.sb3 \
  --project-root . \
  --output dist/my-story.sb3 \
  --control-profile production \
  --channel bundled
```

4つの共通上限optionを省略すると、CLIは次の有限な安全上限を適用します。

| option                    | デフォルト | overrideまたは制約                                                   |
| ------------------------- | ---------- | -------------------------------------------------------------------- |
| `--max-source-bytes`      | 1048576    | 現行frontendの1 MiB上限。YAML node数とaction数も別に制限する         |
| `--max-asset-file-bytes`  | 16777216   | 確認済みの単一assetが16 MiBを超える場合に増やす                      |
| `--max-asset-files`       | 256        | build／asset処理では増やせるが、browser previewは現在256 filesが上限 |
| `--max-total-asset-bytes` | 134217728  | 確認済みassetの合計が128 MiBを超える場合に増やす                     |

これらは予約memory量ではなく上限値です。sourceの1 MiB上限は、既存のaction上限内で長い台詞を
持つ入力を計測した結果から選びました。計測値と判断根拠は
[resource limit設計](./docs/design/dsl-4-expression-limits-diagnostics.md#23-source-frontend既定policy)に
記録しています。例外的に大きいassetは明示overrideできますが、previewで推奨上限のasset合計
128 MiBを超える場合は`--allow-large-preview-artifacts`が必要で、browserの絶対上限も残ります。
Source Graph includeはopt-inのままであり、graph構造を安全に推定できないため、file数・source合計
byte数・深さの各上限を別途指定します。

CLIにはほかに次のcommandがあります。引数と終了statusは`tmpose-kamishibai --help`および[メンテナンスガイド](https://kubohiroya.github.io/tmpose-kamishibai-docs/developer-guides/developer-guide/)で確認できます。

| command               | 用途                                                  |
| --------------------- | ----------------------------------------------------- |
| `build-sb3`           | 3.1／3.2台本とアセットからSB3一式を生成               |
| `convert-dsl4`        | 3.1／3.2テキストDSLを4.0 YAMLへ変換                   |
| `convert-dsl4-assets` | 4.0アセットをlocal／remote／SB3 project assetへ変換   |
| `lock-dsl4-assets`    | allowlist内のremote assetを検証しlockを生成           |
| `audit-dsl4-assets`   | 配布profileとlockをネットワークアクセスなしで監査     |
| `vendor-dsl4-assets`  | remote assetをcontent-addressedなoffline mirrorへ固定 |

DSL 4.0では`poseRecognition.modelInitialization`により、従来互換の`legacy`と、不要になったモデルを
cancelして最新の1件だけを準備する`latest-needed`を選べます。camera canvasのreadback contextは
TMPose 1.12.0が所有し、Kamishibai側でTensorFlow.jsの`fromPixels()`経路を補修しません。
責務境界を戻す場合は、TMPose 1.10.0を固定したrc.5成果物を使用します。Schema、既定値、cancel境界は
[DSL 4.0表層仕様](./docs/design/dsl-4-surface.md#41-poseモデル初期化)を参照してください。

TMPose 1.12.0の設定可能なSVG pose overlayもDSL 4.0から利用できます。
`poseRecognition.preview.overlay`を明示した台本だけが表示対象となり、17 joint、bone共通style、最小
confidence、joint／boneのconfidence連動を設定できます。既存台本はこのobjectを省略するため、overlayは
非表示のままです。YAML例と省略値は
[pose overlayの表層契約](./docs/design/dsl-4-surface.md#43-pose-overlay)を参照してください。

TMPose 1.12.0では公開TurboWarp opcodeもブロック文に合わせ、`startRecognition`、
`stopRecognition`、`isRecognizing`、`firstRecognitionMsReporter`へ統一しました。旧`*Predict*`名の
aliasはありません。DSL 4.0はもともとrecognition名のComposition APIを使うため、YAML Schemaとruntime
動作は変わりません。削除されたopcodeを保存した手書きTurboWarp scriptは、rc.7パレットで組み直します。

JavaScriptから使う場合は、package exportの`@kubohiroya/tmpose-kamishibai/builder`、`@kubohiroya/tmpose-kamishibai/dsl4`、`@kubohiroya/tmpose-kamishibai/converter`を用途に応じてimportします。

## 仕組み

DSL 4.0の制作・配布経路は、同じ入力と検証規則を共有します。

```text
YAML + assets
    ↓
source frontend（parse・schema・semantic validation）
    ↓
browser preview / CLI build
    ↓
自己完結SB3
    ↓
TurboWarp runtime + TMPose
```

- 選択されたYAML台本と、存在する場合の`project.source.yml`を編集可能な正本として扱う
- preview、validator、builder、runtime loaderで同じStoryDocumentと診断を使う
- local assetは作品SB3へ埋め込み、remote assetはintegrityと配布profileを明示する
- build失敗時は既存成果物を保持し、検証済みcandidateだけを置き換える

処理境界は[DSL 4.0 processing architecture](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-processing-architecture.md)、アセット配布は[distribution profile設計](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-asset-distribution-profiles.md)を参照してください。

## このリポジトリを開発する

### 必要な環境

- Node.js 22.12.0以上
- pnpm 11
- SB3やブラウザ統合を変更する場合は、TurboWarpを実行できるdesktop環境

### セットアップと検証

```bash
pnpm install --frozen-lockfile
pnpm verify:quick
```

| command             | 内容                                                          |
| ------------------- | ------------------------------------------------------------- |
| `pnpm verify:quick` | lint、型検査、軽量テスト。日常の実装確認                      |
| `pnpm verify:full`  | SB3、全テスト、E2E、site build、package smokeを含むCI相当検証 |
| `pnpm format`       | Prettierによるformat check                                    |
| `pnpm test`         | unit／integrationのfull test suite                            |
| `pnpm run build`    | siteをbuildし検証済みRelease SB3を`dist/`へ取得               |
| `pnpm sb3:build`    | 現行candidateをGit管理外の`tmp/`へ一時生成                    |
| `pnpm sb3:check`    | 現行DSL 4.0 release candidateを再生成して検証                 |

変更はGitHub Issueでスコープ、依存、受け入れ基準、ロールバックを明確にしてから、小さなPRとして進めます。問題報告と提案は[GitHub Issues](https://github.com/kubohiroya/tmpose-kamishibai/issues)へお願いします。

### 主なdirectory

| directory             | 責務                                                      |
| --------------------- | --------------------------------------------------------- |
| `bin/`                | 公開CLIの実行entry point                                  |
| `src/dsl4/`           | DSL 4のdomain model、parser、runtime、platform adapter    |
| `src/builder/`        | CLI commandとSB3、preview、asset、project-source builder  |
| `src/converter/`      | 旧台本からDSL 4への変換API                                |
| `schema/`             | 公開JSON Schema                                           |
| `scripts/sb3/`        | 現行releaseの生成、公開とGitHub Release asset取得workflow |
| `scripts/sb3/assets/` | 現行DSL 4 release generatorが所有する用途名付きasset      |
| `release-metadata/`   | 現行releaseのidentityと公開状態だけを持つ小さいrecord     |
| `site/`               | GitHub Pages source。公開済みSB3はbuild時だけ注入する     |
| `docs/design/`        | 実装に近い設計契約                                        |
| `docs/releases/`      | release note                                              |
| `test/`               | unit、integration、現行browser E2Eと最小fixture           |

公開済みSB3と過去versionの展開sourceは現行branchへ保存しません。Pages buildは各versionの
GitHub Release固定URLからSB3を取得し、catalogのsize、SHA-256、ZIP構造、Titleのversion情報を
検証してから`dist/downloads/`へ配置します。candidateのsource treeとSB3はOS tempまたは
Git管理外の`tmp/`だけへ一時生成し、`app/`と`release-sources/`はrepository構成に含めません。

## ドキュメント

- [公開ドキュメント](https://kubohiroya.github.io/tmpose-kamishibai-docs/): 操作、作者向けガイド、コマンド、ワークショップ資料
- [ドキュメントsource](https://github.com/kubohiroya/tmpose-kamishibai-docs): 公開文書の原稿とissue
- [DSL 4.0表層仕様](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-surface.md): YAMLのschema外契約とaction surface
- [DSL 4.0移行設計](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-migration.md): 3.2との違いと移行方針
- [v4.0.0-rc.8リリースノート][rc8]: 公開状態、互換性、検証済みartifact

## 関連プロジェクト

- [`kubohiroya/tmpose-kamishibai-samples`](https://github.com/kubohiroya/tmpose-kamishibai-samples): サンプル台本、画像、音声、SB3、Web作品
- [`kubohiroya/tmpose-kamishibai-docs`](https://github.com/kubohiroya/tmpose-kamishibai-docs): 利用者、作者、開発者、体験会向け文書
- [`kubohiroya/sb3-toolchain`](https://github.com/kubohiroya/sb3-toolchain): SB3の展開、検証、再構築、埋め込み拡張管理
- [`kubohiroya/turbowarp-tmpose`](https://github.com/kubohiroya/turbowarp-tmpose): TurboWarp向けポーズ認識拡張

## ライセンス

個別表示のない、本プロジェクトが著作権を持つソフトウェアと素材にはMPL-2.0を適用します。第三者著作物と素材ごとの条件は[`LICENSES.md`](LICENSES.md)を参照してください。ドキュメントとサンプルには、それぞれのリポジトリで示す条件が適用されます。

[docs]: https://kubohiroya.github.io/tmpose-kamishibai-docs/
[downloads]: https://kubohiroya.github.io/tmpose-kamishibai/downloads/
[rc8]: https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/releases/v4.0.0-rc.8.md
