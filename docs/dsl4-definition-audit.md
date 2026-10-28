# DSL 4系の定義・参照の検査と未使用定義の削除

Issue: [#1083](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/1083)

`audit-dsl4-definitions`は、作品全体の定義と参照を照合するCLIです。
既定では読取だけを行い、種類・名前・元ファイルの行と列を含む診断を表示します。
未使用の定義は警告、未定義参照・不正な値はエラーです。終了コードは正常（警告のみを含む）が0、作品のエラーが1、CLIの使用方法のエラーが2です。

```sh
# YAMLとinclude先をまとめて検査
pnpm exec turbowarp-kamishibai audit-dsl4-definitions --input story.k4.yml

# SB3内の実在素材を使う作品
pnpm exec turbowarp-kamishibai audit-dsl4-definitions \
  --input story.k4.yml --base project.sb3 --control-profile production

# SB3内のブロック台本を直接検査
pnpm exec turbowarp-kamishibai audit-dsl4-definitions --input project.sb3 --format json

# 安全に未使用と確定した定義を削除した台本を、未作成の別ディレクトリへ出力
pnpm exec turbowarp-kamishibai audit-dsl4-definitions \
  --input story.k4.yml --base project.sb3 --remove-unused --output-dir review-clean
```

サブディレクトリの入口から親側のファイルをincludeする場合は、`--project-root`で作品のルートを指定します。
ソース数・ファイルごとのバイト数・合計バイト数・include深さは、それぞれ`--max-source-files`、`--max-source-bytes`、`--max-total-source-bytes`、`--max-include-depth`で制限できます。
SB3の圧縮サイズは`--max-project-bytes`（既定512 MiB）、展開して読む`project.json`は16 MiBまでです。監査では画像・音声などのZIPエントリーを展開しません。

## 検査対象

| 種類        | 検査する内容                                                                        | 自動削除                           |
| ----------- | ----------------------------------------------------------------------------------- | ---------------------------------- |
| asset       | 直接・間接の利用、未定義、種類や所有actorの不一致、SB3内での名前解決                | 未使用と確定した明示定義のみ       |
| actor       | 命令の対象、初期コスチューム、コスチュームの所有先、未使用、SB3内での同名スプライト | 未使用と確定した明示定義のみ       |
| textStyle   | setText・Bubbleからの参照、未定義・未使用                                           | 未使用と確定した明示定義のみ       |
| variable    | 条件式・型付き条件・代入・加算・反転での参照、未定義・未使用                        | 未使用と確定した明示定義のみ       |
| control     | keymapの妥当性、外部から指定されたプロファイルの存在                                | 外部選択されるため保持             |
| cover       | 背景・BGMの参照、設定内容、未宣言時の既定値                                         | 宣言自体に意味があるため保持       |
| loading     | 背景・コスチュームの参照と設定内容                                                  | 宣言自体に意味があるため保持       |
| recognition | 認識モデル・認識操作との整合、音・操作画像などの参照                                | ホストからも使われる設定として保持 |
| navigation  | keymapの組込みコマンド、goto・入力分岐などの遷移先                                  | 場面・設定を保持                   |

すべての場面、ifの両側、0回の反復内も検査します。場面への到達可能性は削除の根拠にしません。
未使用actorとそのコスチュームが互いに参照するだけの組は、まとめて削除候補になります。
Bubbleの定義・分岐定義など、今回削除しない定義からの依存は保持します。

書込みだけの変数も利用中として扱います。組込み変数`startSceneIndex`は、明示した初期値を保つため削除しません。
条件式は実行せずに参照名を抽出します。文字列リテラルを変数名と誤認しません。
forEachの型付き参照など、参照先をこの監査で確定できない場合は、対象種類の定義を保持して「判定不能」の理由を示します。
独自命令・broadcast・別segmentへの遷移では外部処理からの利用があり得るため、削除判定を保留します。
オン／オフブロックの復元情報がある作品では、再有効化した部分を壊さないよう自動削除を保留します。

JSONには`definitions`（利用状態・理由・削除可否・参照位置）、`references`、`diagnostics`、`removable`、`implicitReferences`（SB3内で解決した未宣言参照）、`defaults`、`removed`、`sourceFiles`を含みます。
SB3の診断には、元の`targetName`と`blockId`も付けます。
構文・型・参照のエラーがある場合は削除結果を書き込みません。

## SB3内の素材を宣言せずに使う

ツールチェインとランタイムの共通frontendは、作品と一緒に渡されたSB3の実体を参照します。
build-dsl4・author-block-dsl・export-block-dsl、ブラウザーでの作品読込、ブロック台本の直接再生、runtime componentの再読込・compiled変換に同じ規則を適用します。
素材の実在を検査するには、監査CLIではSB3入力か`--base`が必要です。

```yaml
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - stage: 町の背景
    - Cat.show:
        skin: 歩く
        x: 0
        y: 0
        scale: 100
    - sound: 足音
```

この例では、Stageの背景「町の背景」、スプライト「Cat」のコスチューム「歩く」、SB3内の音「足音」を使います。assetsとactorsの宣言を省略できます。

- 明示的なasset定義を優先します。宣言の種類や所有者が間違っている場合は、同名の実体で置き換えずエラーにします。
- 未宣言actorは、名前が完全一致するスプライトに結び付けます。初期コスチュームはそのスプライトの最初のものです。現在選択中のコスチュームには依存しません。
- ランタイムは作品開始時に未宣言actorを最初のコスチュームに戻し、その後のshow・setSkin等を適用します。明示actorの既存の論理名による解決は維持します。
- スプライト名は既存DSLのactor識別子の制約に従います。背景・音・コスチュームの名前は空白や日本語を含む名前をそのまま照合します。
- show・setSkin・loop・poseのskinは、そのactorの所有スプライト内で解決します。別スプライトの同名コスチュームを使いません。
- 所有者が指定されないloadingのコスチュームは、SB3内の所有スプライトが一意の場合に解決します。
- 背景はStage内で解決します。音はStageの同名音を優先し、Stageにない場合は全スプライトで一意の同名音を使います。
- 見つからない名前、同一所有者内の重複、所有者が複数ある名前はエラーにします。
- 同じ名前の背景・音・複数スプライトのコスチュームは、内部の識別子を分けて保持します。
- 暗黙に解決した素材はSB3に埋め込まれているため、asset配布プロファイルのprovider・lockには追加しません。配布方法を上書きする場合はassetを明示宣言します。
- image・video・recognitionModelや、ファイル・remote素材には従来どおり明示定義が必要です。

## 未宣言時の既定値

`cover`がない場合は、Stageの最初の背景と最初の音を表紙に使います。背景がない場合は表紙を生成せず、音がない場合はBGMを省略します。
明示したcoverには、指定していないBGMを勝手に追加しません。

`variables.startSceneIndex`がない場合は初期値`1`を補います。明示した値を優先します。
旧版の再開用変数snapshotにこの変数がない場合も、その作品の初期値を補います。他の宣言変数の欠落・型違い・余分な変数の検証は維持します。

既存のsource形式SB3で、今回の暗黙素材用のmanifest項目が保存されていない場合は、保存済みbundleの整合性を検証してから、実在するproject素材だけを読込用snapshotへ追加します。
既存のcompiled形式でも、保存済みIR・配布設定・runtime artifactの検証後に、未指定のcoverとstartSceneIndexを読込用snapshotへ補います。必要なproject素材のmanifestは保存済みbundleの整合性を検証した後で追加します。元のSB3や署名対象のデータは書き換えません。

旧作品でcoverがなかった場合も、この既定値により表紙・音が増える可能性があります。表紙の選択を維持したい場合はcoverを明示します。明示coverにbgmがなければBGMは追加しません。startSceneIndexは作品変数の初期値で、開始シーンを切り替える指定とは別です。

簡易say/thinkの生成は、ベースの埋込ランタイムが対応能力を示す場合に行います。旧ランタイムを含むベースでは既存SPEC版を維持します。宣言省略を使う作品は対応するツールチェインとランタイムを揃えてください。

## 出力・復元

削除は`--remove-unused`と`--output-dir`を一緒に指定したときだけ実行します。
元のYAML・SB3・実体ファイルを書き換えず、既存の出力先を上書きしません。
include先の台本を含め、コメント・定義順序・ファイル境界を保ったYAMLを出力し、出力前に共通frontendで再検証します。
同じ結果を再検査しても、追加の削除候補が出ないことを確認しています。

出力対象は台本ファイルです。素材の相対パスは保持するため、確認後に元作品の対応する台本へ差し替えるか、出力先にも同じ配置の素材を用意して利用します。
SB3を直接編集するEditorのボタンは後続の段階で接続します。現在はSB3の監査と、削除済みYAMLの出力が可能です。

ロールバックは退避した元の台本・SB3への復元です。通常のbuildや再生で定義を自動削除する処理はありません。
暗黙素材・既定値の適用はSB3文脈と未宣言項目によって決まり、新しい有効化フラグは設けていません。
