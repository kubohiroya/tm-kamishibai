# Editorの共通カメラ入口

関連: [Issue #952](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/952)。GUI #51 → Camera Source #55 → app #952の順に導入する。

対応EditorではCamera Sourceの`registerCameraControls`へ接続する。カメラの許可・開始、一覧/選択と左右反転の汎用UI、標準文言はCamera Sourceが所有する。Editorは停止ボタン後方の配置と開閉、テーマを所有する。

appに残すのは、作品のカメラID（pose）、台本とカメラのライフサイクル、TMプレビューへ選択と反転を反映するportの接続。EditorのDOMを探して許可ボタンを移し替えたり、app固有の設定DOMを共通パネル用に複製したりしない。

タイトルで取得したストリームは、タイトルを閉じても物語へ引き継ぐ。物語のプレビュー設定は同じcameraIdへ登録し、Editorが入口を一つにまとめる。停止/再読込ではコントローラーを破棄する。

共通入口の位置変更UIは設けない。既存YAMLの`recognition.preview.controls.*.position`は互換性のため読み込むが、対応Editorの入口位置には使わない。APIのない既存ホストでは従来のプレビュー内コントロールと許可gateを使う。プレビュー映像自体の配置指定は別の機能である。

受け入れ条件は許可から設定への切替、機器選択と左右反転、停止時の解放、再生画面内の重複ボタンがないこと。切戻しはadapter差分をrevertする。公開配布への適用は対応するGUI・Camera Sourceの公開版をそろえた段階で行い、凍結済みSB3を同じ版番号のまま差し替えない。

## Packager HTML

Editor APIがなければCamera Sourceの共通コントローラーがapp-shell Dockへ入口を登録する。リロードも同じstageControls互換APIを使い、一つのDockに並ぶ。個別ボタンの位置変更UIを復活させず、Dock全体を上下左右へ配置する。自動非表示の初期値はONで、パネル表示中は隠さない。

依存はapp-shell #16 → Camera Source #55 → app #952/#951。共通Dockはカメラや台本とは独立し、各ボタンの表示条件は元のライフサイクルが決める。rc.38はapp-shell 0.3.0とCamera Source 0.19.0を完全固定する。

Pagesのbuildは公開済みSB3のハッシュを検証した後、Packager 3.13.0で`players/<version>/index.html`を生成する。プレイヤーは独立したHTMLなのでサイトのヘッダーやスタイルを注入しない。ダウンロードページの「ブラウザーで開く」から利用でき、初回は利用者が起動する。Editorの操作列を含めず、必要な操作は共通Dockへ登録する。
