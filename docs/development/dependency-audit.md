# 依存関係監査記録

## 監査基準

- 監査日: 2026-08-03
- 対象commit: Phase -1の#198までを統合した`main`
- package manager: `pnpm@11.11.0`
- Node.js: リポジトリの`engines`で定める22.12.0以上
- 追跡Issue: #204、残存例外は#212

監査には次のコマンドを使用します。

```sh
pnpm audit --prod
pnpm audit
pnpm why <package>
```

`pnpm audit --prod`はリリースされるnpm packageの実行依存、`pnpm audit`はテスト、
SB3生成、文書生成を含む開発依存も対象とします。

## 結果

| 対象       | 更新前                      | 更新・override後            |
| ---------- | --------------------------- | --------------------------- |
| production | 0件                         | 0件                         |
| devを含む  | high 6 / moderate 5 / low 2 | high 2 / moderate 1 / low 1 |

通常のsemver範囲内でlockfileを更新し、`brace-expansion` 3系列と`tar`をpatched versionへ
更新しました。次の限定overrideは、上流packageがpatched versionを選択できない経路だけに
適用しています。

| package     | override                     | 理由                                            | 解除条件                                   |
| ----------- | ---------------------------- | ----------------------------------------------- | ------------------------------------------ |
| `dompurify` | `@vivliostyle/cli`内を3.4.12 | CLIが3.4.11を固定しているため                   | Vivliostyle CLI自身が3.4.12以上を採用      |
| `prismjs`   | 1.30.0                       | VFMのsyntax highlight経路が1.27.0を選択するため | VFM／refractor自身が1.30.0以上を採用       |
| `trim`      | 0.0.3                        | VFMのMarkdown parserが0.0.1を選択するため       | VFM／remark-parseが脆弱な`trim`依存を除去  |
| `valibot`   | 1.4.2                        | VFMが1.2.0を選択するため                        | VFM自身が1.4.2以上を採用                   |
| `uuid`      | `press-ready`内を11.1.1      | PDF後処理経路が8.3.2を選択するため              | press-ready自身が11.1.1以上を採用          |
| `uuid`      | `scratch-vm`内を11.1.1       | VMテスト経路が8.3.2を選択するため               | TurboWarp scratch-vm自身が11.1.1以上を採用 |

override後は、標準検証、152件の自動テスト、SB3整合性検査、HTML/PDFを含むフルbuildで
互換性を確認します。回帰が見つかった場合は、該当overrideとlockfile更新だけをrevertします。

## 残存するdev依存例外

次の4件はすべて、固定したTurboWarp `scratch-vm`の
`worker-loader > webpack@4`以下にあるlegacy build toolchainです。

| advisory            | package                      | severity | このリポジトリでの実行可能性                               |
| ------------------- | ---------------------------- | -------- | ---------------------------------------------------------- |
| GHSA-grv7-fg5c-xmjg | `braces@2.3.2`               | high     | Webpackのglob/watchを実行しないため到達しない              |
| GHSA-952p-6rrq-rcjv | `micromatch@3.1.10`          | moderate | Webpackのglob/watchを実行しないため到達しない              |
| GHSA-5c6j-r48x-rmvq | `serialize-javascript@4.0.0` | high     | Webpack/Terserのserializationを実行しないため到達しない    |
| GHSA-848j-6mx2-7j84 | `elliptic@6.6.1`             | low      | Webpack用browser crypto polyfillを実行しないため到達しない |

このリポジトリはscratch-vmをbuild/watchせず、固定済みsourceをVMテストで読み込むだけです。
また、`elliptic`は監査情報がpatchedとする6.6.2が2026-08-03時点でnpmに未公開です。
互換性未確認のWebpack 4 transitive dependencyをmajor overrideすると、監査表示だけを消して
将来のscratch-vm更新を壊すため採用しません。

例外の影響、緩和策、解除条件、2026-09-03までの再確認は#212で追跡します。

## 継続監視

`.github/dependabot.yml`でnpm依存とGitHub Actionsを毎週月曜09:00（Asia/Tokyo）に確認します。
Dependabotが残存例外のpatched経路を提示した場合、またはscratch-vmの固定commitを変更する場合は、
#212を更新して本記録とoverrideを再評価します。production監査が0件でなくなった場合は、
修正または明示的なリリース停止判断が完了するまで公開しません。
