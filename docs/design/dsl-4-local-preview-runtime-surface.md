# 紙芝居DSL 4.0 local preview runtime surface契約

Copyright © 2026 Hiroya Kubo.

文書状態: Issue #423の段階実装（browser TurboWarp runtime session factory）

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

## 5. TurboWarp stage ownership

browser stage ownerは最大64 MiB（hard maximum 128 MiB）のbase SB3 byte copy、480×360のcanvas、TurboWarp VM、
renderer、audio engine、storage、bitmap adapterを1 preview pageにつき一度だけ所有します。VMはcompatibility mode、
turbo mode、compilerを無効にしてbase projectをloadし、green flagは開始しません。DSL runtime sessionが同じVM
runtimeを使用し、StoryDocumentの初回valid generationを先頭から開始します。

canvasはkeyboard focusを持つ実stageで、primary pointerとkeyboard inputをVM I/Oへ渡します。外部extension URLの
自動loadは拒否し、標準templateが必要とする固定extension登録は注入された`prepareVm`境界だけで行います。base SB3
byte copyはstory／scene reload時のpresentation resetに同じprojectを再loadするためstage lifetimeだけ保持し、disposeで
空byte列へ置換します。公開snapshotにはproject、VM、runtime、asset dataを含めません。

`resetManagedPresentation`は旧runtime sessionの停止／解放後、next environment生成前にだけ呼び、同じVMへ保持済みbase SB3を
再loadします。SB3の再buildやVM／rendererの再生成は行いません。reset中はstage inputをdetachし、完了後に同じcanvasへ
再attachします。重複resetは同じpromiseへ合流し、dispose競合ではinputを再attachせず、reset失敗時はstage全体を
fail-closedで解放します。現在actionからの再開ではfactoryがresetを呼ばないため、managed presentation stateを保持します。

disposeまたはstartup failureではinput listener、VM target、frame loop、bitmap adapter、audio、renderer、storage、canvas
を一度だけ解放します。project load中のdisposeはload完了を待ち、VM frame loopを開始せずcleanupします。このownerへ
渡す実TurboWarp platform adapterは、VM、renderer、audio engine、storage、SVG bitmap adapterを`package.json`のexact
version／commitで固定します。Node-only consumerがDOM libraryを初期化しないようpackage loadはbrowser側で遅延実行し、
stage dispose時はAudioContextをcloseしWebGL contextを明示的に失効させます。

browser bundleはesbuildで単一ES moduleへ生成し、既定24 MiB、hard maximum 48 MiBとします。固定したTurboWarp sourceが
使用するwebpack inline loaderのうち、raw text、font base64、Browserify `brfs`だけを明示変換します。music assetは
data URLとしてbundle内へ保持します。外部extension worker／iframe loaderはbundle時にfail-closed stubへ置換し、
stage ownerのsecurity policyと二重に無効化します。生成物に未解決loader specifierが残らないことを静的testで確認します。

platformとbundle builderはlocal preview clientから直接有効化せず、次のartifact delivery境界からbase SB3とbundleを
受け取ります。固定extension登録とDSL runtime session接続が揃った段階でstage ownerへ注入します。

### 5.1 runtime artifact delivery

Node hostはbase SB3と単一browser runtime bundleを必ず一組で受け取り、入力と共有しないbounded byte copyとして所有します。
base SB3は既定64 MiB／hard maximum 128 MiB、browser bundleは既定24 MiB／hard maximum 48 MiBです。snapshotには
availabilityとbyte lengthだけを出し、実byte、project内容、path、tokenを含めません。

browser bundleはpage bootstrapに必要なため`/runtime/browser.js`から配信しますが、`no-store`、`nosniff`、
`Cross-Origin-Resource-Policy: same-origin`を必須にします。assetを内包するbase SB3は`/api/runtime-project`から、activeな
preview接続のexact Originとbearer tokenを再検証した後だけ配信します。未接続、token／Origin不一致、full rebuild後は
fail-closedにし、source／generation APIのJSON payloadへSB3 byteを混在させません。

artifact pairはhost disposeまたはbase SB3、asset、app shell、extension、builder設定のfull rebuild要求で参照を破棄します。
同じNode processで新しいartifactへ暗黙差し替えせず、新host／browser sessionを要求します。この段階では配信境界だけを
追加し、既存のfake runtime clientとpublic CLIからは有効化しません。

### 5.2 runtime session factory

browser runtime bridgeへ注入するfactoryは、base SB3から一度だけ検証したruntime componentを静的な土台とします。
各generationではNodeのproduction frontendが生成し、wire decoderを通過したimmutable `StoryDocument`だけを差し替え、
runtime artifact、asset bundle、asset byte getterはbase componentと共有します。factoryはsource frontendやYAML textを受け取らず、
browserでsourceを再parseしません。

factoryは起動時固定の`dsl4Runtime` flagが明示的にONの場合だけ作成できます。generationごとに同じbrowser VM runtimeへ
TurboWarp environmentとnavigation sessionを新規作成し、sessionがnavigation、asset、actor、pose、input、SVG text、
expression compositionを一括所有します。作成途中の例外、control profile不整合、通常disposeのいずれでもenvironmentを
一度だけ解放します。

candidateの生成時点では軽量なlazy sessionだけを返し、TurboWarp environmentは確保しません。旧sessionのsafe boundary確認と
commitが完了し、next sessionの`start()`が呼ばれた後にだけreset、environment生成、navigation開始をこの順で行います。
deferされたcandidate、未開始candidateのdispose、reset中のpage closeではplatform compositionを作らず、旧sessionと
camera／asset／input ownerが重複する時間を作りません。

初回、story先頭、scene先頭からの開始では、次sessionの実行前にbrowser stage ownerが提供する
`resetManagedPresentation`を呼びます。現在actionからの再開だけは同じVM target上のmanaged presentationを保持し、resetを
呼びません。factoryはこのcallbackを必須とするため、reset境界を実装していないstageを実runtimeへ誤接続できません。

この段階でもlocal preview clientは従来のfake runtime protocolを使用し、public CLIは未公開です。次段でbase SB3からの
component読込、stage reset、generation stream、runtime bridgeを単一browser bootstrapへ接続します。

### 5.3 base runtime component loader

browserは認証済みendpointから取得したbase SB3の防御的copyをloaderへ渡し、`project.json`だけを展開します。compressed
SB3は既定64 MiB／hard maximum 128 MiB、ZIP entry数は既定4096／hard maximum 16384、展開後`project.json`は
既定48 MiB／hard maximum 96 MiBです。全entryの重複とunsafe pathを検査し、`project.json`の存在、compression method、
UTF-8、JSON object、`targets`配列を検証してからruntime component loaderへ渡します。展開用SB3 copyとJSON byte列は
処理終了時に空にし、projectやarchiveを公開snapshotへ含めません。

base SB3内のembedded sourceは、runtime artifactとasset bundleが同じ固定snapshotに対応することを確認するため、注入された
production frontendでbrowser起動時に一度だけparseします。これはNode watcherが生成した外部source generationとは別の
artifact検証です。generation wireの`StoryDocument`、raw YAML、source pathをbase loaderへ渡さず、reloadごとの再parseは
行いません。base component診断時はpartial componentを返さず、stage／sessionを開始しません。

### 5.4 browser runtime owner

browser runtime ownerはbase component検証の成功後にだけ、visible stage、世代別session factory、generation bridgeをこの順で
一度ずつ起動します。stage canvasを作品keymapの入力targetとし、speech advanceが有効な場合は同じcanvasをstage pointer
targetとしてsession lifetimeへattachします。generation bridgeはwireで検証済みの`StoryDocument`だけをsession factoryへ渡し、
外部`.k4.yml`のraw source、file name、pathを受け取りません。

startup failure、startup中のpage close、通常disposeではgeneration bridge／runtime environmentを先に、TurboWarp VM／stageを
後に解放します。base componentがinvalidな場合はplatformをinspectせず、stage／camera／rendererを確保しません。このownerは
次段で認証済みhost transportと共通reload overlayへ接続するまでpublic CLIから起動しません。

## 6. securityとrollback

wire schema自体は認証を置き換えません。PR #421のliteral loopback bind、exact Origin、one-use token、
project-root confinementを通過したclientだけがgenerationを受け取れます。hostはbounded wireを作成できたgeneration
だけをresponseへ書き、接続切断時は未確定generationを破棄します。

この段階を戻す場合はbrowser platform／bundle builder、直接依存、export、test、本文を同じPR単位でrevertします。既存
host、Web Preview、production SB3、Standard palette、source／artifact formatにmigrationはありません。
