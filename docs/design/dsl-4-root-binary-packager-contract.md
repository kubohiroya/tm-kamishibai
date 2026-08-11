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

ロールバックはflagをOFFにしてSB3／Packager成果物を再build・再配布します。DSL 3.1／3.2とScratch project assetの
writerは変更しません。SB3は引き続きsb3-toolchainを正式な組立経路とし、ZIPの手作業更新を導入しません。

## 4. sbdl正規化契約

対応基準は`@turbowarp/sbdl` **7.0.0**、npm `gitHead`
`56e841ccbdc4f8902c11b53c85299a4988c213e2`です。devDependencyとlockfileをexact versionで固定します。

sbdlはnested fileをbasenameでSB3 rootへ移し、directory entryを削除します。root binary entryは入力時点からrootにあるため、
正規化後もentry名とbytesが変わりません。回帰testはnested fixtureを併置してsbdlの再ZIPを必ず発生させ、v3 descriptor参照と
全root entry bytesの一致を検証します。v2 nested entryをこの正規化に依存してv3として扱うことは禁止します。

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

## 7. session backing policy

`dsl4SessionBinaryBacking`も起動時固定・既定OFFです。OFFは`policy: disabled`相当のdirect sourceを使用します。
ON時の既定は`prefer`で、`required`と`disabled`を明示できます。選択したmodeを物語の実行途中で変更しません。

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
