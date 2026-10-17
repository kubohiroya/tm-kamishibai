# ブロック台本の生成とYAMLへの書き戻し

関連: [Issue #881](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/881)、#834、#684、#579。

`author-block-dsl`は、検証したYAMLを実際の命令ブロックへ変換する。シーンごとのC字型宣言の内側へ、
既存ランタイムの29種類のcore actionブロックを順番に接続する。元のYAML全文は保持しない。

```sh
turbowarp-kamishibai author-block-dsl --input story.k4.yml --base base.sb3 --output blocks.sb3
# TurboWarpでblocks.sb3を開き、ブロックを編集して保存する。
turbowarp-kamishibai export-block-dsl --input blocks.sb3 --output-dir exported
```

`export-block-dsl`と`build-dsl4`は、保存された接続と入力値から台本を復元し、共通frontendのschema・意味検証へ渡す。
命令の追加・削除・並べ替え、対象・引数の変更、シーン名・順序の変更が反映される。
シーンを改名した際の`goto`や入力経路の参照先もブロック上で変更する。参照不整合は共通検証でエラーになる。
ハットから切り離したブロックは台本に含まれない。YAMLのコメント・引用符・空行は保持しない。

## 補助ブロック

生成SB3には、編集用拡張`kubohiroyakamishibaiauthoring4`をdata URLで同梱する。
既存のベースSB3でも補助ブロックを表示でき、通常ランタイムの再リリースを必要としない。

| ブロック        | 役割                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `scene`         | シーン名とシーン属性を持ち、内側に命令を接続する。                                                             |
| `property`      | 台本メタデータを保持する。PATHは1〜2要素のJSON配列、VALUEはJSON値。素材や変数は項目ごとに分割する。            |
| `actionOptions` | 安定ID、追加属性などを保持し、内側に実命令1個を接続する。`arguments`には実命令の入力にない属性だけを記載する。 |
| `customAction`  | 登録済みcustom actionの対象、命令名、JSON引数、任意の安定IDを保持する。検証には対応するregistryが必要。        |

既存ブロックのSPEC・ROUTES・STEPSは、公開ランタイムの契約どおりJSON入力を使う。
省略可能な引数の空欄は省略を表す。`setText`のrun配列はTEXTをJSONで保持し、
`actionOptions`の`textFormat: "json"`で区別する。通常の文字列は`plain`を使う。
補助属性で実命令の入力を上書きすることはできない。

宣言ハットと補助ブロックはオーサリング用で、台本を実行するハットではない。
実行用成果物は編集後のSB3を`build-dsl4`へ渡して生成する。

## 互換性・検証・ロールバック

旧形式の`whenDsl4Source`＋`dsl4SourceFromYamlJson`は引き続き読み取れる。
旧形式を直接作る`createDsl4BlockSourceDeclaration`も互換APIとして残す。
新形式の生成は`author-block-dsl`を明示的に実行したときだけ行い、既存ランタイム配布物は変更しない。
includeの新規生成は従来と同様に未対応。読取・exportでは既存のStage/Spriteによるmoduleモデルを維持する。

生成物は読取処理と共通frontendに通し、生成前後のcanonical StoryDocumentを比較する。
同じ入力のSB3はブロックIDとZIP timestampを含めて決定的に生成する。
循環・接続不整合・重複・不明なopcode・不正JSON・schema違反はエラーとし、元の台本へフォールバックしない。
ブロック数・入力長・JSON深さ等には上限がある。動的なScratch式の評価は行わず、対応する静的入力を読み取る。

ロールバックは本変更をrevertし、以前のCLIで旧形式を再生成する。通常ランタイムのfeature flagや配布物は変更しない。
