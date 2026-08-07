# 紙芝居DSL 4.0 capability／Bundle／release契約

Copyright © 2026 Hiroya Kubo.

文書状態: Issue #266の実装正本（2026-08-07）

関連Issue: [#258](https://github.com/kubohiroya/tmpose-kamishibai/issues/258)、
[#265](https://github.com/kubohiroya/tmpose-kamishibai/issues/265)、
[#266](https://github.com/kubohiroya/tmpose-kamishibai/issues/266)

機械可読な契約:
[`capability-bundle-release-contract.json`](../../test/fixtures/dsl4/capability-bundle-release-contract.json)

## 1. 結論

4.0.0のStandard成果物は、`kubohiroyakamishibairuntime4`を一度だけ登録する
**source-composed Standard Runtime**です。旧案の生成Composite ID `kubohiroyakamishibai4`は4.0の
Standard成果物へ使用しません。5つの外部capabilityは完全固定npm packageの`./composition`から組み込み、
Structured Dataはこのrepositoryのfirst-party sourceとして組み込みます。

`extensionBundles`は3.2の個別拡張を生成Compositeへ変換し、recovery capsuleからunbundleする境界として
維持します。4.0 StandardはStandalone block成果物を変換していないため、unbundle対象ではありません。
そのprovenanceは`package.json`、`pnpm-lock.yaml`、`LICENSES.md`と統合testで追跡します。

## 2. capability inventory

| capability         | provider／version                                | repository                                | Standalone ID                        | 4.0 Standardでの境界 |
| ------------------ | ------------------------------------------------ | ----------------------------------------- | ------------------------------------ | -------------------- |
| Asset Manager      | `@kubohiroya/turbowarp-asset-manager@0.7.0`      | `kubohiroya/turbowarp-asset-manager`      | `kubohiroyaassetmanager`             | `./composition`      |
| Async Input        | `@kubohiroya/turbowarp-async-input@0.3.0`        | `kubohiroya/turbowarp-async-input`        | `kubohiroyaasyncinput`               | `./composition`      |
| Runtime Expression | `@kubohiroya/turbowarp-runtime-expression@0.3.0` | `kubohiroya/turbowarp-runtime-expression` | `kubohiroyaruntimeexpression`        | `./composition`      |
| SVG Text           | `@kubohiroya/turbowarp-svg-text@0.3.0`           | `kubohiroya/turbowarp-svg-text`           | `kubohiroyasvgtext`                  | `./composition`      |
| TMPose             | `@kubohiroya/turbowarp-tmpose@1.6.1`             | `kubohiroya/turbowarp-tmpose`             | `tmpose`                             | `./composition`      |
| Structured Data    | first-party source v1                            | `kubohiroya/tmpose-kamishibai`            | `kubohiroyastructdata1`              | internal composition |
| Structured debug   | Structured Dataと同じ                            | `kubohiroya/tmpose-kamishibai`            | `kubohiroyastructdata1debug`         | Standardから除外     |
| Action Context     | first-party source                               | `kubohiroya/tmpose-kamishibai`            | `kubohiroyakamishibai4actioncontext` | Standardから除外     |

package versionはrangeを使わず、lockfileのnpm integrityと一致させます。Standalone成果物はcapability単独利用の
公開面であり、4.0 Standardへ登録しません。packageの`./composition`は自動registerせず、Standard Runtimeの
composition rootだけが`Scratch.extensions.register()`を一度呼びます。

## 3. API、integrity、license、SBOM

source compositionの互換契約は次の4点です。

1. `package.json`の完全固定version
2. `pnpm-lock.yaml`の同一versionとSHA-512 integrity
3. packageが公開する`./composition` export
4. Kamishibai adapterを通す統合test

Standard 4.0にはstatic bundle memberがないため、block API manifestは適用しません。将来
`extensionBundles` memberを追加するときは、artifact integrityだけでなくextension ID、opcode、menu、
storage、互換versionを持つAPI manifestを必須にし、保存済みblock graphとの互換性を検証します。

配布SBOMの入力は`package.json`と`pnpm-lock.yaml`、attributionの正本は`LICENSES.md`です。Standard成果物を
生成するlocal source、release source directory、download catalogのSHA-256とsource commitを合わせて、
「どのsourceとpackageからどのSB3を作ったか」を追跡します。

## 4. 成果物とpalette

| surface                    | extension ID                         | 登録 |           palette | preview UI |
| -------------------------- | ------------------------------------ | ---: | ----------------: | ---------: |
| Standard 4.0 Runtime       | `kubohiroyakamishibairuntime4`       |    1 |           0 block |       なし |
| Action Context             | `kubohiroyakamishibai4actioncontext` |    0 |          8 opcode |       なし |
| Structured Data Standalone | `kubohiroyastructdata1`              |    0 | developer surface |       なし |
| Structured Data debug      | `kubohiroyastructdata1debug`         |    0 |     debug surface |       なし |
| development preview host   | なし                                 |    0 |          DOM／CLI | 開発時のみ |

Standard Runtimeの4 opcodeはcanonical templateの内部接続・状態確認用で、すべて
`hideFromPalette: true`です。Standard SB3はそのextension source、YAML source descriptor、runtime artifact、
asset bundle bytesを内包し、実行時にextension codeをremote取得しません。preview token、candidate、modal、
reload preferenceなどのtransient stateも保存しません。

## 5. asset、preview、security境界

remote **extension code**とremote previewは常に禁止します。asset bytesは別の境界で、作者が
`delivery: remote`を明示し、HTTPS、SHA-256 integrity、media typeを固定した場合だけ利用できます。
verified remote cacheは取得後のbytesを再検証し、失敗時に未検証bytesへfallbackしません。

local preview transportはloopback address、許可origin、session token、project root confinementをすべて
満たす接続だけを受け入れます。protocol、fingerprint、candidate session、reload transaction、transport
policy、local HTTP host adapter、公開`preview-dsl4 --watch`のargument／signal／browser open接続は
実装済みです。CLIはbrowser runtime-ready ackを受け取るまで成功表示せず、未接続、full rebuild、
SIGINT／SIGTERMを有限終了させます。

artifact fingerprintにはbase SB3、asset bundle、app shell、Standard Runtime、builder設定、source path／ID、
control profileを含めます。YAML textのintegrityだけが変わった場合はlive reload、fingerprintが変わった場合は
full rebuildしてentrypointから再開します。reload preference、dialog layout、token、candidate revisionは
fingerprintにもproduction artifactにも含めません。

### 5.1 sourceの読込・保存sequence

| surface              | 作者入力                                                          | 読込sequence                                                                                                        | 保存／再読込                                                                                  |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Web Preview          | read-onlyに選択したproject rootの`project.source.json`と`.k4.yml` | browser adapterの安定読込 → production source frontend → 共有preview protocol → browser runtime                     | 台本は外部editorが保存し、Web PreviewはfileやSB3を書き込まない                                |
| local development    | `preview-dsl4 --watch`に渡すbase SB3、project root、manifest      | Node安定読込 → production source frontend → 認証済みgeneration → browser-owned実TurboWarp runtime                   | YAML-only保存はruntime generationだけを更新し、SB3を再buildしない                             |
| TurboWarp editor     | `build-dsl4 --channel unbundled`で生成した自己完結SB3             | editorがSB3を読み、runtimeは`kubohiroyakamishibairuntime4.source`のembedded descriptorだけを読む                    | TurboWarp再保存後もdescriptorを同一extension storageに保持し、再読込で同じintegrityを検証する |
| Web player／Packager | `build-dsl4 --channel bundled`で生成した自己完結SB3               | production shellはpackaged runtime member内のembedded descriptorだけを読み、external pathやpreview bridgeを読まない | playerは保存せず、Packagerは検証済みSB3のsource／artifact／asset storageを保持する            |

4.0 Standardはsource-composed Standalone runtimeであり、3.2の`extensionBundles`変換対象ではありません。
そのためsource descriptorの可逆性は、unbundled／bundledの両storage pathで同じdescriptorを検証するtestと、
固定TurboWarp VMの実際のload → `toJSON()`再保存testを正本とします。

## 6. lifecycle

Standard Runtimeはsource frontend、StoryDocument、scene dependency、asset preload、image／audio／pose model、
runtime controllerを一つのcomposition rootで所有します。正常終了、明示的stop、crash、transport切断のどれでも、
新しい入力を止め、実行中actionをquiesceし、candidate／current session、asset lease、sound、skin、pose、camera、
listener、timer、cache handleの順に所有resourceを解放します。disposeは冪等にし、途中の失敗を集約して残りの
cleanupを継続します。

## 7. releaseとrollback

releaseは必ず次の順で行います。

1. capability packageを個別repositoryでtestしreleaseする
2. Kamishibaiの`package.json`とlockfileを完全固定versionへ更新する
3. package、runtime reporter、release catalogを同じrelease versionへ更新する
4. `pnpm verify:full`を実行する
5. version付き`release-sources/<version>/app`を書き出す
6. `pnpm sb3:dsl4-release:check`でSB3の決定性と実行を検証する
7. download catalogのSHA-256、source commit、build dateを更新する
8. source commitを保持するmerge strategyでrelease PRをmainへ統合する
9. mainで`pnpm verify:full && pnpm release:check`を再実行する
10. version tagを作成する
11. npm packageを公開する
12. GitHub Releaseを公開する
13. siteをbuildして公開する

更新中に失敗した場合は新しい成果物を公開しません。公開後は同じversionのpackage、tag、GitHub Release、
version付きrelease sourceを差し替えません。必要に応じてnpm versionをdeprecateし、GitHub Releaseへ注記し、
直前の推奨downloadへsiteを戻してから修正版を次のpatch versionで公開します。3.2 `extensionBundles`
memberの更新は一件ずつ行い、recovery capsuleを保ったままmember単位で戻します。

## 8. 受け入れ基準

- capability、repository、package、version、extension ID、providerがfixtureと一致する
- Standard SB3が`kubohiroyakamishibairuntime4`一件だけをembedded URLから読み込む
- Standard paletteのvisible DSL 4.0 blockが0で、developer／debug／preview surfaceを含まない
- exact dependency、lock integrity、license attributionが回帰testで検証される
- YAML-only変更と構造変更の分岐、transient state除外がfixtureで固定される
- remote code／remote preview禁止とverified remote asset opt-inを混同しない
- release／update／rollback順序と実行済みevidenceが機械可読契約から検査される

この契約だけを戻す場合は文書、fixture、test、`app-shell-contract.json`のStandard Runtime ID修正をrevertします。
runtime、package pin、release sourceの挙動は変更しません。
