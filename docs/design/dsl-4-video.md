# DSL 4.0 の動画領域と再生制御

追跡: [#780](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/780)。ブランチ: `feat/dsl4/video-blocks`。

台本の途中に矩形の動画領域を置き、ID で再生を制御したいという依頼に対応する。
`video` と `videoControl` の2命令を追加する。Standard production / developmentでは動画を標準で有効にする。
台本の版は `kamishibai: '4.0'` のまま拡張し、既存台本との互換性を維持する。
asset group（#775）、可変 viewport（#779）、保存データ（#771）、segment prefetch（#773）との実接続は、依存機能の実装後に検証する。

## ブロックと YAML

| 命令           | ブロックの入力                                                              | 動作                                                                     |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `video`        | ID、取得元の種類（`asset` / `url`）、取得元、x、y、幅、高さ、plane、z-index | 停止状態の領域を表示する。同じ ID の領域は置き換える                     |
| `videoControl` | ID、操作、値                                                                | その ID の領域だけを操作する。値はシーク・音量・消音・速度の変更時に使う |

```yaml
kamishibai: '4.0'
assets:
  OpeningMovie:
    kind: video
    file: assets/opening.mp4
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - video:
        id: openingMovie
        asset: OpeningMovie
        x: 0
        y: 0
        width: 320
        height: 180
        plane: front
        zIndex: 10
    - videoControl: {id: openingMovie, operation: playUntilDone}
    - videoControl: {id: openingMovie, operation: play}
    - wait: 5
    - videoControl: {id: openingMovie, operation: stop}
    - videoControl: {id: openingMovie, operation: loop}
    - wait: 5
    - videoControl: {id: openingMovie, operation: stop}
```

直接 URL を使う場合、`asset: OpeningMovie` を `url: 'https://example.com/opening.mp4'` に置き換える。
`asset` と `url` はどちらか一つだけ必須。URL は動画ファイルを返す HTTP(S) URL で、認証情報を含めない。
動画共有サイトのページ URL は動画ファイルとしては再生できない。

動画アセットは MP4 / WebM のファイル、または既存の `delivery: remote` / `source` を使用できる。
Scratch の costume / sound の名前で動画を指定する経路は持たない。アセット ID は `kind: video` を参照する。
直接 URL はアセット検証・キャッシュ・同梱の対象にならず、ネットワーク禁止の配布 profile では build を拒否する。
オフライン配布には埋め込み動画アセットを使う。コーデックの対応範囲は実行ブラウザに従う。

## 位置と寿命

- x、y は Scratch と同じ中央原点、右向き・上向きが正のステージ座標で、動画矩形の中心を表す。
- 幅・高さは正のステージ単位。`fit: contain`（既定）は動画の縦横比を保って矩形に収め、余白を黒にする。`fit: cover` は矩形を埋め、はみ出す部分を切り取る。
- `plane: front`（既定）は renderer の `scale-centered` overlay、`plane: background` は背景の上・スプライトの下の専用 video group に描く。どちらもステージの拡大縮小に追従し、クリックを横取りしない。
- `zIndex` は同じ plane 内の動画の順序。既定 `0`、大きいほど手前、同値なら後から表示した領域が手前。負の整数も使え、範囲は `-9007199254740991`〜`9007199254740991`。同じ ID の置換は新しい表示として扱う。
- `zIndex` は plane の境界を越えない。`background` の最大値でもスプライトより奥、`front` の最小値でもステージより手前。スプライト同士の間へ挿入する指定は持たない。
- 前面では native overlay のラッパーに圧縮した順序を設定するため、CSS の整数範囲に依存しない。背景ではグループ内の先頭へ逆順に配置し、隣のスプライトグループへ移動しない。
- 背景側のフレームは辺長最大2048の canvas へ収めて texture に反映する。別オリジンの直接 URL には配信元の CORS 許可が必要。
- ID の有効範囲は現在のシーン。同一シーン内では複数 ID を独立して保持する。
- シーン切替、台本の終了・失敗・停止、タイトルへ戻る操作、dispose で全領域を停止・削除する。
- アセットの解放時には、参照中の領域を先に削除する。動画の `src` を外して `load()` し、decoder / buffer を解放してから、アセット所有者が Object URL を破棄する。

## 再生の意味

`playUntilDone` は先頭から 1 回再生し、`ended` まで次の台本命令へ進まない。完了時は最後のフレームを残す。
`play` は「再生開始（バックグラウンド）」で、先頭から 1 回再生する。再生開始の成功を確認すると次の命令へ進み、終了時は最後のフレームを残す。
`loop` は先頭からループ再生し、再生開始の成功を確認すると次の命令へ進む。
`stop` は停止して先頭へ戻し、領域自体は残す。既に終了待ちしている操作があれば、その待機を正常に解除する。
同じ ID への再生操作は前の操作を終了させてから始める。

`pause` は現在位置で一時停止して終了待ちを解除する。`resume` は現在位置からバックグラウンド再生し、ループ設定を維持する。
`seek` は `seconds`（0以上、長さが判明している場合はその範囲内）へ移動する。
`setVolume` の `volume` は0〜100、`setMuted` の `muted` は boolean、`setPlaybackRate` の `rate` は0.25〜4。
表示時にも `volume`（既定100）、`muted`（既定false）、`playbackRate`（既定1）で初期値を指定できる。
これらの音声設定は各動画に適用し、BGMや効果音の設定とは独立する。

動画 port の `captureState` / `restoreState` は領域の宣言、位置、再生状態、ループ、音量、消音、速度を受け渡す。
素材はアセット ID から再取得し、保存値に Object URL を含めない。保存データ機能への接続は #771 の範囲とする。

台本中止や領域置換で終了待ちを打ち切る場合は `AbortError` にする。
未作成 ID、未準備のアセット、不正な矩形、読込・デコード失敗、再生開始の拒否は診断で通知する。
バックグラウンド再生・ループ開始後の media error は停止させ、host の `onBackgroundActionError` へ通知する。

音声付き動画はブラウザの autoplay 制限で開始を拒否される場合がある。その際は `K4-VIDEO-AUTOPLAY` を返す。
必要なら YAML の `video` に `muted: true` を追加できる（ブロック台本では既存の action options で指定する）。
ブラウザ側の仕様: [HTMLMediaElement.play()](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)、
[HTMLMediaElement.load()](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/load)。

## 有効化とロールバック

rc.36以降のStandard SB3は動画を標準で有効にする。Editor / Player / Packagerの起動URLに動画用のパラメータを付ける必要はない。
`src/dsl4/feature-flags.ts` のStandard production / development profileが共通の設定を持ち、制作プレビューと配布runtimeの両方に適用する。

npm APIで独自hostを構成する場合は `dsl4StandardProductionFeatureFlags` または `dsl4NonEmbeddedDevelopmentFeatureFlags` を使う。
低水準のフラグ解決はruntime自体を既定OFFにする契約を維持する。既存の公開済みrunner / SB3は自動更新しない。

問題が起きたときはAPIで既存フラグに `dsl4Video: false` を上書きするか、SB3を既知のrc.34へ戻す。
動画OFFでは動画命令・動画アセットを含む台本を `K4-VIDEO-DISABLED` で拒否する。動画を使わない既存台本は維持する。
切り戻しのためだけのURLスイッチは設けない。

## 受け入れ基準

- [x] 2 命令の schema、参照検証、core action manifest、TurboWarp ブロック、runtime port が一致する。
- [x] asset / URL と矩形の検証、未作成 ID の診断、block / YAML の往復を検証する。
- [x] 終了待ち、バックグラウンド再生、ループ、一時停止・再開、シーク・音量・消音・速度、停止、置換、abort、再生拒否と media error を検証する。
- [x] ローカル / remote 動画アセットの bundle 化・materialize・解放を検証する。
- [x] host の feature gate、シーン切替と終了時の cleanup を検証する。
- [x] 同梱 WebM を Chromium で実デコードし、終了待ち・バックグラウンド再生・ループ・一時停止・再開・停止・解放を検証する。
- [x] 実 renderer で背景の描画、同一 plane の z-index、同値と ID 置換の順序、plane 境界、前面の DOM 積層順、GPU リソース解放を検証する。

Chromium fixture は native HTML video と、プロジェクトが固定する実 renderer を使う。WebGL は headless Chrome / SwiftShader で検証する。
基本機能はDSL 4.0 / rc.37で公開済み。各製品実画面・ブラウザ別の追加検証、
asset group / 保存・復元 / 可変viewport / segmentとの統合はIssue #780で継続する。
これらは公開済み基本機能への追加検証・統合であり、4.0 GAを待たせる追加要件にはしない。
検証済みの環境・条件と残務は[動画の実画面検証記録](dsl-4-video-validation.md)を参照する。

対象検証は `test/dsl4-video-*.test.ts`、関連する schema / block / host / asset tests、
および `test/e2e/dsl4-web-preview-chromium.test.ts` の `plays DSL video` / `renders video below sprites`。
