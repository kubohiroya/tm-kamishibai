# DSL 4.0 式評価・資源上限・診断境界

この文書はIssue #262の式言語、resource policy、診断projectionの正本です。機械可読な対応物は
`test/fixtures/dsl4/expression-limits-diagnostics.json`です。表の既定値は現行コードとtestで同期し、hostは
既定値以下へだけ絞れます。artifact固有のbyte／件数上限は従来どおりcallerによる明示を必須とします。

## 1. Runtime Expression互換

DSL 4.0の`branch[].if`は`@kubohiroya/turbowarp-runtime-expression` 0.5.0の
`./composition` entrypointを使用します。Kamishibai独自の式parser、`eval`、`Function`、Scratch block
呼出しへfallbackしません。importだけではScratch、DOM、network、storageへ触れません。

### 1.1 値と演算

| 分類       | 許可するもの                                                                  |
| ---------- | ----------------------------------------------------------------------------- |
| literal    | finite number、quoted string、`true`、`false`、`null`、`undefined`            |
| variable   | ASCII bare name、または完全一致の`vars["名前"]`                               |
| unary      | `!`、unary `+`、unary `-`                                                     |
| arithmetic | `+`、`-`、`*`、`/`、`%`                                                       |
| comparison | `==`、`!=`、`===`、`!==`、`<`、`<=`、`>`、`>=`                                |
| logic      | <code>&amp;&amp;</code>、<code>&#124;&#124;</code>。通常のshort circuitを行う |
| grouping   | `(`、`)`                                                                      |

runtime variableはplain objectのown enumerable data propertyだけを読み、値をstring、finite number、
booleanに限定します。prototype、accessor、symbol、object、array、`NaN`、Infinityを拒否します。実際に
評価された未知variableはerrorですが、`true || missing`の`missing`はshort circuitにより読みません。
式全体の結果はJavaScript互換の演算後にbooleanへ変換します。

assignment、関数呼出し、一般property access、`new`、array/object literal、optional chaining、template
stringは禁止です。これにより任意code実行やprototype traversalを式言語へ持ち込みません。

### 1.2 実装済み上限

| 上限          |    値 | 単位・境界                                  |
| ------------- | ----: | ------------------------------------------- |
| expression長  | 4,096 | UTF-16 code unit。4,096以下を許可           |
| token         |   512 | EOFを含む。512以下を許可                    |
| parse nesting |    64 | parentheses／再帰unaryのdepth。64以下を許可 |
| parsed cache  |   128 | composition instanceごとのLRU entry         |

AST node数はtoken数以下で、評価は同期・I/Oなし・loopなしです。このため4.0.0ではwall-clock timeoutを
重ねず、token／depth上限をevaluation step上限として使います。`releaseAll()`はcacheを空にし、
compositionは再利用可能です。source検証時のsyntax checkとruntime評価は同じcomposition APIを使います。

## 2. Resource limit registry

上限は次の二状態を区別します。

- 実装済みdefault: moduleが既定値を持ち、callerは同値以下だけへ絞れる。
- 必須explicit: build/startupごとにhostが値を渡し、省略はerror。台本から変更できない。

### 2.1 現在の実装済みdefault

| subsystem          | 主な上限                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| Runtime Expression | length 4,096、token 512、depth 64、cache 128                             |
| Object Store       | depth 64、entry 1,024、handle 4,096、node 32,768、operation 100,000 step |
| JSONPath           | query 1,024 scalar、segment 32、AST 128、visit 10,000、result 1,000      |
| Structured Data    | active iterator 1,024                                                    |
| Action discovery   | target 256、top-level block/target 4,096、custom action 64、parameter 16 |
| custom action      | 30秒、許容範囲100 ms〜300秒、failure message 256 scalar                  |
| reload quiesce     | 5秒、許容範囲100 ms〜30秒                                                |
| preview watch      | quiet 100 ms、retry 50 ms、stability timeout 2秒                         |
| source frontend    | canonical source 1 MiB、YAML node 20,000、depth 64、scalar 16,384等      |
| diagnostic表示     | 保持100件、UI 20件、excerpt 240 scalar、message 500 scalar、related 8件  |

完全なfield名と値は機械可読contractを正本とし、testで公開定数または実装sourceと照合します。

### 2.2 現在の必須explicit上限

builder／runtime APIでは`maxSourceBytes`、asset一件／件数／総byte、history action／scene visit、
pose archive展開上限をhostが明示します。公開CLIはこのうちsource／assetの共通4値へ有限defaultを
渡します。preview、validate、build、runtimeは同じartifactについて同じ値を使います。台本やruntime
variableから値を引き上げられません。

### 2.3 source frontend既定policy

| 上限             |        既定値 | 理由                                                                  |
| ---------------- | ------------: | --------------------------------------------------------------------- |
| canonical source |         1 MiB | 長い台詞を含む2,000 actionの計測で、4 MiBほどheapが増えない範囲を選択 |
| YAML node        |        20,000 | mapping/sequence/scalarの総数を制限する                               |
| YAML depth       |            64 | nested collectionによるstack/memory増加を制限する                     |
| scalar           | 16,384 scalar | 長文を許しつつ単一message/pathの肥大を防ぐ                            |
| scene            |           512 | UIとruntime indexを有限化する                                         |
| action/scene     |         1,024 | 一sceneだけの極端な配列を拒否する                                     |
| total action     |         4,096 | benchmarkで約4,000 actionが約92 ms／heap増分最大約21 MiBだったため    |
| asset            |         1,024 | dependency indexとmanifestを有限化する                                |

2026-08-07、Node 26.5.0のlocal Apple Silicon環境で、`wait: 0`だけを持つ一sceneを3回parseした中央値は
次のとおりでした。heap値はGC直後からparse完了までの最大観測差で、製品保証値ではありません。

| action | UTF-8 byte |   median | 最大heap差 |
| -----: | ---------: | -------: | ---------: |
|  1,000 |     14,037 |  29.5 ms |   11.1 MiB |
|  4,000 |     56,037 |  91.6 ms |   20.7 MiB |
| 16,000 |    224,037 | 293.9 ms |   66.7 MiB |
| 32,000 |    448,037 | 526.4 ms |  127.9 MiB |

byte上限だけではaction数を十分に制限できないため、この複合上限をsource frontendの既定値として採用します。

2026-08-15には同じNode 26.5.0、Apple M1 Max、64 GiB環境で、2 scene × 1,000 `say` actionの
台詞長だけを変えた有効な入力を3回ずつparseしました。

| canonical source | 台詞scalar/action |   median | 最大heap差 |
| ---------------: | ----------------: | -------: | ---------: |
|          256 KiB |                79 | 105.4 ms |   27.1 MiB |
|            1 MiB |               472 | 125.0 ms |   39.4 MiB |
|            4 MiB |             2,045 | 260.6 ms |  152.7 MiB |

256 KiBから1 MiBへの拡張は、長い台詞を持つ実用的な台本余地を4倍にしながら、同一action数での
median増加を約20 ms、最大heap差の増加を約12 MiBに抑えました。一方4 MiBでは最大heap差が
150 MiBを超えたため採用しません。1 MiBをfrontendとCLIの共通上限とし、YAML node、scalar、scene、
actionの独立上限を維持します。hostは採用上限以下へ下げられますが、台本から上げられません。
境界は独立fixtureで検証します。

## 3. Versioned diagnostic

canonical diagnostic v1は次を持ちます。

```json
{
  "version": 1,
  "code": "K4-EXPRESSION-SYNTAX-001",
  "severity": "error",
  "message": "Condition syntax is invalid at expression offset 12.",
  "sourceId": "main",
  "range": {
    "start": {"line": 18, "column": 11, "offset": 220},
    "end": {"line": 18, "column": 12, "offset": 221}
  },
  "path": "$.branches.rescueResult[0].if",
  "related": []
}
```

`storyPath`だけが任意です。rangeはcanonicalized source基準の1-origin line/columnと0-origin offsetです。
内部error、handle、absolute path、runtime valueを作者に解決させません。

### 3.1 GenericからK4へのmapping

| Generic                                 | K4                               | 意味                              |
| --------------------------------------- | -------------------------------- | --------------------------------- |
| `CONDITION_SYNTAX_ERROR`                | `K4-EXPRESSION-SYNTAX-001`       | parse前の式syntax／limit違反      |
| `RUNTIME_EXPRESSION_UNKNOWN_VARIABLE`   | `K4-EXPRESSION-VARIABLE-UNKNOWN` | 実際に評価した未宣言variable      |
| `RUNTIME_EXPRESSION_INVALID_VARIABLE_*` | `K4-EXPRESSION-VARIABLE-001`     | runtime variable snapshot契約違反 |
| unexpected failure                      | `K4-EXPRESSION-INTERNAL-001`     | 詳細をredactして安全停止          |

Generic packageは`K4-*`を返しません。Kamishibai adapterが一度だけmappingし、controllerはそのcodeと
branch actionのStoryPathを保持します。syntax errorはstage前に検出し、asset、actor、camera、listenerを
開始しません。runtime variable依存errorは実行中にcurrent actionをcancelし、scene/action resource、
Object Store scope、input subscriptionを解放してfailedへ移ります。

## 4. 順序、件数上限、stage gate

diagnosticは`range.start.offset`、code、messageの順に並べます。string比較はlocale依存の
`localeCompare`ではなくUnicode code unit順とします。同じsourceとpolicyはWeb、editor、Packager、CLIで
byte-equivalentなcode/severity/range順を返します。

保持上限は100件、通常UI表示は先頭20件です。上限を超えた場合、最後の一枠を
`K4-DIAGNOSTICS-TRUNCATED`に置き換え、最初に省略した位置と省略件数を示します。省略対象にerrorが
一件でもあればtruncation自体もerror、warningだけならwarningです。黙って切り捨てません。

- errorが一件以上: candidateをstageせず、現在のimmutable snapshotがあれば継続する。
- warningだけ: candidateをstageできる。作者へ件数とcodeを表示する。
- diagnosticなし: stageできる。

## 5. 表示、SVG、clipboard、telemetry

UI excerptは240 Unicode scalar、messageは500 scalar、related locationは8件、画面同時表示は20件を上限
とします。scalar境界で切り、切詰めたことを`…`で明示してから、`& < > \" '`をSVG/XML escapeします。
source textをHTML/SVGとして解釈せず、複数errorは一つの巨大SVGへ詰め込まず、scroll可能なhost UIで
20件まで表示します。Scratch stage用SVGは最初のerrorと総件数だけを示すfallback rendererとします。

SVG rendererは独立capabilityにしません。`diagnostic-projection.js`のapp shell所有pure rendererとし、
bounded diagnostic projectionだけを受けます。source file、Object Store、runtimeへアクセスしません。

clipboard/exportは暗黙実行しません。作者の明示操作として次を分けます。

- 「この診断をコピー」: 画面に見えるbounded message、code、displayName、line/columnだけ。
- 「診断JSONを書き出す」: redacted diagnostic envelopeだけ。source/excerpt/runtime valueを含めない。
- 「台本を書き出す」: source channelの別操作。診断copy/exportから到達させない。

通常log／crash telemetryは`version, code, severity, sourceId, range, storyPath, path`のallowlistだけです。
message、canonical source、excerpt、runtime value、absolute path、session tokenを含めません。

## 6. Error、retry、解放sequence

```text
load bounded bytes
  -> canonicalize
  -> YAML/schema/expression validation
  -> sort + truncate diagnostics
  -> errorあり: stageせず、作成済みcandidate resourceを全解放
  -> warningのみ/正常: immutable candidateをstage可能

runtime expression failure
  -> active action generationを無効化
  -> wait/input/timer/custom actionをcancel
  -> action/scene Object Store scopeとcandidate assetを解放
  -> K4 diagnosticを一件publish
  -> failedで停止（自動retryなし）
```

Runtime Expressionのgeneric errorは`expression-diagnostics.js`で一度だけK4へ変換します。変換後errorは
expression本文、variable名・値、dependencyのmessageを保持しません。controllerはaction generationを
無効化し、Object Store scopeとasset lifecycleを`runtime-failed`で解放してからfailed stateを公開します。

初回source errorはwatchを継続し、実行中reload candidateのerrorは旧immutable snapshotを継続します。
runtime failureのretryは明示的なrestart/reloadだけです。同じ失敗を自動loopさせません。cleanup failureは
元errorを隠さずAggregateErrorとして内部観測し、作者向けには安定したcleanup用K4 code一件へ投影します。

## 7. 実装境界

- `source-frontend.js`: source/YAML/scene/action/asset上限、注入された式syntax validator、canonical diagnostic sequence
- `builder/dsl4-source-frontend.js`: pinned Runtime Expressionをproduction frontendへ注入するcomposition root
- `expression-diagnostics.js`: runtime generic errorからredacted K4 errorへの一度だけのmapping
- `diagnostic-projection.js`: bounded UI、SVG fallback、clipboard、JSON export、telemetry allowlist
- `runtime-controller.js`: branch位置の同義projection、fail-closed停止、scope／asset解放
- `dsl4-expression-diagnostic-boundaries.test.mjs`: editor UI／CLI／Packagerのfailure identityとsecurity境界

すべてDSL 4.0の既定OFF flag内で導入します。問題時はflag OFFまたは上記module差分をrevertし、3.1/3.2の
K32診断、renderer、SB3へ切り戻せます。
