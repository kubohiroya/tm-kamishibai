# 紙芝居DSL 4.0 Web Preview 作者向け手順

Copyright © 2026 Hiroya Kubo.

文書状態: Issue #390実装済み（起動時flagは既定OFF）

## 1. 利用条件

Web Previewは開発用App Shellの機能です。production SB3、通常のTurboWarp editor、Web player、Packagerには
登録または保存しません。hostは起動時に次の三つをすべて明示的にONにします。

```js
const featureFlags = {
  dsl4Runtime: true,
  dsl4AppShell: true,
  dsl4WebPreviewAdapter: true,
};
```

子flagだけをONにすると起動前に設定errorになります。一般作者向けの既定値はすべてOFFです。HTTPSまたは
localhostのtop-level desktop Chromiumで、`showDirectoryPicker()`とread handle APIが利用できる必要があります。

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
5. validな変更ならreload候補が表示されるので、先頭、現在scene、現在actionのいずれかを選びます。
6. `Escape`は候補を保留し、現在のimmutable実行を継続します。

foregroundでは読込完了後500 msで次回pollを予約します。通常保存とatomic replaceのどちらも、同じcanonical
integrityを二回読めた時だけstageします。連続保存や重複pollが起きても同時readは一つで、古い結果は採用しません。
tabをbackgroundへ移すと5秒間隔へ落とし、visibleへ戻した時に即時pollします。

## 4. 診断と回復

- initial invalid／missing: runtimeを開始せずwatchを継続します。
- 実行中のinvalid／missing: 現在のintegrityを置換せず、reload dialogを開きません。
- source復旧: 次のstable valid snapshotを通常のreload候補として表示します。
- permission取消: 自動でpermission promptを出さず、現在実行を保って作者の再選択へ戻します。
- `K4-PREVIEW-SOURCE-UNSTABLE`: 部分保存をstageせず、次回pollでretryします。

UIとsnapshotはsource本文、絶対path、filesystem handle、runtime variable、全文diffを保持しません。handle、timer、
pending read、candidateはsession memoryだけに置き、pagehide／disposeで破棄します。

## 5. browser非対応時

folder APIがない、secure contextではない、またはpermissionを得られない場合はUIに機械可読diagnosticと次の既存
commandを表示します。

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

現在はCLI live preview commandを公開していないため、架空の`preview --watch`は案内しません。

## 6. rollback

`dsl4WebPreviewAdapter=false`へ戻すとproject open button、feature detection、permission request、poll timer、
visibility listener、browser adapterを初期化しません。共有source frontend、Node watcher、preview protocol、
`validate-dsl4`、`build-dsl4`はそのまま利用できます。handleを永続化しないためdata migrationは不要です。
