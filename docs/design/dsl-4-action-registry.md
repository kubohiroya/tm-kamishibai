# DSL 4.0 Scratch Action Registry handler契約

## 1. 位置づけ

本書は、Scratchで作品固有custom actionを実装するためのhat検出、Registry Snapshot、threadと
ActionContextの関連付け、terminal outcome、action scope、timeout、clone／並行実行、live reload
quiesceを定める。

Custom actionは標準作品の必須機能ではない。全core actionは台本だけで実行でき、Scratch Action Registryが
空の作品を標準経路とする。通常の台本製作者へregister、Object Store、JSONPath、完了待ちloop、scope解放の
blockを要求しない。

## 2. Registry Snapshot

### 2.1 hat検出

TurboWarp Adapterは台本をparseする前に、展開済みproject graphのoriginal targetだけを次の順序で走査する。

1. target IDのcanonical順、同一target内はtop-level block ID順に走査する。
2. custom action用hat opcodeと一致し、`topLevel: true`、`parent: null`であるblockだけを候補にする。
3. hat mutationからaction名、target種別、parameter、quiesce modeを読み取る。
4. original target IDとhat block IDをsource locatorとして記録する。
5. 全候補をCoreの`createDsl4ActionRegistrySnapshot`へ渡し、action名順のimmutable snapshotへ正規化する。
6. snapshot生成が成功した場合だけ、そのsnapshotをsource frontendとruntime generationへ固定する。

cloneに複製されたhat、実行中に作られたhat、green flag後にmutationされたhatを同じgenerationへ追加しない。
変更を反映するにはproject restartまたはlive reloadの新candidate generationを作る。hat検出はblockを実行せず、
別のregister script、broadcast、初期化順序に依存しない。

hat opcodeはStandalone／Compositeの物理namespaceをdetector内で推測せず、toolchainまたはapp shellが解決した
完全なopcodeを起動時に注入する。mutationは`tagName: "mutation"`、空の`children`、一つの
`dsl4action`属性だけを持つ。TurboWarp VMのXML mutation adapterは属性名を小文字化するため、
camelCaseの`dsl4Action`はwire keyとして使わない。`dsl4action`は次のdeclarative JSONであり、version 1以外、unknown key、
procedure、list、runtime variable、実行可能コードを受理しない。

```json
{
  "version": 1,
  "name": "wave",
  "target": "actor",
  "parameters": [{"name": "speed", "type": "string", "required": true}],
  "quiesce": "finish-only"
}
```

`required`と`quiesce`はmutationでは省略可能であり、CoreのSnapshot生成時にそれぞれ`true`と
`finish-only`へ正規化する。

一つのaction名へ複数hatが見つかった場合、同一target内か別targetか、originalかcloneかにかかわらず、original
targetの候補が複数なら`K4-REGISTRY-COLLISION-001`でsnapshot全体を拒否する。cloneのhatは候補数へ含めない。

### 2.2 Snapshot v2

```json
{
  "kind": "ActionRegistrySnapshot",
  "version": 2,
  "actions": [
    {
      "name": "wave",
      "target": "actor",
      "parameters": [
        {"name": "speed", "type": "string", "required": true},
        {"name": "count", "type": "number", "required": false}
      ],
      "quiesce": "finish-only",
      "source": {"targetId": "target-id", "hatBlockId": "hat-id"}
    }
  ]
}
```

- parameter typeは`string`、`number`、`boolean`だけとする。
- `required`省略は`true`へ正規化する。
- `quiesce`省略は`finish-only`へ正規化する。
- `quiesce`は`finish-only`または`cancel-replay-safe`だけとする。
- action名、parameter名はDSL ID規則、Unicode NFC、project内一意性に従う。
- core actionとの衝突、同名handler、parameter重複をsnapshot全体のerrorにする。

Snapshot v1は`quiesce`を持たないlegacy入力として読み、全actionを`finish-only`にしてv2へ正規化する。v2で
`quiesce`が欠落した非canonical snapshotは受理しない。

### 2.3 detection limit

| limit                         | default |
| ----------------------------- | ------- |
| original target数             | 256     |
| targetあたりtop-level block数 | 4096    |
| custom action数               | 64      |
| actionあたりparameter数       | 16      |
| action／parameter名scalar数   | 64      |
| mutation JSON code unit数     | 8192    |

上限超過、malformed mutation、source locator欠落では部分snapshotを返さない。hat mutationはdeclarative JSON
だけを受理し、JavaScript、procedure、list、runtime variableをschemaとして評価しない。

## 3. ActionInvocationとthread context

### 3.1 Invocation

custom action一回のdispatchごとに、他と共有しない`ActionInvocation`を作る。

```ts
type ActionInvocation = {
  invocationId: string;
  runtimeGeneration: number;
  registrySnapshot: ActionRegistrySnapshot;
  actionPath: string;
  name: string;
  target: string;
  arguments: Readonly<Record<string, string | number | boolean>>;
  actionScope: ScopeRef;
  signal: AbortSignal;
  state: InvocationState;
};
```

`invocationId`はruntime session内で単調増加するopaque IDであり、台本、SB3、live reload変数へ永続化しない。
同じaction名の二回の実行、二つのruntime session、二つのcloneは同じActionInvocationを共有しない。

### 3.2 primary thread

Adapterはsnapshotに固定されたoriginal `targetId`と`hatBlockId`だけを指定してhatを開始する。戻ったthreadは
次を満たさなければならない。

- 0件: `K4-CUSTOM-HANDLER-MISSING`
- 1件: primary threadとしてActionInvocationへbindする
- 2件以上: 全threadを停止し`K4-CUSTOM-HANDLER-AMBIGUOUS`

threadとcontextの関連はAdapter instance内の`WeakMap<Thread, ActionInvocation>`を正本とする。
`current action` reporterは`util.thread`をkeyに解決し、単一global variableやruntime variableを読まない。
Scratch procedure callは同じthreadなのでcontextを維持する。一方、通常のbroadcastで開始したreceiver、cloneの
script、別hat、別runtime sessionのthreadへcontextを暗黙伝播しない。それらから専用reporterを呼ぶと
`K4-CUSTOM-CONTEXT-MISSING`になる。

Adapterへ注入するTurboWarp thread hostは、次の三操作だけを持つ。`start`はsource locatorの
original target／hat blockだけを同期的に開始し、handler本体が次のblockを実行する前にthread配列を返す。
`waitForCompletion(thread)`は正常終了でresolve、thread異常でrejectし、`stop(thread, reason)`は指定threadだけを
呼び出し中に実行不能にする。追加cleanupがpromiseならoutcome settlementはその完了を待つが、WeakMap
bindingは`stop`呼び出し直後に外す。Adapterはこの返値が0件または2件以上ならpartial contextを公開せず、複数件では全threadの
stopを試行する。

runtimeへ返すterminal outcomeは`{"outcome":"completed"}`または
`{"outcome":"transitioned","sceneId":"..."}`のexact objectとする。互換用の`undefined`／`null`はcompleteとして扱うが、
unknown field、unknown outcome、scene IDの型不一致は`K4-RUNTIME-RESULT-001`で拒否する。

custom actionをdispatchする`ActionContext`は`structuredData.actionScopeRef`と
`structuredData.actionViewRef`を必須とする。Adapterはこの2参照を起動時にcopy・freezeし、Invocationの
`actionScope`／`actionView`とthread identity専用の内部resource APIに固定する。scopeの作成と解放の正本は
runtime controllerが保持し、Adapterは別scopeや別leaseを作らない。thread cleanup後にcontrollerが
action scopeを解放し、解放で失敗したcustom actionは元のStore errorを公開messageに出さず
`K4-CUSTOM-CLEANUP-FAILED`へ正規化する。

この制限により、handlerが`broadcast and wait`で別scriptへ処理を委譲しても、receiverからcurrent action
reporterは読めない。値を渡す必要がある作品はprimary threadで専用reporterを読み、Scratchの通常の変数や
procedure引数へ明示的に渡す。

## 4. Invocation状態とterminal outcome

### 4.1 状態機械

```text
created ──bind/start────> running
running ──complete／normal thread end────> settling ──cleanup──> completed
running ──goto valid─────────────────────> settling ──cleanup──> transitioned
running ──fail／thread error／timeout────> settling ──cleanup──> failed
running ──stop／navigation／reload cancel> cancelling ─cleanup> cancelled
completed／transitioned／failed／cancelled = terminal
```

最初に受理したterminal signalだけが勝つ。`settling`またはterminal後のcomplete／fail／gotoは実行結果を
変えず、`K4-CUSTOM-ALREADY-SETTLED`をdeveloper diagnosticへ記録する。primary threadとaction scopeを
解放する前に次actionをdispatchしない。

### 4.2 normal endと明示block

primary threadがScratch上で正常終了し、terminal blockを呼んでいない場合は**暗黙complete**とする。
これは台本製作者ではなく作品カスタマイザーの定型block数を減らすための既定動作である。

| 契機                        | outcome      | controllerの動作                             |
| --------------------------- | ------------ | -------------------------------------------- |
| primary thread正常終了      | complete     | action commit後に次actionへ進む              |
| `complete current action`   | complete     | primary threadの残りを停止して次actionへ進む |
| `fail current action [msg]` | fail         | `K4-CUSTOM-FAILED`でruntimeをfailedにする    |
| `goto from action [scene]`  | goto         | scene検証後、scope解放してscene遷移する      |
| primary thread error        | fail         | `K4-CUSTOM-THREAD-FAILED`                    |
| action timeout              | fail         | thread停止後`K4-CUSTOM-TIMEOUT`              |
| runtime stop                | cancel       | action commitせずruntimeをstoppedにする      |
| navigation／rewind          | cancel       | action commitせず指定境界へ移る              |
| live reload cancel-replay   | cancel/pause | 同action先頭anchorで旧runtimeをpauseする     |

`goto`はterminal signalを受理する前にscene IDを現在のStoryDocumentで検証する。未知sceneならgotoへ遷移せず
`K4-CUSTOM-GOTO-001`でfailする。`fail`の作者messageは長さ256 Unicode scalarへ制限し、source text、opaque
reference、stackを診断へ含めない。codeは作者入力を使わず固定`K4-CUSTOM-FAILED`とする。

### 4.3 timeout

`customActionTimeoutMs`はapp shellが起動時に固定し、default 30000 ms、許容範囲100〜300000 msとする。
台本やScratch blockからactionごとに変更できない。timeoutはmonotonic clockで測り、発火時にAbortSignal、
TurboWarp primary thread停止、action scope cleanupを順に実行する。timeout後のstale thread settlementと
reporter書き込みはgeneration不一致で無視する。

## 5. ActionContext reporterとscope

### 5.1 公開するdeveloper palette

| opcode                     | shape    | argument  | return／効果                  |
| -------------------------- | -------- | --------- | ----------------------------- |
| `whenCustomAction`         | hat      | mutation  | Registry宣言とhandler開始点   |
| `currentActionName`        | reporter | なし      | action名                      |
| `currentActionTarget`      | reporter | なし      | target actor名                |
| `currentActionHasArgument` | Boolean  | `NAME`    | optional argumentが存在するか |
| `currentActionArgument`    | reporter | `NAME`    | 宣言済みScratch scalar        |
| `completeCurrentAction`    | command  | なし      | explicit complete             |
| `failCurrentAction`        | command  | `MESSAGE` | fail                          |
| `gotoFromCurrentAction`    | command  | `SCENE`   | goto                          |

hatのparameterとquiesceはmutation UIで編集し、実行blockを追加しない。通常handlerへgeneric Store、JSONPath、
scope release blockを要求しない。ActionViewのJSONPath accessはStructured Data上級paletteを別途有効にした
場合だけ使える。

`currentActionArgument`は存在するargumentを宣言型のScratch scalarで返す。宣言済みoptional argumentが
省略されている場合は空文字を返し、`currentActionHasArgument`で実際の空文字と区別する。未宣言parameter名は
`K4-CUSTOM-ARGUMENT-UNKNOWN`でInvocationをfailする。required欠落と型不一致は台本検証時に拒否されるため、
正常runtimeでは到達しない。

### 5.2 action scope sequence

```text
1. runtimeがaction child scopeを作る
2. immutable ActionViewと一時referenceをscopeへ置く
3. ActionInvocationとAbortSignalを作る
4. source targetのhatを一つ開始し、primary threadへbindする
5. terminal outcomeまたはtimeout／cancelを待つ
6. explicit terminal／cancelならprimary threadを停止する
7. WeakMap bindingとAdapter observerを外す
8. action scopeをatomicにreleaseする
9. cleanup成功後だけoutcomeをcontrollerへ返す
```

scope releaseが失敗した場合、complete／gotoを成功として返さず`K4-CUSTOM-CLEANUP-FAILED`でruntimeを
fail closedする。cancel中のthread停止とscope解放の両方が失敗した場合は、公開診断を一件にまとめ、内部の
複数原因をAggregateErrorとしてhost observerへ渡せる。action scopeはcomplete、fail、goto、timeout、stop、
navigation、scene遷移、live reloadのすべてで一回だけ解放する。

## 6. clone、duplicate、並行実行

### 6.1 規則

- Registry Snapshotはoriginal targetのhatだけから作る。
- dispatchはsnapshotのoriginal targetへ限定し、clone上の同opcode hatを開始しない。
- handler source target自身と台本上のtarget actorは別概念である。専用reporterは台本targetを返す。
- 一runtime controllerはactionを直列dispatchし、前actionのcleanup前に次actionを始めない。
- 別runtime sessionでは同じsnapshot／handlerを並行実行できるが、Adapter、WeakMap、scope、timeoutを共有しない。
- 将来一session内で並行actionを許す場合も、thread keyからInvocationを引き、global current actionを導入しない。

### 6.2 必須fixture

1. original targetに`wave` hat一つ、cloneに同hatがある場合、snapshotとdispatch threadは各一件になる。
2. 二つのoriginal targetが`wave`を宣言した場合、snapshot全体がcollisionになり台本を実行しない。
3. 同じhandlerを二sessionで同時実行し、一方のcomplete／timeoutが他方のcontextとscopeを変えない。
4. primary threadからbroadcastしたreceiverのreporterはcontext missingになり、primaryの値を漏らさない。
5. timeout済みthreadのlate terminal signalが次actionまたは次generationをsettleしない。

## 7. custom actionのblock budget

| handler                  | 定型block数 | 内容                                  |
| ------------------------ | ----------- | ------------------------------------- |
| 引数なし、最後まで実行   | 1           | hatだけ。正常thread endを暗黙complete |
| targetを使う             | 2           | hat＋target reporter                  |
| parameterを一つ使う      | 2           | hat＋argument reporter                |
| optional parameterを分岐 | 3           | hat＋has-argument＋argument reporter  |
| 途中で終了               | 2           | hat＋explicit complete                |
| fail／goto               | 2           | hat＋terminal block                   |

演出本体を除く定型overheadは常に8 block以下である。register script、初期化broadcast、action index variable、
Temporary Variables、完了待ちloop、scope releaseは数にも手順にも含めない。

## 8. live reload quiesce

### 8.1 quiesce mode

| mode                 | 意味                                                       | 既定 |
| -------------------- | ---------------------------------------------------------- | ---- |
| `finish-only`        | 現actionを正常terminalまで続け、次action開始前でpauseする  | yes  |
| `cancel-replay-safe` | 現actionをcancelし、同action先頭をresume anchorにしてpause | no   |

`finish-only`は非冪等な外部副作用を重複させない安全側の既定である。`cancel-replay-safe`は、途中までの
presentation／runtime variableを巻き戻さなくても同actionを再実行してよい、というhandler作者の宣言である。
どちらのmodeも既に発生した副作用、presentation、通常runtime variableをrollbackしない。

core actionはJavaScript handler manifestで同じmodeを宣言する。同期actionはそのcommit直後をboundaryとし、
AbortSignalで決定的に停止でき再実行可能なwait、input、pose、managed presentation actionは
`cancel-replay-safe`にできる。外部副作用を持つactionは`finish-only`とする。

### 8.2 candidateからchoice表示まで

```text
candidate source parse／validate成功
  -> dispatch gateを閉じる（以後、新actionを開始しない）
  -> current actionへquiesce modeを適用
  -> thread terminal／cancelとaction scope releaseを待つ
  -> immutable QuiesceTokenでscene／action anchorとvariable snapshotを固定
  -> そのanchorからreload planを作る
  -> 1／2／3 choice UIを表示
```

candidateを検出した直後の可変execution stateから先にreload planを作らない。`currentAction` choiceが参照する
のはQuiesceTokenのanchorである。Tokenはcandidate ID、旧runtime generation、StoryPath、action signature、
scene ID、action index、runtime variable snapshot、resume modeを持つ。

- action実行中でない場合は次にdispatchするactionをanchorにする。
- `finish-only`は現actionのcommit／goto／failを待つ。completeなら次action境界、gotoなら遷移先先頭をanchorにする。
- `cancel-replay-safe`は現actionをcancelし、cleanup後に現action先頭をanchorにする。
- fail／timeoutで旧runtimeがfailedになった場合、candidate choiceを表示せずruntime diagnosticを優先する。
- QuiesceTokenはthread停止とaction scope解放が完了するまで発行しない。

### 8.3 Escと旧snapshot再開

`Esc`はcandidateとQuiesceTokenを破棄し、旧StoryDocument／Registry Snapshotを次の位置から再開する。

| quiesce時点                          | Esc後                                      |
| ------------------------------------ | ------------------------------------------ |
| `finish-only` actionがまだrunning    | dispatch gateを開き、そのactionを継続      |
| `finish-only` action完了後のboundary | 次actionから再開                           |
| `cancel-replay-safe`でcancel済み     | 同action先頭から旧snapshotを再実行         |
| actionなしのboundary                 | Tokenが示す次actionから再開                |
| cleanup失敗で旧runtimeがfaulted      | 再開不可。診断を表示しstoryStartだけを許可 |

Escでexecution positionは変わり得るが、通常runtime variableと既に発生したpresentation／外部副作用は
巻き戻さない。`cancel-replay-safe` handlerはこの条件で再実行可能でなければならない。

### 8.4 timeoutと回復

`cancel-replay-safe`のthread停止とcleanupは起動時固定`quiesceTimeoutMs`（default 5000 ms、100〜30000 ms）
以内に完了しなければならない。超過時は`K4-RELOAD-QUIESCE-TIMEOUT`とし、current scene／action choiceを
無効にする。旧runtimeを安全に再開できる場合はEsc、再開できない場合は明示確認付きstoryStartだけを許可する。

`finish-only`は通常の`customActionTimeoutMs`まで実行を許す。UIは`quiescing`を表示できるが、choiceを先に
表示しない。handler timeout、thread stop失敗、scope cleanup失敗ではそれぞれ原因codeを保持し、黙って
current action anchorを推測しない。

## 9. raceと優先順位

外部eventはruntime sessionのoperation queueで直列化し、次の規則を適用する。

| 競合                                  | 結果                                                         |
| ------------------------------------- | ------------------------------------------------------------ |
| action terminal vs quiesce request    | queueで先に観測したevent。terminal先なら次boundary           |
| `Esc` vs quiesce完了                  | Esc先ならmode別に継続／cleanup後replay、Token先ならToken規則 |
| candidate A vs candidate B            | BがAをstale化。gateを閉じ、同じanchorからB用Tokenを作り直す  |
| runtime stop vs quiesce               | stop優先。candidate／Tokenを破棄し旧runtimeをstoppedにする   |
| action timeout vs quiesce             | timeout優先。旧runtime failed、candidateを破棄               |
| reload commit vs `Esc`                | exclusive commitを先に得た方。commit開始後のEscはstale       |
| reload commit vs runtime stop         | commit前のstopはcandidate破棄、swap後のstopは新runtimeへ適用 |
| old thread late settlement vs new run | generation／invocation ID不一致として無視                    |

commitは新session作成に成功してから旧sessionをstop／disposeする。旧session dispose後に新session startが失敗した
場合はstatusをfailedにし、存在しない旧sessionを復活させない。candidateの`Esc`再開能力をcommit開始後まで保証する
ものではない。

## 10. diagnostic

| code                          | 意味                                     |
| ----------------------------- | ---------------------------------------- |
| `K4-CUSTOM-CONTEXT-MISSING`   | bound primary thread以外からreporter利用 |
| `K4-CUSTOM-ARGUMENT-UNKNOWN`  | 未宣言parameterのreporter利用            |
| `K4-CUSTOM-HANDLER-MISSING`   | snapshotのhatをdispatch時に解決できない  |
| `K4-CUSTOM-HANDLER-AMBIGUOUS` | dispatchが複数primary threadを開始した   |
| `K4-CUSTOM-ALREADY-SETTLED`   | terminal後の追加terminal signal          |
| `K4-CUSTOM-FAILED`            | handlerの明示fail                        |
| `K4-CUSTOM-THREAD-FAILED`     | Scratch thread異常終了                   |
| `K4-CUSTOM-GOTO-001`          | 未知sceneへのgoto                        |
| `K4-CUSTOM-TIMEOUT`           | custom action実行上限                    |
| `K4-CUSTOM-CLEANUP-FAILED`    | thread／action scope cleanup失敗         |
| `K4-RELOAD-QUIESCE-TIMEOUT`   | cancel／cleanupがquiesce上限を超えた     |
| `K4-RELOAD-QUIESCE-FAILED`    | safe boundaryを確定できない              |

診断はAction StoryPathとSource Map位置を持ち、Scratch target ID、hat block ID、opaque reference、台本source、
stack traceを作者向けmessageへ含めない。developer buildだけがredacted source locatorを参照できる。

## 11. test contract

- original targetだけからcanonical snapshotを作り、v1を`finish-only`付きv2へ移行する。
- malformed mutation、limit、duplicate、core collisionでpartial snapshotを返さない。
- primary thread exactly-one、broadcast／clone context非継承、二session分離を検証する。
- normal end、complete、fail、goto、thread error、timeout、stopの状態遷移をmodel-based testする。
- first terminal wins、late settlement無視、action scope exactly-once releaseをproperty testする。
- simple handlerの定型overheadが8 block以下であるfixtureを持つ。
- candidate後に新actionがdispatchされず、scope release後のanchorからplanが作られる。
- finish-only／cancel-replay-safeとEsc resumeを両方検証する。
- candidate replacement、stop、timeout、commit、Escのrace表をfake clockで網羅する。
- cleanup不能と副作用発生済みactionで、scene／action choiceを黙って有効にしない。
- custom action 0件のStandard fixtureがAction Registry blockなしで完走する。

## 12. feature flagとrollback

Action Registry Adapterは`dsl4CustomActionsEnabled`を起動時固定・既定OFFにする。flag OFFではhat scan、
thread observer、ActionContext reporter、custom action block registrationを行わず、empty snapshotを使う。
live reload quiesceのcore action gateは別機能として利用でき、custom action flagへ依存させない。

問題時はflagをOFFにし、handler／quiesce実装PRをrevertする。core actionだけのDSL 4.0作品、Standard
Kamishibai fixture、3.2 runtimeはAction Registryなしで実行できる。
