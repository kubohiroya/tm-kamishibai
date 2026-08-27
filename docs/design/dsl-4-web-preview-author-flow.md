# 紙芝居DSL 4.0 Web Preview 作者向け手順

Copyright © 2026 Hiroya Kubo.

文書状態: Issue #390／#394／#538／#541実装済み

## 1. 利用条件

Web Previewは開発用App Shellの機能です。汎用の非埋め込み Standard SB3（
`application.mode=menu`）は制作・デバッグ用ランナーなので、次の起動profileを既定で使います。
作者がURL parameterやScratch variableでdebug modeを指定する必要はありません。

```js
const featureFlags = {
  dsl4Runtime: true,
  dsl4AppShell: true,
  dsl4WebPreviewAdapter: true,
  dsl4PreviewReloadOverlay: true,
  dsl4Debugger: true,
};
```

`dsl4PreviewReloadOverlay`はWeb／CLI browser preview共通のflagで、`dsl4WebPreviewAdapter`の子ではありません。
埋め込み済み作品SB3（`application.mode=story`）はproduction profileのままで、picker、watcher、preview
sessionを初期化しません。共通flag自体のdefault-OFF契約も維持し、非埋め込みentrypointが専用の
`dsl4NonEmbeddedDevelopmentFeatureFlags`を明示的に選びます。HTTPSまたはlocalhostのtop-level desktop
Chromiumで、台本単体は`showOpenFilePicker()`、project directoryは`showDirectoryPicker()`とread
handle APIが利用できる必要があります。

## 2. project layout

最小projectは次の構成です。

```text
project-root/
├── project.source.yml
└── story.kamishibai.yaml
```

`project.source.yml`は次のread-only source契約を持ちます。directory open時は
`project.source.yml`、`project.source.yaml`、`project.source.json`の順に探します。

```yaml
formatVersion: 1
mode: external
sourceId: main
```

`path`を省略すると後方互換のため`story.kamishibai.yaml`を使用します。新規sourceでは`.k4.yml`を推奨します。
別名を指定する場合はproject root直下で、`.k4.yml`、`.k4.yaml`、`.kamishibai.yml`、`.kamishibai.yaml`の
いずれかで終わるbasenameだけを許可し、`/`または`\\`を含むサブディレクトリは受理しません。manifestと
そのYAMLをsourceの正本にします。YAMLが`file`で宣言したlocal assetは選択したproject root内の
宣言pathだけを読み、directory全体は走査しません。

## 3. 開始と保存

1. 非埋め込み Standard SB3をbrowserで開き、メニューの「Open」を押します。
2. 「台本ファイルを開く」または「project directoryを開く」を選びます。どちらも要求するpermissionは
   readだけです。独立Web Preview hostではproject directoryを直接選択します。
3. 台本単体の場合はそのfileだけを監視します。project directoryの場合はmanifestが指すYAMLと、
   そのYAMLが宣言するlocal file assetを同じrootから読みます。
4. 初回YAMLがvalidならmodalなしで先頭から開始します。
5. 外部editorでYAMLを保存します。
6. stableかつvalidな変更なら、sessionの再開方針を使ってsafe boundaryで自動reloadします。既定は現在actionで、
   replay-safeでなければ現在scene、さらに利用不能ならストーリー先頭へfallbackします。
7. 自動reloadはmodalを開かずfocusも奪いません。commit完了後、常時表示のreload status buttonが成功を通知します。

### 3.1 assetの選び方

| YAMLのasset                                   | 台本ファイル単体 | project directory | YAML更新時の扱い                             |
| --------------------------------------------- | ---------------- | ----------------- | -------------------------------------------- |
| `name`で参照するSB3内costume／backdrop／sound | 利用可           | 利用可            | 現在のTurboWarp VMから再解決                 |
| `delivery: remote`                            | 利用可           | 利用可            | URLと検証metadataを次generationへ引き継ぐ    |
| `file` local asset                            | 不可             | 利用可            | 宣言pathを2回読み、同じSHA-256の場合だけ採用 |

TurboWarp Editorへimageをドロップしてcostume／backdropを追加したり、sound fileをドロップして
音声を追加した場合、それらはTurboWarp VM所有のproject assetです。preview reloadはVMを
`loadProject()`し直さないため追加素材を削除せず、次のvalid YAML generationの`name`から再解決します。
ただし、project assetの追加そのものはfilesystem watch対象ではありません。参照を追加・変更した
YAMLを保存したときにlive reloadされます。

### 3.2 debuggerとステップ実行

非埋め込み Standard SB3のdevelopment runnerでは、引数なしの`debugger` actionを台本の任意位置へ
置けます。既定の「debuggerで停止」modeでは、そのactionを実行する直前に停止します。

```yaml
scenes:
  opening:
    - stage: Intro
    - debugger:
    - wait: 1
```

reload status buttonを押して設定dialogを開くと、「debuggerで停止」と「1 actionずつ実行」を選べます。
後者では`debugger`の有無にかかわらず各actionの直前で停止し、「次のactionを実行」を押すたびに
現在actionを一つ実行して次のaction直前で停止します。buttonは停止理由、scene、1始まりのaction番号、
commandを表示します。

実行modeと停止位置はbrowser sessionだけの値です。YAML、project manifest、SB3、runtime variable、
localStorageへ保存しません。埋め込み作品SB3はproduction profileなので設定UIを作らず、`debugger`を
副作用なしで通過します。stop、dispose、live reloadは未解放のdebug停止をcancelし、live reloadでは
同じactionを再実行できるsafe boundaryへ戻します。

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
- `K4-ASSET-PROJECT-DIRECTORY-REQUIRED`: 台本単体でlocal `file` assetが宣言されたため、
  project directoryを開き直します。
- `K4-ASSET-MISSING`／`K4-ASSET-UNSTABLE-001`: 不完入力を採用せず、有限retry後も安定しなければ
  現在generationを保持します。

UIとsnapshotはsource本文、絶対path、filesystem handle、runtime variable、全文diffを保持しません。handle、timer、
pending read、candidateはsession memoryだけに置き、pagehide／disposeで破棄します。

## 5. browser非対応時

folder APIがない、secure contextではない、またはpermissionを得られない場合、非埋め込みSB3の
「Open」は従来の単発YAML file pickerへfallbackします。保存監視が必要な場合は、次の既存commandを
使用します。

```bash
pnpm exec tm-kamishibai preview-dsl4 --watch \
  --base BASE.sb3 \
  --project-root PROJECT_ROOT \
  --source-manifest PROJECT_ROOT/project.source.yaml \
  --control-profile production \
  --channel bundled \
  --max-project-bytes N \
  --max-project-json-bytes N

pnpm exec tm-kamishibai validate-dsl4 \
  --input story.k4.yml \
  --format pretty

pnpm exec tm-kamishibai build-dsl4 \
  --base BASE.sb3 \
  --project-root PROJECT_ROOT \
  --source-manifest PROJECT_ROOT/project.source.yaml \
  --output OUTPUT.sb3 \
  --control-profile production \
  --channel bundled
```

`preview-dsl4 --watch`は認証済みloopback browserで実TurboWarp runtimeを起動し、台本を監視します。

## 6. rollback

非埋め込みentrypointのprofileを`dsl4StandardProductionFeatureFlags`へ戻すと、picker、watcher、
reload overlay、debugger停止、source-generation asset準備をまとめて無効化できます。埋め込み作品SB3は常にその
production profileなので影響を受けません。共有source frontend、Node watcher、preview protocol、
`validate-dsl4`、`build-dsl4`はそのまま利用でき、handleを永続化しないためdata migrationは不要です。
