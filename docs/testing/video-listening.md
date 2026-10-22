# 動画のスピーカー実聴と入力回帰テスト

Issue #780の実聴確認ツールをGit管理する。Safariは対象外。対象はChrome・Firefox製品版・EdgeのEditor / Player / PackagerとWebM / MP4。

## 入力修正と検証範囲

確認パネルにfocusしてSpaceを押したとき、hostのdocument-level keyup処理がpreventDefaultすると、ブラウザ標準のbutton clickが発生しない。`scripts/manual/video-listening-audit.ts` はパネル内のkeydown / keyupだけstopPropagationし、nativeの既定動作を維持する。合成clickへの置き換えやhost全体のキー処理変更は行わない。

同じモジュールを手動runnerと回帰テストが読み込み、ブラウザへ注入する。初回報告との同一原因かは当時の入力・focus記録不足で未確定。タイトルの重なり修正（公開rc.43）とは別に扱う。

```sh
pnpm install --frozen-lockfile
pnpm test:video-listening
```

Chrome / Chromiumが必要。`CHROME_BIN`を指定するか、macOSの標準Chrome配置・PATHのgoogle-chrome / chromiumを使用する。playwright-coreは既に実画面で使用した版へ開発依存を固定しており、ブラウザ本体をダウンロードしない。通常CIのquickテストにも自動で含まれる。約4秒の独立したfixtureであり、verify:fullは不要。

回帰テストのVMは明示的な偽物で、音は出ない。マウス・Enter・Spaceのnative入力、二重開始防止、パネル外のキー伝播、準備判定、非trusted入力拒否、遮蔽の診断、開始例外後の再試行、診断の上限・文字入力の除外を検証する。人による実聴や実codecの検証結果として数えない。

## 実聴fixtureの入力契約

手動runnerは利用者が用意したfixtureディレクトリを引数で受け取る。過去のtmpディレクトリや特定のMacの配置を前提にしない。大きなSB3 / HTML / 音声付き動画、既存の実聴回答、ブラウザ本体はGitへ追加しない。

- `webm-audible.sb3`、`mp4-audible.sb3`: 検証対象のStandard SB3へ音声付きの160×120動画を埋め込む。台本はDSL 4.0でproduction keymapを持つ。
- 先に前面の動画を作成する。`muted: false`、`volume: 35`、通常の`play`（バックグラウンド開始）。次に背景の動画を作り、`muted: true`、`loop`で開始する。
- 2動画とも少なくとも5秒間再生を維持する。ツールは両方の時間が1秒を超えた後、約2.8秒でVMを停止し、paused / src解放を観測する。終了待ち再生で背景の作成を遅らせない。
- `webm-audible.html`、`mp4-audible.html`: 同じSB3をPackagerでHTMLへ変換し、autoplayを無効にして準備待ちにする。外部ファイルを必要としないHTMLを使う。Packagerを試さない場合は不要。

従来のrc.41 fixtureはこの入力契約で使用した。別の版のfixtureを使う場合は版と生成手順も記録する。runnerはSB3のSHA-256を結果へ記録する。fixtureを作り直した結果を過去の実聴報告へ流用しない。

## 手動実行

Node.js 24以上。実端末のスピーカー出力をユーザーが確認する。OSの音量・出力先、autoplay設定、ブラウザの既存profileはツールから変更しない。

```sh
node scripts/manual/video-listening.ts \
  --browser chrome --executable '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --fixture-dir /absolute/path/to/fixtures \
  --output-dir /absolute/path/to/new-chrome-results
```

Edgeは`--browser edge --executable /absolute/path/to/Microsoft\ Edge`とする。Chrome / Edgeはplaywright-coreで隔離profileの実ウィンドウを開く。`--executable`の代わりに`CHROME_BIN` / `EDGE_BIN`を指定できる。

Firefox製品版はgeckodriverを別プロセスで起動する。Playwright配布版Firefoxとは区別する。

```sh
geckodriver --host 127.0.0.1 --port 8861
# 別terminal
node scripts/manual/video-listening.ts \
  --browser firefox --executable /absolute/path/to/Firefox \
  --webdriver-url http://127.0.0.1:8861 \
  --fixture-dir /absolute/path/to/fixtures \
  --output-dir /absolute/path/to/new-firefox-results
```

`FIREFOX_BIN`も使用可能。driverは利用者が終了する。Safari向けのdriver起動や設定操作は行わない。

Editor / Playerでは通常のproject_url経路を使い、指定fixtureのSB3応答だけを転送する。既知の検証fixtureの拡張許可UIをツールが承認する。Packagerはlocalhostへ用意したHTMLを配信する。GUIやnative media playの結果は差し替えない。

「再生して確認」を実際に操作し、スピーカーの音と停止を確認したユーザーが回答する。回答待ちの時間制限はない。プロトコル通信は60秒で失敗し、ウィンドウ終了も未確認の失敗として記録する。自動で「聞こえた」を選ばない。`pass`は回答の記録形式・必要なnative観測が妥当な意味であり、実聴成功は`listenerResult: heard-and-stopped`で別に判定する。

## 保存・再開と診断

出力はブラウザ別のresults.json、accepted-feedback.jsonl、input-events.jsonl、条件別の画像。出力先のresults.jsonが既にあれば起動前に拒否し、以前の報告を暗黙に上書きしない。出力先を省略すると新しい`tmp/video-listening-*`を作る。

```sh
node scripts/manual/video-listening.ts \
  --browser firefox --executable /absolute/path/to/Firefox \
  --fixture-dir /absolute/path/to/fixtures \
  --resume /absolute/path/to/old/firefox-results.json \
  --output-dir /absolute/path/to/new-resumed-results
```

同じブラウザの有効な既確認ケースを引き継ぎ、case IDが一致する条件を飛ばす。元のファイルは変更しない。`--surfaces player --formats webm,mp4`で対象を絞れる。チャットだけで確認済みの条件などは`--skip chrome-editor-webm-audible`で除外し、その申告の根拠は別に保存する。

回答前からcase ID付きの入力・focus / visibility・disabled / ready・hit-test / 前面要素・開始受理 / 拒否 / 例外をJSONLへ保存する。ページ内では`__speakerAudit.inputDiagnostics()`から現在の状態と直近120件を取得できる。診断にはEnter / Space / Tab / Escape以外の文字入力を記録しない。

再発時は該当case ID・時刻・input-events.jsonlと画面画像を残し、入力が到達したか、準備待ち・遮蔽・focus・例外のどれかを切り分ける。過去の実聴18件を再入力したり、自動観測を実聴報告へ加算したりしない。

## 切戻しと残務

この差分は手動ツール・回帰テスト・開発依存のみ。問題時は該当PRをrevertする。公開runtime・DSL・凍結metadataとrc.43配布物は変更しない。

初回事象との同一性、purge / 配布 #775・#773、保存復元 #771、可変viewport #779との統合はIssue #780で追跡する。Safariは対象外を維持する。
