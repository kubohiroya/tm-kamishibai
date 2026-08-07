# 紙芝居DSL 4.0 local preview runtime surface契約

Copyright © 2026 Hiroya Kubo.

文書状態: Issue #423の段階実装（source generation wire）

関連Issue: [#258](https://github.com/kubohiroya/tmpose-kamishibai/issues/258)、
[#423](https://github.com/kubohiroya/tmpose-kamishibai/issues/423)

## 1. runtime所有境界

local preview browser pageで作品を実際に表示するruntimeはbrowser側で所有します。camera、DOM、renderer、
TurboWarp target、audio contextを必要とするため、Node内のheadless VMを作者previewの正本にはしません。Node側は
loopback server、project root内のsource read／watch、production source frontend、認証済みtransportを所有します。

公開CLI argument、signal、browser openは、browser runtime surfaceが初回sourceを実行できる段階まで公開しません。
reload statusだけを表示して作品を実行しないcommandを`preview`として提供しないためです。

## 2. source generation wire

NodeはYAMLをproduction source frontendで一度だけparseし、browserへはversion付き
`preview.source.generation`を送ります。valid generationは検証済みimmutable `StoryDocument`、diagnostic、
`sourceId`、canonical source byte length、SHA-256 SRIを持ちます。invalid／missing generationはdiagnosticだけを
持ち、以前の`StoryDocument`を再送しません。

wireへraw／canonical YAML、source filename、絶対path、URL、tokenを含めません。`StoryDocument`内の台詞、宣言、
project-relative asset referenceは作品実行に必要なcompiled IRとして認証済みloopback接続内だけで送ります。
browserはYAMLを再parseせず、このIRをruntime-owned live reload sessionへstageします。

messageはUTF-8 JSONで、既定4 MiB、hard maximum 16 MiBです。revisionは1から単調増加し、diagnosticはsource
frontendと同じ最大100件です。decoderはUTF-8、JSON、exact top-level schema、revision、SRI、diagnostic envelope、
StoryDocument versionを再検証し、未知field、超過message、raw source fieldをfail-closedで拒否します。

## 3. loopback stream接続

local preview hostは検証済みgenerationを、PR #421と同じ認証済みNDJSON event streamの
`local-preview.generation` recordとしてbrowserへ送ります。初回connect responseにも最新generationを含め、connect
完了直前の更新を失いません。通常eventは最大64件を保持しますが、最大4 MiBのgenerationは最新1件だけを別枠で
保持し、rapid saveでhost memoryが累積しないようにします。

generationは安全な`onEvent` observerへ渡しません。observerは従来どおりintegrity、有限count、diagnostic、protocol
acknowledgementだけを受け取ります。作品IRはOrigin／bearer検証を通過したHTTP clientだけに送ります。browser
disconnect、full rebuild要求、host disposeではlatest generation参照を解放し、新規接続はsourceを安定読込して
新しいgenerationを作成します。

## 4. browser runtime ownership

browser側のruntime bridgeは`local-preview.generation` recordをbounded decoderで再検証し、wire revisionの連続性と
stream sequenceの単調増加を確認してから、browser所有のlive reload sessionへstageします。bridgeがsourceをparse
し直すことはなく、runtime session factoryへ渡す正本はNodeのproduction frontendが生成したimmutable
`StoryDocument`です。

初回invalid generationではruntimeを作らず、最初のvalid generationで先頭から開始します。以後のvalid generationは
browser内の共有preview protocolでcandidate化し、commit／defer／manual restartを処理します。invalid generationは
現在のruntimeを維持し、manual restart用の最新valid generationを置換しません。bridgeの公開snapshotとobserverには
StoryDocumentを含めません。disposeはprotocol接続を切断した後、current runtime sessionを一度だけ停止・解放します。

このbridgeはtransportとUIを所有せず、具体的なTurboWarp VM／renderer session factoryを次段から注入します。実VMが
接続されるまでlocal preview clientおよび公開CLIから有効化しません。

## 5. securityとrollback

wire schema自体は認証を置き換えません。PR #421のliteral loopback bind、exact Origin、one-use token、
project-root confinementを通過したclientだけがgenerationを受け取れます。hostはbounded wireを作成できたgeneration
だけをresponseへ書き、接続切断時は未確定generationを破棄します。

この段階を戻す場合はwire module、export、test、本文をrevertします。既存host、Web Preview、production SB3、
Standard palette、source／artifact formatにmigrationはありません。
