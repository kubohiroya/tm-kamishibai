# DSL 4.0 Standard publication導線と所有権

関連Issueは[#773](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/773) → [#775](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/775) → [#780](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/780)。2026-10-23、ブランチ`feat/dsl4/standard-publication`、基準main `ce0f9a80`（#979）。未公開コミット`27dc2cea`へのローカル修正を記録する。検証後のユーザー指示によりローカルmainへSquash統合する。push・PR・GitHub上のmerge・package公開は行わず、公開済みrc.43は変更しない。DSLは4.0を維持し、有効化用URLやフラグを追加しない。Safariは対象外。

## 物語の進行をシナリオが所有する

複数台本は作者による構成・分割の単位である。再生画面には任意の章選択、前章・次章一覧、履歴移動、「章を開く」、その読込だけを取り消すボタンを設けない。`27dc2cea`で追加した章選択・Open・Cancel UIと、hostの任意章切替メソッド`transitionPublication`を撤去する。

章を移るには、作者がDSLの`gotoSegment`を記述する。manifestの`next`はその章から許可する遷移先であり、自動で実行する順序やユーザー向けリンクではない。章末でも`gotoSegment`がなければ物語を終了し、暗黙に次章へ進まない。配列上の前章、公開entry point、同一章という理由だけで途中移動を許可しない。Standard ownerは現在の章の`next`を検査する。loaderも前章・公開entry pointへの暗黙の途中移動を許可しない。`entryPoints`は初期読込の検証用であり、章選択UIには使わない。

主人公が時間を行き来する物語では、作者が戻り先の章を`next`に宣言し、シナリオから`gotoSegment`で移る。変数・世界の状態・演出の意味はシナリオが定める。システムは章移動を過去状態の復元として扱わない。現在の実装では各章の変数はその章の初期値から開始する。型付き変数の章間引継ぎは#773の残務であり、復元済みとは報告しない。

ユーザーによる過去状態の復元は、セーブポイントで保存したデータのロードに限定する。これは#771等で扱う別の状態復元契約であり、今回セーブ・ロード機能を実装したわけではない。既存の単一台本の履歴・前scene/action操作全体の整理は、この差分で完了したとは扱わない。章遷移命令の待機中は、next action / next scene・rehearsal skip・repositionでその命令を飛ばさず、停止・終了は受け付ける。

## 台本とブロック

```yaml
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  ending:
    - gotoSegment: chapter2
```

対応する公開ブロックは`gotoSegment`（`go to story segment [SEGMENT]`）で、DSLと同じ正規化・Schema・dispatcherを使う。構造化台本ブロックのruntime/bundle両形式で往復できる。`goto`は従来どおり同じ台本内のsceneを対象とし、意味を変更しない。`gotoSegment`はpublication hostを必要とし、単一台本hostでは能力検証で拒否する。

章内の条件分岐や入力選択で到達したsceneに`gotoSegment`を置けば、その選択に従って章が移る。manifestと各章のsource/componentを検証する際、すべての`gotoSegment`の宛先が、その章の`next`に含まれることを照合する。未宣言・不明な宛先は起動前に拒否する。公開ブロックも現在実行中のシナリオactionのcontextを使い、独立した章閲覧APIにはしない。

## 入力と配布

1. フォルダ直下に`publication.json`を置く。既存のPublicationManifestV1で各章の完全な`.k4.yml`等を参照し、`next`にシナリオが使う遷移先を宣言する。`source.entry`はmanifestからの相対path、`size`と`integrity`はcanonical化前のUTF-8 bytesを対象とする。[形式](dsl-4-publication-asset-groups.md#publicationmanifestv1)を参照。
2. Standard Editorの「プロジェクトを開く」でフォルダを選ぶかstageへdropする。manifestがあればpublicationとして検証・構成する。今回は全章source/componentを一括検証・同梱する。章内素材はその章ファイルのフォルダを基準に解決する。単一台本/watch経路を保持し、単一台本を新たに選ぶ際は、元SB3の古いpublicationとstage archiveを除く。
3. 再生を開始するとentry章が動き、`gotoSegment`へ到達した時だけ章が移る。候補の準備中も現章の表示・動画を保持する。進行中のactionが待機を所有し、候補成功前に後続actionを実行しない。
4. 「SB3を保存」は全章と起動用アーカイブを含む配布物の保存であり、プレイ状態やセーブポイントの保存ではない。保存したSB3をEditor / Playerへ読み込み、PackagerでHTMLにできる。保存・診断欄には章リストを置かない。

配布データは`extensionStorage.kubohiroyakamishibai4.publication`の`formatVersion: 1`、manifest、元の章source、章ごとの通常のsource/artifact/asset component、配布時の`stageArchive`である。単一台本componentもentry章として保持する。章sourceは同梱offline providerを使うが、remote assetは既存providerがnetworkを使うため、全素材の完全offline配布を保証しない。

source合計は`maxTotalAssetBytes`、componentのシリアライズ合計はその2倍、起動アーカイブは64 MiB、保存時project.jsonは16 MiB、SB3全体の展開bytesは256 MiBを上限とする。manifestのsize/hash不一致・欠落章・不正DSL・component/source不一致・archive path逸脱を拒否する。Stage原本も起動アーカイブもない場合は衣装欠落をエラーにする。

## VM・実行・資源の所有権

各章は親hostにロード済みのVM / Renderer / AudioEngine / Storage / BitmapAdapterのconstructorから作る独立VM・canvas・audio engineを持つ。章VMは親の拡張を再帰ロードせず、Scratchのhatを起動しない。Stageの衣装・変数monitor・素材原本を引き継ぎ、台本controllerが進行を所有する。

1. 候補をhidden stageで作り、source/artifact/bundle・boot・初期scene groupを準備する。候補イベントとLoading/Busy/Cursorは共有画面へ出さない。
2. 停止・破棄のAbortSignalを確認し、同期commitで表示と入力を交換する。input接続失敗では候補を外して現章へ再接続する。loaderのcurrent更新はcommit成功後である。
3. commit時点で元の`gotoSegment`を完了させ、その後に旧host/VMを破棄する。元のactionが章遷移Promiseを待ち、旧hostのdisposeが同じactionを待つ循環を避ける。旧章の終了はpublication全体の終了として扱わず、新章の再生を開始する。
4. 再生全体を待つPromiseは章をまたいで維持し、最終章の終了で完了する。明示的な再生開始は新しい実行世代とPromiseを持ち、同じ章hostの古い開始結果も新しいrunを完了させない。停止は候補準備をabortし、遅れて準備完了しても新章を開始しない。
5. commit後の旧資源cleanup失敗は成功した遷移と区別する。既に公開した候補をrollback済みとは報告しない。

候補の準備失敗では旧章・変数・動画と入力ownerを維持し、診断欄へ失敗を表示する。`gotoSegment`は`retained`を返し、controllerはそのaction位置でpausedになる。失敗した命令をcommitせず、後続actionも実行せず、`runtime.fail`に伴う旧資源の全解放を起こさない。通常の継続処理による再開時は同じ命令を再試行する。章の一覧や別章への逃げ道は追加しない。

## group coordinatorと内部中断

publicationのasset lifecycleがscene coordinatorを提供し、controllerはそれを採用する。旧coordinatorと同じ資源を二重に管理しない。

- startupはloading素材を先に準備してからboot/sharedを取得する。scene準備中はcommit済みgroupを保持し、確定後に旧scene groupを外す。訪問済みstory-retainedとcrossfade BGMの保持を継承する。
- startupにもsceneにも保持したAbortControllerを使う。`cancel()`は両方に届き、停止・破棄時は部分取得分だけをrollbackして全cleanupを試す。ユーザー向けCancelボタンはない。provider/lifecycleは渡されたsignalに従って中断する。
- coordinatorはstartup/scene待機を`setLoading(true/false)`で囲む。成功・失敗・取消しでも非表示に戻す。commit済みhostはLoading/Busy/Cursorをshellへ転送し、hidden候補だけ抑制する。
- 動画はpublication共通adapterで同じbytes/MIMEのURLを共有する。各VMのleaseは独立し、不要動画のpause・src除去・decoder unload・描画破棄後にleaseを外す。最後のleaseでURLをrevokeする。

Packagerによる`costume.asset`等の破棄に備え、拡張・blockを除いた起動ZIPをbase64/SHA-256付きで保持する。起動アーカイブと全章componentは原本のownerであり、sceneのmaterialization purgeで解放したとは扱わない。

## 今回の受け入れ基準

- [x] 章選択・Open・Cancel UIと任意章切替host APIを撤去する。
- [x] DSL・公開ブロックの`gotoSegment`が同じ経路で実行され、`next`の明示リンクだけに従う。
- [x] 未宣言移動・暗黙の前章移動を拒否し、作者が明示した後方遷移は新しい章VMで実行する。
- [x] startup中断・古いpublicationの残留・連続startの結果混線・Loading欠落の4回帰を防ぐ。
- [x] 遷移失敗時に旧章・変数・動画を保持し、失敗した命令と後続命令をcommitしない。
- [x] シナリオ遷移中の停止と再開始、最後の章の終了・メニュー復帰が動作し、破棄時に待機や資源を残さない。
- [x] 生成runtime・設計文書を揃え、ローカル差分として保持する。

## 検証記録

今回の追加回帰は、startup中断signalと部分取得rollback、Loadingの成功/失敗時の表示解除、保存済みpublicationから単一台本を開く経路、同一hostへの連続start、候補失敗・中断・input rollback、シナリオ遷移と旧run解放の循環防止、章選択UI/APIの不在を対象とする。DSLとブロックの正規化・構造化台本の往復、明示next linkの検証、シナリオによる後方遷移、次action/sceneによる遷移命令skipの拒否も確認する。

対象13ファイルの回帰・接続・境界テストは219件成功。最初の対象実行の既存結果に、修正したhost境界と追加owner回帰の再実行結果を合わせた件数である。生成runtime profile整合性1件、build・型検査・対象lint/formatも成功。`verify:full`は実行しない。

Chrome製品版155.0.8059.86、独立profileの実ウィンドウでEditor / Player / Packager各2条件（成功・候補素材生成失敗）、計6条件・39確認が成功。fixtureは3章、実WebM・muted動画2領域、marker 7→8→9。ユーザーによる章選択なしでシナリオ内の`gotoSegment`が2回実行され、旧章の後続marker=99へ進まない。Shared URLの継続、scene group purge、最終章終了後のメニュー復帰、親VM停止後のstage/src/動画URL残留0、srcを残したURLのrevoke 0、Page error 0を確認した。候補失敗時は旧章の2動画とmarker=7を保持し、runtimeは`gotoSegment`の位置でpausedとなる。

Editor / Playerは公開Standard GUIの通常loaderへローカルSB3の応答だけを差し替え、拡張確認と緑旗から起動した。Packagerは同じSB3からローカルHTMLを生成した。公開物は変更していない。今回のSB3 SHA-256は`7d853a3c9a7b2082f79c8f63bbce09e32f9c39e905ca4df34c19dff867afab0d`。3画面から保存したSB3について全章manifest・シナリオ命令・起動ZIPのsize/SHA-256を照合し、成功した（今回の保存物の実画面再読込は未実施）。[新Chrome観測値](../testing/evidence/publication-scenario-20261023/chrome-results.json)・[新fixtureと保存物照合](../testing/evidence/publication-scenario-20261023/fixture.json)。

起動用素材の準備中断とLoading表示・解除は回帰テストで検証し、今回のブラウザ6条件の測定項目には加算しない。最初の検証では、既存の固定action件数・全命令fixtureを34命令へ更新し、単一台本hostの能力不足が例外になる契約にテストを合わせた。ブラウザの最初の確認では、EOF直後にも全URL解放を要求して失敗したが、再生停止・src除去と所有leaseの解放を分け、破棄時に全URL解放を確認する条件へ訂正した。EOF時点の0 URLという実装変更・保証は行っていない。

旧コミット`27dc2cea`ではChrome/Edge実ウィンドウのEditor / Player / Packager各7項目、計42確認、保存物3件の再読込、仕上げ後Packager7確認を実施した。これらは撤去前の章選択UIを使った旧実装の履歴であり、新しいシナリオ遷移の実画面検証に加算しない。[旧Chrome観測値](../testing/evidence/publication-20261023/chrome-results.json)・[旧Edge観測値](../testing/evidence/publication-20261023/edge-results.json)・[旧保存物再読込](../testing/evidence/publication-20261023/saved-reload-results.json)・[旧最終Packager](../testing/evidence/publication-20261023/final-packager-results.json)。

旧fixtureは実WebM・mutedの動画2領域、3章・各2sceneである。42確認時のSB3 SHA-256は`e8f599cf78c0b5f70c23a682234bbb4220714637f9ee2241209f76781f78f8c2`、旧最終候補は`3f9070886356b2ab5c9ec81b9244af8ca3047ebeef50143d70a1f679812deb7c`。[旧metadata](../testing/evidence/publication-20261023/final-fixture.json)。公開rc.43の親projectへ未公開runtimeを入れたローカル検証物であり、新しいリリースではない。

## ローカルmainへの統合

2026-10-23、修正を作業ブランチの`fb53ecdd`へコミットし、ローカルmainの`cc86d480`へSquash統合する。先行する反復・条件分岐の実装を保持する。runtime controllerは自動統合でき、競合したplayback runtimeは統合後のsourceから再生成した。共通runtime・startup・publication所有権・group・先行の反復/条件分岐・architectureの8ファイル187件、生成profile整合性1件、build・型検査が成功。先行の219件とChrome 6条件39確認は前提が維持された結果として保持し、統合後の実画面検証へは加算しない。[ローカル統合記録](../testing/evidence/publication-scenario-20261023/local-integration.json)。

push・PR作成・GitHub上のmerge・Issue更新・公開は行わない。GitHub上のmerge確認がないため、作業ブランチとworktreeは保持する。

## 残務とロールバック

- #773: 型付きpublication/segment変数の引継ぎ、publication cover、segment単位preview/build/live reload、CLI builder、実配布物のonline/hybrid/offline。セーブポイント保存データによる復元は#771等の別契約。任意章選択UIを残務には戻さない。
- #775: raw memory / IndexedDB / 原本bundleの寿命分離、byte budget・materialization LRU・cache prune、動画以外の全種dedup、AudioBuffer / Pose / GPU / カメラ・共通UI ownerの組合せ検証。
- #780: 新publication導線でのFirefox製品版、MP4、音声付きautoplayと背景plane。native decoder buffer/RSS/IndexedDB purgeの証明とURL数の観測を混同しない。過去の実聴・autoplay記録を維持し、新規の実聴には加算しない。#779可変viewport等も継続。Safariは対象外。
- 共通: 次回公開への反映。3 Issueの全体DoDは未完了でOpenを維持する。今回の指示に従いIssueへの外部追記はせず、結果と方針変更をこの文書に保存する。ローカルmainへの統合時は、先行して入った反復・条件分岐の実装を保持し、共通runtimeと生成物を検証する。

切戻しは今回のsource・Schema・ブロック・生成playback runtimeをまとめて戻す。未マージの修正を破棄する場合は`27dc2cea`との差分を対象とするが、撤去前の任意章選択UIが復活するため採用しない。既存の単一台本へ戻す場合は`27dc2cea`を含むpublication接続差分全体を戻す。公開済みrc.43と版付きartifactは上書きしない。
