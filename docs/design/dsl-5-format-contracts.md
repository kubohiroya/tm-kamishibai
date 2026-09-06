# DSL 5.0 format contracts

追跡 Issue: [#769](https://github.com/kubohiroya/tm-kamishibai/issues/769)。親 Epic: [#636](https://github.com/kubohiroya/tm-kamishibai/issues/636)。

DSL 5.0 の実装が始まる前に、version、format、resource limit、feature flag の 4 つの契約をここで決めきる。以降の子 Issue（#770〜#782）はこの上に載るだけで、自前の version 規約や上限を持たない。

## なぜ先に決めるのか

DSL 4.0 では `formatVersion: 1` が `asset-bundle-descriptor`、`asset-reload-policy`、`asset-distribution-profile`、`runtime-artifact-descriptor` など十数箇所に独立して書かれている。値は一致しているが、**どの format が存在するのかを述べている場所がない**。resource limit も `dsl4SourceGraphDefaultLimits`、`dsl4CliDefaultLimits`、browser preview の artifact limits、および呼び出し側の直値に分かれている。

5.0 は `SaveDataV1`、`PublicationManifestV1`、compiled artifact、sealed artifact という**別々に流通する** format を新たに 4 つ増やす。同じ広がり方を繰り返すと、Persistence（#771）と Publication（#773）と distribution（#781）がそれぞれ別の version 規約と上限を持ち始める。

## 1. source version は exact match

`kamishibai: "5.0"` は 4.0 の後継ではなく独立した version として扱う。`requireDsl5SourceVersion` は `"5.0"` 以外をすべて拒否する。

4.0 だけは名指しで扱う。`"4.0"` を渡すと「convert the document to 5.0 rather than relying on a fallback」という文言を含む診断になる。これは、この error に到達した作者が実際に必要としている情報が「これは 4.0 の文書だから converter を通せ」であって「version が違う」ではないため。converter 自体は #782。

逆方向は既に閉じている。`schema/dsl-4.schema.json` の `"kamishibai": {"const": "4.0"}` が 5.0 文書を拒否し、`source-frontend.ts` がそれを `K4-VERSION-001` へ写す。

## 2. format は 5 つ、それぞれ独立に version を持つ

| format                | 所有 Issue | 何を運ぶか                                                |
| --------------------- | ---------- | --------------------------------------------------------- |
| `storyDocument`       | #782       | 1 つの segment が compile された正規化済み story document |
| `publicationManifest` | #773       | segment の索引。どの segment より先に読まれる             |
| `saveData`            | #771       | 1 つの保存位置と runtime state                            |
| `compiledArtifact`    | #781       | authoring source を落とした production artifact           |
| `sealedArtifact`      | #781       | segment／asset group 単位の認証付き暗号化 envelope        |

**独立させる理由は流通経路が別だから。** save file は、それが書かれた artifact より長生きする。publication manifest は、どの segment よりも先に取得される。sealed artifact は、authoring source を一度も見ていない reader が復号する。共有の version 番号 1 つにすると、無関係な format が一緒に動かざるを得なくなる。

## 3. decoder は fail closed

`decodeDsl5Envelope` が 4 つすべてを拒否する。version 違いだけではない。

| 拒否                                          | code                        |
| --------------------------------------------- | --------------------------- |
| record でない（`null`、文字列、配列を含む）   | `K5-FORMAT-SHAPE-001`       |
| `formatVersion` がこの build の値と一致しない | `K5-FORMAT-VERSION-001`     |
| その format が宣言していない key を持つ       | `K5-FORMAT-UNKNOWN-KEY-001` |
| 宣言された必須 key が無い                     | `K5-FORMAT-MISSING-KEY-001` |

**unknown key の拒否がこの decoder の主目的。** 未知の key を受理して無視すると、新しい writer が足したメンバを reader が黙って落とす。これは DSL 4.0 の `validateStageAck` で実際に起きた回帰と同じ形で、record を再構築する validator が `sourceIntegrity` と `diagnostics` を落として auto-reload を壊した。decoder は検証した record **そのもの**を返し、再構築しない。

migration は意図的にここに置いていない。古い version で書かれた save をどうするかは caller（#771）の判断で、この decoder は「この build が宣言する format と一致するか」だけを答える。

## 4. resource limit は 1 箇所

`dsl5DefaultResourceLimits` が全上限を 1 record で持つ。`resolveDsl5ResourceLimits` は正の safe integer 以外を拒否する。`Infinity` も拒否する — 有限でない上限は上限ではない。

source と asset の値は 4.0 からそのまま持ってくる（`maxSourceBytes: 1 MiB`、`maxSourceFiles: 64`、`maxTotalSourceBytes: 4 MiB`、`maxIncludeDepth: 32` ほか）。**4.0 の story を 5.0 へ変換したときに、より厳しい reader によって新たに拒否されることがないようにするため。**

5.0 が新設する概念の値は、測定した結果ではなく「有限であること」を満たす初期値。それぞれ所有 Issue をコメントで名指ししてあり、測定値への差し替えはその Issue で行う。

| 上限                                                                            | 所有                                |
| ------------------------------------------------------------------------------- | ----------------------------------- |
| `maxAliasExpansions`、`maxExpandedNodes`、`maxAliasDepth`、`maxActionsPerScene` | #774（YAML anchor／alias）          |
| `maxSegments`、`maxCachedDocuments`                                             | #773（publication／segment loader） |
| `maxSaveDataBytes`、`maxSaveHistoryEntries`                                     | #771（Persistence）                 |

alias 系を 4 つに分けているのは #636 の要求どおり。1 つの alias は展開回数でも深さでも安いのに action 数だけ爆発する、ということがあるため。

## 5. feature flag は startup-fixed、既定 OFF

`dsl4DefaultFeatureFlags` と同じ形にした。未知 key は無視ではなく `TypeError`、値は boolean 必須、解決後の snapshot は frozen。startup で固定され session 中に切り替わらないので、story が capability の出現・消失を観測することはない。

13 flag すべてが OFF のとき、runtime・app shell・asset lifecycle・distribution artifact は DSL 4.0 のものであり、4.0 artifact へ 5.0 の opcode／storage／manifest は入らない。

### flag 間の依存を code に書いた

`featureFlagRequirements` が Epic の依存順序を、読むだけでなく検査できる形で持つ。

| flag                   | 要求                                         | 理由                                     |
| ---------------------- | -------------------------------------------- | ---------------------------------------- |
| `dsl5Persistence`      | `dsl5NarrativeCore`                          | 復元する変数を narrative core が定義する |
| `dsl5ProjectAppShell`  | `dsl5Persistence`                            | save slot と continue が前提             |
| `dsl5ReadingUx`        | `dsl5PublicationSegments`                    | 移動先の segment が前提                  |
| `dsl5AssetGroups`      | `dsl5PublicationSegments`                    | 保持 scope が segment 境界に紐づく       |
| `dsl5AudioLifecycle`   | `dsl5AssetGroups`                            | AudioBuffer の解放を group が行う        |
| `dsl5RichText`         | `dsl5NarrativeCore`                          | 本文への値埋込みが合流する               |
| `dsl5Video`            | `dsl5AssetGroups`、`dsl5Viewport`            | decoder の解放と描画先                   |
| `dsl5CompiledArtifact` | `dsl5PublicationSegments`、`dsl5AssetGroups` | compile 単位が segment と group          |
| `dsl5SealedArtifact`   | `dsl5CompiledArtifact`                       | 封じる対象が compiled artifact           |

### この Issue で決めたこと（Epic 本文に無く、後で覆せるもの）

- **`dsl5SealedArtifact` は `dsl5CompiledArtifact` を要求する。** Epic は `source`／`compiled`／`sealed` の 3 profile を挙げるだけで包含関係を書いていない。raw authoring source を封じる profile は 5.0 が提供しないと解釈した。#781 で覆すなら `featureFlagRequirements` の 1 行を消せばよい。
- **`dsl5PresentationEffects` と `dsl5Viewport` は依存を持たない。** どちらも 4.0 の既存 port（crossfade transition、`attachStagePointer`）の上に載るだけで、5.0 の他 capability を読まないため。

## Rollback

flag 追加と型・文書のみで runtime を変えない。revert すればよい。4.0 の release source、SB3、npm version、GitHub Release は変更しない。
