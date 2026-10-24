# DSL 4.0 publicationの章間asset共有（publication formatVersion 2）

関連: [#1008](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1008)。
2026-10-24、基準main `b0b2f160`（[常駐予算](dsl-4-asset-owner-budget.md#publicationの常駐予算2026-10-24追補)、#1017）。
作業ブランチは`feat/dsl4/publication-asset-dedup`。

DSLは4.0のまま。新しい有効化スイッチは追加しない。Safariは対象外。公開済みのrc artifactは差し替えない。

## 問題

`extensionStorage.kubohiroyakamishibai4.publication.components[segmentId]`は、章ごとに通常のcomponentを保持する。
各componentのembedded asset bundle（`assets.files[]`）は、使用するfileのbase64（`data`）を章ごとに持つ。
N章が共有する素材は、memory上にもSB3（`project.json`）上にもN回保存される。常駐予算の`duplicateAssetBytes`がこの重複分を示していた。

## 保存形式の判断（ユーザー確認済み）

publicationの`formatVersion`を2に上げ、新しく作るpublicationはv2で書く。読込はv1とv2の両方を受け付ける。

```text
publication (formatVersion 2)
├─ manifest / sources / stageArchive   … v1と同じ
├─ assetFiles: { "<sha256 integrity>": "<base64>" }   … 各fileを1回だけ保存
└─ components[segmentId].assets.files[]
     … assetId・path・size・integrity・encodingを保持し、dataだけを持たない
```

| 案                                   | 採否     | 理由                                                                                              |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------- |
| v2へ上げ、v1も読む                   | **採用** | 旧版runtimeはv2を版エラー（`Unsupported publication project version`）で明確に拒否する            |
| v1のまま任意の`assetFiles`を追加     | 不採用   | 旧版runtimeはdataのないbundleを、版ではなく「bundleの破損」として遅れて拒否し、原因が分かりにくい |
| 保存形式を変えず、memory上だけで共有 | 不採用   | SB3上の重複が残り、`project.json`の16 MiB上限・配布サイズを改善しない                             |

互換性：

- rc.49以前が保存したv1のSB3は、そのまま開き、再生・配布できる。配布生成はv1をv2へ書き換えない（既存の保存物を変換しない）。
- 本変更後のEditorが新しく作るpublicationはv2。**rc.49以前のruntimeはv2のSB3を開けない**（版エラーで拒否）。公開済みartifactは変更しない。
- 単一台本のcomponent（`components.kubohiroyakamishibairuntime4`）とembedded asset bundleの形式は変えない。
  dataの復元後のbundleは、v1で章ごとに保存していたbundleとbytes単位で同じである。

## 検証の順序

1. **開くとき**（`validateDsl4ProjectPublication`）：常駐予算を章の解析より先に検査する。
   v2では、`assetFiles`の鍵がSRI（`sha256-…=`）で値が文字列であること、manifestの全章のbase64 fileが`data`を持たず`assetFiles`の鍵を参照すること、
   参照されない`assetFiles`がないことを検査する。
2. **使う前**（`publicationSegmentProject(project, component, assetFiles)`）：章のcomponentへ`data`を復元する。
   復元したbundleは、従来どおりcomponent loader（`validateDsl4EmbeddedAssetBundle`）が、bundle integrity、各fileのsizeとSHA-256を検証してから使う。
   `assetFiles`の値を差し替えても、その章の準備・配布生成で拒否される。開くときにはbytesを復号・hashしない（検証は従来どおり使用前の1回）。

## 常駐予算

`componentBytes`は、dataを除いたcomponentと`assetFiles`の合計とする。上限（128 MiB）・合計上限は変えない。
`assetFiles`の分は`sharedAssetBytes`としても報告する。v2では`duplicateAssetBytes`は0になる。
作成時の上限（`maxTotalAssetBytes`の2倍）も、重複を除いた量で数える。

memory上では、publication snapshotが`assetFiles`を1回だけ保持する。章の準備ごとに、その章のcomponentへ`data`を復元した章projectを作る。
復元したbase64文字列は`assetFiles`の値と同じ文字列を参照する（JSの文字列は複製しない）。章projectは章の解放で手放す。
本変更ではmemory量の実測を行っていない。

## 検証

`test/dsl4-publication-project.test.ts`：

- 1つの素材を共有する3章のpublicationで、共有素材のbase64が保存データに1回だけ現れ、`duplicateAssetBytes`が0、
  `sharedAssetBytes`が4 file分になる。各章の復元componentがv1の保存内容と一致し、配布SB3もv2のまま`assetFiles`を保つ。
- 同じ内容をv1へ戻したpublicationを、検証・章の復元・配布生成でき、重複bytesが2回分と測定される。配布後もv1のまま。
- 参照先のない`assetFiles`、不要な`assetFiles`、v2のcomponentに残る`data`を開くときに拒否する。
  差し替えた`assetFiles`の値は、開く検査を通っても、使う前のintegrity検証で拒否される。
- 常駐予算の部分ごとの上限検査を、v1・v2の両方で行う。

全体では、3生成runtimeの再生成後に、full suite 195ファイル・1,676件、lint・format・型検査、`sb3:check`が成功した。実ブラウザでの再生確認は行っていない。

## ロールバック

source・回帰・本文書・3生成runtimeをまとめてrevertする。revert後のruntimeはv2のSB3を開けないため、
本変更後に作ったpublicationは、v1を書く版で作り直す。公開済みの同版artifactは差し替えない。
