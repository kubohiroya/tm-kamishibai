# 依存関係監査記録

## 監査基準

- 監査日: 2026-08-03
- 対象commit: `main`の`e884bea`を起点とする#227の依存更新
- package manager: `pnpm@11.18.0`
- Node.js: リポジトリの`engines`で定める22.12.0以上
- 追跡Issue: #204、legacy Webpack経路の除去は#212、バージョン更新は#227

監査には次のコマンドを使用します。

```sh
pnpm audit --prod
pnpm audit
pnpm why <package>
```

`pnpm audit --prod`はリリースされるnpm packageの実行依存、`pnpm audit`はテスト、
SB3生成、文書生成を含む開発依存も対象とします。

## バージョン更新状況

2026-08-03にnpm registryと各GitHubリポジトリの既定branchを確認しました。

| 対象                   | 更新前       | 更新後・判断                                                                |
| ---------------------- | ------------ | --------------------------------------------------------------------------- |
| pnpm                   | 11.11.0      | 最新の11.18.0へ更新                                                         |
| sb3-toolchain          | 0.1.0相当    | 最新の0.3.0、commit `2c82aaf`へ更新                                         |
| rubygana               | `a24b8a6`    | 最新のmaster `649cba1`、0.9.0へ更新                                         |
| globals                | 17.8.0       | 17.9.0は公開後24時間未満で鮮度policyの対象となるため17.8.0を維持            |
| trim override          | 0.0.3        | 最新の1.0.1へ更新し、文書buildを含む全検証で互換性を確認                    |
| その他の直接npm依存    | package.json | registry上の最新安定版と一致                                                |
| scratch-vm             | `c482342`    | TurboWarpの最新develop／既定branchと一致するため維持                        |
| scratch-render-fonts   | `7b6768f`    | TurboWarpの最新master／既定branchと一致するため維持                         |
| CommonJS利用元内のuuid | 11.1.1       | 12以降はCommonJS用exportがないため、press-readyとscratch-vm内は11.1.1を維持 |

`@kubohiroya/sb3-toolchain`はcommit固定の開発時依存です。`pnpm sb3:*`、CIの
`pnpm sb3:check`、配布buildのJavaScript API呼び出しは同じ0.3.0を利用します。

管理対象の組み込み機能拡張は、最新toolchainのtransactional updateで次の上流
`main`へ更新しました。

| 機能拡張           | 更新後version | resolved commit |
| ------------------ | ------------- | --------------- |
| Asset Manager      | 0.4.0         | `c952b0b`       |
| TMPose             | 1.4.0         | `08fe0cf`       |
| Text Lines         | 0.1.1         | `8655d76`       |
| Runtime Expression | 0.2.0         | `7e2bd99`       |
| Async Input        | 0.2.0         | `3ecd7ff`       |

外部URLで読み込むTurboWarp Gallery機能拡張はversionをこのrepositoryで固定しないため、
URLを維持します。ローカル実装のKamishibai RuntimeとWeb Linkには別の上流versionはありません。

## 結果

| 対象       | 更新前                      | 更新・override後 |
| ---------- | --------------------------- | ---------------- |
| production | 0件                         | 0件              |
| devを含む  | high 6 / moderate 5 / low 2 | 0件              |

通常のsemver範囲内でlockfileを更新し、`brace-expansion` 3系列と`tar`をpatched versionへ
更新しました。次の限定overrideは、上流packageがpatched versionを選択できない経路だけに
適用しています。

| package         | override                     | 理由                                                                               | 解除条件                                                                             |
| --------------- | ---------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `dompurify`     | `@vivliostyle/cli`内を3.4.12 | CLIが3.4.11を固定しているため                                                      | Vivliostyle CLI自身が3.4.12以上を採用                                                |
| `prismjs`       | 1.30.0                       | VFMのsyntax highlight経路が1.27.0を選択するため                                    | VFM／refractor自身が1.30.0以上を採用                                                 |
| `trim`          | 1.0.1                        | VFMのMarkdown parserが0.0.1を選択するため                                          | VFM／remark-parseが`trim`依存を除去                                                  |
| `valibot`       | 1.4.2                        | VFMが1.2.0を選択するため                                                           | VFM自身が1.4.2以上を採用                                                             |
| `uuid`          | `press-ready`内を11.1.1      | PDF後処理経路が8.3.2を選択するため                                                 | press-ready自身が11.1.1以上を採用                                                    |
| `uuid`          | `scratch-vm`内を11.1.1       | VMテスト経路が8.3.2を選択するため                                                  | TurboWarp scratch-vm自身が11.1.1以上を採用                                           |
| `worker-loader` | `scratch-vm`内から除去       | このrepositoryはscratch-vmをbundleせず、sandboxed worker extensionも起動しないため | scratch-vmをbundleする、またはsandboxed worker extensionをテストする場合は除去を解除 |

override後は、標準検証、159件の自動テスト、SB3整合性検査、HTML/PDFを含むフルbuildで
互換性を確認します。回帰が見つかった場合は、該当overrideとlockfile更新だけをrevertします。

## 解消したdev依存例外

次の4件はすべて、固定したTurboWarp `scratch-vm`の
`worker-loader > webpack@4`以下にあったlegacy build toolchainです。

| advisory            | package                      | severity | このリポジトリでの実行可能性                               |
| ------------------- | ---------------------------- | -------- | ---------------------------------------------------------- |
| GHSA-grv7-fg5c-xmjg | `braces@2.3.2`               | high     | Webpackのglob/watchを実行しないため到達しない              |
| GHSA-952p-6rrq-rcjv | `micromatch@3.1.10`          | moderate | Webpackのglob/watchを実行しないため到達しない              |
| GHSA-5c6j-r48x-rmvq | `serialize-javascript@4.0.0` | high     | Webpack/Terserのserializationを実行しないため到達しない    |
| GHSA-848j-6mx2-7j84 | `elliptic@6.6.1`             | low      | Webpack用browser crypto polyfillを実行しないため到達しない |

2026-08-03時点でTurboWarp `scratch-vm`の`develop`は固定commit
`c4823421cb7c17d8d8a89878851ce1668c26a21f`と同一で、上流packageは引き続き
`worker-loader`を宣言しています。一方、このリポジトリはscratch-vmをbuild/watchせず、
固定済みsourceをVMテストで読み込むだけです。テスト対象の拡張は非サンドボックスであり、
`extension-manager`の`sandboxMode === 'worker'`経路は実行しません。

そのため、pnpmの親package限定overrideで`scratch-vm>worker-loader`だけを除去しました。
これによりWebpack 4 toolchain全体がlockfileから外れ、4件は`pnpm audit`から消えます。
脆弱なtransitive packageを互換性未確認のmajor versionへ差し替えず、未使用のbuild依存だけを
除去するため、scratch-vm sourceとVM実行経路は変更しません。

scratch-vmをbundleする、sandboxed worker extensionを利用する、または上流が
`worker-loader`を置き換えた場合は、このoverrideを解除して監査と全回帰をやり直します。

## 継続監視

`.github/dependabot.yml`でnpm依存とGitHub Actionsを毎週月曜09:00（Asia/Tokyo）に確認します。
Dependabotがscratch-vmのbuild経路変更を提示した場合、またはscratch-vmの固定commitを変更する場合は、
本記録とoverrideを再評価します。production監査が0件でなくなった場合は、
修正または明示的なリリース停止判断が完了するまで公開しません。
