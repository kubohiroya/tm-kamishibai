# DSL 4.0 Generic Object Store参照モデル

## 1. 位置づけ

本書はGeneric Object Store Coreのruntime契約を定める。紙芝居固有のstory、scene、actionという意味は
扱わず、Kamishibai Adapterが本契約上のrealmとscopeへ対応付ける。

初版の目的は次の四点に限定する。

- JavaScriptのJSON-like valueを`MapBackend`へ保持する
- 構造化valueをopaque handleで安全に参照する
- scopeとreference countによりatomicに解放する
- realm、slot generation、handle stateにより古い参照を拒否する

Temporary Variables、Scratch runtime variable、IndexedDBは正本にしない。JSONPath、Iterator、Scratchの
visible blockは本書の上に構築し、
[`Iterator・JSONPath・TurboWarp Adapter API`](dsl-4-iterator-jsonpath.md)で定義する。

## 2. 用語と型

### 2.1 realm、scope、entry、node

- **realm**: 一つのStore instanceの寿命。別realmのhandleは共有しない。
- **scope**: entry、lease、子scopeを所有し、一括解放する汎用container。
- **entry**: `newEntry`で作る一つの所有closure。root nodeと構造的な子nodeを持つ。
- **node**: object、array、scalarのいずれか。object propertyとarray elementはentry内の構造所有edgeである。

入力valueは`null`、Boolean、有限number、string、array、plain objectからなる非循環グラフに限定する。
class instance、function、symbol、bigint、accessor、symbol key、prototype pollution key、非有限number、
JavaScript object identityの共有、構造cycleは受理しない。

### 2.2 公開Core handleと内部edge

| 種類             | 公開値        | 作成方法                        | 状態                | countへの影響  |
| ---------------- | ------------- | ------------------------------- | ------------------- | -------------- |
| `ScopeRef`       | opaque string | `createScope`                   | active → released   | なし           |
| `OwnerRef`       | opaque string | `newEntry`                      | active → freed      | なし           |
| `ReferenceLease` | opaque string | `createReference`／query結果    | active → released   | active中は+1   |
| `RefValue`       | Core内部値    | `setReferenceValue`等のCore API | attached → detached | attached中は+1 |

`RefValue`はopaque stringではなく、Coreだけが生成できるbranded internal recordである。通常のstringを
`RefValue`として解釈しない。構造的な親子edgeはcountへ加えず、別nodeを指す`RefValue`だけを管理対象edgeと
する。

`OwnerRef`はentryの唯一の解放権限を表すが、自分自身への外部参照には数えない。`OwnerRef`文字列をcopy
しても所有権は増えず、いずれかのaliasから`free`した時点で全aliasがstaleになる。

`ExceptionRef`はCoreのobject handleではなく、TurboWarp Adapterが`StoreResult.error`をScratch scalarへ
投影する場合だけ作る。符号化、predicate、diagnostic reporter、expiryは
[`Iterator・JSONPath・TurboWarp Adapter API`](dsl-4-iterator-jsonpath.md)で定義し、Coreの`@os1` handle
tableへ登録しない。Adapter上ではactiveからreleaseまたはexpiryによりexpiredへ遷移する。

## 3. opaque handle

### 3.1 形式

`ScopeRef`、`OwnerRef`、`ReferenceLease`は次のruntime-only形式を使用する。

```text
@os1.<realmNonce>.<handleNonce>
```

`realmNonce`と`handleNonce`はそれぞれ128 bit以上の暗号学的乱数をbase64urlで符号化する。
kind、slot、generation、scope label、type tag、台本名、filesystem pathを文字列へ含めない。Coreはtokenを
分解してentryへ直接到達せず、realm内のhandle tableを引いて次の内部recordを検証する。

```text
token -> {kind, slot, generation, state, ownerScopeSlot}
```

乱数sourceはhostが注入可能にし、productionはWeb Crypto相当のCSPRNGを必須とする。testは衝突しない
決定的nonce列を注入できる。tokenはSB3、YAML、manifest、user config、live reload変数へ永続化しない。

### 3.2 検証順序とtombstone

1. `@os1`形式と長さを検証する。
2. `realmNonce`が現在のrealmと一致しなければ`STORE-REALM-MISMATCH`を返す。
3. handle tableにtokenがなければ`STORE-REFERENCE-INVALID`を返す。
4. handle kindが操作と合わなければ`STORE-HANDLE-KIND`を返す。
5. released／freedなら対応するreleasedまたはstale errorを返す。
6. slotの現在generationとhandle recordが一致しなければ`STORE-REFERENCE-STALE`を返す。

released／freed handleのtombstoneはrealm終了まで保持する。handle数には明示的な上限を設けるため、
tombstone保持はunboundedにならない。slot再利用時はgenerationを1増やし、新しいhandleNonceを生成する。
realm dispose後はStore instance自体が`STORE-REALM-DISPOSED`を返し、tableを全破棄する。

## 4. 状態遷移

```text
Realm:       active ──disposeRealm────────> disposed
               └────invariant failure────> faulted ──disposeRealm──> disposed
ScopeRef:    active ──releaseScope─> released
OwnerRef:    active ──free─────────> freed
Lease:       active ──release──────> released
RefValue:    attached ──replace/remove/free─> detached
```

TurboWarp Adapter固有の`ExceptionRef`は、Core状態遷移の外でactiveからreleaseまたはexpiryにより
expiredへ遷移する。

terminal状態から同じ解放操作を再実行しても成功扱いにはしない。leaseの二重releaseは
`STORE-REFERENCE-RELEASED`、ownerの再freeは`STORE-REFERENCE-STALE`、scopeの再releaseは
`STORE-SCOPE-RELEASED`を返す。realmの`disposeRealm`だけはhost cleanupを単純にするためidempotentとし、
二回目以降も同じdisposed snapshotを返す。

## 5. 公開Resultとerror

Coreのdomain operationはJavaScript例外ではなく、deeply immutableな次のdiscriminated unionを返す。

```ts
type StoreResult<T> =
  | {ok: true; value: T}
  | {
      ok: false;
      error: {
        code: StoreErrorCode;
        operation: string;
        message: string;
        handleKind?: string;
      };
    };
```

errorへhandle token、保存value、台本source、path、backend内部recordを含めない。constructorへ無効な
backend／policyを渡すprogramming errorだけは`TypeError`とし、realm作成後の公開operationはResultへ
正規化する。backend failureはtransactionをrollbackして`STORE-BACKEND-FAILURE`を返す。

| code                        | 意味                                        |
| --------------------------- | ------------------------------------------- |
| `STORE-REALM-DISPOSED`      | realm終了後の操作                           |
| `STORE-REALM-MISMATCH`      | 別realmのhandle                             |
| `STORE-REFERENCE-INVALID`   | 形式は正しいが登録されていないtoken         |
| `STORE-REFERENCE-STALE`     | freed ownerまたはslot generation不一致      |
| `STORE-REFERENCE-RELEASED`  | released leaseの利用／再release             |
| `STORE-SCOPE-RELEASED`      | released scopeの利用／再release             |
| `STORE-HANDLE-KIND`         | 操作が要求するhandle kindと不一致           |
| `STORE-OBJECT-IN-USE`       | 解放closureへ外部のlease／RefValueが流入    |
| `STORE-STRONG-CYCLE`        | cross-owner strong cycleを作るRefValue      |
| `STORE-VALUE-INVALID`       | 非JSON-like value、共有identity、禁止key    |
| `STORE-VALUE-CYCLE`         | 入力構造自体にJavaScript cycleがある        |
| `STORE-LIMIT-EXCEEDED`      | node、handle、scope、深さ、操作量の上限     |
| `STORE-CONFLICT`            | backend revisionがtransaction開始時から変化 |
| `STORE-REFERENCE-UNDERFLOW` | countを0未満にする内部不整合                |
| `STORE-BACKEND-FAILURE`     | transaction準備／commit中のbackend失敗      |

`STORE-REFERENCE-UNDERFLOW`は通常入力では到達不能なinvariant failureである。transactionを変更なしで
rollbackし、realmをfaultedにする。faulted後は読み取り専用debug snapshotと`disposeRealm`だけを許可し、
その他を同じerrorでfail closedする。

## 6. count規則

各nodeの`incomingCount`は、realm内でそのnodeへ入るactive `ReferenceLease`とattached `RefValue`の
実数の合計でなければならない。

| 操作                                              | 対象count     | handle／edgeの結果                    |
| ------------------------------------------------- | ------------- | ------------------------------------- |
| `newEntry(value, scope)`                          | 変化なし      | active `OwnerRef`を一つ作る           |
| OwnerRef／LeaseのScratch string copy              | 変化なし      | 同じhandleのalias                     |
| `createReference(ownerOrLease, path, ownerScope)` | +1            | 新しいactive lease                    |
| `duplicateReference(lease, ownerScope)`           | +1            | 独立した新しいactive lease            |
| `releaseReference(lease)`                         | -1            | leaseをreleasedへ                     |
| `setReferenceValue(source, key, target)`          | +1            | attached RefValueを作る               |
| RefValueを別targetへ置換                          | old -1/new +1 | 一transactionでedgeを置換             |
| RefValueを削除                                    | -1            | edgeをdetachedへ                      |
| iterator／collection作成                          | +N            | entryが所有するleaseを作る            |
| iterator／collection／所有scope解放               | -N            | 所有leaseをすべてrelease              |
| `free(owner)`／`releaseScope(scope)`              | 下記参照      | closure外向きedgeと所有leaseをrelease |

count更新とhandle／edgeの状態更新は常に同一transactionでcommitする。同じlease文字列を二つのScratch
variableへ入れてもcountは1であり、独立した寿命が必要な呼び出し側だけが`duplicateReference`を使う。

## 7. cycle規則

同じentryの所有closure内では、`RefValue`による自己参照と内部cycleを許可する。closureごとfreeするため、
closure外から流入がなければ内部edgeは解放を妨げない。

異なるOwnerRefのentry間では、有向strong `RefValue` graphがcycleになるedgeを作成時に
`STORE-STRONG-CYCLE`で拒否する。A→Bが存在するときB→Aを追加するtransactionは何も変更しない。
初版ではweak referenceと任意OwnerRef集合のatomic multi-freeを提供しない。共通scopeの
`releaseScope`はそのscope配下全体を一つのclosureとして解放できるが、任意集合を後から指定する
multi-freeの代替にはしない。

この規則により、一方向のcross-owner参照は許可し、参照元を先に解放すれば参照先を後で解放できる。
所有scopeをまたぐcycle解決policyを利用者へ要求しない。

## 8. atomic freeとscope release

`free(OwnerRef)`と`releaseScope(ScopeRef)`は次を一つのtransaction planとして実行する。

1. realm、handle kind／state、slot generation、ownershipを検証する。
2. 構造子孫、配下scope、配下entryから解放closureを求める。
3. closure外から内へ入るactive leaseとRefValueを列挙する。
4. 一件でもあれば`STORE-OBJECT-IN-USE`を返し、backend revisionを含む全状態を変更しない。
5. closureが所有するleaseと、closure内から外へ出るRefValueのcount減分を計算する。
6. 全countが0以上で、resource limit内で、backend revisionが開始時と同じことを検証する。
7. working snapshotへ全変更を適用し、MapBackendのroot snapshotを一回だけswapする。
8. handleをterminal状態にし、解放slotのgenerationを進める。

`MapBackend`はimmutable root snapshotと単調増加revisionを正本とする。transactionはbase revisionと
copy-on-write working mapsを持ち、commit成功時だけroot pointerとrevisionを一回更新する。検証失敗、
conflict、limit、backend failureでは旧rootを保持する。observerやprojectionはcommit後のsnapshotだけを
受け取り、途中状態を観測しない。

Iterator／collection実装は、非公開の子scope、type tag付きentry、source／item leaseを一つの
`createScopeBundle` transactionで作る。この限定的なcomposition primitiveは`MapBackend`のprivate mapを
公開せず、全handleとcountを一回のcommitで追加する。作成失敗はbundle全体をrollbackし、解放は既存の
`releaseScope`でentryと全所有leaseを同時に解放する。

### 8.1 例: nested valueとlease

```text
newEntry({actor: {name: "Hero"}}) -> OwnerRef O1  count(actor)=0
createReference(O1, "$.actor")    -> Lease L1     count(actor)=1
copy string L1                     -> alias        count(actor)=1
free(O1)                           -> IN_USE       状態変更なし
releaseReference(L1)               -> released     count(actor)=0
free(O1)                           -> freed        root/actorを同時削除
```

### 8.2 例: RefValueとcross-owner cycle

```text
newEntry({name: "A"}) -> O-A
newEntry({name: "B"}) -> O-B
setReferenceValue(O-A, "friend", O-B) -> 成功、B count=1
free(O-B)                              -> IN_USE、変更なし
setReferenceValue(O-B, "friend", O-A) -> STRONG_CYCLE、変更なし
free(O-A)                              -> 成功、B count=0
free(O-B)                              -> 成功
```

### 8.3 例: scope全体のrollback

scope S配下にO-A、子scope T配下にO-Bがあり、scope外lease LがO-Bを指す場合、`releaseScope(S)`は
O-A、O-B、S、Tのいずれも解放せず失敗する。Lをreleaseした後の再実行は全配下entry／scopeと
内部leaseを一回で解放する。

## 9. property test不変条件

model-based property testは、上限内のoperation列をreference modelと実装へ同時に適用し、各stepで
次を検証する。

1. `incomingCount(node)`がactive lease＋attached RefValueの実数に一致する。
2. active handleは一つのactive realm recordだけへ解決し、terminal handleは再活性化しない。
3. slot再利用後、旧tokenは新entryへ解決しない。
4. handle string copyはcount、handle数、backend revisionを変えない。
5. lease duplicateだけが独立countを増やし、各leaseは一回だけreleaseできる。
6. domain／validation failureはbackend root、revision、count、handle state、scope graphをbyte-for-byteで変えない。
7. 解放closure外からの流入が0の場合だけfree／scope releaseが成功する。
8. closure内部cycleはfree可能で、cross-owner strong cycleを作るedgeはcommitされない。
9. active entry／leaseはactive scopeへ所有され、scope解放後にorphanを残さない。
10. realm dispose後にactive handle、node、scope、lease、projectionを残さない。
11. debug snapshotから再計算したcountと保存countが一致する。
12. arbitrary operation列でcount underflowとtoken collisionが発生しない。
13. live reloadのplain valueは旧valueとobject identityを共有せず、handle／leaseを含む変数は個別初期化される。

乱数、resource limit、backend failure、transaction conflictを注入し、成功系だけでなく全failure pointで
rollbackを確認する。内部invariant failureだけはdata rootを変更せずrealm状態を`faulted`へ遷移させる例外と
する。debug snapshotはtokenや保存valueを伏せ、test専用の連番IDとcountだけを返す。

## 10. Kamishibai Adapterとlive reload

### 10.1 自動scope管理

| Kamishibai寿命 | Generic表現          | 作成                    | 解放                                           |
| -------------- | -------------------- | ----------------------- | ---------------------------------------------- |
| story          | realm root直下scope  | parse成功後             | 台本再読込、タイトル復帰、終了、fatal error    |
| scene          | story scopeの子scope | scene entry             | scene遷移、story終了、fatal error              |
| action         | scene scopeの子scope | action dispatch前       | complete、fail、goto、timeout、stop、scene遷移 |
| custom manual  | 明示scope            | developer API利用時だけ | handlerまたは親scope                           |

標準Kamishibai RuntimeはCore APIをJavaScriptから直接呼び、scopeとleaseを自動解放する。標準作者paletteと
標準SB3にはnew、query、copy lease、release、free、scope、debug blockを登録しない。Standalone／developer
surfaceは[`Iterator・JSONPath・TurboWarp Adapter API`](dsl-4-iterator-jsonpath.md)で別extension IDとflagへ
分離する。

### 10.2 live reload transfer

live reloadの新sessionは、restart choiceにかかわらず新しいrealmと新しいslot generation空間を作る。
旧realmのOwnerRef、Lease、ScopeRef、ExceptionRef、RefValue、object identityを新realmへ移さない。

移行候補のruntime variableは変数ごとに再帰走査する。`null`、Boolean、有限number、string、array、plain
objectだけからなる非循環valueは新しい構造へdeep copyする。次のいずれかを直接またはnestedに含む変数は、
変数全体をcandidate StoryDocumentの初期値へ戻す。

- `RefValue` branded record
- `@os1.` reserved prefixのopaque handle string
- TurboWarp Adapterが`ExceptionRef`と判定するscalar
- function、symbol、bigint、class instance、accessor、非有限number
- JavaScript cycleまたは共有object identity

resetした変数ごとに`K4-RELOAD-VARIABLE-REFERENCE-RESET` warningを返すが、handle文字列や値本文を診断へ
含めない。既存reload plannerの同名・同型scalar条件も引き続き適用し、条件を満たさない変数は通常どおり
candidate初期値へ戻す。

commit前に新realm作成またはplain value copyが失敗した場合は、旧runtime／realmを停止せずcandidateだけを
失敗させる。commit成功後に旧runtimeを停止し、旧story scopeとrealmをdisposeする。旧handleがscanを
すり抜けても、新realmは`realmNonce`不一致で受理しない。

## 11. 実装境界と初版の非目標

- Generic CoreはScratch、TurboWarp VM、StoryDocument、Kamishibai controllerをimportしない。
- `MapBackend`のprivate mapsをadapterへ公開しない。
- Standard Kamishibaiはpure Coreを直接利用し、汎用block facadeを持たない。
- Structured Data Standaloneだけが上級block facadeを持ち、developer/debugは別buildとする。
- projectionは読み取り専用cacheであり、削除してもCoreの結果を変えない。
- 初版ではweak reference、arbitrary multi-owner free、永続handle、cross-realm transferを実装しない。
- 初版ではJSONPath／Iteratorの表層APIを本書へ混在させない。

本契約を変更する場合、reference modelとproperty testを先に更新する。runtime featureは既定OFFで導入し、
flag OFFまたは変更PRのrevertで3.2 runtimeとObject Store未使用のDSL 4.0経路へ切り戻せるようにする。
