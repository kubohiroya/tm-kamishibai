# TMPose紙芝居

**ポーズで進めるAIインタラクティブ紙芝居**

TMPose紙芝居は、TurboWarpとTMPoseを利用し、参加者がカメラの前でポーズを取ることで物語を進める紙芝居システムです。

## 公開先

- GitHub Pages: <https://kubohiroya.github.io/tmpose-kamishibai/>
- 現在公開中のWeb版: <https://sqs.prof.cuc.ac.jp/kamishibai/>

## ドキュメント

文書原稿は、用途と公開単位に合わせて分けています。

```text
docs/
├── general/                  # 一般向けの上位ドキュメント
│   ├── 01-user-guide.md
│   ├── 02-dsl-manual.md
│   ├── 03-command-reference.md
│   ├── 04-executive-summary-adult.md
│   ├── 05-executive-summary-kids.md
│   ├── 06-developer-guide.md
│   └── history.md
└── workshops/
    └── 2026-08-01/           # 日付付きの体験会資料
        ├── tmpose-kamishibai-cover-20260801.md
        ├── tmpose-kamishibai-20260801.md
        └── tmpose-kamishibai-staff-20260801.md
```

一般向け7文書は、`kamishibai=3.1` を前提として、それぞれをVivliostyleでHTML/PDF化します。旧付録B・Cから分離したソフトウェア開発者向け資料と、2.0から3.1への変更履歴もここに含みます。子供向け概要書だけはrubyganaでふりがなを追加し、他の6文書はMarkdown原稿どおりの本文を組版します。

子供向け概要書と2026年8月1日版の参加者向け体験会資料は、VivliostyleでHTMLを生成した後にrubyganaを適用し、ルビ付きHTMLからPDFを組版します。既定では小学3年生までに学ぶ漢字を既習として扱います。コード、コマンド例、プログラム名はrubyganaの処理対象から除外し、固有名詞の読みは[`docs/config.mjs`](docs/config.mjs)の`rubyOverrides`で補正します。

同日版のスタッフ向け資料は、参加者向け資料の旧付録Aから運営・準備情報を分離した独立文書です。一般向け文書と同様に、rubyganaを適用せずHTML/PDF化します。

公開時は、一般文書と体験会資料への導線を[`site/docs/index.html`](site/docs/index.html)に統合します。

## 必要な環境

- Node.js 22.12.0以上
- pnpm 11
- PDF生成に利用できるChromeまたはChromium

macOSでは通常のGoogle Chromeを自動検出します。それ以外の場所でブラウザを明示する場合は、`VIVLIOSTYLE_CHROME_PATH`に実行ファイルのパスを設定してください。

## セットアップ

```bash
pnpm install
```

rubyganaは保守フォーク[`kubohiroya/rubygana`](https://github.com/kubohiroya/rubygana) 0.9.0のコミットSHAへ固定しています。この版は小学校学習指導要領（平成29年告示）の学年別漢字1,026字に対応し、pnpmの分離された`node_modules`でもKuromoji辞書を解決できます。

## ビルド

```bash
pnpm run build
```

子供向け概要書と参加者向け体験会資料の対象学年は1から6まで指定できます。他の一般向け文書とスタッフ向け資料はこの値に関係なく、ルビを追加せず生成します。

```bash
RUBYGANA_GRADE=4 pnpm run build
```

主な生成物:

```text
dist/
├── index.html
├── downloads/
│   ├── index.html
│   └── kamishibai.sb3
└── docs/
    ├── index.html
    ├── general/
    │   ├── 01-user-guide.html
    │   ├── 01-user-guide.pdf
    │   ├── 02-dsl-manual.html
    │   ├── 02-dsl-manual.pdf
    │   ├── 03-command-reference.html
    │   ├── 03-command-reference.pdf
    │   ├── 04-executive-summary-adult.html
    │   ├── 04-executive-summary-adult.pdf
    │   ├── 05-executive-summary-kids.html
    │   ├── 05-executive-summary-kids.pdf
    │   ├── 06-developer-guide.html
    │   ├── 06-developer-guide.pdf
    │   ├── history.html
    │   ├── history.pdf
    │   └── publication.json
    └── workshops/
        └── 2026-08-01/
            ├── index.html
            ├── publication.json
            ├── staff/
            │   ├── index.html
            │   └── tmpose-kamishibai-staff-20260801.pdf
            ├── tmpose-kamishibai-20260801.html
            └── tmpose-kamishibai-20260801.pdf

output/pdf/
├── general/
│   ├── 01-user-guide.pdf
│   ├── 02-dsl-manual.pdf
│   ├── 03-command-reference.pdf
│   ├── 04-executive-summary-adult.pdf
│   ├── 05-executive-summary-kids.pdf
│   ├── 06-developer-guide.pdf
│   └── history.pdf
└── workshops/
    └── 2026-08-01/
        ├── staff/
        │   └── tmpose-kamishibai-staff-20260801.pdf
        └── tmpose-kamishibai-20260801.pdf
```

`output/pdf/`は印刷用PDFの確認場所、`dist/`はGitHub Pagesへ公開する内容です。どちらも生成物のためGit管理から除外しています。

公開用の台本とサンプル固有アセットは、[サンプルサイト](https://kubohiroya.github.io/tmpose-kamishibai-samples/) で MPL-2.0 により配信し、別リポジトリ [`kubohiroya/tmpose-kamishibai-samples`](https://github.com/kubohiroya/tmpose-kamishibai-samples) で管理します。本リポジトには `test/fixtures/` の最小検証台本だけを置きます。

## プレビュー

一般向け文書をVivliostyle Viewerで確認する場合:

```bash
pnpm run preview:docs
```

体験会資料を確認する場合:

```bash
pnpm run preview:workshop
```

スタッフ向け資料を確認する場合:

```bash
pnpm run preview:staff
```

一般向け文書と参加者向け体験会資料はBook Modeで開き、Vivliostyleが見出しから生成した目次パネルを利用できます。

## テスト

```bash
pnpm test
pnpm run build
```

`pnpm run build`の最後に、次の項目を検証します。

- 一般向け7文書（ソフトウェア開発者向け資料と変更履歴を含む）のHTML/PDFと統合入口からのリンク
- 子供向け概要書だけにrubygana由来のルビと学年属性があり、他の一般向けHTMLにはないこと
- 体験会資料の学年メタデータ、ルビ数、コードブロック除外、固有名詞の読み
- 体験会資料の自動目次、PDFしおり、画像参照と表示幅
- スタッフ向け資料への旧付録Aの分離、ソフトウェア開発者向け資料への旧付録B・Cの分離、rubygana非適用、会場図、HTML/PDF導線
- 公開サンプルサイトへの導線
- `app/` から生成した `dist/downloads/kamishibai.sb3` とダウンロードリンク

PDFの見た目はPopplerでPNG化して確認できます。

```bash
mkdir -p tmp/pdfs
find output/pdf -name '*.pdf' -print0 | while IFS= read -r -d '' pdf; do
  name=$(basename "$pdf" .pdf)
  pdftoppm -png "$pdf" "tmp/pdfs/$name"
done
```

## GitHub Pagesへ公開

```bash
pnpm run deploy
```

`predeploy`が毎回`pnpm run build`を実行し、成功した`dist/`だけを`gh-pages`ブランチへ公開します。学年を変える場合はデプロイ時にも環境変数を指定します。

```bash
RUBYGANA_GRADE=4 pnpm run deploy
```

## ディレクトリ構成

```text
.
├── app/                       # SB3のGit管理上の正本
│   ├── assets/
│   ├── extensions/
│   ├── embedded-extensions.json
│   ├── project.source.json
│   └── sb3-source.json
├── docs/
│   ├── general/
│   ├── images/
│   ├── workshops/
│   ├── config.mjs
│   ├── document-theme.css
│   ├── general-theme.css
│   ├── staff-theme.css
│   ├── theme.css
│   ├── vivliostyle.general.config.mjs
│   ├── vivliostyle.staff.config.mjs
│   └── vivliostyle.workshop.config.mjs
├── scripts/
│   ├── build-docs.mjs
│   ├── build-site.mjs
│   └── verify-build.mjs
├── site/
│   ├── docs/
│   └── downloads/
│       └── index.html
└── test/
```

## 配置方針

- `docs/general/`: 日付やイベントに依存しない一般向けMarkdown原稿
- `docs/workshops/<日付>/`: 特定の体験会で利用する参加者向け・スタッフ向けMarkdown原稿
- `docs/images/`: 体験会資料から参照する元画像
- `app/`: 整形済みproject、アセット、埋め込み拡張を含むSB3のGit管理上の正本
- `site/docs/`: 一般文書と体験会資料を統合する公開入口
- `site/app/`: TurboWarpからエクスポートしたWebアプリ一式
- `test/fixtures/`: 汎用実行環境の自動・手動検証に必要な最小台本
- `site/downloads/`: SB3ダウンロードページ。配布SB3自体はビルド時に `dist/downloads/` へ生成
- `output/pdf/`: ローカル確認用の印刷PDF

## SB3の開発と配布

SB3の展開ソース形式、安全なimport、検証、決定的ビルドは、MPL-2.0で公開する
[`kubohiroya/sb3-toolchain`](https://github.com/kubohiroya/sb3-toolchain)を利用します。
このリポジトリでは、検証済みコミットを固定依存として指定し、`pnpm-lock.yaml`で解決先を
固定します。

```json
{
  "devDependencies": {
    "@kubohiroya/sb3-toolchain": "github:kubohiroya/sb3-toolchain#51f26fcfd68ab39b12f329e86a89e9f306dd7bfb"
  }
}
```

ローカル編集用SB3は次のコマンドで `tmp/kamishibai.sb3` へ生成します。

```bash
pnpm sb3:build
```

TurboWarpで編集して保存したSB3は、明示した入力パスから `app/` へ取り込みます。

```bash
pnpm sb3:import -- /path/to/edited-kamishibai.sb3
pnpm sb3:check
pnpm test
pnpm run build
```

埋め込み拡張はGitHubリポジトリ、追跡ref、固定commit、成果物パス、SHA-256を
`app/embedded-extensions.json`へ記録します。状態確認と固定commitからの再同期は次の
コマンドで行います。

```bash
pnpm sb3:extensions:status
pnpm sb3:extensions:sync
```

上流refを新commitへ進める操作は`pnpm sb3:extensions:update -- [EXTENSION_ID]`として
明示的に実行します。取得したJavaScriptを実行せず、IDとintegrityを検証してから
transactionalに置換します。

`pnpm run build` は配布用 `dist/downloads/kamishibai.sb3` を同じ正本から生成します。通常手順、置換時の安全判定、手動確認、ロールバックについては [`docs/general/06-developer-guide.md`](docs/general/06-developer-guide.md) を参照してください。

ツールチェーン更新に問題がある場合は、`package.json`と`pnpm-lock.yaml`を直前の検証済み
コミットへ戻します。`app/`の正本と生成SB3の形式を変更せずに切り戻せます。

浦島太郎の台本、専用スプライト、背景、画像、音声、組み込み済みSB3は、[サンプルサイト](https://kubohiroya.github.io/tmpose-kamishibai-samples/) で配信し、別リポジトリ [`kubohiroya/tmpose-kamishibai-samples`](https://github.com/kubohiroya/tmpose-kamishibai-samples) で管理します。本体リポジトリの `pnpm run build` では、浦島太郎固有コンテンツを生成・公開しません。

## Loading表示のカスタマイズ

アセット読込中は、組み込みスプライト`Loading`のそばに、Loading用アセットを除いた通常アセットの進捗を`完了数 / 総数`の吹き出しで表示します。台本でLoading用の画像アセットを複数指定すると、それらを通常アセットより先に読み込み、通常アセットの読込番号に合わせて循環表示します。吹き出しは固定アンカーから表示するため、画像の外形が異なっても位置は変わりません。

```text
asset=loading1,https://example.com/loading/loading1.png
asset=loading2,https://example.com/loading/loading2.png
asset=loading3,https://example.com/loading/loading3.png
setLoadingCostume=loading1,loading2,loading3
```

この例では、通常アセット1、2、3、4件目の読込中に、`loading1`、`loading2`、`loading3`、`loading1`の順で表示します。Loading用の3アセットは進捗の分子・分母に含めません。`setLoadingCostume`を省略した場合は、組み込みのLoadingコスチュームを使用します。詳しい書式は[`02-dsl-manual.md`](docs/general/02-dsl-manual.md)と[`03-command-reference.md`](docs/general/03-command-reference.md)を参照してください。

## 汎用SB3・台本変換ビルダー

`@kubohiroya/tmpose-kamishibai`は、外部画像・音声をベースSB3へ組み込み、台本の`asset=`行をプロジェクト内参照へ変換するJavaScript APIとCLIを提供します。消費側では浮動ブランチではなく、検証済みバージョンを固定します。

現在の固定配布経路はGitHubタグです。消費側の`package.json`でタグを指定します。

```json
{
  "dependencies": {
    "@kubohiroya/tmpose-kamishibai": "github:kubohiroya/tmpose-kamishibai#v3.1.0"
  }
}
```

pnpm 11ではGit依存の準備スクリプトを明示的に許可します。`pnpm-workspace.yaml`の`allowBuilds`はこのパッケージだけを対象にします。

```yaml
allowBuilds:
  '@kubohiroya/tmpose-kamishibai': true
```

初回の`pnpm install`で生成した`pnpm-lock.yaml`をコミットし、CIでは固定コミットからだけ復元します。

```bash
pnpm install
pnpm install --frozen-lockfile

tmpose-kamishibai build-sb3 \
  --base kamishibai.sb3 \
  --script source.txt \
  --assets assets.lock.json \
  --output dist/_sample \
  --profile editor
```

このコマンドは編集用の`dist/_sample.sb3`、`dist/_sample.txt`、`dist/_sample.manifest.json`を検証してから一括で確定します。配布・再生用は出力名から先頭`_`を外し、`--profile player`を指定すると、同じ変換済み台本をSB3内にも組み込みます。API、アセットマニフェスト、ネットワークとファイルの安全設定、決定的出力、エラー、ロールバックの詳細は[`docs/general/06-developer-guide.md`](docs/general/06-developer-guide.md)を参照してください。

## バージョン

既存の開発履歴を引き継ぎ、汎用ビルダーを公開するパッケージ版は`3.1.0`とします。`package.json`のバージョンとGitタグ`v3.1.0`を一致させ、公開済みタグは移動・削除しません。リポジトリ間の固定依存にはGitタグとlockfileを使用するため、npmレジストリ公開は必須ではありません。将来、不特定の外部利用者向けにnpm公開する場合は別のリリース作業として扱います。

紙芝居アプリの配布SB3は、kamishibai 3.1の展開ソースからビルド時に生成します。
