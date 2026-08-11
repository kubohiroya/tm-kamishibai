# 紙芝居DSL 4.0 Web Preview 作者向け手順

Copyright © 2026 Hiroya Kubo.

文書状態: Issue #390／#394実装済み（起動時flagは既定OFF）

## 1. 利用条件

Web Previewは開発用App Shellの機能です。production SB3、通常のTurboWarp editor、Web player、Packagerには
登録または保存しません。現在の非blocking auto reload UXを使うhostは、起動時に次の四つをすべて明示的に
ONにします。

```js
const featureFlags = {
  dsl4Runtime: true,
  dsl4AppShell: true,
  dsl4WebPreviewAdapter: true,
  dsl4PreviewReloadOverlay: true,
};
```

`dsl4PreviewReloadOverlay`はWeb／CLI browser preview共通のflagで、`dsl4WebPreviewAdapter`の子ではありません。
ただしWeb Previewで本手順のUXを使う場合は両方をONにします。依存する親flagがOFFのまま子flagだけをONにすると
起動前に設定errorになります。一般作者向けの既定値はすべてOFFです。HTTPSまたはlocalhostのtop-level desktop
Chromiumで、`showDirectoryPicker()`とread handle APIが利用できる必要があります。

## 2. project layout

最小projectは次の構成です。

```text
project-root/
├── project.source.json
└── story.kamishibai.yaml
```

`project.source.json`は次のread-only source契約を持ちます。

```json
{
  "formatVersion": 1,
  "mode": "external",
  "sourceId": "main"
}
```

`path`を省略すると後方互換のため`story.kamishibai.yaml`を使用します。新規sourceでは`.k4.yml`を推奨します。
別名を指定する場合はproject root直下で、`.k4.yml`、`.k4.yaml`、`.kamishibai.yml`、`.kamishibai.yaml`の
いずれかで終わるbasenameだけを許可し、`/`または`\\`を含むサブディレクトリは受理しません。Web Previewは
manifestとそのYAMLだけを読み、asset、base SB3、builder設定は変更しません。

## 3. 開始と保存

1. 開発用App Shellで「Open project directory」を押します。
2. OS pickerでproject rootを選びます。要求するpermissionはreadだけです。
3. 初回YAMLがvalidならmodalなしで先頭から開始します。
4. 外部editorでYAMLを保存します。
5. stableかつvalidな変更なら、sessionの再開方針を使ってsafe boundaryで自動reloadします。既定は現在actionで、
   replay-safeでなければ現在scene、さらに利用不能ならストーリー先頭へfallbackします。
6. 自動reloadはmodalを開かずfocusも奪いません。commit完了後、常時表示のreload status buttonが成功を通知します。

foregroundでは読込完了後500 msで次回pollを予約します。通常保存とatomic replaceのどちらも、同じcanonical
integrityを二回読めた時だけstageします。連続保存や重複pollが起きても同時readは一つで、古い結果は採用しません。
tabをbackgroundへ移すと5秒間隔へ落とし、visibleへ戻した時に即時pollします。

再開方針はpreview sessionだけに保持し、project、YAML、SB3、production artifactへ保存しません。方針または開始位置を
手動で変更するときだけreload status buttonを押します。dialogの第1段階で「ストーリーの最初から」「このsceneの
最初から」「このactionから」を選び、第2段階で次のいずれかを明示します。

- この位置から今回だけreload
- この位置からreloadし、次回以降も使用
- 今はreloadせず、次回以降に使用
- キャンセル

位置を選んだだけではreloadも方針変更も行いません。`Escape`、close button、キャンセルはdialog内の未確定値だけを
破棄します。保存時に完了済みの自動reloadを保留または巻き戻す操作ではありません。

## 4. 診断と回復

- initial invalid／missing: runtimeを開始せずwatchを継続します。
- 実行中のinvalid／missing: 現在のintegrityを置換せず、reload dialogを開きません。
- source復旧: currentと同じbytesならdiagnosticだけを解除し、異なるstable valid snapshotなら通常の再開方針で
  自動reloadします。
- permission取消: 自動でpermission promptを出さず、現在実行を保って作者の再選択へ戻します。
- `K4-PREVIEW-SOURCE-UNSTABLE`: 部分保存をstageせず、次回pollでretryします。

UIとsnapshotはsource本文、絶対path、filesystem handle、runtime variable、全文diffを保持しません。handle、timer、
pending read、candidateはsession memoryだけに置き、pagehide／disposeで破棄します。

## 5. browser非対応時

folder APIがない、secure contextではない、またはpermissionを得られない場合はUIに機械可読diagnosticと次の既存
commandを表示します。

```bash
pnpm exec tmpose-kamishibai preview-dsl4 --watch \
  --base BASE.sb3 \
  --project-root PROJECT_ROOT \
  --source-manifest PROJECT_ROOT/project.source.json \
  --control-profile production \
  --channel bundled \
  --max-source-bytes N \
  --max-asset-file-bytes N \
  --max-asset-files N \
  --max-total-asset-bytes N \
  --max-project-bytes N \
  --max-project-json-bytes N

pnpm exec tmpose-kamishibai validate-dsl4 \
  --input story.k4.yml \
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

`preview-dsl4 --watch`は認証済みloopback browserで実TurboWarp runtimeを起動し、台本を監視します。

## 6. rollback

`dsl4PreviewReloadOverlay=false`へ戻すと共通status buttonと自動適用方針を無効化し、従来のblocking candidate dialogへ
戻せます。`dsl4WebPreviewAdapter=false`へ戻すとproject open button、feature detection、permission request、poll timer、
visibility listener、browser adapter自体を初期化しません。共有source frontend、Node watcher、preview protocol、
`validate-dsl4`、`build-dsl4`はそのまま利用できます。handleを永続化しないためdata migrationは不要です。
