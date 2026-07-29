# 紙芝居アプリ ソフトウェア開発者向け資料

Copyright © 2026 Hiroya Kubo. この文書は[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)で提供します。

このガイドは、TMPose紙芝居のアプリ、SB3ソース、ビルダー、Webサイト、ドキュメントを変更する開発者向けの入口です。台本の書式や個別コマンドの仕様は重複して掲載せず、[台本DSLマニュアル](02-dsl-manual.md)と[コマンドリファレンス](03-command-reference.md)を正本とします。

対象アプリ／DSL: `kamishibai=3.1`

過去のバージョンからの変更は[`history.md`](history.md)を参照してください。

## 1. 紙芝居アプリの開発

### 1.1 対象と責務

このリポジトリが管理するものは次のとおりです。

- 物語固有の台本やアセットを含まない、汎用の紙芝居アプリ
- アプリSB3の展開ソースと、配布用SB3を生成する設定
- 台本と画像・音声をSB3へ組み込むnpmパッケージ
- GitHub Pagesへ公開するWebサイトと一般向けドキュメント
- 上記を検証する自動テスト

関連プロジェクトとの境界は次のとおりです。

| 対象                                  | 管理場所                                                                                          | このリポジトリとの関係                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| SB3の展開・検証・決定的再構築         | [`kubohiroya/sb3-toolchain`](https://github.com/kubohiroya/sb3-toolchain)                         | 固定依存として利用する。共通仕様は[3.1](#31-sb3-toolchain)を参照する |
| 浦島太郎などの公開用物語              | [`kubohiroya/tmpose-kamishibai-samples`](https://github.com/kubohiroya/tmpose-kamishibai-samples) | `stories/urashima/`などで台本、固有アセット、生成物を管理する        |
| 埋め込み機能拡張                      | 各機能拡張のGitHubリポジトリ                                                                      | `app/`には検証済み成果物と由来情報だけを同期する                     |
| TurboWarp Extension Galleryの機能拡張 | Galleryの公開URL                                                                                  | SB3から外部URLを参照する                                             |

[公開サンプル](https://kubohiroya.github.io/tmpose-kamishibai-samples/stories/urashima/)の固有ファイルを本体へコピーしません。本体の汎用性と、サンプルの独立した更新・配布を維持します。

依存バージョン、スクリプト、公開対象の正本は`package.json`と`pnpm-lock.yaml`です。文書には特定commitを転記せず、必要なときに次のように確認します。

```bash
pnpm why @kubohiroya/sb3-toolchain
git diff -- package.json pnpm-lock.yaml
```

### 1.2 セットアップ

#### 必要な環境

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

macOSでは通常のGoogle ChromeをPDF生成に自動利用します。別のブラウザを使う環境では、`VIVLIOSTYLE_CHROME_PATH`へ実行ファイルの絶対パスを設定します。

### 1.3 リポジトリ構成

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

### 1.4 基本開発フロー

すべての変更はGitHub Issueへ受け入れ基準とロールバック手順を記録し、小さなブランチとPRへ分けます。

1. 最新の`main`から作業ブランチを作る。
2. `pnpm install --frozen-lockfile`で依存を復元する。
3. 変更対象に近いテストを先に実行する。
4. 生成物ではなく正本を変更する。
5. 差分と生成結果を確認する。
6. 標準チェックと必要な手動確認を行う。
7. Issueの運用ログとDoDを更新してPRを作成する。

無関係な変更や未追跡ファイルをまとめてコミットしません。SB3のimportや成果物の置換を行う前には、必ず`git status`と対象パスの差分を確認します。

### 1.5 アプリSB3を変更する

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

展開形式とアセット・拡張の整合性は`pnpm sb3:check`で検証します。toolchainの
共通検証項目を本ガイドへ重複して列挙しません。

DSL、Loading表示、入力、分岐、テキスト、画面遷移などの振る舞いを変更するときは、同じPRで[DSL資料](02-dsl-manual.md)、[コマンド資料](03-command-reference.md)、VMまたはブロック構造のテストを更新します。

### 1.6 埋め込み機能拡張を更新する

`app/extensions/`のJavaScriptは同期済み成果物です。バグ修正や機能追加は、
`app/embedded-extensions.json`に記録された上流リポジトリで行い、レビュー済みの
成果物だけを本リポジトリへ取り込みます。

`status`、`sync`、`update`の意味、由来情報の形式、transactionalな更新、ID移行の
対象schemaは、[`sb3-toolchain`のSB3ソース管理ワークフロー](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/workflows.md)と
[`埋め込み拡張IDの移行`](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/extension-id-migration.md)
を正本とします。ここでは紙芝居アプリへ反映する手順だけを示します。

現在の追跡refとの差分を確認します。

```bash
pnpm sb3:extensions:status
```

現在採用している成果物を由来情報どおりに復元する場合は`sync`を使います。

```bash
pnpm sb3:extensions:sync
```

上流の変更をレビューし、紙芝居アプリへ採用する場合は`update`を使います。

```bash
pnpm sb3:extensions:update -- EXTENSION_ID
```

上流で拡張IDが変更された場合は、toolchainのID移行を伴う更新を使います。

```bash
pnpm sb3:extensions:update -- OLD_ID --migrate-id NEW_ID
```

上流の成果物パスも変わった場合だけ`--artifact PATH`を追加します。更新後は必ず
`git diff -- app`、`pnpm sb3:check`、`pnpm test`、`pnpm run build`を確認し、
生成したSB3をTurboWarpで開いて対象拡張の主要機能を確認します。

### 1.7 ビルダーを変更する

公開APIは`src/builder/index.js`、CLIは`src/builder/cli.js`と`bin/`、仕様テストは`test/builder.test.mjs`にあります。

APIまたはCLIを変更するときは次を同じ変更に含めます。

- API入力、返り値、エラーの後方互換性の判断
- CLIの`--help`と引数検証
- アセットマニフェストと出力manifestの形式
- 決定的生成とtransactional更新のテスト
- 本ガイドのAPI／CLI例
- 破壊的変更の場合は新しいメジャーバージョン

対象を絞った確認は次のとおりです。

```bash
node --test test/builder.test.mjs
node bin/tmpose-kamishibai.mjs --help
pnpm typecheck
pnpm pack:check
```

### 1.8 ドキュメントとサイトを変更する

一般文書は`docs/general/`、体験会資料は`docs/workshops/<日付>/`、公開入口は`site/`を正本とします。

```bash
pnpm run preview:docs
pnpm run preview:workshop
pnpm run preview:staff
```

子供向け概要書と参加者向け体験会資料だけにrubyganaを適用します。確認する学年を変更する場合は1から6を指定します。

```bash
RUBYGANA_GRADE=4 pnpm run build
```

`pnpm run build`はHTML、PDF、目次、画像参照、しおり、favicon、ライセンス、配布SB3をまとめて検証します。Markdownだけを確認して完了にせず、生成されたHTML/PDFも確認します。

## 2. 成果物・ビルダー・検証・公開

### 2.1 成果物プロファイル

紙芝居の成果物は、台本と物語固有アセットをどこに保持するかで分けます。

| プロファイル | 例               | 台本       | 物語固有アセット | 主な用途                   |
| ------------ | ---------------- | ---------- | ---------------- | -------------------------- |
| `generic`    | `kamishibai.sb3` | 非埋め込み | 非埋め込み       | 本体が配布する汎用雛形     |
| `editor`     | `_urashima.sb3`  | 非埋め込み | 埋め込み         | 物語作成者の編集・動作確認 |
| `player`     | `urashima.sb3`   | 埋め込み   | 埋め込み         | 配布・再生、Packager Web版 |

`generic`は`app/`から生成し、特定の物語を含めません。builder APIとCLIが受け付ける`profile`は`editor`または`player`です。

`editor`と`player`は同じベースSB3、台本、アセットロックから生成します。両者の変換済み台本とアセット参照を分岐させません。`player`は組み込み台本を予約変数へ保存し、タイトル操作後にファイル選択なしで開始します。

`player`へ台本とアセットを組み込んでも、TMPoseモデル、カメラ、外部サービスまで自動的にオフライン化されるわけではありません。残るオンライン依存は成果物manifestと公開ページへ明記します。

### 2.2 SB3・台本変換ビルダー

#### 導入

利用可能なバージョンを確認し、消費側で明示的に固定します。

```bash
npm view @kubohiroya/tmpose-kamishibai version
pnpm add --save-exact @kubohiroya/tmpose-kamishibai@<VERSION>
```

生成したlockfileをコミットし、CIでは`pnpm install --frozen-lockfile`を使います。

#### CLI

```bash
pnpm exec tmpose-kamishibai build-sb3 \
  --base kamishibai.sb3 \
  --script source.txt \
  --assets assets.lock.json \
  --output dist/sample \
  --profile editor
```

`--output`は拡張子を含まないベース名です。次の3ファイルを同じtransactionとして生成します。

```text
dist/sample.sb3
dist/sample.txt
dist/sample.manifest.json
```

主な追加オプションは次のとおりです。

| オプション              | 意味                                      |
| ----------------------- | ----------------------------------------- |
| `--allow-file-root DIR` | `file:`の許可ルートを追加。複数回指定可能 |
| `--allow-http`          | 平文HTTPを明示的に許可                    |
| `--timeout-ms N`        | 1リクエストのタイムアウト                 |
| `--max-asset-bytes N`   | 1アセットの最大バイト数                   |
| `--max-script-bytes N`  | 組み込み台本の最大バイト数                |
| `--max-redirects N`     | HTTPリダイレクト上限                      |

現在の完全な一覧は`pnpm exec tmpose-kamishibai --help`で確認します。

#### JavaScript API

```js
import {
  Sb3BuilderError,
  buildSb3Bundle,
  validateAssetManifest,
  validateBundle,
} from '@kubohiroya/tmpose-kamishibai/builder';

const result = await buildSb3Bundle({
  baseSb3: 'kamishibai.sb3',
  sourceScript: 'source.txt',
  assetManifest: 'assets.lock.json',
  outputDirectory: 'dist',
  outputName: 'sample',
  profile: 'editor',
});

console.log(result.outputPaths);
```

`baseSb3`と`sourceScript`にはファイルパスまたは`file:` URLを指定できます。`assetManifest`にはファイルパス、`file:` URL、または検証対象のJavaScriptオブジェクトを指定できます。相対`file:`を含むオブジェクトでは`manifestBaseDirectory`も指定します。

ネットワーク・ファイル取得は`allowedFileRoots`、`allowHttp`、`requestTimeoutMs`、`maxAssetBytes`、`maxRedirects`で制限できます。`player`の組み込み台本上限は`maxEmbeddedScriptBytes`で変更できます。

`buildSb3Bundle`は`manifest`と`outputPaths`を返します。入力・アセット・出力の問題は`Sb3BuilderError`として処理段階とアセット情報を保持します。

#### アセットマニフェスト

入力manifestは`formatVersion: 1`と1件以上の`assets`を持ちます。

```json
{
  "formatVersion": 1,
  "assets": [
    {
      "name": "forest",
      "uri": "file:assets/forest.svg",
      "kind": "backdrop",
      "target": "@stage",
      "sb3Name": "森",
      "contentType": "image/svg+xml",
      "dataFormat": "svg",
      "size": 1234,
      "sha256": "<64文字の16進数>",
      "license": "CC-BY-4.0: https://creativecommons.org/licenses/by/4.0/",
      "metadata": {
        "bitmapResolution": 1,
        "rotationCenterX": 240,
        "rotationCenterY": 180
      }
    }
  ]
}
```

| `kind`        | `target`     | 変換後の台本参照             |
| ------------- | ------------ | ---------------------------- |
| `backdrop`    | `@stage`     | `backdrop:<sb3Name>`         |
| `costume`     | スプライト名 | `costume:<target>:<sb3Name>` |
| `stageSound`  | `@stage`     | `sound:@stage:<sb3Name>`     |
| `spriteSound` | スプライト名 | `sound:<target>:<sb3Name>`   |

DSL名、同一target内のSB3名、既存SB3のアセット名は重複できません。`license`には素材のライセンスまたは利用条件の識別情報と参照先を記録します。

#### 安全性と再現性

- `file:`は既定でmanifestのディレクトリ以下だけを許可し、`..`やシンボリックリンクによる脱出を拒否する
- HTTPSを既定とし、平文HTTPは明示的に許可した場合だけ取得する
- Content-Type、実サイズ、ロック済みサイズ、SHA-256、タイムアウト、リダイレクトを検証する
- ZIPエントリ順、タイムスタンプ、圧縮設定、JSON表現を固定する
- SB3、変換済み台本、出力manifestの対応を確定前に再検証する
- 3成果物を一時領域で生成し、すべて成功した場合だけ置換する
- 失敗時は既存成果物を保持または復元する

同じ入力、固定依存、設定から生成したSB3、台本、manifestはbit-for-bitで一致しなければなりません。

### 2.3 検証

#### 変更対象ごとのテスト

| 変更対象               | 主なテスト                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| builder API／CLI       | `test/builder.test.mjs`                                                                         |
| 展開SB3の構造          | `test/sb3-project.test.mjs`、`test/skip-mode.test.mjs`                                          |
| TurboWarp実行結果      | `test/turbowarp-vm.test.mjs`                                                                    |
| 入力、分岐、wait       | `test/async-input.test.mjs`、`test/register-branch.test.mjs`、`test/wait-action.test.mjs`       |
| 文書、画像、ライセンス | `test/docs-config.test.mjs`、`test/docs-images.test.mjs`、`test/documentation-license.test.mjs` |
| 公開物と汎用性         | `test/sb3-publication.test.mjs`、`test/build-freshness.test.mjs`                                |

#### 標準チェック

```bash
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm run build
```

GitHub ActionsはcleanなLinux環境で`pnpm install --frozen-lockfile`、`pnpm test`、`pnpm build`を実行します。ローカルで成功しても、未追跡ファイルや既存生成物へ依存していないことをCIで確認します。

`pnpm run build`は少なくとも次を生成・検証します。

- `dist/downloads/kamishibai.sb3`
- 一般文書のHTML/PDF
- 参加者向け・スタッフ向け体験会資料
- 公開サイトのリンク、画像、目次、PDFしおり、favicon

SB3またはランタイムを変更した場合は、生成SB3をTurboWarpで開いて次を手動確認します。

- 読込エラーがない
- 緑の旗で表紙とメニューが表示される
- 外部台本と組み込み台本の対象フローが開始できる
- ポーズ、スペース、右矢印、下矢印の進行が意図どおり動く
- Loading、画像、音声、テキストが正しく表示・再生される

### 2.4 公開

#### GitHub Pages

```bash
pnpm run deploy
```

`predeploy`がフルビルドを行い、成功した`dist/`だけを`gh-pages`へ公開します。公開後はトップページ、ドキュメント一覧、HTML/PDF、SB3ダウンロードを実際のURLから確認します。

問題がある場合は、直前の検証済みcommitをcheckoutしたcleanな環境から再度ビルド・デプロイします。生成済み`dist/`だけを手作業で修正しません。

#### npmパッケージ

公開済みバージョンは変更・再利用できません。リリースごとに新しいバージョンとGitタグを使います。

1. `package.json`、lockfile、`src/builder/constants.js`、READMEの導入例を同じバージョンへ更新する。
2. cleanなcommitで標準チェック、フルビルド、公開内容のdry-runを実行する。

```bash
pnpm release:check
```

3. tarballのファイル一覧、ライセンス、サイズ、CLI/APIを確認する。
4. Git worktreeではなく通常のclean cloneから公開する。npmがソースcommitを正しく記録できることを確認する。
5. WebAuthnなどの認証を完了してpublic packageとして公開する。

```bash
npm publish --access public
```

6. registry反映後にメタデータを確認する。

```bash
npm view @kubohiroya/tmpose-kamishibai@<VERSION> \
  version license dist-tags.latest dist.integrity --json
```

7. 一時ディレクトリへ公開版を導入し、CLIの`--version`と`@kubohiroya/tmpose-kamishibai/builder`のimportを確認する。
8. 公開に使った確定commitへannotated tagを作り、GitHub Releaseを作成する。

公開後に問題が見つかった場合は対象バージョンを`npm deprecate`し、修正版を新しいpatchバージョンとして公開します。公開済みtarballやタグを差し替えません。

### 2.5 トラブルシューティング

| 症状                                              | 確認と対応                                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sb3:import`が置換を拒否する                      | `git status`と`git diff -- app`を確認し、[toolchainの手順](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/workflows.md#既存ソースへの再import)に従う |
| `.app.rollback-*`や`.＜出力名＞.rollback-*`が残る | 削除前に元出力と比較し、[toolchainの失敗時の扱い](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/workflows.md#失敗時の扱い)に従う                    |
| 埋め込み拡張が追跡refと異なる                     | `pnpm sb3:extensions:status`で確認し、固定commitへ戻すなら`sync`、更新するなら`update`を使う                                                                     |
| PDF生成ブラウザが見つからない                     | Chrome/Chromiumを導入し、必要なら`VIVLIOSTYLE_CHROME_PATH`を設定する                                                                                             |
| ローカルだけテストが通る                          | 生成物と未追跡ファイルを確認し、clean cloneと`pnpm install --frozen-lockfile`で再現する                                                                          |
| ビルダーが既存出力を更新しない                    | エラーの`stage`、アセット名、URIを確認する。rollback領域が残っていないか確認する                                                                                 |
| 公開直後にnpm registryが404になる                 | 同じバージョンを再publishせず、npm公開ページとregistryの反映を待って確認する                                                                                     |

復旧でGit履歴を破壊しません。公開済み変更は`git revert`または新しい修正PRで戻し、タグを移動しません。

### 2.6 ライセンスと秘密情報

| 対象                                                                     | ライセンス                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------- |
| `docs/general/**`                                                        | CC BY-SA 4.0                                       |
| `docs/workshops/**`                                                      | Copyright © 2026 Hiroya Kubo. All rights reserved. |
| 上記以外で個別表示のない、本プロジェクトが著作権を持つソフトウェアと素材 | MPL-2.0                                            |

詳細は[`LICENSES.md`](../../LICENSES.md)、[`docs/general/LICENSE.md`](LICENSE.md)、[`docs/workshops/LICENSE.md`](../workshops/LICENSE.md)を参照してください。

第三者の画像、音声、フォント、モデル、機能拡張には個別のライセンスまたは利用条件が適用されます。builderで組み込む素材はアセットマニフェストの`license`へ由来を記録します。許諾が確認できない素材を本体またはサンプルへ追加しません。

トークン、npm認証情報、秘密鍵、個人情報をリポジトリ、SB3、台本、manifest、生成HTMLへ記録しません。認証情報は環境変数、OSのキーチェーン、GitHub Secretsなど、公開物へ含まれない仕組みで渡します。

## 3. 関連プロジェクト

TMPose紙芝居の開発から分離し、他のTurboWarp作品や開発環境でも利用できるものを
各リポジトリで公開しています。各プロジェクトの仕様、開発手順、リリースはリンク先を
正本とします。

### 3.1 sb3-toolchain

[`sb3-toolchain`](https://github.com/kubohiroya/sb3-toolchain)は、SB3をGit差分可能な
展開ソースとして管理し、検証して決定的に再構築するためのCLI／JavaScript APIです。
このリポジトリでは固定依存として利用し、`app/`のimport、検証、build、埋め込み
機能拡張の同期とID移行を担います。

- [SB3ソース管理ワークフロー](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/workflows.md)
- [SB3展開ソース形式 v1](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/source-format-v1.md)
- [埋め込み拡張IDの移行](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/extension-id-migration.md)

### 3.2 Viteプラグイン

- [`vite-plugin-turbowarp-extension`](https://github.com/kubohiroya/vite-plugin-turbowarp-extension):
  TypeScriptプロジェクトを単一ファイルのTurboWarp機能拡張としてbuildするViteプラグイン

### 3.3 TurboWarp 機能拡張開発用テンプレート

- [`turbowarp-extension-template`](https://github.com/kubohiroya/turbowarp-extension-template):
  Viteを使ったTurboWarp機能拡張の開発、テスト、build、リリース用テンプレート

### 3.4 TurboWarp 機能拡張

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

### 3.5 その他のライブラリ

- [`rubygana`](https://github.com/kubohiroya/rubygana):
  日本語テキストの読み仮名を生成するNode.jsライブラリ

## 4. 関連ドキュメント

- [`01-user-guide.md`](01-user-guide.md): アプリの利用方法と成果物の使い分け
- [`02-dsl-manual.md`](02-dsl-manual.md): 台本の構造と書き方
- [`03-command-reference.md`](03-command-reference.md): コマンドとアクションの仕様
- [`history.md`](history.md): DSLとアプリの変更履歴
- [`README.md`](../../README.md): プロジェクト全体の入口と主要コマンド
