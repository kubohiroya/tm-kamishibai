# DSL 4.0 format contracts

追跡 Issue: [#782](https://github.com/kubohiroya/tm-kamishibai/issues/782)（4.0 GA release gate）。親 Epic: [#636](https://github.com/kubohiroya/tm-kamishibai/issues/636)。

DSL 4.0 が publish している serialized format の索引と、それを fail closed で読む decoder を置く。

## この文書の来歴

初版は `docs/design/dsl-5-format-contracts.md` として、DSL 5.0 の足場（PR #783、Issue #769）を書いたものだった。5.0 という版を立てない判断（2026-09-09、#636）に伴い、内容を 4 系へ引き取った。

引き取らなかったもの:

- `requireDsl5SourceVersion` と `dsl5SourceVersion` — source version の判定は `schema/dsl-4.schema.json` の `{"const": "4.0"}` と `source-frontend.ts` の `K4-VERSION-001` が既に持っている。二重に持たない。
- 13 個の `dsl5*` feature flag — flag の正本は `src/dsl4/feature-flags.ts` 一つ。新しい capability の flag はそこへ、実装が入る PR で足す。**実装の来ない flag を先に置かない。**
- `dsl5DefaultResourceLimits` — 上限値の半分は 4.0 の値の写しで、残り半分は未着手機能のための仮値だった。4.0 の上限は `dsl4SourceFrontendDefaultLimits`、`dsl4CliDefaultLimits` ほかが持っている。集約するなら実在する上限を 1 箇所へ集める作業として別に行う。

引き取ったのは次の 2 つ。どちらも 4.0 に今ある問題へ直接効くため。

## 1. format は 12 個ある、と述べる場所

`formatVersion: 1` は `asset-bundle-descriptor`、`asset-reload-policy`、`asset-distribution-profile`、`runtime-artifact-descriptor` など十数箇所に独立して書かれている。値は一致しているが、**どの format が存在するのかを述べている場所がなかった。** 新しい format を足したときに、それも version を持つべきだと気づく仕組みがない。

`dsl4FormatVersions` がその一覧を持つ。

| format                        | 所有 module                           | 何を運ぶか                                              |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------- |
| `assetBundle`                 | `asset-bundle-descriptor.ts`          | `manifest`／`files`／`integrity` を包む bundle envelope |
| `assetBundleManifest`         | `asset-bundle-descriptor.ts`          | bundle と story file が運ぶ asset manifest              |
| `assetDistributionConfig`     | `asset-distribution-profile.ts`       | profile／provider の設定                                |
| `assetDistributionLock`       | `asset-distribution-profile.ts`       | 設定を解決した lock                                     |
| `assetReloadPolicySnapshot`   | `asset-reload-policy.ts`              | reload 判定の入力となる asset snapshot                  |
| `binaryEntry`                 | `binary-entry-provider.ts`            | packaged binary entry（version 3、2 は読める）          |
| `blockSourceExport`           | `block-source-export.ts`              | project から書き出した source export                    |
| `blockSourceProject`          | `turbowarp-yaml-json-block-source.ts` | project の hat から読み戻した source 一式               |
| `externalSourceManifest`      | `external-source-manifest.ts`         | project root の外にある story の descriptor             |
| `previewSourceGenerationWire` | `preview-source-generation-wire.ts`   | `preview.source.generation` message 1 件                |
| `runtimeArtifactDescriptor`   | `runtime-artifact-descriptor.ts`      | build した runtime artifact が持つ descriptor           |
| `sourceGraphSnapshot`         | `source-graph.ts`                     | frontend が渡す include graph の snapshot               |

**索引は第二の定義ではない。** 所有 module が自分の定数と validator を持ち続ける。exported な定数を持つ 4 件（`dsl4AssetDistributionFormatVersion`、`dsl4BlockSourceExportFormatVersion`、`dsl4BinaryEntryFormatVersion`、`dsl4LegacyBinaryEntryFormatVersion`）は `test/dsl4-format-contracts.test.ts` が索引と一致することを固定しており、片方だけ動かすと test が落ちる。

legacy version は `dsl4LegacyFormatVersions` に名指しで置く。範囲指定にしない。現在は `binaryEntry` の version 2 だけで、これは reader が読めて writer が書かない version。

## 2. decoder は fail closed

`decodeDsl4Envelope` は 4 つとも拒否する。version 違いだけではない。

| 拒否                                          | code                        |
| --------------------------------------------- | --------------------------- |
| record でない（`null`、文字列、配列を含む）   | `K4-FORMAT-SHAPE-001`       |
| `formatVersion` がこの build の値と一致しない | `K4-FORMAT-VERSION-001`     |
| その format が宣言していない key を持つ       | `K4-FORMAT-UNKNOWN-KEY-001` |
| 宣言された必須 key が無い                     | `K4-FORMAT-MISSING-KEY-001` |

**unknown key の拒否がこの decoder の主目的。** 未知の key を受理して無視すると、新しい writer が足したメンバを reader が黙って落とす。これは 4.0 の `validateStageAck` で実際に起きた回帰と同じ形で、record を再構築する validator が `sourceIntegrity` と `diagnostics` を落として auto-reload を壊した。decoder は検証した record **そのもの**を返し、再構築しない。

migration は意図的にここに置いていない。古い version で書かれたデータをどうするかは所有 module の判断で、この decoder は「この build が宣言する format と一致するか」だけを答える。

## まだ配線していないこと

既存の 12 site は自前の検証を持ったままで、この decoder へは載せ替えていない。載せ替えは挙動を変えうる（今は無視している unknown key を拒否するようになる）ので、rc の途中で黙って行わず、4.0 GA gate（#782）の中で site ごとに判断する。

## Rollback

型と定数と decoder だけで、runtime の経路を変えていない。revert すればよい。4.0 の release source、SB3、npm version、GitHub Release は変更しない。
