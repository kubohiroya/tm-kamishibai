# DSL 4.0 root binary／Packager契約

この文書は、DSL embedded assetをSB3とTurboWarp Packager成果物へ格納し、実行時へ渡す境界を規定します。
Scratch project asset、remote assetの永続cache、実行sessionだけのembedded backingを同じstorageとして扱いません。

## 1. 用語と所有境界

| 用語                    | 所有者                    | 内容                                                                                     |
| ----------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| Scratch project asset   | Scratch VM／storage       | `targets[].costumes`と`targets[].sounds`から参照される通常asset。Stage costumeはbackdrop |
| DSL embedded asset      | Kamishibai Runtime        | `k4.yml assets`のfileから作るimage、sound、poseModel等                                   |
| root binary entry       | builder／SB3 entry source | SB3 rootの`k4asset-v1-<sha256-hex>`                                                      |
| persistent remote cache | Asset Manager             | 検証済みremote assetを次回起動でも再利用するstory単位cache                               |
| session backing store   | Asset Manager             | 現在の実行sessionだけでembedded bytesを保持する一時store                                 |
| materialized resource   | renderer／Audio／TMPose   | skin、AudioBuffer、classifier、PoseNet等                                                 |

Kamishibai RuntimeがTMPoseへ渡す公開入力は従来どおり
`files: [{path, bytes}]`です。SB3 entry名、ZIP reader、Packager object、IndexedDB keyをTMPose、
Teachable Machine、TensorFlow.jsへ公開しません。

## 2. descriptor format

新形式は`formatVersion: 3`です。`project.json`のcomponent storageにはdescriptorだけを保存し、
binary本文、Base64本文、data URL、absolute pathを保存しません。

```json
{
  "formatVersion": 3,
  "manifest": {"formatVersion": 1, "assets": []},
  "files": [
    {
      "assetId": "RescuePose",
      "path": "model.json",
      "size": 1234,
      "integrity": "sha256-...",
      "contentType": "application/json",
      "entry": "k4asset-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ],
  "integrity": "sha256-..."
}
```

`entry`はSHA-256 SRIをhexへ変換した`k4asset-v1-<64 lowercase hex>`と完全一致しなければなりません。
slash、backslash、URL、logical filename、dot segmentは入りません。同じbytesはasset IDやlogical pathが異なっても
同じentryへdeduplicateします。descriptor integrityは`formatVersion`、manifest、全file bindingのcanonical JSONを
対象にします。

`contentType`はlowercaseかつparameterなしとし、logical pathの拡張子から決定的に求めます。対応するimage、audio、
JSON以外は`application/octet-stream`です。この値をZIP entry名の決定には使いません。

旧nested形式は`formatVersion: 2`と`kamishibai/assets/v1/<sha256-hex>`の組合せとしてだけ読み取ります。
v2をv3へ読み替えたり、nested entryのbasenameをroot entryとして推測したりしません。新writerはv3だけを生成します。

## 3. builderとロールバック

`dsl4RootBinaryEntryPackaging`はbuild開始時に一度解決する既定OFFのflagです。
CLIでは`build-dsl4 --enable-root-binary-entries`がONにします。

- OFF: 既存のBase64 descriptorを生成する
- ON: v3 descriptorとroot binary entryを生成する
- 同じ入力、flag、上限から2回生成したSB3はbyte-identicalである
- root-entryだけを持つ既存成果物をruntime flagだけでBase64へ変換しない

TurboWarpエディターへSB3を直接読み込むsurfaceはv3の対象外です。エディターのVMは`project.json`を読み込んだ後に
元のZIP entry sourceをKamishibai拡張へ公開しないため、直接実行用SB3はflagをOFFにしてBase64 descriptorを生成します。
v3成果物は本書の正式Packager adapterまたはbinary entry providerを注入する対応surfaceだけで実行します。

ロールバックはflagをOFFにしてSB3／Packager成果物を再build・再配布します。DSL 3.1／3.2とScratch project assetの
writerは変更しません。SB3は引き続きsb3-toolchainを正式な組立経路とし、ZIPの手作業更新を導入しません。

## 4. sbdl正規化契約

対応基準は`@turbowarp/sbdl` **7.0.0**、npm `gitHead`
`56e841ccbdc4f8902c11b53c85299a4988c213e2`です。devDependencyとlockfileをexact versionで固定します。

sbdlはnested fileをbasenameでSB3 rootへ移し、directory entryを削除します。root binary entryは入力時点からrootにあるため、
正規化後もentry名とbytesが変わりません。回帰testはnested fixtureを併置してsbdlの再ZIPを必ず発生させ、v3 descriptor参照と
全root entry bytesの一致を検証します。v2 nested entryをこの正規化に依存してv3として扱うことは禁止します。

Packager側の対応基準は`@turbowarp/packager` **3.13.0**、upstream commit
`ca5decb80e8870160425e84f0b6c575879bc6dd0`です。npm packageとlockfileをexact versionで固定し、version不一致は
成果物生成前に`K4-PACKAGER-COMPATIBILITY-001`で拒否します。

## 5. archive readerのsecurity契約

readerの呼出側は次の有限上限をすべて指定します。

- 圧縮済みarchive byte数、archive entry数
- 1 entryとarchive全体の展開後byte数
- asset file数、1 asset file byte数、asset file合計byte数
- 圧縮比

readerは中央directory走査時にunsafe path、duplicate entry、未対応圧縮、圧縮比、size、missing／extra reserved entryを
拒否し、要求されたassetだけを展開します。展開後sizeとSHA-256をruntimeへ渡す前に再検証します。collision、descriptorの
logical path／size／integrity／Content-Type／entry不一致はfail closedです。診断にはbinary、Base64、model本文、absolute pathを
含めません。

## 6. Packager bridge契約

Plain HTMLでは、Base85から戻した正規化済みSB3をPackagerがZIP展開した直後、`project.json`を
`scaffolding.loadProject()`へ渡す前にKamishibai entry sourceを登録します。`PROJECT_LOADED`後にZIP objectを解放する前に、
次のどちらかを確立しなければなりません。

1. session backingへの全entry commitとread-back検証が完了した
2. 起動時に選んだdirect entry sourceが、実行中に必要なentryを取得できる

非公開objectへの場当たり的なmonkey patchは製品契約にしません。固定Packager versionの生成templateまたは正式adapterを使い、
Plain HTML、通常ZIP、`zip-one-asset`、Electronを別surfaceとして検証します。通常ZIP／Electronのようにentryを個別取得できる
surfaceはdirect sourceを選択でき、IndexedDBを必須にしません。

正式adapterは`packageDsl4WithTurboWarpPackager()`です。入力は、sbdlが返した`type: sb3`の正規化済みproject、検証済み
StoryDocument／v3 descriptor、全archive／asset上限、Packager package metadataです。adapterは次の順序を固定します。

1. 正規化済みSB3の中央directoryをentry非展開で走査し、unsafe path、duplicate、missing／extra reserved entry、size、圧縮方式、
   圧縮比、全上限を検査する
2. asset本文を含まないarchive集計値とroot entry metadataだけを、Packagerの公開`options.custom.js`へ追加する
3. Packager 3.13.0の生成結果を、固定template文字列がちょうど1箇所にある場合だけ接続する
4. Plain HTML／`zip-one-asset`では`JSZip.loadAsync(data)`の直後に同じZIP closureを登録し、その後で
   `project.json`を取得して`scaffolding.loadProject()`へ渡す
5. 通常ZIP／Electronでは、Packagerが出力した`assets/k4asset-v1-...`を個別fetchするdirect sourceを登録する

実行時の`JSZip.loadAsync`、storage helper、VM、scaffolding methodは差し替えません。templateが変化した場合は推測して続行せず
`K4-PACKAGER-TEMPLATE-001`でbuildを失敗させます。`zip-one-asset`で再構築するのはPackagerの外側の配布ZIPだけであり、
内側の`project.zip`／SB3は変更しません。SB3を構成・更新する正式経路は引き続きsb3-toolchainだけです。

登録先は`Symbol.for('@kubohiroya/tmpose-kamishibai/dsl4-packager-entry-source/v1')`で識別するsingle-use registryです。
Kamishibai側は`claimDsl4PackagerEntrySource()`で一度だけsourceを取得し、
`createDsl4BinaryEntryProviderFromPackagerSource()`でdescriptor、archive集計、entry metadata、展開後size、SHA-256を再検証します。
claim時にglobal slotを削除し、providerの明示releaseまでZIP closureを保持します。現在の30日persistent backingへは接続せず、
後続のsession／direct policyが所有権を引き継ぎます。

作者用の最小接続は次の形です。`runtimeComponent`はroot-entry flagをONにしたDSL 4 builder結果です。

```js
const packager = new TurboWarpPackager.Packager();
packager.project = await TurboWarpPackager.loadProject(runtimeComponent.bytes);
packager.options.target = 'html';

const result = await packageDsl4WithTurboWarpPackager({
  packager,
  packagerPackage: installedPackagerPackage,
  storyDocument: runtimeComponent.runtimeComponent.storyDocument,
  descriptor: runtimeComponent.runtimeComponent.assetBundle,
  limits: {
    maxArchiveBytes,
    maxArchiveEntries,
    maxArchiveEntryBytes,
    maxArchiveExpandedBytes,
    maxAssetFiles,
    maxAssetFileBytes,
    maxAssetBytes,
    maxCompressionRatio,
  },
});
```

## 7. session backing policy

`dsl4SessionBinaryBacking`も起動時固定・既定OFFです。OFFは`policy: disabled`相当のdirect sourceを使用します。
ON時の既定は`prefer`で、`required`と`disabled`を明示できます。選択したmodeを物語の実行途中で変更しません。

runtime hostでは次の起動時optionを使用します。`sessionId`を省略した場合は起動ごとに新しいIDを生成します。
`storeOptions`はAsset Manager 0.11.0のsession専用storeへだけ渡し、persistent remote cacheや既存の
`binaryBundleStore`には渡しません。

```js
await createDsl4TurboWarpRuntimeHost({
  featureFlags: {
    dsl4Runtime: true,
    dsl4SessionBinaryBacking: true,
  },
  assetBundleFormat: 'binary-entry',
  binaryEntryProvider,
  sessionBacking: {
    policy: 'prefer',
    // sessionId: crypto.randomUUID(),
    storeOptions: {
      maxSessionBytes: 512 * 1024 * 1024,
    },
  },
  onSessionBackingWarning(warning) {
    showNonFatalStorageWarning(warning);
  },
  onSessionBackingFatalError(error) {
    showFatalStorageDiagnostic(error);
  },
});
```

flagがOFFのとき、`sessionBacking.policy`の省略または明示した`disabled`だけを許可します。
`prefer`または`required`はflagをONにしなければ起動前に拒否します。旧Kamishibai接続optionの
`binaryBundleStoreOptions`は使用できません。

| policy     | 起動前のsession store失敗                                                       | 起動後のstore読込失敗                          |
| ---------- | ------------------------------------------------------------------------------- | ---------------------------------------------- |
| `prefer`   | partial sessionだけをcleanupし、未解放の同じsourceからdirect modeを選択して警告 | 安全停止。再抽出、再書込み、direct切替をしない |
| `required` | 原因別errorで物語を開始しない                                                   | 安全停止。再抽出、再書込み、direct切替をしない |
| `disabled` | IndexedDBを開かずdirect sourceを固定                                            | direct source failureとして安全停止            |

ZIP破損、hash不一致、descriptor不整合はstorage availability failureではないため、どのpolicyでもfallbackしません。
session recordは共有versioned database内で起動ごとのsession IDを複合keyへ含め、cross-session hitを禁止します。
一件ずつcommitし、全entryのcommitとmetadata／size／integrityのread-back成功後だけ元SB3 snapshotへのapplication referenceを
解放します。

正常disposeは当該sessionのrecordだけを削除します。crash orphanは短いTTL、heartbeat、active lease、versioned prefixで
bounded cleanupし、別tabのactive sessionを削除しません。remote persistent cacheのdatabase、TTL、LRU、lease、clearは
変更しません。

## 8. 診断と復旧案内

| failure分類                          | runtime動作                                          | 表示する復旧案内                                              |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------- |
| IndexedDB unavailable／abort         | `prefer`は起動前だけdirect警告、`required`は起動失敗 | browser設定を確認。必要ならdirect modeまたは通常ZIP／Electron |
| blocked／version change              | 起動失敗または安全停止                               | 他tabを閉じて再読み込み                                       |
| quota                                | 起動失敗または安全停止                               | site data整理、direct mode、通常ZIP／Electron、asset削減      |
| session record missing／corrupt      | 安全停止                                             | session backingを破棄してアプリを再読み込み                   |
| source size／integrity不一致         | fail closed                                          | 正本assetからSB3を再build                                     |
| image／Audio／TMPose materialize失敗 | storage errorと区別して安全停止                      | 対象asset形式と実行環境を確認                                 |

診断は安定したcode、asset label、failure分類を持ちます。binary本文や機密になり得るsource pathは表示しません。

Packager実行時は警告をScratch stage内の非modal表示として出し、物語を続行します。確立後のfatal failureは
既存のruntime error表示へ渡して物語を安全停止します。どちらの表示にもbinary本文、Base64、model内容、
absolute pathを含めません。

## 9. 実Packager／offline smoke

浦島太郎の正本台本とassetは、隣接する`tmpose-kamishibai-samples/stories/urashima`を使用します。
smokeは次の正式経路だけで一時成果物を作成します。

1. `scripts/sb3/build.mjs`でDSL 4 release sourceから基礎SB3を作る
2. sb3-toolchainで基礎SB3を展開し、`project-assets-dsl4.yml`を適用して決定的に再構築する
3. `build-dsl4 --enable-root-binary-entries`で正本`urashima.k4.yml`と全assetを埋め込む
4. 固定したTurboWarp Packager adapterで各surfaceを生成する

手作業でSB3 ZIPを更新する経路は含みません。実行例は次のとおりです。

```sh
pnpm smoke:dsl4-packager-binary-memory -- \
  --output-directory /tmp/dsl4-packager-smoke \
  --target html \
  --target zip \
  --target zip-one-asset \
  --measure-browser

pnpm smoke:dsl4-packager-binary-memory -- \
  --output-directory /tmp/dsl4-packager-electron \
  --target electron-linux64
```

samples repositoryが隣接していない場合は`--samples-root /absolute/path/to/tmpose-kamishibai-samples`を指定します。
`--measure-browser`はChrome／Chromiumを使用し、必要なら`CHROME_BIN`で実行ファイルを指定します。ローカルorigin以外の
名前解決をloopbackへ固定し、観測したrequest URLにも外部originがないことを検証します。

各成果物について、54件のroot binary entryと55件のlogical file（3 poseModel、合計9 model file）の
entry名、size、SHA-256、bytesを検証します。ブラウザ計測は次を確認します。

- Plain HTMLの`prefer`がsession backingを確立し、元providerを解放する
- IndexedDBを利用不能にしたPlain HTMLが同じ未解放sourceからdirectへfallbackし、警告を表示する
- 通常ZIPがIndexedDBを開かずdirect sourceを使用する
- タイトルを閉じて最初の`pose`待機まで進み、「ポーズ認識」「チャージ」を表示する
- poseModelの登録／active数が場面に必要な範囲へ留まり、外部network requestを発生させない

2026-08-11、Chrome 151、samples commit `c2497f301423a1196131041c4e80bafd7c623ce8`での浦島太郎計測値は
次のとおりです。byte値は`performance.memory.usedJSHeapSize`で、GC後値は明示的GC直後を記録しています。

| surface／mode                         | startup peak | title GC後 | 最初のpose GC後 | provider保持 | pose model registered／active |
| ------------------------------------ | -----------: | ---------: | --------------: | ------------ | ----------------------------- |
| Plain HTML／session                  | 229,921,692  | 70,195,311 | 102,925,929     | なし         | 1／1                          |
| Plain HTML／direct fallback          | 187,301,476  | 110,556,719 | 143,397,300     | あり         | 1／1                          |
| 通常ZIP／direct                      | 113,924,786  | 69,708,627 | 102,559,028     | あり         | 1／1                          |

Plain HTMLは起動時にSB3全体をBase85 decode／ZIP展開するため、一時peakを避けられません。大容量assetでは、
起動時peakと元archive保持を抑えられる通常ZIPまたはElectronを推奨します。`report.json`には成果物hash、起動時間、
全計測値、外部request、使用Chromeを機械可読形式で保存します。
