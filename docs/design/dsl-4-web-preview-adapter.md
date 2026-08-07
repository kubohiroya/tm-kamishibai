# 紙芝居DSL 4.0 Web Preview adapter契約

Copyright © 2026 Hiroya Kubo.

文書状態: Issue #390の実装基準

関連Issue: [#258](https://github.com/kubohiroya/tmpose-kamishibai/issues/258)、
[#262](https://github.com/kubohiroya/tmpose-kamishibai/issues/262)、
[#265](https://github.com/kubohiroya/tmpose-kamishibai/issues/265)、
[#266](https://github.com/kubohiroya/tmpose-kamishibai/issues/266)、
[#390](https://github.com/kubohiroya/tmpose-kamishibai/issues/390)

機械可読な契約:
[`web-preview-adapter-contract.json`](../../test/fixtures/dsl4/web-preview-adapter-contract.json)

## 1. 結論

一般作者向けの既定preview導線は、HTTPSのtop-level pageでproject rootをread-only選択するWeb
Previewとします。初版はChromium系desktop browserをTier 1とし、`FileSystemObserver`には依存せず、
`FileSystemDirectoryHandle`からmanifest指定fileを再取得するpollingを正本とします。

browser adapter、Node watcher、runtimeは別々のlive reloadを実装しません。両adapterは同じsource frontendの
結果をversion 1 preview protocolへ渡し、runtimeはpath、URL、filesystem handle、permission、poll timerを
受け取りません。Web Previewは台本editorでもbuilderでもなく、YAML以外の変更はlocal full rebuildへ案内します。

## 2. 現行実装と前提

2026-08-07時点のrepositoryには次が実装済みです。

- `createDsl4PreviewSourceWatcher`: Node.jsの`fs.watch`と安定読込
- `createDsl4PreviewProtocolSession`: handshake、stage、commit、defer、disconnect
- `createDsl4DevelopmentPreviewShell`: 初回自動開始、診断、reload選択1／2／3
- `validate-dsl4`と`build-dsl4`: local検証とfull rebuild

一方、`preview --watch`相当のCLI commandと`dsl4AppShell` flagはまだ公開されていません。したがって、Web
Preview UIで「CLI live previewを起動するcommand」が利用可能だと表示してはいけません。後続実装は次を満たして
から一般作者向けfallback文言を確定します。

1. local preview hostがNode watcher、共有protocol、共有reload shellを接続する
2. `--help`に実在するcommandと必須limitを表示する
3. unsupported browserのE2Eがそのcommandを含む案内へ到達する

それまでのfallbackは、`validate-dsl4`で台本を検証し、`build-dsl4`でfull rebuildする既存commandを正確に
表示します。Web Previewを既定ONにする条件に、local live preview commandの公開を含めます。

## 3. browser対応表

`showDirectoryPicker()`はsecure contextとuser activationを要求し、広く利用される全browserのBaselineでは
ありません。browser名やversionの推測より、起動時のfeature detectionを正本とします。

| browser／surface                   | 初版tier | 判定                                                                 | fallback                 |
| ---------------------------------- | -------: | -------------------------------------------------------------------- | ------------------------ |
| Chrome desktop 86以降              |        1 | HTTPS、top-level、`showDirectoryPicker`、handle read APIを実行時確認 | Web Preview              |
| Edge desktop 86以降                |        1 | Chromeと同じ実行時確認                                               | Web Preview              |
| ChromeOS上のdesktop Chrome         |        1 | desktop UIと同じfixtureが通る場合だけ                                | Web Preview              |
| Opera等のその他Chromium            |        2 | APIが存在してもrelease gateでは保証しない                            | local preview／build     |
| Brave既定設定                      |        0 | browser flagを一般作者へ要求しない                                   | local preview／build     |
| Firefox desktop                    |        0 | `showDirectoryPicker`非対応                                          | local preview／build     |
| Safari desktop／iOS                |        0 | `showDirectoryPicker`非対応                                          | local preview／build     |
| Android、WebView、埋込みbrowser    |        0 | 初版desktop scope外                                                  | local preview／build     |
| cross-origin iframe内のWeb Preview |        0 | permission UIをiframeへ委譲しない                                    | top-level HTTPSを開く    |
| HTTP（localhost以外）              |        0 | secure contextではない                                               | HTTPSまたはlocal preview |

参考:

- [File System Access specification](https://wicg.github.io/file-system-access/)
- [MDN: `showDirectoryPicker()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)
- [Chrome: File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- [Chrome: File System Observer origin trial](https://developer.chrome.com/blog/file-system-observer)

Tier 1でもprivate browsing、enterprise policy、OS picker制限、permission取消により利用できない場合があります。
adapterはbrowser familyをallowlistにせず、APIの存在、secure context、実際のpicker結果、handle操作結果を順に
判定します。

## 4. project openとpath境界

「プロジェクトを開く」buttonの同期click handlerからだけ次を開始します。

```js
await globalThis.showDirectoryPicker({mode: 'read'});
```

adapterは選択されたroot直下の`project.source.json`だけを最初に読みます。manifestは既存
`validateDsl4ExternalSourceManifest`と同じ契約を使用し、`path`は次をすべて満たす必要があります。

- normalized POSIX relative path
- segmentが空、`.`、`..`のいずれでもない
- absolute path、drive prefix、URL scheme、backslash、NULを含まない
- `.kamishibai.yaml`で終わる

pathは`/`でsegmentへ分割し、選択済みroot handleから`getDirectoryHandle()`と`getFileHandle()`だけで辿ります。
文字列pathをOS pathへ変換せず、root外handle、URL、symlink解決API、任意file pickerへfallbackしません。

manifestのraw上限は32 KiBです。UTF-8をfatal decodeし、JSON objectと既存manifest schemaを検証します。
初版session中にmanifestが変更された場合はadapter設定を暗黙更新せず、project再選択またはlocal full rebuildを
要求します。YAML以外のasset、base SB3、app shell、extension、builder設定、`controlProfile`も読みません。

## 5. pollingと安定読込

固定値は次のとおりです。

| 項目                        |   固定値 | 意味                                                         |
| --------------------------- | -------: | ------------------------------------------------------------ |
| foreground polling interval |   500 ms | 読込完了後に次回をschedule                                   |
| background polling interval | 5,000 ms | hidden pageでも有限間隔で確認するが即時性を保証しない        |
| quiet window                |   100 ms | 変更兆候後、安定読込開始まで待つ                             |
| retry interval              |    50 ms | missing／unstableを再取得する間隔                            |
| stability timeout           | 2,000 ms | 一回のpoll cycleでretryする上限                              |
| stable read count           |        2 | 同じcanonical integrityが連続するまでpublishしない           |
| manifest raw byte limit     | 32,768 B | `project.source.json`の読込上限                              |
| source raw byte limit       | `2N+3` B | canonical source上限`N`に対するCRLF／BOM許容。Nodeと同じ意味 |

各pollは次の順序です。

1. root handleのread permissionを確認する
2. manifest pathをrootから辿り直し、file handleを取得する
3. `getFile()`でsize上限を先に検査し、bounded bytesをfatal UTF-8 decodeする
4. 共有canonicalizerでBOMと改行を正規化し、SHA-256 integrityを計算する
5. quiet window後に2〜4をもう一度行う
6. 二つのcanonical integrityが一致した場合だけ共有source frontendへ渡す
7. frontend結果とimmutable source snapshotを共有preview protocolへstageする
8. cycle完了後にvisibilityに応じた次回timerを一つだけscheduleする

`lastModified`とsizeは読込を省略するhintに使わず、変更採用条件にも使いません。前回publish済みintegrityと同じ
場合はstageしません。外部editorのatomic saveを考慮し、保持したfile handleをpoll間で正本にせず、毎回root
handleから取得します。

poll実行中にtimer、observer、visibility eventが重なった場合は追加poll要求を一つにcoalesceします。二つの
`getFile()` sequenceを同時実行しません。古いreadの完了時にsession generationまたはrequested revisionが
変わっていれば、その結果をparse、stage、診断publishに使用しません。

pageがhiddenになったらwatch statusを`background-throttled`にし、5秒intervalへ切り替えます。browser自身の
timer throttlingにより実時間が5秒を超える可能性をUIへ表示します。visibleへ戻った時は既存timerをcancelし、
即時pollを一回要求します。

`FileSystemObserver`は初版release gateへ含めません。後続flagでfeature detectionしても、通知はpoll要求を
早めるhintに限定し、上の二重読込、integrity採用、診断、revision順序、polling fallbackを変更しません。

## 6. 状態機械

```text
disabled
   │ flags enabled
   v
idle ── user click ──> selecting ── selected ──> loading-manifest
 ^                         │ cancel/deny                 │ invalid
 │                         v                             v
 │                     diagnostic <──────────────── diagnostic
 │                                                        │ retry/reselect
 │ manifest valid                                         │
 v                                                        │
stabilizing ── stable valid/invalid ──> watching-visible <─┘
     │ missing/unstable timeout               │ hidden
     v                                        v
diagnostic <────────────────────── background-throttled

any active state ── stop/reselect/pagehide ──> disposed
```

初回sourceがvalidならprotocolの`storyStart`相当をmodalなしでcommitします。初回missing／invalid時はruntimeを
開始せずwatchを継続します。実行中のinvalid／missing candidateは現在のimmutable snapshotを置換せず、reload
modalも開きません。回復後のvalid candidateは通常どおり選択1／2／3を表示します。

## 7. diagnostic契約

adapter固有diagnosticは既存K4 envelopeを使用し、source text、absolute path、handle名の連結、permission object、
exception messageを作者向けmessageやtelemetryへ含めません。

| code                                   | severity | 意味                                   | 次の操作                          |
| -------------------------------------- | -------- | -------------------------------------- | --------------------------------- |
| `K4-WEB-PREVIEW-UNSUPPORTED`           | error    | 必須APIがない                          | local fallback                    |
| `K4-WEB-PREVIEW-INSECURE-CONTEXT`      | error    | secure contextではない                 | HTTPSまたはlocal fallback         |
| `K4-WEB-PREVIEW-PICKER-CANCELLED`      | warning  | 作者がpickerを閉じた                   | 同じbuttonから再選択              |
| `K4-WEB-PREVIEW-PERMISSION-DENIED`     | error    | 初回read permissionを得られない        | 再選択またはlocal fallback        |
| `K4-WEB-PREVIEW-PERMISSION-REVOKED`    | error    | watch中にpermissionが失効              | 現在実行を継続し、再選択          |
| `K4-WEB-PREVIEW-BACKGROUND-THROTTLED`  | warning  | hiddenで検出latencyを保証できない      | tabをvisibleにする                |
| `K4-WEB-PREVIEW-MANIFEST-MISSING`      | error    | root直下にmanifestがない               | projectを修正または再選択         |
| `K4-WEB-PREVIEW-MANIFEST-READ-001`     | error    | manifestを安全に読めない               | projectを修正またはlocal fallback |
| `K4-WEB-PREVIEW-MANIFEST-JSON-001`     | error    | manifestがUTF-8 JSON objectではない    | manifestを修正                    |
| `K4-SOURCE-MANIFEST-001`               | error    | manifest fieldが契約違反               | manifestを修正                    |
| `K4-SOURCE-PATH-001`                   | error    | source pathが許可境界外                | manifestを修正                    |
| `K4-SOURCE-MISSING`                    | error    | manifest指定YAMLがない                 | 現在実行を継続しwatch             |
| `K4-SOURCE-READ-001`                   | error    | YAML読込に失敗                         | 現在実行を継続しwatch             |
| `K4-SOURCE-FILE-001`                   | error    | sourceがregular fileではない           | manifest／projectを修正           |
| `K4-SOURCE-SIZE-001`                   | error    | source上限超過                         | sourceを縮小                      |
| `K4-SOURCE-UTF8-001`                   | error    | sourceがvalid UTF-8ではない            | encodingを修正                    |
| `K4-PREVIEW-SOURCE-UNSTABLE`           | warning  | timeout内に同じintegrityを二回読めない | 現在実行を継続し次pollでretry     |
| `K4-WEB-PREVIEW-FULL-REBUILD-REQUIRED` | warning  | YAML以外のfingerprintが変化            | local `build-dsl4`                |
| `K4-WEB-PREVIEW-PROTOCOL-001`          | error    | protocol接続／capabilityが不正         | adapterをstopしlocal fallback     |

同じcodeをpollごとに繰り返しannounceしません。状態またはcodeが変化した時だけUIへpublishし、recovery時は
直前diagnosticをclearするstatus eventを一回出します。内部exceptionはcauseとして保持できますが、通常telemetryは
`version, code, severity, sourceId, range, storyPath, path`のallowlistだけを送ります。

## 8. protocol、UI、feature flag

browserとruntimeが同じpageにあっても、直接`liveReloadSession.stage()`を呼ばずversion 1 protocol portを通します。
adapterがstable resultをpublishするたび、session内で単調増加するrevisionを割り当てます。次revisionが受理された
後に古いstage ackが返っても、古いcandidate IDをmodalへ表示しません。

起動時flagは次の依存を持ちます。

```text
dsl4Runtime=true
  └─ dsl4AppShell=true
       └─ dsl4WebPreviewAdapter=true
```

三つとも起動時固定、既定OFFです。依存先がOFFのまま子flagだけをONにした設定は起動前に拒否し、暗黙に親flagを
ONにしません。`dsl4WebPreviewAdapter=false`ではproject open button、feature detection、permission request、
visibility listener、poll timer、observer、browser adapterを初期化しません。

UIは少なくともproject open／reselect button、watch status、safe diagnostic、source表示名、現在／候補integrity、
reload選択1／2／3、local fallbackへの案内を持ちます。source本文、組込みeditor、absolute path、runtime variable、
full diffは表示しません。permission再取得をtimerや自動処理から要求せず、必ず作者のbutton操作へ戻します。

## 9. session memory、cleanup、production除外

初版のdirectory/file handle、manifest bytes、source bytes、timer、observer、pending read、candidate、modal stateは
session memoryだけに保持します。IndexedDB、local/session storage、Cache Storage、service worker、YAML、manifest、
SB3、user config、URL、telemetryへ保存しません。

stop、project再選択、`pagehide`、shell disposeは同じidempotent cleanupへ収束します。

1. session generationを無効化する
2. timerとvisibility listenerを解除する
3. observerがあれば一度だけdisconnectする
4. protocolを一度だけdisconnectしpending candidateをdiscardする
5. pending readの完了を待たずstale扱いにし、結果をpublishしない
6. handle、bytes、candidate、modalへのapplication referenceを破棄する

production SB3、通常のTurboWarp editor読込、Web player、PackagerはWeb Preview moduleをimport、登録、保存しません。
既存production exclusion fixtureへ`browserPreviewHandle`、`browserPreviewTimer`、
`browserPreviewCandidate`、`browserPreviewModalState`を追加して検査します。

## 10. fallback文言と実在command

UIの固定要旨は次です。

> このブラウザではフォルダーの変更を安全に監視できません。HTTPSのdesktop Chrome/Edgeで開くか、local
> toolで台本を検証・再buildしてください。

現時点で案内できる実在commandは次です。`N`やasset limitをUIが推測せず、projectの設定値を表示します。

```bash
pnpm exec tmpose-kamishibai validate-dsl4 \
  --input story.kamishibai.yaml \
  --max-source-bytes N \
  --format pretty

pnpm exec tmpose-kamishibai build-dsl4 \
  --base BASE.sb3 \
  --project-root PROJECT_ROOT \
  --source-manifest PROJECT_ROOT/project.source.json \
  --output OUTPUT.sb3 \
  --control-profile production \
  --channel bundled \
  --max-source-bytes N \
  --max-asset-file-bytes N \
  --max-asset-files N \
  --max-total-asset-bytes N
```

live preview commandが実装されるまでは架空の`preview --watch` commandをcopy buttonへ入れません。browser非対応時も
download、polyfill、`webkitdirectory`へ自動fallbackせず、上の明示経路へ案内します。

## 11. test matrixと測定

後続実装はfake handle／deterministic clockで全caseをunit testし、Tier 1の最新stable ChromeとEdgeで同じfixtureを
E2E実行します。

| case                     | unit | protocol integration | Chromium E2E | 合否条件                                            |
| ------------------------ | ---: | -------------------: | -----------: | --------------------------------------------------- |
| unsupported／insecure    | 必須 |                    - |         必須 | pickerを呼ばずfallback表示                          |
| picker cancel／deny      | 必須 |                    - |         必須 | 機械可読診断、再選択可能                            |
| initial valid            | 必須 |                 必須 |         必須 | modalなしで先頭から開始                             |
| initial invalid          | 必須 |                 必須 |         必須 | runtime未開始、watch継続                            |
| valid reload 1／2／3     | 必須 |                 必須 |         必須 | Node経路と同じstage／commit sequence                |
| invalid candidate        | 必須 |                 必須 |         必須 | current integrity不変、modalなし                    |
| missing／restore         | 必須 |                 必須 |         必須 | 一回診断後にrecovery candidate                      |
| rapid save               | 必須 |                 必須 |         必須 | 最新integrityだけpending／commit                    |
| overlapping poll         | 必須 |                    - |         必須 | 同時read sequenceが最大1                            |
| atomic replace           | 必須 |                 必須 |         必須 | rootからhandleを再取得して変更検出                  |
| partial／unstable read   | 必須 |                 必須 |         必須 | 部分snapshotをstageしない                           |
| background／foreground   | 必須 |                    - |         必須 | status表示、visible復帰時に即時poll                 |
| permission revoke        | 必須 |                 必須 |         必須 | current実行継続、candidate破棄、再選択              |
| stop／reselect／pagehide | 必須 |                 必須 |         必須 | timer、listener、observer、pending resultが残らない |
| flag OFF                 | 必須 |                    - |         必須 | module初期化、picker、timerが0回                    |
| production artifact      | 必須 |                    - |         必須 | handle、timer、candidate、UI persisted fieldが0     |
| YAML外fingerprint変更    | 必須 |                 必須 |         必須 | stageせずfull rebuild案内                           |

latencyは外部editorから10回ずつ通常saveとatomic replaceを行い、save完了からwatch status更新までを測ります。
foregroundは中央値1秒以下、p95 2.5秒以下をrelease gateとします。backgroundはbrowser throttlingの実測値を
Chrome／Edge、OS、version、sample数とともにIssueへ記録しますが、上限保証には使いません。測定値を得る前に
一般作者向け既定ONへ切り替えません。

## 12. rolloutとrollback

実装は次の小粒PRに分けます。

1. pure manifest／adapter portとdeterministic polling fixture
2. File System Access handle adapter
3. shared preview protocol接続
4. `dsl4AppShell`と`dsl4WebPreviewAdapter`を既定OFFでUIへ接続
5. Chromium E2E、測定、作者向け手順、local live preview fallback

rollbackは`dsl4WebPreviewAdapter=false`だけでWeb固有UIとadapterを初期化しない状態へ戻します。共有source
frontend、preview protocol、Node watcher、CLI validate/buildはrevertしません。handleを永続化しないため、
rollbackにIndexedDB migrationやcleanupはありません。DSL 3.1／3.2とproduction artifactを変更しません。
