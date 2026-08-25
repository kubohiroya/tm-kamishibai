# DSL 4.0 navigation／作品内input arbitration

文書状態: Issue #440 PR 3の実装契約（2026-08-07）

## 結論

一つのphysical keyboard／pointer sequenceがcommitできるsemantic consumerは高々一つとする。作品内の
`keyInputToChangeScene`／`touchInputToChangeScene`はactive actionの一部、control profileのkeymapは
navigation sessionの入力であり、`createDsl4InputArbitration`が両者の短いlifetime情報だけを共有する。
raw DOM event、source本文、session historyは保持しない。

## 優先順位とconsume

| 状態                                                | 入力                    | consumer／動作                                                                                      |
| --------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------- |
| interactive element、contenteditable、IME、modifier | key                     | 作品内inputとnavigationのどちらもsemantic消費しない                                                 |
| active `keyInputToChangeScene`のexact候補           | initial keydown         | 作品内inputを優先し、navigation adapterはprevent／stopせずsourceへ渡す                              |
| active input actionの候補ではないkeymap key         | initial keydown         | navigationがprevent／stopしてcommandを一度だけdispatchし、controllerがactive actionを同期cancelする |
| history paused                                      | keymap key              | active actionは既にcancel済みなのでnavigationだけがback／forward／resumeを処理する                  |
| active actor touch待機中                            | pointer sequence        | actor touch候補sourceを優先する                                                                     |
| actor touch成立後の同一release                      | pointerup               | 一度だけprevent／stopし、navigation／speech advanceへ再利用しない                                   |
| pointercancel                                       | pointer sequence        | 保留中のrelease抑止を破棄し、次のgestureへ持ち越さない                                              |
| active pose step                                    | `rehearsal.skipPose`    | `recognition.navigation.allowSkip`が`true`の場合だけ現在stepを終了する                          |
| active pose action／active action                   | `rehearsal.skipAction`  | 現在actionを最終状態へ完了する。poseでは残りstepも実行しない                                        |
| active action／action間／scene内                    | `rehearsal.skipScene`   | 現在sceneの残りを3.2互換のstateful tail規則で終了する                                               |
| active pose sequence                                | `navigation.nextAction` | 既存の`recognition.navigation.allowSkip`と`canAdvance()`を変更せず最終決定とする                |

schema／semantic検証の`K4-KEY-001`は、navigation keymapと作品内key routeの静的衝突を引き続き拒否する。
runtime arbitrationのexact候補優先は、injected portや境界の防御としても同じ単一consumer規則を維持する。
mapped keyのrepeatは新しいcommandをdispatchしない。初回navigation後のbrowser default抑止という既存動作は
維持する。

3.2互換commandは停止中と対応する実行文脈がないときにDOM eventを消費しない。Space、→、↓のうち最初に
受理した一入力だけをownerとし、そのactionのAbort cleanupと次の実行境界への到達が完了するまで、他の
リハーサル入力は受理しない。

## cancellationとownership

- async input action portは待機開始前に候補種別と件数をarbiterへ登録し、resolve／reject／Abortのすべてで
  tokenを終了する。候補文字列はprotocol、diagnostic、production stateへ出さない。
- navigationが勝った場合、runtime controllerの`advance()`／`reposition()`が現在の`AbortSignal`を同期abortし、
  generationとrun IDを更新する。旧waitの遅延完了はcommitできない。
- history移動はactive actionをcancelしてpaused境界を作る。resume keyだけが選択位置から新しいactionを開始する。
- navigation sessionのdisposeでDOM listenerを先に外し、runtime environmentのdisposeでarbiterを破棄してから
  Async Input compositionをreleaseする。途中のcleanup失敗でも残りのowner解放を続ける。

## rollback

この変更をrevertすると、既存のkeymap adapterとAsync Input action portの独立経路へ戻る。追加feature flagや
永続formatはなく、SB3、source descriptor、preview stateのmigrationは不要である。
