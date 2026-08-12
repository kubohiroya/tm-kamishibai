# 紙芝居DSL 4.0 capability／Bundle／release契約

Copyright © 2026 Hiroya Kubo.

文書状態: Issue #266／#517の実装正本（2026-08-10）

関連Issue: [#258](https://github.com/kubohiroya/tmpose-kamishibai/issues/258)、
[#265](https://github.com/kubohiroya/tmpose-kamishibai/issues/265)、
[#266](https://github.com/kubohiroya/tmpose-kamishibai/issues/266)、
[#517](https://github.com/kubohiroya/tmpose-kamishibai/issues/517)、
[#548](https://github.com/kubohiroya/tmpose-kamishibai/issues/548)

機械可読な契約:
[`capability-bundle-release-contract.json`](../../test/fixtures/dsl4/capability-bundle-release-contract.json)

## 1. 結論

4.0.0-rc.1のStandard成果物は、`kubohiroyakamishibai4`一件をembedded extensionとして生成します。
公式WebサイトボタンはこのRuntimeの固定URL用`openOfficialWebsite`を呼び、任意URLを受け取るWeb Link拡張を
組み込みません。生成SB3がTurboWarpへ登録する拡張とdata URLはこの一件だけです。

Runtime member自体は、6つの完全固定npm packageの公開composition subpathと、このrepositoryの
first-party Structured Dataをesbuildで一つのclassic拡張sourceへ構成します。そのsource先頭には
Gallery形式のmember headerと、内部構成要素のtitle、copyright、license、package versionを残します。

## 2. capability inventory

| capability         | provider／version                                | repository                                | Standalone ID                        | 4.0 Standardでの境界         |
| ------------------ | ------------------------------------------------ | ----------------------------------------- | ------------------------------------ | ---------------------------- |
| Asset Manager      | `@kubohiroya/turbowarp-asset-manager@0.10.0`     | `kubohiroya/turbowarp-asset-manager`      | `kubohiroyaassetmanager`             | `./composition`              |
| Async Input        | `@kubohiroya/turbowarp-async-input@0.3.0`        | `kubohiroya/turbowarp-async-input`        | `kubohiroyaasyncinput`               | `./composition`              |
| Bubble             | `@kubohiroya/turbowarp-bubble@0.4.0`             | `kubohiroya/turbowarp-bubble`             | `kubohiroyabubble`                   | `./` + `./turbowarp-adapter` |
| Runtime Expression | `@kubohiroya/turbowarp-runtime-expression@0.3.0` | `kubohiroya/turbowarp-runtime-expression` | `kubohiroyaruntimeexpression`        | `./composition`              |
| SVG Text           | `@kubohiroya/turbowarp-svg-text@0.4.0`           | `kubohiroya/turbowarp-svg-text`           | `kubohiroyasvgtext`                  | `./composition`              |
| TMPose             | `@kubohiroya/turbowarp-tmpose@1.7.4`             | `kubohiroya/turbowarp-tmpose`             | `tmpose`                             | `./composition`              |
| Structured Data    | first-party source v1                            | `kubohiroya/tmpose-kamishibai`            | `kubohiroyastructdata1`              | internal composition         |
| Structured debug   | Structured Dataと同じ                            | `kubohiroya/tmpose-kamishibai`            | `kubohiroyastructdata1debug`         | Standardから除外             |
| Action Context     | first-party source                               | `kubohiroya/tmpose-kamishibai`            | `kubohiroyakamishibai4actioncontext` | Standardから除外             |

package versionはrangeを使わず、lockfileのnpm integrityと一致させます。6つのnpm capabilityのStandalone成果物は
4.0 Standardのbundle memberにはせず、Runtime memberのcomposition rootだけがそれらのserviceを構成します。
Standard Runtimeは`Scratch.extensions.register()`を一度だけ実行し、外部リンクを含むアプリshell capabilityも
同じRuntime境界で提供します。

Asset Manager 0.8.0はstructured project locatorを正規のcomposition APIとして公開しています。
Standard Runtimeはnpmの完全固定releaseを直接利用し、`patchedDependencies`やrepository-local patchを
介しません。rollbackは0.7.0のexact pin、直前の`patchedDependencies`／patch、lockfileを復元するか、
DSL 4 runtime flagをOFFにして3.2成果物を使用します。

## 3. API、integrity、license、SBOM

Runtime member内部のsource composition互換契約は次の4点です。

1. `package.json`の完全固定version
2. `pnpm-lock.yaml`の同一versionとSHA-512 integrity
3. packageが公開する`./composition` export
4. Kamishibai adapterを通す統合test

Standard 4.0のembedded extensionはRuntime 4一件です。Gallery形式のheader、単一の同期
`Scratch.extensions.register()`、固定IDを満たし、保存済みblock graphのopcodeを回帰testで検証します。
managed external memberを追加するときは、artifact integrityに加えてextension ID、opcode、menu、storage、
互換versionを持つAPI manifestを必須にします。

配布SBOMの入力は`package.json`と`pnpm-lock.yaml`、attributionの正本は`LICENSES.md`です。Standard成果物を
生成するlocal source、version付きrelease source directory、そのpathとbyte列から求めたsource identity、
download catalogのSHA-256を合わせて、
「どのsourceとpackageからどのSB3を作ったか」を追跡します。

## 4. 成果物とpalette

| surface                    | extension ID                         | 登録 |           palette |     preview UI |
| -------------------------- | ------------------------------------ | ---: | ----------------: | -------------: |
| Standard 4.0 Runtime       | `kubohiroyakamishibai4`              |    1 |     hidden facade | 非埋め込みのみ |
| Action Context             | `kubohiroyakamishibai4actioncontext` |    0 |          8 opcode |           なし |
| Structured Data Standalone | `kubohiroyastructdata1`              |    0 | developer surface |           なし |
| Structured Data debug      | `kubohiroyastructdata1debug`         |    0 |     debug surface |           なし |
| development preview host   | なし                                 |    0 |          DOM／CLI |     開発時のみ |

Runtime memberのopcodeはcanonical templateの内部接続・状態確認用で、すべて`hideFromPalette: true`です。
Standard SB3はruntime source、YAML source descriptor、runtime artifact、asset bundle bytesを内包し、
実行時にextension codeをremote取得しません。preview token、candidate、modal、reload preferenceなどの
transient stateも保存しません。非埋め込み`application.mode=menu`は制作・debug runnerとして
preview UIを初期化し、埋め込み`application.mode=story`はproduction実行として初期化しません。

## 5. asset、preview、security境界

remote **extension code**とremote previewは常に禁止します。asset bytesは別の境界です。作者が
`delivery: remote`を明示したposeModelは通常のHTTPS TMPoseディレクトリURLを利用できます。内容固定が
必要ならembeddedへ変換します。integrity、media type、sizeを宣言したverified remoteは取得後のbytesを
再検証し、失敗時に未検証bytesへfallbackしません。

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

| surface              | 作者入力                                                     | 読込sequence                                                                                                | 保存／再読込                                                                       |
| -------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Web Preview          | 非埋め込みSB3で選択した台本fileまたはproject root            | browser安定読込 → production frontend → 宣言asset準備 → 共有preview protocol → runtime                      | 台本は外部editorが保存し、handleやpreview stateはSB3へ書き込まない                 |
| local development    | `preview-dsl4 --watch`に渡すbase SB3、project root、manifest | Node安定読込 → production source frontend → 認証済みgeneration → browser-owned実TurboWarp runtime           | YAML-only保存はruntime generationだけを更新し、SB3を再buildしない                  |
| TurboWarp editor     | Standard SB3、または台本埋め込みSB3                          | 非埋め込みはOpen後にwatch、埋め込みはcomponent descriptorをproduction再生                                   | Editorで追加したcostume／soundを保持し、非埋め込みのYAML更新時に`name`から再解決   |
| Web player／Packager | 同じStandard SB3                                             | production shellはruntime componentのembedded descriptorだけを読み、external pathやpreview bridgeを読まない | playerは保存せず、Packagerは検証済みSB3のsource／artifact／asset storageを保持する |

4.0 StandardはRuntime内部のsource compositionを行い、SB3生成時には一件のembedded extensionとして格納します。
source descriptorの可逆性は、Runtime component storage pathの検証と、固定TurboWarp VMの実際の
load → `toJSON()`再保存testを正本とします。`extensionBundles`は複数の実在する拡張を統合する3.2成果物だけに使います。

## 6. lifecycle

Standard Runtimeはsource frontend、StoryDocument、scene dependency、asset preload、image／audio／pose model、
runtime controllerを一つのcomposition rootで所有します。正常終了、明示的stop、crash、transport切断のどれでも、
新しい入力を止め、実行中actionをquiesceし、candidate／current session、asset lease、sound、skin、pose、camera、
listener、timer、cache handleの順に所有resourceを解放します。disposeは冪等にし、途中の失敗を集約して残りの
cleanupを継続します。

タイトルから物語またはメニューへ進む分岐は、
[3.2内部仕様書の状態遷移](https://kubohiroya.github.io/tmpose-kamishibai-docs/3.2/developer-guides/internal-specification/document.html#%E7%8A%B6%E6%85%8B%E9%81%B7%E7%A7%BB)
を4.0 Standardでも維持します。緑の旗は初期化後に`showTitle`へ進み、タイトル表示中は物語を開始しません。
ステージ上のタイトル背景クリックと右上の閉じるボタンは、いずれも`closeTitle` broadcastへ集約します。
`closeTitle`受信後は、台本埋め込み版なら`startStory`、非埋め込み版なら`showCover`からカバー／メニューへ進みます。
物語の終了または中止は`stopStory`からカバー／メニューへ戻し、タイトルを再表示しません。

## 7. releaseとrollback

4.0.0-rc.1 releaseは必ず次の順で行います。

1. capability packageを個別repositoryでtestしreleaseする
2. Kamishibaiの`package.json`とlockfileを完全固定versionへ更新する
3. package、runtime reporter、release catalogを同じrelease versionへ更新する
4. candidate状態で`pnpm release:dsl4:update`を実行し、version付きsource、SB3 hash、metadataを一括更新する
5. `pnpm release:dsl4:check`と`pnpm verify:full`でsource一致とSB3決定性を非破壊検証する
6. candidate PRをmainへ統合し、clean mainで`pnpm verify:full && pnpm release:check`を再実行する
7. `pnpm release:dsl4:freeze`でsource identityとartifact SHA-256を固定し、mainへ統合する
8. frozen commitへannotated `v4.0.0-rc.1` tagを作成する
9. npm packageをdist-tag `next`で公開し、`latest=3.2.3`を維持する
10. GitHub prereleaseを公開する
11. 3.2.3を推奨安定版に維持したままsiteをbuildして公開する
12. 外部URLをmetadataへ記録してpublishedへ遷移し、version／hash／dist-tagを照合する

更新中に失敗した場合は新しい成果物を公開しません。公開後は同じversionのpackage、tag、GitHub Release、
version付きrelease sourceを差し替えません。`frozen`または`published`ではupdateをfail closedにし、修正は
4.0.0-rc.2、正式安定版は4.0.0として新しいmetadata、source identity、artifact hashを作成します。
既定OFFの対象surfaceを無効化し、必要に応じてnpm versionをdeprecateし、GitHub Releaseへ注記します。
3.2の`extensionBundles` member更新は一件ずつ行い、recovery capsuleを保ったままmember単位で戻します。

## 8. 受け入れ基準

- capability、repository、package、version、extension ID、providerがfixtureと一致する
- Standard展開ソースがRuntime 4一件を管理し、Web Linkを含まない
- Standard SB3が`kubohiroyakamishibai4`一件だけをembedded URLから読み込む
- runtime source先頭にheader、全構成要素のprovenanceが残る
- Standard paletteのvisible DSL 4.0 blockが0で、preview専用opcodeを含まない
- 非埋め込みだけがpreviewを初期化し、埋め込みproductionは初期化しない
- preview handle、candidate、reload preference、dialog stateをSB3に保存しない
- exact dependency、lock integrity、license attributionが回帰testで検証される
- YAML-only変更と構造変更の分岐、transient state除外がfixtureで固定される
- 緑の旗、タイトル背景／閉じるボタン、台本有無、物語終了の遷移が3.2の状態遷移と一致する
- remote code／remote preview禁止とverified remote asset opt-inを混同しない
- release／update／rollback順序と実行済みevidenceが機械可読契約から検査される

この契約だけを戻す場合は文書、fixture、test、`app-shell-contract.json`のStandard Runtime ID修正をrevertします。
runtime、package pin、release sourceの挙動は変更しません。
