# 紙芝居DSL 4.0 local preview host契約

Copyright © 2026 Hiroya Kubo.

文書状態: Issue #258の段階実装（local host adapter）

関連Issue: [#258](https://github.com/kubohiroya/tmpose-kamishibai/issues/258)、
[#390](https://github.com/kubohiroya/tmpose-kamishibai/issues/390)、
[#394](https://github.com/kubohiroya/tmpose-kamishibai/issues/394)

## 1. 責務

`createDsl4LocalPreviewHost`は、Node.jsのsource watcherとruntime所有のpreview protocol sessionを、
loopback HTTP上のCLI browser pageへ接続するdevelopment-only adapterです。hostは作品runtimeやreload plannerを
再実装しません。呼出側が所有する`createDsl4PreviewProtocolSession`互換sessionへ接続し、browser pageは
`createDsl4CliPreviewShell`とWeb Previewと同じ`createDsl4PreviewReloadSurface`を使います。

```text
external YAML
  -> createDsl4PreviewSourceWatcher
  -> shared source frontend result
  -> createDsl4PreviewSourceProtocolPort
  -> injected runtime protocol session
  -> loopback browser page / shared CLI reload overlay
```

sourceのread、canonicalize、parse、schema／semantic diagnosticは`validate-dsl4`／`build-dsl4`と同じ
source frontendへ委譲します。HTTP responseとbrowser eventにはsource text、絶対path、runtime variable、tokenを
含めず、integrity、有限count、diagnostic envelope、protocol acknowledgementだけを送ります。

新規sourceの推奨suffixは`.k4.yml`です。entrypoint basenameは`.k4.yml`、`.k4.yaml`、`.kamishibai.yml`、
`.kamishibai.yaml`を正式に受理し、`path`省略時の`story.kamishibai.yaml`は後方互換として維持します。

## 2. 接続とsecurity

- bind先はliteral `127.0.0.1`または`::1`だけとし、port `0`はOSによる空きport選択として受理する
- server listen後の実portからexact originを確定し、既存transport policyへ渡す
- 起動ごとに32-byte tokenを一度だけ発行し、CLIが開くURL fragmentでbrowserへ渡す
- clientはtokenをmemoryへ取り込み、`history.replaceState`でfragmentを直ちに消す
- 初回connectはOrigin、loopback remote address、tokenの単回消費をすべて検証する
- 後続POST／NDJSON streamはexact Originとmemory-only bearer sessionを毎回検証する
- HTTP APIはmanifestで認可されたsource watcherだけを操作し、任意path read endpointを持たない
- browser module配信はpackage内の`src/builder/*.js`／`src/dsl4/*.js`へ固定し、path traversalを拒否する
- CSPはsame-origin script／connectだけを許可し、frame埋込みと外部base／formを拒否する

remote bind、remote preview、token再発行、source write、directory listing、telemetryは提供しません。

## 3. reloadと構造変更

初回validはprotocolの既存動作によりmodalなしで先頭から開始します。実行中のvalid変更はprotocol candidateを
共有overlayへ渡し、session既定のaction、scene、storyの順にsafe fallbackして自動commitします。invalid／missing
結果は同じdiagnostic envelopeを表示し、current integrityとruntime sessionを置換しません。manual reloadも、
Web Previewと同じoverlay policyが現在の検証済みgenerationを再stageしてからcommitします。

`project.source.json`は別watcherで監視します。正規化済みmanifestのsource path／source IDが変わるか、manifestが
不正・unreadableになった場合はsource watcherとprotocol candidateを破棄し、current runtimeを維持したまま
`K4-PREVIEW-STRUCTURE-*`を表示します。この状態ではcommitを拒否し、full rebuild後の新host／sessionを要求します。
base SB3、asset bundle、app shell、extension、builder設定、`controlProfile`の分類意味は既存の
`classifyDsl4PreviewChange`を正本とし、公開CLI adapterがそれらの入力を所有する段階で同じnew-session境界へ接続します。

## 4. lifecycle

browser stream close、host crash、明示stopは、watcher停止、protocol disconnect、transport disconnectの順で一度だけ
処理します。protocol disconnectはcandidateを破棄しますが、注入されたruntimeのcurrent executionをdisposeしません。
runtimeの最終disposeはruntime所有者の責務です。host `dispose()`はstream、manifest watcher、source watcher、protocol
port、transport policy、HTTP serverを冪等に解放し、途中失敗時も残りを継続して最後に集約します。
server listen中またはprotocol接続中に`dispose()`された場合も、進行中の初期化を収束させてから同じcleanupへ入り、
disposed hostからsocketやwatcherが後発で再生成されないことを保証します。

SIGINT／SIGTERMのprocess signal接続と、作者向け`preview --watch` commandのargument／help／browser openは次の
CLI adapter差分で追加します。この段階ではREADMEやWeb Preview fallbackへ未公開commandを表示しません。

## 5. rollout、検証、rollback

hostは既存production entryから参照されず、呼出側がdevelopment時に明示生成した場合だけsocket、watcher、DOMを
初期化します。共有overlayの起動時flagは引き続き既定OFFで、local host pageだけが明示ONにします。production SB3、
Standard palette、Web player、Packagerへhost module、token、bridge、candidate、reload UIを格納しません。

unit統合fixtureはinitial valid、invalid保持、recovery、commit、manifest構造変更、Origin拒否、path confinement、
redaction、起動中dispose、冪等cleanupを検証します。Chromium E2Eは実loopback serverからCLI pageを開き、URL
fragment消去、manifest指定のsource basename、共有`data-preview-surface="cli"` overlay、valid auto reload、invalid保持、
recovery、full rebuild表示を確認します。

rollbackは本module、browser client、builder export、test、本文をrevertします。shared watcher、protocol、runtime、
Web Preview、production artifactのformat migrationはありません。
