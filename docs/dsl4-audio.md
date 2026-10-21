# DSL 4.0 の音声再生

追跡: [アプリ #776](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/776)、[共通controller #6](https://github.com/kubohiroya/turbowarp-asset-cache/issues/6)。この文書は公開プレリリースrc.39の音声仕様です。rc.37とrc.38には含まれません。台本の版は `4.0` のままです。

## DSLとブロック

動画の `video` / `videoControl` と同じく、音声の準備と操作を2つに分けます。`audio` は音声を停止状態でIDへ登録し、`audioControl` はそのIDを操作します。準備だけでは再生しません。有効化URLスイッチは不要です。

```yaml
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
assets:
  Theme: {kind: sound, file: assets/theme.mp3}
scenes:
  opening:
    - audio: {id: music, asset: Theme}
    - audioControl: {id: music, operation: loop, fadeIn: 1, volume: 150, fadeOut: 1.5}
    - wait: 2
    - audioControl: {id: music, operation: pause}
    - audioControl: {id: music, operation: seek, seconds: 1.5}
    - audioControl: {id: music, operation: setVolume, volume: 35}
    - audioControl: {id: music, operation: resume}
    - wait: 2
    - audioControl: {id: music, operation: stop, fadeOut: 0.5}
```

素材は既存の `kind: sound` を使います。`asset` の代わりに `url: https://example.com/theme.mp3` を指定できます。どちらか一つが必須です。URLは認証情報を含まないHTTP(S)の音声ファイルを指定します。オフライン配布では直接URLを拒否するため、埋め込み素材を使ってください。対応形式・codecはブラウザに従います。

準備時の任意設定は `volume`（0以上の有限数、既定100）、`muted`（真偽値、既定false）、`playbackRate`（0.25〜4、既定1）、`fadeIn` / `fadeOut`（0以上の有限な秒数、既定0）です。動画の位置・大きさ・plane・zIndexは音声にはありません。

対応するcore blockは「prepare audio [ID] from [SOURCE_TYPE] [SOURCE] fade in [FADEIN] seconds volume [VOLUME] % fade out [FADEOUT] seconds」「audio [ID] [OPERATION] value [VALUE] fade in [FADEIN] seconds volume [VOLUME] % fade out [FADEOUT] seconds」の2つです。SOURCE_TYPEはasset/url、OPERATIONは下表の操作を選びます。秒数・再生音量欄が空なら省略・継承です。秒数0ならフェードなし、音量0なら無音です。初期音量の既定値は100です。setVolume操作ではVALUE欄へ音量を入力し、再生用VOLUME欄は空にします。フェード欄がなかった旧ブロックも読み込めます。その他の任意設定は構造化ブロックのオプションで保持され、YAMLとの往復で失われません。

| operation       | 値      | 動作                                                                             |
| --------------- | ------- | -------------------------------------------------------------------------------- |
| playUntilDone   | なし    | 先頭から再生し、自然終了まで台本を待機                                           |
| play            | なし    | 先頭から再生開始し、台本を続行                                                   |
| loop            | なし    | 先頭から繰り返し再生し、台本を続行                                               |
| stop            | なし    | 指定されたフェードアウトの完了を待って停止し、先頭へ戻す。IDと準備済み音声は保持 |
| pause           | なし    | 現在位置で一時停止                                                               |
| resume          | なし    | 現在位置から再開。ループ設定を保持                                               |
| seek            | seconds | 0以上の秒へ移動。長さを超える指定はエラー                                        |
| setVolume       | volume  | 0以上の音量へ変更                                                                |
| setMuted        | muted   | true/falseでミュートを変更                                                       |
| setPlaybackRate | rate    | 0.25〜4の再生速度へ変更                                                          |

## 再生時の指定

`playUntilDone` / `play` / `loop` / `resume` に `fadeIn`・`volume`・`fadeOut` を指定できます。例えば `{id: music, operation: play, fadeIn: 1, volume: 200, fadeOut: 1.5}` です。`stop` は `{id: music, operation: stop, fadeOut: 0.5}` のように終了時の秒数を指定します。

音量は100を原音の倍率1とし、50は半分、0は無音、200は2倍です。小数も指定でき、負数・NaN・Infinityは拒否します。準備時の省略値は100で、再生時に省略すると現在の設定音量を保持します。再生時の指定やsetVolumeで変更した音量は、その後も保持します。100超は共通controllerのWeb Audio GainNodeで増幅します。極端な値はWeb Audioのfloat表現範囲内で出力します。

直接URLの音声は、後から増幅へ変更できるようanonymous CORSで読み込みます。別originのサーバーはAccess-Control-Allow-Originを返す必要があります。埋め込み素材にはこのサーバー設定は不要です。[Web AudioのCORS仕様](https://webaudio.github.io/web-audio-api/#MediaElementAudioSourceNode-security)に従い、CORSを回避しません。

## フェードの秒数

`fadeIn` は再生開始・再開時に0から設定音量へ線形に上げる秒数、`fadeOut` は終了前に設定音量から0へ線形に下げる秒数です。秒数は実時間であり、再生速度が変わっても指定秒数を基準にします。フェード中も設定音量は独立して保持し、`setVolume` はその設定音量を変更します。

- `audio` の設定を各再生の既定値とします。`playUntilDone` / `play` / `loop` / `resume` の `fadeIn` / `fadeOut` で、その再生の値を上書きできます。例えば `{id: music, operation: play, fadeIn: 0.25, fadeOut: 2}` です。
- 非ループ再生は音声ファイルの自然終了に向けて `fadeOut` を適用します。残り時間を再生速度で換算し、seekや速度変更後も追従します。開始・終了のフェードが重なる短い音声では、小さい方の音量倍率を使います。長さが不明なストリームでは自然終了前のフェードを予測できないため、明示的な `stop` を使ってください。
- ループ中は周回ごとのフェードアウトを行いません。`stop` は再生中なら現在の音量から指定秒数で消音し、完了まで台本を待機します。`stop` の `fadeOut` で上書きでき、省略時はその再生の設定、0なら即時停止です。
- `pause` は即時に一時停止します。`resume` は準備時の既定値またはその操作の指定でフェードインします。フェードなしで再開するには `fadeIn: 0` を指定します。
- scene切替・終了・素材解放・dispose・キャンセルは即時に停止・回収します。sceneを移る前にフェードを完了させる場合は、`stop` を明示してから移動してください。再生の置換や中断後に古いフェードtimerが新しい再生を変更することはありません。

秒数を省略または0にすると従来の即時再生・停止になり、既存4.0台本の動作を維持します。`pause` / `seek` / 音量等の設定操作にフェード秒数を付けることはできません。

## 所有と互換性

同じ素材から複数IDを準備できます。音量・停止・位置などは各instanceに独立しています。IDを再定義すると、準備に成功した新しいinstanceへ交換して旧instanceを解放します。IDはscene単位で管理し、最大32件です。scene切替、台本終了、runtime dispose、該当素材の解放では音声を停止し、native media sourceとObject URLを回収します。

既存の `bgm`、`sound`、`stopBgm`、`setBgmVolume` は互換入口として維持します。`bgm` のsceneを跨ぐ寿命、crossfade、`sound` の終了待ち、BGMの停止・音量遷移も維持します。BGMのvoice、従来の効果音、ID付き音声は共通controllerを使い、それぞれが自分のinstanceを停止・解放します。Scratch SoundBankを使う旧compositionの再生経路は互換adapterとして残ります。

共通ライブラリが音声bytesの解決・native再生・Object URLを所有し、アプリのaudio action portはID・scene寿命・台本の待機・キャンセル・診断を所有します。新しいnative音声engineをアプリ側に重複実装しません。

## autoplayとエラー

音声再生にはブラウザがユーザー操作を要求する場合があります。Chromeの実測では、audio要素はmutedがtrueでも操作なしでは拒否されました。動画のミュートautoplayと同じ許可条件は保証しません。[Chromiumの設計文書](https://github.com/chromium/chromium/blob/main/docs/media/autoplay.md)も、ミュート例外をvideo要素について説明しています。許可されない場合、`K4-AUDIO-AUTOPLAY` と元の `NotAllowedError` を診断へ残し、失敗したinstanceを解放します。デコード失敗は `K4-AUDIO-PLAY`、不明IDは `K4-AUDIO-ID` です。ブラウザの許可条件を回避するスイッチは追加しません。

## 導入・検証・切り戻し

共通ライブラリ `@kubohiroya/turbowarp-asset-cache@0.3.0` を使用し、依存とlockfileを固定して配布runtimeへ組み込みます。アプリのnpm/SB3公開は、別途新しいRCを作成して行います。公開済みrc.37のnpm/SB3は差し替えません。開発中のローカル連携結果だけで公開済みartifactの対応を主張しません。

検証対象はcontrollerの再利用・abort・自然終了・解放、素材参照とSchema、2種類の構造化ブロックの往復、旧BGM/SE、scene寿命、オフラインURL拒否、Editor/Player/Packagerの実再生です。実画面の測定ログはIssueへ記録します。

切り戻す場合はアプリの追加と依存更新を先にrevertし、必要なら共通ライブラリの依存も前版へ戻します。新構文を含む台本は旧版では読めないため、台本を旧4コマンドへ戻すか、対応版を継続利用してください。既存4.0台本には書き換えを要求しません。
