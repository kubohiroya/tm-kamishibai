# DSL 4.0 Source Graph Preview

## 1. 適用範囲

`dsl4SourceIncludes`を起動時に明示ONにしたdevelopment previewは、entry sourceだけでなく、
`include`から到達する全sourceを一つのimmutable generationとして扱います。flagは既定OFFであり、
OFF時は従来どおりmanifestが指す単一sourceだけを監視します。

新規sourceの推奨suffixは`.k4.yml`です。entry sourceは`project.source.yml`（`.yaml`／`.json`互換入力可）のroot-level basename、
included sourceはinclude元から解決されるproject内の相対pathで指定します。directory名やbasename本体は任意で、
`.k4.yml`で終わればSource Graphのsourceとして使用できます。既存projectとの互換性のため、従来suffixも
引き続き受理します。

## 2. generation境界

generation identityは、discovery order順の全`[logical source path, canonical source]`をSHA-256で
fingerprintした値です。composed sourceが同じでも、declarationを別sourceへ移動した場合はidentityが変わります。
diagnosticとStoryDocumentのsource originはlogical source pathを保持します。

Node local previewは次の全処理を二回行い、二つのidentityが一致した場合だけstageします。

1. entry sourceをbounded stable readする
2. project rootから脱出しない全included sourceを読み、cycle、file数、depth、合計byte数を検証する
3. Source Graph frontendで一つのcanonical StoryDocumentへcomposeする
4. validなStoryDocumentが参照する全local assetをbounded stable readする
5. source fingerprintとasset manifest fingerprintを一つのgeneration keyへ結合する

二回の取得中にsourceまたはassetが変化した場合は、有限timeout内でgeneration全体を取り直します。
途中状態、sourceだけ新しい状態、assetだけ新しい状態はprotocolへ公開しません。include flag ON時のNode watcherは
project rootをrecursiveに監視し、included source、asset、atomic replaceのいずれのeventでも同じ全体取得を開始します。

Browser Web Previewも全Source Graphを二回取得して一致を確認します。local asset live reloadがONの場合は、
asset pipelineのtransactionが`ready`または`active`になるまでsource candidateのprotocol stageを保留します。
File System Access APIのhandle、source本文、絶対machine pathはsession stateやdiagnosticへ保存しません。

## 3. 上限と失敗時の動作

`--enable-source-includes`を指定するCLI previewでは、Source Graph固有の三上限をすべて明示します。
source一ファイルの上限は共通CLIデフォルトを使用し、必要なら小さい値へoverrideします。

- `--max-source-files`: Source Graphのfile数上限
- `--max-total-source-bytes`: graph全source合計とcomposed canonical sourceの上限
- `--max-include-depth`: include depth上限
- asset一ファイル、file数、合計byte数は共通CLIデフォルトまたは明示override

missingまたはunstableなsource／assetは有限回retryします。timeout後もmissingならerror、変化し続ける場合は
`K4-PREVIEW-SOURCE-UNSTABLE` warningを一度publishし、現在実行中のgenerationは置換しません。cycle、path escape、
上限超過、duplicate declaration、schema／semantic errorはinvalid generationとしてstageし、既存runtimeを維持します。

## 4. rolloutとrollback

rolloutは`dsl4Runtime: true`と`dsl4SourceIncludes: true`を同じstartup snapshotへ設定したpreviewだけが対象です。
production artifactへwatcherやbrowser handleを追加しません。

rollbackは`dsl4SourceIncludes`をOFFにしてprocessまたはWeb Preview sessionを再起動します。これによりrecursive graph watch、
graph resolver、graph asset gateは初期化されず、従来の単一source generationへ戻ります。artifact format、manifest format、
runtime protocolのmigrationやdata cleanupは不要です。
