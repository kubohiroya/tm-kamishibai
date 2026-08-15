# DSL 4.0 実Chrome・実カメラ Smoke 手順

この手順は、PoseNet基盤モデルを同梱したDSL 4.0 runtimeが、実Chromeの実カメラで
PoseModel prepareと認識ループを開始できることを確認するためのものです。自動E2Eは
カメラをスタブ化しているため、この手順の結果をIssueへ記録するまで実カメラのDoDを
完了扱いにしません。

## 前提

- macOSまたはLinuxのdesktop Chrome
- 動作する物理カメラと、カメラ権限を許可できるユーザーセッション
- `pnpm install` 済みのリポジトリ
- poseModelを参照するDSL 4.0 project root（`project.source.yaml` と `.k4.yml`）
- DSL 4.0 base SB3

Chromeはtop-levelの`localhost`またはHTTPS originで起動します。HTTPのremote hostや
iframe内ではカメラ権限を検証しません。

## 起動

current release candidateの再生成検証を先に実行します。

```bash
pnpm sb3:dsl4-release:check
```

project rootでlocal previewを起動します。`BASE.sb3`はDSL 4.0 base SB3の実体へ置き換えます。

```bash
pnpm exec tmpose-kamishibai preview-dsl4 --watch \
  --base BASE.sb3 \
  --project-root . \
  --source-manifest project.source.yaml \
  --control-profile production \
  --channel bundled
```

CLIが表示したloopback URLを、通常のdesktop Chromeで開きます。カメラ権限を許可しても
ページを再読み込みせず、runtimeの初回準備が完了するまで待ちます。

## 確認項目

1. **入力環境**
   - Chromeのアドレスバーにカメラ権限が許可済みと表示される。
   - Chrome DevTools Consoleで、少なくとも1つのvideo入力が列挙される。

     ```js
     await navigator.mediaDevices
       .enumerateDevices()
       .then((devices) =>
         devices
           .filter(({kind}) => kind === 'videoinput')
           .map(({label, deviceId}) => ({label, deviceId})),
       );
     ```

2. **PoseModel prepare**
   - loading表示が終了し、`K4-ASSET-PREPARE-001`や`K4-POSENET-ASSET-*`で停止しない。
   - Pose recognition用のpreviewが表示される。

3. **認識ループ**
   - 実カメラ映像を画面へ向け、pose recognitionのfeedbackが初期値から更新される。
   - 少なくとも1回、対象poseを認識してscene/actionが進む。
   - 認識開始から最初のfeedbackまでの時間を記録する。

4. **ネットワーク境界**
   - DevTools Networkで`storage.googleapis.com`を検索し、PoseNet JSON／shardの外部取得が
     0件であることを確認する。
   - Consoleに`connect-src 'self'`違反がなく、PoseNetの未知URL拒否
     (`K4-POSENET-FETCH-001`)も発生しない。

5. **停止と解放**
   - previewまたはruntimeを停止し、カメラの使用中インジケータが消える。
   - ページを閉じる前に、別のアプリケーションがカメラを取得できることを確認する。

## 記録フォーマット

Issue #510へ次の情報を追記します。

```text
date: YYYY-MM-DDThh:mm:ss+09:00
os: <name/version>
chrome: <version>
camera: <device name>
origin: <localhost or HTTPS origin>
pose-prepare: pass/fail
recognition-start: pass/fail
external-posenet-fetches: 0/<count>
csp-violations: 0/<count>
camera-release: pass/fail
notes: <observations>
```

失敗時はConsoleのdiagnostic code、NetworkのURL、runtime statusを併記します。失敗した
環境でfeature flagを既定ONへ変更したり、CSPへ外部originを追加したりしません。

## 自動検証との関係

実カメラ確認の前後に、既存の決定的テストを実行します。

```bash
pnpm lint
pnpm format
pnpm typecheck
pnpm test:full
pnpm e2e
```

自動E2Eのcamera stub成功だけでは、実カメラのDoDを満たしたことにはなりません。
