# 物語の有限反復と条件分岐（Issue #980）

状態: 設計と純粋な静的展開modelを実装。frontend／runtime／blocksへの接続は後続PR。公開rc.43では使用できません。
この文書を初期版の意味の正本とし、未実装の機能を既存の4.0作品へ自動適用しません。

## 目的と既存機能

説話の三段反復など、共通の展開を一度書き、人物・選択・結果の違いを各行で指定できるようにします。
台本は静的に読み取る構造ですが、条件は再生時に判定できます。既存のvariables、branch、gotoと
同じruntimeが所有し、Scratch制御ブロックを読み取り時に実行しません。
Actor.loopは衣装アニメーション、useSectionは編集時の採否であり、物語の反復・条件とは別です。

## 対応版と導入

新構文は`kamishibai: '4.1'`で明示します。4.0のSchemaと意味は維持します。
`dsl4NarrativeControl`は起動時固定・既定OFFで、flag OFFの4.1は起動前に拒否します。
flagの正本はsrc/dsl4/feature-flags.ts、builderの伝達はsrc/builder/dsl4-build-feature-flags.tsです。
新しい独立設定ファイルは追加しません。npm・Release・配布SB3更新はこの実装作業の対象外です。

## 構文

- `if: {condition, then, else?}`: conditionはboolean、既存の条件式文字列、または型付きref。
  thenとelseは命令列で、else省略は空列です。到達時に一度だけ条件を評価し、片側を再生して合流します。
- `repeat: {times, as?, do}`: timesは0以上の整数、asは任意の回次スコープ名です。
  回次refは`{ref: '回次.index'}`（0始まり）と`{ref: '回次.number'}`（1始まり）です。
- `forEach: {as, items, do}`: itemsは記述順の固定行一覧です。各行は同じ列名・型を持ち、値はstring、
  finite number、booleanに限ります。空一覧は0回、各行の空mappingも許可します。
- `{ref: 'スコープ.列名'}`は値そのものを置き換えます。文字列内の暗黙補間はしません。
  scopeと列名はDSL ID規則に従い、最も近い字句スコープを参照します。外側の異名scopeも参照できます。
  動的なproperty traversalやScratch reporterを評価する構文ではありません。

```yaml
kamishibai: '4.1'
actors:
  Narrator: NarratorIdle
assets:
  NarratorIdle: costume
scenes:
  三人の訪問:
    - forEach:
        as: 訪問
        items:
          - {人物: 長兄, 親切にする: false}
          - {人物: 次兄, 親切にする: false}
          - {人物: 末弟, 親切にする: true}
        do:
          - Narrator.say: {text: {ref: 訪問.人物}, seconds: 2}
          - if:
              condition: {ref: 訪問.親切にする}
              then:
                - Narrator.say: {text: 贈り物を授かりました。, seconds: 2}
              else:
                - Narrator.say: {text: 何も得られませんでした。, seconds: 2}
```

例の素材は実際の作品で実在する衣装へ解決します。これは未配布構文の説明であり、公開SB3用の台本ではありません。
値参照の語彙は#770の本文埋込みと共通化し、初期版の固定行参照からruntime変数の自由補間へ拡張しません。

## 静的検証と上限

構造、全分岐、全行、未実行の本体も検証し、0回や空一覧を使って不正な台本を隠せません。
未知key、未知ref、型の違う行、非整数／負数の回数、入力の循環・危険なmapping keyを拒否します。
回数と行数は各1024、制御構造の入れ子は16を上限とします。hostは上限を引き下げられます。
展開前に必要命令数を見積もり、既存のmaxActionsPerScene／maxTotalActions以下だけを受理します。
ifの両側と内部判定境界も上限に含めます。巨大な展開配列を確保してから検査しません。

固定反復は事前展開します。未選択側も型・参照・アセット・式を検証しますが、副作用は起こしません。
条件文字列には既存Runtime Expressionの検証と実行・上限を使います。評価器を二重実装しません。
0回の本体は検証用に一度だけ型解決し、実行IRには追加しません。空itemsで参照列の型が分からない場合は
列参照を診断し、空itemsだからと未知参照を黙認しません。

## 実行位置・履歴・中断

if条件はその構造へ到達した時だけ評価します。内側が未選択なら内側の条件も評価しません。
false側の命令はdispatchせず、アセット実体化、動画／音声再生、入力待ちも開始しません。
内部の分岐境界を別sceneに見せず、既存scene順・scene末尾の暗黙遷移・scene履歴を維持します。

展開後actionは元のsource位置・ブロック・入れ子・反復回次へ対応させます。stableIdは各展開位置へ
決定的に修飾し、元のIDも診断用に保持します。現在位置はscene、元命令位置、回次、選択側を識別します。
履歴から分岐内部へ戻るときはその位置の選択側・回次を復元します。作品変数は巻き戻しません。
進め直して新たに条件境界へ到達した場合は現在の変数で再評価し、既存のfuture破棄規則へ従います。

goto、branch、入力による別scene移動は、その命令列と残りの反復を終了します。暗黙returnはありません。
stop、skip、scene移動、reloadは既存のaction scope・generation・signal・cleanupを使用します。
未選択命令のために新しいresource ownerや永続timerを作りません。

## 台本ブロック

専用ifは2囲み、repeat／forEachは1囲みを持ちます。表示名は「もし〜ならば／でなければ」、
「〜回くりかえす」、「一覧を順番に、それぞれについて」です。条件・一覧は型付きフォームで編集でき、
各回の値を参照する専用入力を用意します。既存のSchema editor APIと同じ登録・解除を使います。
編集情報は現在のblock graphから読むため、元YAMLのcacheへfallbackしません。
生成・読取・exportで入れ子と順序を保ち、4.1のhat versionも保持します。

標準Scratch制御の互換読取、forever、while、再帰、動的回数・動的一覧、共通エピソード呼出しは初期版に含めません。
標準制御の混入は現在の診断を維持し、ブロック日本語名・Stage/Sprite名・移動と強調表示へ接続します。

## 検証・関連文書・切戻し

Schema／frontend→runtime→block codec→surfaceの順に小粒PRで進め、各PRで対応文書を更新します。
三段反復、入れ子、空列、非選択側の不正、上限、巻き戻し、途中goto、入力cancel、reloadを受け入れfixtureにします。
公開Editor・SB3・Web Playerと同じ共通runtimeを使う統合fixtureで比較し、公開済み版へ機能があるとは扱いません。

- surface／design: 構文と既存branch／gotoの関係、実装状況。
- structured-block-script: 専用ブロック、フォーム、4.1相互変換。
- expression-limits-diagnostics／feature-flag-inventory: 制限、診断、flagの正本。
- processing-architecture: 展開、source位置、履歴／reload／cleanup。
- README／移行、Docs、Samples: 未配布であることと同じ例、対応版の区別。

切戻しはflag OFFと旧台本・旧SB3への復帰を同時に行います。4.1台本は旧runtimeで実行できません。
実装PRをrevertしても既存4.0作品が動くことを確認します。公開物を同じ版のまま差し替えません。

## 実装記録

静的modelは`src/dsl4/narrative-control.ts`に分離します。入力を変更せず、事前の命令数見積り、
両分岐と0回の検証用命令、型付き行参照、回次・元位置・guard情報を返します。通常命令のSchema／semantic検証と
式評価は既存frontend／runtimeへ接続する次段階の責務であり、model単独で台本を実行しません。
