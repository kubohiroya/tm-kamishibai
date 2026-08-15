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

|                      | 3.2.3                                | 4.0.0-rc.5                                   |
| -------------------- | ------------------------------------ | -------------------------------------------- |
| 状態                 | 安定版・現在の推奨                   | リリース候補                                 |
| 向いている用途       | 体験会、安定運用、既存の3.1／3.2作品 | YAML台本、ブラウザ制作、CLI／APIの先行検証   |
| 台本                 | 3.1／3.2テキストDSL                  | DSL 4.0 YAML                                 |
| 入手先               | [ダウンロードページ][downloads]      | [ダウンロードページ][downloads]／npmの`next` |
| 変更時に確認する文書 | [公開ドキュメント][docs]             | [4.0リリースノート][rc5]                     |

迷った場合は3.2.3を使ってください。4.0.0-rc.5は正式版前の公開候補であり、安定運用よりも4.0の制作フローやAPIを検証したい場合に適しています。公開済みの3.1／3.2作品は、4.0へ移行しなくても引き続き利用できます。

## まず体験する

ブラウザですぐ試す場合は、[公開中のWeb版](https://sqs.prof.cuc.ac.jp/kamishibai/)または[「浦島太郎」のサンプル](https://kubohiroya.github.io/tmpose-kamishibai-samples/stories/urashima/web/)を開きます。カメラの利用を許可し、画面の案内に従ってポーズを取ってください。

作品ファイルをTurboWarpで開く場合は、[ダウンロードページ][downloads]から使用する系列のSB3を取得します。体験会で使う資料は[ワークショップ一覧](https://kubohiroya.github.io/tmpose-kamishibai-docs/workshops/)から選べます。

## DSL 4.0で作品を作る

### ブラウザだけで作る

4.0.0-rc.5のStandard SB3には、台本の選択、検証、live preview、配布用SB3生成までを行う作者用ランナーが入っています。

1. [4.0のSB3をダウンロード][downloads]し、[TurboWarp Editor](https://turbowarp.org/editor)で開く。
2. 緑の旗を押し、メニューの「開く」から台本ファイルまたはproject directoryを選ぶ。
3. 外部エディターでYAMLやlocal assetを編集する。正常な保存は検証後に自動反映される。
4. メニューの「配布用SB3を作る」から、台本とアセットを埋め込んだ作品SB3を保存する。

project directoryの監視には、File System Access APIを利用できるdesktop版Chrome／Edgeのtop-level HTTPS環境が必要です。nativeの保存先pickerを利用できない場合、成果物はbrowser downloadとして保存します。その他の非対応操作では、単一ファイル選択または後述のCLIを使います。詳しい画面操作、ブラウザ条件、エラーへの対処は[DSL 4.0作者ガイド](https://kubohiroya.github.io/tmpose-kamishibai-docs/dsl-author-guides/dsl-4.0-author-guide/)を参照してください。

### projectの最小構成

DSL 4.0では、source manifest、YAML台本、画像・音声・pose modelなどのアセットを一つのproject rootで管理します。分類用directoryの名前は任意です。

```text
my-story/
├── project.source.json
├── story.k4.yml
├── images/
├── sounds/
└── pose-models/
```

`project.source.json`はentry sourceを指定します。

```json
{
  "formatVersion": 1,
  "mode": "external",
  "sourceId": "main",
  "path": "story.k4.yml"
}
```

最小の`story.k4.yml`は、versionと一つ以上のsceneを持ちます。

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

より実用的な台本、アセット参照、ポーズモデル、分岐、吹き出しについては[作者ガイド](https://kubohiroya.github.io/tmpose-kamishibai-docs/dsl-author-guides/dsl-4.0-author-guide/)と[サンプルリポジトリ](https://github.com/kubohiroya/tmpose-kamishibai-samples)を参照してください。

### CLIで検証・preview・buildする

[`@kubohiroya/tmpose-kamishibai`](https://www.npmjs.com/package/@kubohiroya/tmpose-kamishibai/v/4.0.0-rc.5)のCLIは、CI、再現可能なbuild、大規模project、配布profileの管理に向いています。Node.js 22.12.0以上とpnpm 11を使用し、検証するversionを固定して導入します。

```bash
pnpm add --save-exact @kubohiroya/tmpose-kamishibai@4.0.0-rc.5
pnpm exec tmpose-kamishibai --help
```

台本だけを検証します。

```bash
pnpm exec tmpose-kamishibai validate-dsl4 \
  --input story.k4.yml \
  --max-source-bytes 262144 \
  --format pretty
```

project全体を監視し、ブラウザでpreviewします。

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

同じ入力から自己完結SB3を生成します。

```bash
pnpm exec tmpose-kamishibai build-dsl4 \
  --base kamishibai-4-base.sb3 \
  --project-root . \
  --source-manifest project.source.json \
  --output dist/my-story.sb3 \
  --control-profile production \
  --channel bundled \
  --max-source-bytes 262144 \
  --max-asset-file-bytes 16777216 \
  --max-asset-files 256 \
  --max-total-asset-bytes 134217728
```

byte上限は入力規模を明示し、誤った入力や過大な成果物をfail closedにするための必須値です。必要性を確認せずに大きくしないでください。

CLIにはほかに次のcommandがあります。引数と終了statusは`tmpose-kamishibai --help`および[メンテナンスガイド](https://kubohiroya.github.io/tmpose-kamishibai-docs/developer-guides/developer-guide/)で確認できます。

| command               | 用途                                                  |
| --------------------- | ----------------------------------------------------- |
| `build-sb3`           | 3.1／3.2台本とアセットからSB3一式を生成               |
| `convert-dsl4`        | 3.1／3.2テキストDSLを4.0 YAMLへ変換                   |
| `convert-dsl4-assets` | 4.0アセットをlocal／remote／SB3 project assetへ変換   |
| `lock-dsl4-assets`    | allowlist内のremote assetを検証しlockを生成           |
| `audit-dsl4-assets`   | 配布profileとlockをネットワークアクセスなしで監査     |
| `vendor-dsl4-assets`  | remote assetをcontent-addressedなoffline mirrorへ固定 |

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

- YAMLと`project.source.json`を編集可能な正本として扱う
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
| `pnpm test`         | 生成SB3と実VMを含むfull test suite                            |
| `pnpm run build`    | 公開サイトと配布用SB3を`dist/`へ生成                          |
| `pnpm sb3:build`    | 編集用SB3を`tmp/kamishibai.sb3`へ生成                         |
| `pnpm sb3:check`    | `app/`と4.0配布sourceを検証                                   |

変更はGitHub Issueでスコープ、依存、受け入れ基準、ロールバックを明確にしてから、小さなPRとして進めます。問題報告と提案は[GitHub Issues](https://github.com/kubohiroya/tmpose-kamishibai/issues)へお願いします。

### 主なdirectory

- `app/`: 現行の紙芝居SB3 source
- `release-sources/`: 公開済みSB3を再現するversion別snapshot
- `src/dsl4/`: DSL 4.0のdomain、runtime、platform adapter
- `src/builder/`: CLIとSB3／preview builder
- `schema/`: 公開JSON Schema
- `site/`: 公開サイトのsource
- `scripts/`: build、release、検証workflow
- `test/`: unit、integration、browser E2Eとfixture
- `docs/design/`: 実装に近い設計契約

## ドキュメント

- [公開ドキュメント](https://kubohiroya.github.io/tmpose-kamishibai-docs/): 操作、作者向けガイド、コマンド、ワークショップ資料
- [ドキュメントsource](https://github.com/kubohiroya/tmpose-kamishibai-docs): 公開文書の原稿とissue
- [DSL 4.0表層仕様](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-surface.md): YAMLのschema外契約とaction surface
- [DSL 4.0移行設計](https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/design/dsl-4-migration.md): 3.2との違いと移行方針
- [v4.0.0-rc.5リリースノート][rc5]: 公開状態、互換性、検証済みartifact

## 関連プロジェクト

- [`kubohiroya/tmpose-kamishibai-samples`](https://github.com/kubohiroya/tmpose-kamishibai-samples): サンプル台本、画像、音声、SB3、Web作品
- [`kubohiroya/tmpose-kamishibai-docs`](https://github.com/kubohiroya/tmpose-kamishibai-docs): 利用者、作者、開発者、体験会向け文書
- [`kubohiroya/sb3-toolchain`](https://github.com/kubohiroya/sb3-toolchain): SB3の展開、検証、再構築、埋め込み拡張管理
- [`kubohiroya/turbowarp-tmpose`](https://github.com/kubohiroya/turbowarp-tmpose): TurboWarp向けポーズ認識拡張

## ライセンス

個別表示のない、本プロジェクトが著作権を持つソフトウェアと素材にはMPL-2.0を適用します。第三者著作物と素材ごとの条件は[`LICENSES.md`](LICENSES.md)を参照してください。ドキュメントとサンプルには、それぞれのリポジトリで示す条件が適用されます。

[docs]: https://kubohiroya.github.io/tmpose-kamishibai-docs/
[downloads]: https://kubohiroya.github.io/tmpose-kamishibai/downloads/
[rc5]: https://github.com/kubohiroya/tmpose-kamishibai/blob/main/docs/releases/v4.0.0-rc.5.md
