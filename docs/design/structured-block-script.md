# ブロック台本の生成とYAMLへの書き戻し

関連: [Issue #883](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/883)、[Issue #881](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/881)、#834、#684、#579。

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
CLIの実行用成果物は、書き戻したYAMLから`build-dsl4`で生成する。

## 対象形式・検証・ロールバック

台本の入口は`kamishibai [4.0] [ラベル]`ハットへ統一する。
旧`whenDsl4Source`と`dsl4SourceFromYamlJson`はランタイムの定義・読取・生成APIから削除し、互換読取は行わない。
旧ハットを含むSB3は`K4-BLOCK-SOURCE-REMOVED-001`で拒否する。
新形式は`author-block-dsl`で生成する。公開済み配布物は再リリースせず、開発版のランタイム定義と内部再生bundleを更新する。
include付きの生成は下記のラベル付き宣言で行う。読取・exportではStage/Spriteの各targetに置いた新ハットも読み取る。

生成物は読取処理と共通frontendに通し、生成前後のcanonical StoryDocumentを比較する。
同じ入力のSB3はブロックIDとZIP timestampを含めて決定的に生成する。
循環・接続不整合・重複・不明なopcode・不正JSON・schema違反はエラーとし、元の台本へフォールバックしない。
ブロック数・入力長・JSON深さ等には上限がある。動的なScratch式の評価は行わず、対応する静的入力を読み取る。

ロールバックは本変更をrevertし、以前のCLIで旧形式を再生成する。通常ランタイムのfeature flagの既定値は変更しない。

## ラベル付き宣言とincludeBlocks（Issue #883）

新しい生成では編集用拡張の`kamishibai [VERSION] [LABEL]`をハットとして使う。
VERSIONは文字列`4.0`、LABELの既定は空文字。`includeBlocks [LABEL]`を宣言直下に接続する。
`includeBlocks`は実行命令ではなく、既存YAMLのincludeと同じモジュール合成を指す。
宣言列内ではシーンの前後に置けるが、シーンやactionOptionsの内側には置けない。

- 空でないラベルはSB3全体で一意。Stage/Spriteをまたいで完全一致で解決し、同一targetにも複数宣言を置ける。
- Stage上の空ラベル宣言を入口にする。Stageの宣言が1個だけなら名前付きでも入口になる。
  名前付きだけが複数ある場合は曖昧な入口として拒否する。空ラベル宣言は各targetに1個まで。
- 新ハットのラベル入力がなければ空文字と解釈する。旧whenDsl4Sourceハットは対応しない。
- includeBlocksの参照ラベルは空文字にできない。Scratch変数や動的式は使えない。
- 自己参照・循環・重複・未定義ラベル・接続不整合・合成時の同名宣言を拒否する。
  ブロック診断はtargetとblock IDを持ち、合成衝突もソースを宣言したtargetとhat IDを表示する。

`author-block-dsl`は入力ファイルのフォルダーをプロジェクトのルートとしてincludeを読み取る。
既存の安全なファイル読取とsource graph検証を使い、symlinkによるルート外参照や変更中の入力も拒否する。
生成時のラベルは元の相対ソースパス、主台本のラベルは空文字。全宣言をStageに並べる。
名前付きモジュールにkamishibaiプロパティを生成せず、各ハットのVERSIONから入口のバージョンだけを復元する。
素材のfileはプロジェクトルート基準へ補正する。素材ファイル自体はYAML exportには同梱しない。

読取では、ラベルをパスとして直接使用しない。空でないラベルを辞書順に並べ、
`blocks-0001.k4.yml`などの安全な仮想ファイル名を割り当てる。入口と既存の空ラベル宣言はtarget名を維持する。
参照を対応するファイル名へ変換し、includeの順序・モジュール分割を保つ。
ラベル変更・追加により連番は変わり得る。同じ入力に対しては決定的である。
既存名やexport時の主台本名と衝突した場合は、大文字小文字・Unicode正規化も考慮して拒否する。
参照されないモジュールは既存のexport規則どおりエラーにする。

生成CLIは64ファイル、各ソース1 MiB、合計4 MiB、深さ32を既定上限とする。
共通frontendの合成後ソース上限は1 MiB以内。読取には宣言数256、target数256、各targetのブロック数8192の上限もある。
`--max-source-files`、`--max-source-bytes`、`--max-total-source-bytes`、`--max-include-depth`で生成側の上限を指定できる。

同期API`authorDsl4BlockSourceSb3`は単一台本用とし、
非同期API`authorDsl4BlockSourceGraphSb3`をinclude graph用に追加する。
各モジュールを生成した後に再読取・再合成し、両側のcanonical StoryDocumentの意味を比較する。
ソース位置と元のファイル名は変換で変わるため、合成後YAMLを共通frontendで再解析して比較する。

CLIで再生用SB3を作るときは、exportしたZIPを展開し、`build-dsl4 --source <主台本>`と
`--enable-source-includes`・graphの上限を指定する。既存の低水準build APIはブロックSB3の直接読取にも対応する。
通常ランタイムのfeature flagの既定値や公開済み配布物は変更しない。
ロールバックは本変更のrevertと以前のCLIによる単一台本の再生成。元の分割YAMLと編集SB3は退避して保持する。

## ハットの責務と旧定義の廃止

`kamishibai [4.0] [ラベル]`は、変換ツールが収集する台本ソースの入口であり、同時に版と識別名を宣言する。
イベント受信や作品の再生開始を表さない。`when kamishibai DSL source`を前段に置く二段構成は作らない。

新しいランタイムから旧sourceハット・YAML/JSON文字列命令を削除する。
公開rc.22のような既存の埋込JavaScriptをベースに使う場合は、拡張の公開register境界でこの2定義を除去する。
同じ拡張の他の命令・状態ブロックと素材は維持する。元の配布SB3は書き換えない。
ランタイム拡張をURL参照するベースは入力として受理せず、JavaScriptを埋め込んだベースを使う。
読取側には旧ハット、旧ソース文字列、YAML/JSON reporter評価の互換経路を残さない。
旧ブロック台本を使っている場合は、元のYAMLから新ハットのSB3を再生成する。
