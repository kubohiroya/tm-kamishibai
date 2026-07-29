# 紙芝居アプリ ソフトウェア開発者向け資料

Copyright © 2026 Hiroya Kubo. この文書は[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)で提供します。

このガイドは、TMPose紙芝居のアプリ、SB3ソース、ビルダー、Webサイト、ドキュメントを
変更する開発者向けの入口です。アプリの内部構造、成果物、ビルダー仕様、検証、公開は
[紙芝居アプリ内部仕様書](07-internal-specification.md)、台本の書式とコマンド仕様は
[台本DSLマニュアル](02-dsl-manual.md)と[コマンドリファレンス](03-command-reference.md)
を正本とします。

対象アプリ／DSL: `kamishibai=3.1`

過去のバージョンからの変更は[`history.md`](history.md)を参照してください。

## 1. 対象と責務

このリポジトリが管理するものは次のとおりです。

- 物語固有の台本やアセットを含まない、汎用の紙芝居アプリ
- アプリSB3の展開ソースと、配布用SB3を生成する設定
- 台本と画像・音声をSB3へ組み込むnpmパッケージ
- GitHub Pagesへ公開するWebサイトと一般向けドキュメント
- 上記を検証する自動テスト

関連プロジェクトとの境界は次のとおりです。

| 対象                                  | 管理場所                                                                                          | このリポジトリとの関係                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| SB3の展開・検証・決定的再構築         | [`kubohiroya/sb3-toolchain`](https://github.com/kubohiroya/sb3-toolchain)                         | 固定依存として利用する。共通仕様は[9.1](#91-sb3-toolchain)参照 |
| 浦島太郎などの公開用物語              | [`kubohiroya/tmpose-kamishibai-samples`](https://github.com/kubohiroya/tmpose-kamishibai-samples) | `stories/urashima/`で台本、固有アセット、生成物を管理する      |
| 埋め込み機能拡張                      | 各機能拡張のGitHubリポジトリ                                                                      | `app/`には検証済み成果物と由来情報だけを同期する               |
| TurboWarp Extension Galleryの機能拡張 | Galleryの公開URL                                                                                  | SB3から外部URLを参照する                                       |

[公開サンプル](https://kubohiroya.github.io/tmpose-kamishibai-samples/stories/urashima/)
の固有ファイルを本体へコピーしません。本体の汎用性と、サンプルの独立した更新・配布を
維持します。

依存バージョン、スクリプト、公開対象の正本は`package.json`と`pnpm-lock.yaml`です。
文書には特定commitを転記せず、必要なときに確認します。

```bash
pnpm why @kubohiroya/sb3-toolchain
git diff -- package.json pnpm-lock.yaml
```

## 2. セットアップ

### 必要な環境

- Node.js 22.12.0以上
- pnpm 11
- PDF生成に利用できるChromeまたはChromium
- Gitと、GitHub操作に利用するGitHub CLI

```bash
corepack enable
pnpm install
```

CIではlockfile以外の依存解決を許可しません。

```bash
pnpm install --frozen-lockfile
```

初回セットアップ後は、展開SB3ソースとテスト用SB3を確認します。

```bash
pnpm sb3:check
pnpm test
```

macOSでは通常のGoogle ChromeをPDF生成に自動利用します。別のブラウザを使う環境では、
`VIVLIOSTYLE_CHROME_PATH`へ実行ファイルの絶対パスを設定します。

## 3. リポジトリ構成

| パス                           | 役割                                              |
| ------------------------------ | ------------------------------------------------- |
| `app/`                         | 紙芝居アプリSB3のGit管理上の正本                  |
| `app/project.source.json`      | 整形済みScratchプロジェクト                       |
| `app/assets/`                  | 汎用アプリ自身が使用する画像・音声                |
| `app/extensions/`              | 埋め込み機能拡張の同期済みJavaScript              |
| `app/embedded-extensions.json` | 埋め込み機能拡張の管理情報                        |
| `app/sb3-source.json`          | SB3展開ソースのマニフェスト                       |
| `src/builder/`                 | npmで公開するSB3・台本変換API                     |
| `bin/`                         | npm CLIのエントリーポイント                       |
| `scripts/`                     | サイト、ドキュメント、配布物のビルドと検証        |
| `docs/general/`                | 一般向け・開発者向けの文書原稿                    |
| `docs/workshops/`              | 日付付き体験会資料                                |
| `site/`                        | GitHub Pagesの静的入力                            |
| `test/`                        | ビルダー、SB3、VM、ドキュメント、公開契約のテスト |

次の場所は生成物であり、Git管理上の正本ではありません。

| パス                 | 内容                                              |
| -------------------- | ------------------------------------------------- |
| `tmp/kamishibai.sb3` | TurboWarp編集と自動テストに使うSB3                |
| `dist/`              | GitHub Pagesへ公開するサイト、HTML/PDF、配布用SB3 |
| `output/pdf/`        | 印刷用PDFのローカル確認先                         |

## 4. 基本開発フロー

すべての変更はGitHub Issueへ受け入れ基準とロールバック手順を記録し、小さなブランチと
PRへ分けます。

1. 最新の`main`から作業ブランチを作る。
2. `pnpm install --frozen-lockfile`で依存を復元する。
3. 変更対象に近いテストを先に実行する。
4. 生成物ではなく正本を変更する。
5. 差分と生成結果を確認する。
6. 標準チェックと必要な手動確認を行う。
7. Issueの運用ログとDoDを更新してPRを作成する。

無関係な変更や未追跡ファイルをまとめてコミットしません。SB3のimportや成果物の
置換を行う前には、必ず`git status`と対象パスの差分を確認します。変更対象ごとの
テストと公開前チェックは[内部仕様書の検証](07-internal-specification.md#8-検証)を
参照してください。

## 5. アプリSB3を変更する

このリポジトリでは`app/`をアプリSB3の正本とし、固定した`sb3-toolchain`を
`pnpm sb3:*`スクリプトから利用します。展開ソース形式、importとbuildの上書き保護、
決定的出力の共通仕様は
[`sb3-toolchain`のSB3ソース管理ワークフロー](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/workflows.md)
を参照してください。

`app/`から編集用SB3を生成します。

```bash
pnpm sb3:build
```

`tmp/kamishibai.sb3`をTurboWarpで編集し、別の明示的なパスへ保存してから取り込みます。

```bash
pnpm sb3:import -- /path/to/edited-kamishibai.sb3
git diff -- app
pnpm sb3:check
pnpm test
pnpm run build
```

`app/project.source.json`は次の不変条件を維持します。

- 浦島太郎などの公開サンプル固有ターゲット、画像、音声を含めない
- 台本解析・実行用リストを空の初期状態で保持する
- 組み込み台本用の予約変数を一意に保持する

展開形式とアセット・拡張の整合性は`pnpm sb3:check`で検証します。toolchainの共通
検証項目を本ガイドへ重複して列挙しません。

DSL、Loading表示、入力、分岐、テキスト、画面遷移などの振る舞いを変更するときは、
同じPRで[DSL資料](02-dsl-manual.md)、[コマンド資料](03-command-reference.md)、
[内部仕様書](07-internal-specification.md)、VMまたはブロック構造のテストを更新します。

## 6. 埋め込み機能拡張を更新する

`app/extensions/`のJavaScriptは同期済み成果物です。バグ修正や機能追加は、
`app/embedded-extensions.json`に記録された上流リポジトリで行い、レビュー済みの
成果物だけを本リポジトリへ取り込みます。

`status`、`sync`、`update`の意味、由来情報の形式、transactionalな更新、ID移行の
対象schemaは、[`sb3-toolchain`のSB3ソース管理ワークフロー](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/workflows.md)と
[`埋め込み拡張IDの移行`](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/extension-id-migration.md)
を正本とします。ここでは紙芝居アプリへ反映する手順だけを示します。

```bash
pnpm sb3:extensions:status
pnpm sb3:extensions:sync
pnpm sb3:extensions:update -- EXTENSION_ID
```

上流で拡張IDが変更された場合は、toolchainのID移行を伴う更新を使います。

```bash
pnpm sb3:extensions:update -- OLD_ID --migrate-id NEW_ID
```

上流の成果物パスも変わった場合だけ`--artifact PATH`を追加します。更新後は必ず
`git diff -- app`、`pnpm sb3:check`、`pnpm test`、`pnpm run build`を確認し、
生成したSB3をTurboWarpで開いて対象拡張の主要機能を確認します。

## 7. ビルダーを変更する

公開APIは`src/builder/index.js`、CLIは`src/builder/cli.js`と`bin/`、仕様テストは
`test/builder.test.mjs`にあります。公開API、CLI、アセットマニフェスト、決定的生成、
transactional更新の現行仕様は
[内部仕様書のSB3・台本変換ビルダー](07-internal-specification.md#3-sb3台本変換ビルダー)
を参照してください。

APIまたはCLIを変更するときは次を同じ変更に含めます。

- API入力、返り値、エラーの後方互換性の判断
- CLIの`--help`と引数検証
- アセットマニフェストと出力manifestの形式
- 決定的生成とtransactional更新のテスト
- 内部仕様書のAPI／CLI例
- 破壊的変更の場合は新しいメジャーバージョン

```bash
node --test test/builder.test.mjs
node bin/tmpose-kamishibai.mjs --help
pnpm typecheck
pnpm pack:check
```

## 8. ドキュメントとサイトを変更する

一般文書は`docs/general/`、体験会資料は`docs/workshops/<日付>/`、公開入口は`site/`を
正本とします。

```bash
pnpm run preview:docs
pnpm run preview:workshop
pnpm run preview:staff
```

子供向け概要書と参加者向け体験会資料だけにrubyganaを適用します。確認する学年を
変更する場合は1から6を指定します。

```bash
RUBYGANA_GRADE=4 pnpm run build
```

`pnpm run build`はHTML、PDF、目次、画像参照、しおり、favicon、ライセンス、配布SB3を
まとめて検証します。Markdownだけを確認して完了にせず、生成されたHTML/PDFも確認します。

## 9. 関連プロジェクト

TMPose紙芝居の開発から分離し、他のTurboWarp作品や開発環境でも利用できるものを
各リポジトリで公開しています。各プロジェクトの仕様、開発手順、リリースはリンク先を
正本とします。

### 9.1 sb3-toolchain

[`sb3-toolchain`](https://github.com/kubohiroya/sb3-toolchain)は、SB3をGit差分可能な
展開ソースとして管理し、検証して決定的に再構築するためのCLI／JavaScript APIです。
このリポジトリでは固定依存として利用し、`app/`のimport、検証、build、埋め込み
機能拡張の同期とID移行を担います。

- [SB3ソース管理ワークフロー](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/workflows.md)
- [SB3展開ソース形式 v1](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/source-format-v1.md)
- [埋め込み拡張IDの移行](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/extension-id-migration.md)

### 9.2 Viteプラグイン

- [`vite-plugin-turbowarp-extension`](https://github.com/kubohiroya/vite-plugin-turbowarp-extension):
  TypeScriptプロジェクトを単一ファイルのTurboWarp機能拡張としてbuildするViteプラグイン

### 9.3 TurboWarp 機能拡張開発用テンプレート

- [`turbowarp-extension-template`](https://github.com/kubohiroya/turbowarp-extension-template):
  Viteを使ったTurboWarp機能拡張の開発、テスト、build、リリース用テンプレート

### 9.4 TurboWarp 機能拡張

- [`turbowarp-tmpose`](https://github.com/kubohiroya/turbowarp-tmpose):
  Teachable Machine Poseモデルを利用したカメラ姿勢認識
- [`turbowarp-text-lines`](https://github.com/kubohiroya/turbowarp-text-lines):
  テキストの行数取得、行単位の読み出し・分割
- [`turbowarp-asset-manager`](https://github.com/kubohiroya/turbowarp-asset-manager):
  IndexedDBとSB3内の画像・音声を扱うアセット管理
- [`turbowarp-async-input`](https://github.com/kubohiroya/turbowarp-async-input):
  キーボード、ポインター、姿勢入力を対象ごとに扱う非同期入力
- [`turbowarp-runtime-expression`](https://github.com/kubohiroya/turbowarp-runtime-expression):
  runtime変数を使う条件式の安全な評価とbroadcast監視

### 9.5 その他のライブラリ

- [`rubygana`](https://github.com/kubohiroya/rubygana):
  日本語テキストの読み仮名を生成するNode.jsライブラリ

## 10. 関連ドキュメント

- [`01-user-guide.md`](01-user-guide.md): アプリの利用方法と成果物の使い分け
- [`02-dsl-manual.md`](02-dsl-manual.md): 台本の構造と書き方
- [`03-command-reference.md`](03-command-reference.md): コマンドとアクションの仕様
- [`07-internal-specification.md`](07-internal-specification.md): アプリ内部構造、成果物、検証、公開
- [`history.md`](history.md): DSLとアプリの変更履歴
- [`README.md`](../../README.md): プロジェクト全体の入口と主要コマンド
