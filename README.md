# TMPose紙芝居

**ポーズで進めるAIインタラクティブ紙芝居**

TMPose紙芝居は、TurboWarpとTMPoseを利用し、参加者がカメラの前でポーズを取ることで物語を進める紙芝居システムです。このリポジトリには、紙芝居アプリのソース、配布用SB3、Webサイト、ドキュメント、および台本とアセットをSB3へ組み込むビルダーがあります。

## 使ってみる

- [現在公開中のWeb版](https://sqs.prof.cuc.ac.jp/kamishibai/)
- [GitHub Pages版](https://kubohiroya.github.io/tmpose-kamishibai/)
- [サンプル](https://kubohiroya.github.io/tmpose-kamishibai-samples/)

利用方法、台本の書式、利用できるコマンドについては[ドキュメント](#ドキュメント)を参照してください。

## npmパッケージ

[`@kubohiroya/tmpose-kamishibai`](https://www.npmjs.com/package/@kubohiroya/tmpose-kamishibai)は、外部の画像・音声をベースSB3へ組み込み、台本の`asset=`行をプロジェクト内参照へ変換するCLIとJavaScript APIを提供します。

検証済みバージョンを固定して導入します。

```bash
pnpm add --save-exact @kubohiroya/tmpose-kamishibai@3.1.5
```

```bash
pnpm exec tmpose-kamishibai build-sb3 \
  --base kamishibai.sb3 \
  --script source.txt \
  --assets assets.lock.json \
  --output dist/_sample \
  --profile editor
```

API、アセットマニフェスト、安全設定、出力形式については[メンテナンスガイド](docs/general/06-developer-guide.md)を参照してください。

## このリポジトリを開発する

### 必要な環境

- Node.js 22.12.0以上
- pnpm 11
- PDF生成に利用できるChromeまたはChromium

### セットアップ

```bash
pnpm install
```

### 主なコマンド

| コマンド                                  | 内容                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `pnpm run build`                          | Webサイト、ドキュメント、配布用SB3を`dist/`へ生成 |
| `pnpm test`                               | SB3、ビルダー、ドキュメントをテスト               |
| `pnpm lint`                               | JavaScriptを検査                                  |
| `pnpm typecheck`                          | ビルダーAPIを型検査                               |
| `pnpm sb3:build`                          | `app/`から編集用SB3を`tmp/kamishibai.sb3`へ生成   |
| `pnpm sb3:check`                          | `app/`のSB3ソースを検証                           |
| `pnpm sb3:import -- /path/to/project.sb3` | TurboWarpで編集したSB3を`app/`へ取り込み          |
| `pnpm run deploy`                         | ビルド結果をGitHub Pagesへ公開                    |

文書だけをプレビューする場合は、`pnpm run preview:docs`、`pnpm run preview:workshop`、`pnpm run preview:staff`を利用できます。

主な生成先は次のとおりです。

- `dist/`: GitHub Pagesへ公開するWebサイト、HTML/PDF、配布用SB3
- `output/pdf/`: 印刷用PDFのローカル確認先
- `tmp/kamishibai.sb3`: TurboWarpで編集するためのSB3

## リポジトリ構成

- `app/`: 紙芝居SB3のGit管理上の正本
- `src/builder/`、`bin/`: npmで配布するビルダーAPIとCLI
- `docs/general/`: 一般向け資料と技術資料
- `docs/workshops/`: 日付付きの体験会資料
- `site/`: 公開サイトの静的ファイル
- `scripts/`: サイトとドキュメントのビルド処理
- `test/`: 自動テストと最小検証用台本

## ドキュメント

- [概要説明書（大人向け）](docs/general/01-executive-summary-adult.md)
- [概要説明書（子供向け）](docs/general/02-executive-summary-kids.md)
- [利用者ガイド](docs/general/03-user-guide.md)
- [台本DSLマニュアル](docs/general/04-dsl-manual.md)
- [コマンドリファレンス](docs/general/05-command-reference.md)
- [メンテナンスガイド](docs/general/06-developer-guide.md)
- [内部仕様書](docs/general/07-internal-specification.md)
- [変更履歴](docs/general/history.md)
- [公開ドキュメント一覧](https://kubohiroya.github.io/tmpose-kamishibai/docs/)

## 関連プロジェクト

- [`kubohiroya/sb3-toolchain`](https://github.com/kubohiroya/sb3-toolchain): このリポジトリで利用している、SB3の展開・検証・再構築・埋め込み拡張管理のためのツール
- [`kubohiroya/tmpose-kamishibai-samples`](https://github.com/kubohiroya/tmpose-kamishibai-samples): サンプル台本、スプライト、背景、画像、音声、組み込み済みSB3

## ライセンス

著作権とライセンスは対象ごとに区分します。

- `docs/general/**`: CC BY-SA 4.0
- `docs/workshops/**`: Copyright © 2026 Hiroya Kubo. All rights reserved.
- 上記以外で個別表示のない、本プロジェクトが著作権を持つソフトウェアおよび素材: MPL-2.0

詳細と第三者著作物の扱いは[`LICENSES.md`](LICENSES.md)を参照してください。npmパッケージに含まれるCLIとbuilder APIにはMPL-2.0を適用します。
