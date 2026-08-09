# ライセンス区分

Copyright © 2026 Hiroya Kubo.

このリポジトリでは、次のライセンスを適用します。

| 対象                                                                 | ライセンス                                       |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| 個別の表示がない、本プロジェクトが著作権を持つソフトウェアおよび素材 | [Mozilla Public License 2.0](LICENSE)（MPL-2.0） |

一般向け、紙芝居DSL作成者向け、開発者向け、および体験会の文書と図版は
[`kubohiroya/tmpose-kamishibai-docs`](https://github.com/kubohiroya/tmpose-kamishibai-docs)
へ移設しました。文書のライセンス区分は移設先の表示を参照してください。

第三者のソフトウェア、フォント、画像、音声その他の素材には、それぞれの権利者が
定めたライセンスまたは利用条件が適用されます。個別のライセンス表示がある場合は、
この一覧より個別表示を優先します。

## DSL 4.0 Standard Runtimeの直接依存

次の一覧は`package.json`と`pnpm-lock.yaml`で完全固定している直接依存です。各packageに同梱された
license表示とsource repositoryを正本とします。

| package                                  | version／revision | license      | source repository                         |
| ---------------------------------------- | ----------------- | ------------ | ----------------------------------------- |
| @kubohiroya/turbowarp-asset-manager      | 0.8.0             | MPL-2.0      | `kubohiroya/turbowarp-asset-manager`      |
| @kubohiroya/turbowarp-async-input        | 0.3.0             | MPL-2.0      | `kubohiroya/turbowarp-async-input`        |
| @kubohiroya/turbowarp-bubble             | 0.3.1             | MPL-2.0      | `kubohiroya/turbowarp-bubble`             |
| @kubohiroya/turbowarp-runtime-expression | 0.3.0             | MPL-2.0      | `kubohiroya/turbowarp-runtime-expression` |
| @kubohiroya/turbowarp-svg-text           | 0.4.0             | MPL-2.0      | `kubohiroya/turbowarp-svg-text`           |
| @kubohiroya/turbowarp-tmpose             | 1.6.1             | MPL-2.0      | `kubohiroya/turbowarp-tmpose`             |
| @turbowarp/scratch-storage               | 2.0.0             | BSD-3-Clause | `TurboWarp/scratch-storage`               |
| @turbowarp/scratch-svg-renderer          | 1.1.0             | MPL-2.0      | `TurboWarp/scratch-svg-renderer`          |
| brfs                                     | 1.6.1             | MIT          | `browserify/brfs`                         |
| esbuild                                  | 0.28.1            | MIT          | `evanw/esbuild`                           |
| fflate                                   | 0.8.3             | MIT          | `101arrowz/fflate`                        |
| scratch-audio                            | `aba00cd`         | BSD-3-Clause | `TurboWarp/scratch-audio`                 |
| scratch-render                           | `a67f7c9`         | MPL-2.0      | `TurboWarp/scratch-render`                |
| scratch-vm                               | `c482342`         | MPL-2.0      | `TurboWarp/scratch-vm`                    |
| yaml                                     | 2.8.1             | ISC          | `eemeli/yaml`                             |
