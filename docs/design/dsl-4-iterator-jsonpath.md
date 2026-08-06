# DSL 4.0 Iterator・JSONPath・TurboWarp Adapter API

## 1. 位置づけ

本書は、Generic Object Store Core上の読み取り専用JSONPath、query collection、Iterator、および
TurboWarp Adapterの上級APIを定める。Object Storeの所有・参照・解放契約は
[`DSL 4.0 Generic Object Store参照モデル`](dsl-4-object-store.md)を正本とする。

JSONPathの意味は[IETF RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html)を基礎にする。ただし初版は、
停止性と実装量を明確にできるchild segment subsetだけを受理する。RFC 9535のqueryは常にnodelistを返し、
data構造との不一致はerrorではなく空nodelistになる、同じnodeを複数回選んだ場合に重複を除去しない、という
意味を維持する。

## 2. API surfaceの分離

| surface                       | consumer                     | TurboWarp登録 | 公開内容                                  |
| ----------------------------- | ---------------------------- | ------------- | ----------------------------------------- |
| pure library／composition API | Kamishibai Runtime、単体test | なし          | typed Result、query、collection、Iterator |
| Structured Data Standalone    | 上級作者、教材、汎用project  | あり          | lifecycleを明示するvisible block facade   |
| Structured Data developer     | 実装者、診断fixture          | 別build       | redacted snapshot、invariant、limit       |
| Standard Kamishibai Composite | 通常の台本製作者             | なし          | Kamishibai専用runtime APIだけ             |

Standalone extension IDは`kubohiroyastructdata1`、developer buildは
`kubohiroyastructdata1debug`とする。Standard Kamishibaiのmanifest、palette、SB3 block graphへこの二つの
extension IDとopcodeを含めない。Kamishibai Runtimeはpure libraryをJavaScriptから直接使用し、台本作者へ
scope、query、lease、iteratorのblock操作を要求しない。

## 3. RFC 9535 subset

### 3.1 受理する構文

queryは`$`で始まり、次のchild segmentだけを0個以上続けられる。

| 構文                    | 意味                                     | 例                        |
| ----------------------- | ---------------------------------------- | ------------------------- |
| root                    | query argument自身                       | `$`                       |
| name selector           | object member value                      | `$.actor`、`$['a.b']`     |
| index selector          | array element。負数は末尾から数える      | `$[0]`、`$[-1]`           |
| wildcard selector       | object／arrayの全child                   | `$[*]`、`$.actors[*]`     |
| array slice selector    | start:end:step。RFC 9535の境界規則を使う | `$[1:5:2]`、`$[::-1]`     |
| selector list           | 記述順に各selectorの結果を連結する       | `$[0,2,-1]`、`$['a','b']` |
| dot shorthand           | 一つのnameまたはwildcardの省略記法       | `$.actor`、`$.*`          |
| optional RFC whitespace | bracket内とsegment間のRFC上の空白        | `$ [ 0 , 2 ] ['name']`    |

quoted nameはsingle quoteとdouble quoteの両方、およびRFC 9535のescapeを受理する。index、sliceの整数は
I-JSON exact integer範囲内でなければならない。sliceのstepが0の場合はRFC 9535どおり空nodelistとし、
errorにしない。存在しないname、範囲外index、structured value以外へのchild selectionも空結果とする。

selector listの重複は保存する。例えば`$[0,0]`の結果数は2である。array childはarray順、selector listは
selector記述順を維持する。RFC 9535はobject wildcardの順序を規定しないが、`MapBackend`実装は
validation後valueのmember挿入順を一つのsnapshot内で安定して使用する。別backendや別source間で
object wildcard順が同じであることをportableな意味として扱ってはならない。

### 3.2 初版で受理しない構文

| 構文                           | 初版で除外する理由                             |
| ------------------------------ | ---------------------------------------------- |
| descendant segment `..`        | visit数と再帰深度を増やしやすい                |
| filter selector `[?...]`       | 独立した式型、比較、短絡、resource modelが必要 |
| current node `@`               | filterを実装しないため用途がない               |
| function extension             | function registryと追加の型検証が必要          |
| script expression／host `eval` | RFC 9535外であり、injection境界を壊す          |
| mutation／assignment           | JSONPathは読み取り専用queryとして扱う          |

tokenizerが`..`、`[?`、`@`、function callを認識した場合は`SD-JSONPATH-UNSUPPORTED`を返す。それ以外の
subset grammar違反は`SD-JSONPATH-SYNTAX`とする。parserはquery全体を検証・compileしてからvalueを評価し、
JavaScript parser、regular expression engine、`eval`へquery断片を渡さない。

### 3.3 singular query

`queryScalar`と`queryReference`は、各segmentが単一のname selectorまたは単一のindex selectorである
syntactically singularなqueryだけを受理する。wildcard、slice、selector listを含むqueryは、実data上の
結果が一件であっても`SD-QUERY-NOT-SINGULAR`とする。

Scratch scalarとopaque handleを一つの`query one` reporterから返す案は採用しない。pure libraryは
discriminated unionを扱えるが、Scratch block facadeは`queryScalar`と`queryReference`へ分離する。

## 4. resource limitとerror

初版のdefault limitは次とする。hostは同じか厳しい値を起動時に注入でき、queryごとには変更できない。

| limit                    | default | 数え方                                          |
| ------------------------ | ------- | ----------------------------------------------- |
| query Unicode scalar数   | 1024    | decode後のquery全体                             |
| segment数                | 32      | child segment数                                 |
| 一segmentのselector数    | 16      | comma区切りselector                             |
| compile AST node数       | 128     | root、segment、selector                         |
| evaluation node visit数  | 10000   | selectorへ入力したnodeごと                      |
| result数                 | 1000    | 重複を含む最終nodelist                          |
| normalized path長        | 4096    | 一resultのUnicode scalar数                      |
| active Iterator数        | 1024    | realm単位。Object Storeのhandle上限も同時に適用 |
| active ExceptionRef数    | 256     | TurboWarp Adapter realm単位                     |
| ExceptionRef tombstone数 | 256     | released／expired record。activeとは別枠        |

compile時上限は`SD-JSONPATH-LIMIT`、評価時のvisit／result／path上限は
`SD-JSONPATH-EVALUATION-LIMIT`を返す。上限到達までの部分nodelistを成功結果として返さない。queryと
collection／Iterator作成はObject Store transactionを変更せず失敗する。

| code                           | 意味                                         |
| ------------------------------ | -------------------------------------------- |
| `SD-JSONPATH-SYNTAX`           | subset grammarとして不正                     |
| `SD-JSONPATH-UNSUPPORTED`      | RFC 9535機能だが初版subset外                 |
| `SD-JSONPATH-LIMIT`            | query／AST／segment／selector上限            |
| `SD-JSONPATH-EVALUATION-LIMIT` | visit／result／normalized path上限           |
| `SD-QUERY-NOT-SINGULAR`        | singular APIへnon-singular queryを渡した     |
| `SD-QUERY-NO-MATCH`            | singular queryが0 nodeを返した               |
| `SD-QUERY-TYPE-MISMATCH`       | scalar APIとstructured node、またはその逆    |
| `SD-COLLECTION-RELEASED`       | 解放済みcollectionを利用した                 |
| `SD-SCOPE-PROTECTED`           | Adapterのdefault scopeを明示解放しようとした |
| `SD-ITERATOR-NOT-POSITIONED`   | current itemがない状態でcurrentを読んだ      |
| `SD-ITERATOR-RELEASED`         | 解放済みIteratorを利用した                   |
| `SD-EXCEPTION-EXPIRED`         | release／session終了済みExceptionRefを読んだ |
| `SD-ADAPTER-EXCEPTION-LIMIT`   | active ExceptionRef上限                      |

Coreの`STORE-*` errorはcodeを変えずAdapter diagnosticへ格納する。query text、opaque handle、保存value、
normalized path本文はExceptionRef reporterのmessageへ含めない。

## 5. query resultとcollection

### 5.1 pure libraryの型

```ts
type QueryKindResult = StoreResult<{
  kind: 'null' | 'boolean' | 'number' | 'string' | 'reference';
}>;

type QueryScalarResult = StoreResult<{
  kind: 'scalar';
  value: null | boolean | number | string;
}>;

type QueryReferenceResult = StoreResult<{
  kind: 'reference';
  reference: ReferenceLease;
}>;

type QueryCollectionResult = StoreResult<{
  kind: 'collection';
  collection: OwnerRef;
  length: number;
}>;
```

| API                                    | 0 node           | scalar node       | object／array node   | 複数node            |
| -------------------------------------- | ---------------- | ----------------- | -------------------- | ------------------- |
| `queryKind(source, singularPath)`      | NO_MATCH         | scalar kind       | `reference`          | grammar上発生しない |
| `queryScalar(source, singularPath)`    | NO_MATCH         | scalar copy       | TYPE_MISMATCH        | grammar上発生しない |
| `queryReference(source, path, scope)`  | NO_MATCH         | TYPE_MISMATCH     | new `ReferenceLease` | grammar上発生しない |
| `queryCollection(source, path, scope)` | empty collection | scalar copyを所有 | leaseを所有          | 記述順に全件を所有  |

collectionはtype tag `structured-data.query-collection.v1`のentryであり、公開する`CollectionRef`はその
`OwnerRef`である。scalar itemは不変valueをcopyし、structured itemごとにcollection scope所有の独立leaseを
作る。同じnodeがquery結果へ二回現れた場合はleaseも二本作り、countを2増やす。

`releaseCollection`はcollection entryの`free`であり、所有する全leaseを同一transactionでreleaseする。
collection外へduplicateしたleaseがある場合、そのleaseは呼び出し側scopeが所有し、collection解放後も
有効である。単なるCollectionRef文字列copyは所有権とcountを増やさない。

pure libraryは`null`をそのまま返す。Scratchにはnull scalarがないため、Standaloneの`queryScalar`と
`iteratorCurrentScalar`だけはnullを空文字へ投影する。呼び出し側は先に`queryKind`または
`iteratorCurrentKind`を使うことで、nullと空文字を区別できる。number、Boolean、stringはScratchの
対応scalarへ変換する。

### 5.2 normalized path

各itemはRFC 9535のcanonical bracket notationによるNormalized Pathを内部に保持する。通常のpaletteでは
pathを値取得に必要とせず、developer buildだけがredacted debug snapshotまたは専用reporterで公開できる。
member名はsingle quote形式、array indexはnon-negative decimalへ正規化する。

## 6. Iterator

### 6.1 snapshotと状態

Iteratorは作成時のnodelistまたはcollection item列をimmutable snapshotとして保持し、後続のStore変更で
順序、長さ、現在位置を変えない。scalar itemは作成時にcopyし、structured itemはIteratorが所有するleaseで
生存させる。

```text
ready ──next/item────> positioned ──next/item────> positioned
  │                         │
  └────next/no item─────────┴────next/no item────> exhausted
exhausted ──next────────> exhausted   result = "done"
ready／positioned／exhausted ──release──────────> released
```

`iteratorNext`はitemへ進んだ場合`"item"`、終端では`"done"`を返す。終端後の再呼び出しも
idempotentに`"done"`を返し、空文字やExceptionRefにはしない。invalid／released handleだけを
ExceptionRefとする。

current itemは`positioned`でだけ読める。`ready`と`exhausted`では`SD-ITERATOR-NOT-POSITIONED`、
`released`では`SD-ITERATOR-RELEASED`を返す。

### 6.2 current item

- `iteratorCurrentKind`は`null`、`boolean`、`number`、`string`、`reference`のいずれかを返す。
- `iteratorCurrentScalar`はscalar copyを返し、structured itemには`SD-QUERY-TYPE-MISMATCH`を返す。
- `iteratorCurrentReference(iterator, ownerScope)`はstructured itemへの独立leaseを作り、scalar itemには
  `SD-QUERY-TYPE-MISMATCH`を返す。
- 同じitemで`iteratorCurrentReference`を二回呼ぶと独立leaseを二本作る。不要な再取得を暗黙にまとめない。

### 6.3 source lease

sourceから直接作るIteratorは、作成時にsource nodeへのleaseを一つ取得し、自身のscopeで所有する。
query結果のstructured itemについてもIterator所有leaseを作る。Iterator解放時に全leaseをatomicに
releaseする。

```text
newEntry({actors: [{name: "A"}, {name: "B"}]}) -> Owner O1
newQueryIterator(O1, "$.actors[*]", Scope S)     -> Iterator I1、source/item leaseを所有
free(O1)                                         -> STORE-OBJECT-IN-USE、変更なし
iteratorNext(I1)                                 -> "item"
iteratorCurrentReference(I1, Scope C)            -> caller lease L1
releaseIterator(I1)                              -> Iterator所有leaseだけをrelease
free(O1)                                         -> L1が残るためSTORE-OBJECT-IN-USE
releaseReference(L1)                             -> caller leaseをrelease
free(O1)                                         -> 成功
```

collectionから作るIteratorはcollection entryへのsource leaseを取得する。collectionを先に解放しようとすると
Iteratorが生きている間は`STORE-OBJECT-IN-USE`になる。親scopeを一括解放する場合は同じclosure内のleaseと
entryをatomicに解放できる。

## 7. ExceptionRef

### 7.1 形式と寿命

TurboWarp Adapterは失敗時だけ次のruntime-only scalarを作る。

```text
@sdx1.<adapterRealmNonce>.<exceptionNonce>
```

二つのnonceは各128 bit以上のCSPRNGとする。ExceptionRefはCoreの`@os1` handle table、Store count、SB3、
YAML、live reload transferへ含めない。Adapter tableだけがcode、operation、安全なmessage、state、ownerを
保持する。

```text
active ──releaseException────────> released
active ──reload／adapter dispose─> expired
```

active上限は256件とする。上限時は新しいrecordを増やさず、adapter realmごとに一つ予約した
`SD-ADAPTER-EXCEPTION-LIMIT`のExceptionRefを返す。active recordをLRU evictionして生きた参照を暗黙に
expiredにはしない。release／expiryはactive枠を直ちに空け、別枠のtombstoneへ移す。tombstoneは256件を
上限として古い順に破棄でき、破棄後のtokenは未知の通常stringとして扱う。Adapter disposeではtable全体を
破棄し、新しいadapter realmの`isException`は旧tokenへfalseを返す。

### 7.2 predicateとdiagnostic

- `isException(value)`は現在のAdapter tableのactive recordまたは保持中のreleased／expired tombstoneに
  一致する場合だけtrueを返す。
- live reload plannerは現在のAdapterの`isException` predicateをsession起動時に受け取り、trueになった
  scalarだけを移送対象から外す。`@sdx1.`に似た未知tokenをprefixだけでExceptionRefと推測しない。
- `exceptionCode`、`exceptionOperation`、`exceptionMessage`はactive recordだけを読める。
- released／expired recordは`SD-EXCEPTION-EXPIRED`を返す。別realm／未知tokenは通常のstringであり、
  `isException`はfalseとする。
- diagnostic reporterはquery text、opaque token、保存value、filesystem path、stack traceを返さない。
- Standard KamishibaiはExceptionRefを作らず、Core／query errorをSource Map付き`K4-*`診断へ変換する。

## 8. Standalone block facade

全blockのextension IDは`kubohiroyastructdata1`とする。fallibleな更新操作もreporterとして
`true | ExceptionRef`を返し、JavaScript例外や暗黙のthread-local last errorへ逃がさない。

| opcode                     | shape    | argument                          | return                       |
| -------------------------- | -------- | --------------------------------- | ---------------------------- |
| `defaultScope`             | reporter | なし                              | ScopeRef                     |
| `createScope`              | reporter | `PARENT_SCOPE`, `LABEL`           | ScopeRef／ExceptionRef       |
| `newEntryFromJson`         | reporter | `JSON`, `TYPE_TAG`, `OWNER_SCOPE` | OwnerRef／ExceptionRef       |
| `duplicateReference`       | reporter | `REFERENCE`, `OWNER_SCOPE`        | ReferenceLease／ExceptionRef |
| `queryKind`                | reporter | `SOURCE`, `PATH`                  | kind string／ExceptionRef    |
| `queryScalar`              | reporter | `SOURCE`, `PATH`                  | Scratch scalar／ExceptionRef |
| `queryReference`           | reporter | `SOURCE`, `PATH`, `OWNER_SCOPE`   | ReferenceLease／ExceptionRef |
| `queryCollection`          | reporter | `SOURCE`, `PATH`, `OWNER_SCOPE`   | CollectionRef／ExceptionRef  |
| `newQueryIterator`         | reporter | `SOURCE`, `PATH`, `OWNER_SCOPE`   | IteratorRef／ExceptionRef    |
| `newCollectionIterator`    | reporter | `COLLECTION`, `OWNER_SCOPE`       | IteratorRef／ExceptionRef    |
| `iteratorNext`             | reporter | `ITERATOR`                        | `item`／`done`／ExceptionRef |
| `iteratorCurrentKind`      | reporter | `ITERATOR`                        | kind string／ExceptionRef    |
| `iteratorCurrentScalar`    | reporter | `ITERATOR`                        | Scratch scalar／ExceptionRef |
| `iteratorCurrentReference` | reporter | `ITERATOR`, `OWNER_SCOPE`         | ReferenceLease／ExceptionRef |
| `releaseReference`         | reporter | `REFERENCE`                       | true／ExceptionRef           |
| `releaseCollection`        | reporter | `COLLECTION`                      | true／ExceptionRef           |
| `releaseIterator`          | reporter | `ITERATOR`                        | true／ExceptionRef           |
| `freeEntry`                | reporter | `OWNER`                           | true／ExceptionRef           |
| `releaseScope`             | reporter | `SCOPE`                           | true／ExceptionRef           |
| `isReference`              | Boolean  | `VALUE`                           | active Core handleならtrue   |
| `isException`              | Boolean  | `VALUE`                           | Adapter exceptionならtrue    |
| `exceptionCode`            | reporter | `EXCEPTION`                       | code／ExceptionRef           |
| `exceptionOperation`       | reporter | `EXCEPTION`                       | operation／ExceptionRef      |
| `exceptionMessage`         | reporter | `EXCEPTION`                       | safe message／ExceptionRef   |
| `releaseException`         | reporter | `EXCEPTION`                       | true／ExceptionRef           |

`CollectionRef`と`IteratorRef`は専用形式のhandleを増やさず、type tag付きentryの`OwnerRef`である。
predicateと各operationはCore tableを介してkind／type tagを検証する。`newEntryFromJson`はJSON textを
専用parserで読み、Object Storeが禁止する非有限number、共有identity、prototype pollution keyを作らない。
`defaultScope`はStandalone adapter realmが起動時に作るroot直下scopeであり、project stop／adapter disposeで
自動解放する。利用者はこれを親またはownerとして使えるが、`releaseScope(defaultScope)`は
`SD-SCOPE-PROTECTED`で拒否し、realmを利用中に既定所有先を失わせない。

developer buildにだけ`debugSnapshot`、`debugAssertInvariants`、`debugHandleKind`、
`debugNormalizedPath`、`debugLimits`を置く。snapshotとmessageはtokenと保存valueをredactする。

## 9. Kamishibai内部API

Kamishibai Runtimeは任意JSONPathをactionごとに評価せず、型付き`StoryIterator`と
`SceneActionIterator`を利用する。通常のcustom actionもtarget、parameter、current actionの専用reporterを
優先し、JSONPathを必須にしない。上級custom actionがJSONPathを使う場合だけ、action scopeへ結果とleaseを
所有させ、complete、fail、goto、timeout、stop、scene遷移で自動解放する。

Standard fixtureの受け入れ条件は次とする。

- `kubohiroyastructdata1`／`kubohiroyastructdata1debug`をextension storageへ登録しない。
- `kubohiroyastructdata1_*`／`kubohiroyastructdata1debug_*` opcodeを0件にする。
- YAMLのscene／action数を増やしてもgeneric block数を増やさない。
- Object Store、Iterator、JSONPathの寿命はruntimeのJavaScript APIだけで管理する。

## 10. test contract

- RFC 9535のname、index、negative index、wildcard、slice、selector list例をsubset fixtureにする。
- missing member、out-of-range index、primitive child、step 0がempty collectionになることを確認する。
- duplicate selectorのnodeとlease countを重複したまま保存する。
- object wildcardは一snapshot内で安定し、array順とselector記述順を維持する。
- descendant、filter、function、`@`、script expressionを`UNSUPPORTED`にする。
- query、AST、visit、result、normalized pathの各limitで部分結果をcommitしない。
- Iteratorのready、positioned、exhausted、releasedをmodel-based testする。
- exhausted後の任意回数の`next`が`done`のままでcountとrevisionを変えない。
- Iterator／collectionがsource解放を止め、release後にcountが正確に戻ることをproperty testする。
- scalar／referenceの型違い、ExceptionRefのrelease／realm expiry、active上限を検証する。
- null／空文字をkind reporterで区別し、ExceptionRef tombstone上限後もactive枠を再利用できることを確認する。
- Standard fixtureのgeneric Structured Data opcode数が0であることをtestする。

## 11. feature flagとrollback

pure libraryは既存runtimeから未参照で導入する。Standalone paletteは起動時固定の
`structuredDataStandaloneEnabled`、developer surfaceは`structuredDataDebugEnabled`で個別に既定OFFとする。
Kamishibai内部統合はさらに別の既定OFF flagにし、Standalone有効化と連動させない。

実装は`./dsl4` package subpathから、既定OFFのflag snapshot、Adapter、TurboWarp surface factoryを公開する。
factory生成だけでは登録せず、app shellが起動時に一度だけ`register()`を呼ぶ。両flagがOFFならScratch hostと
Adapterを参照せず、Standard manifest／palette／SB3へextension IDまたはopcodeを追加しない。

問題時は各flagをOFFにし、implementation PRをrevertする。Standard Kamishibai fixtureと3.2 runtimeは
Structured Data visible extensionへ依存しないため、そのまま実行できる。
