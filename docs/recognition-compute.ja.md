# 認識の計算方式（Teachable Machine 4.0.2）

kamishibaiは `@kubohiroya/turbowarp-teachable-machine` 4.0.2のランタイムを共有します。
配布用の統合拡張には `dist/teachable-machine-webgpu.js` を一度だけ組み込みます。このファイルにはTensorFlow.js 4.22.0、WebGPU/WebGL/WASM/CPUの各バックエンド、WASMバイナリとワーカーが含まれます。kamishibaiの既定の計算方式は `auto` です。同じページで拡張を再読み込みする場合は、軽量版の登録処理から既存のv4.0.2ランタイムを再利用し、TensorFlow.jsの二重初期化を避けます。

## 利用者の選択

緑の旗・停止ボタンと同じ操作列にある「Teachable Machine」ボタンから開き、「保存して最初から再生」を押します。
ボタンは `Scratch.gui.stageControls.addButton()` で登録し、作品のステージ内には置きません。操作列APIのない単独HTML等では、Camera Sourceと同じ `getRuntimeControlsDock()` の共通Dockを使います。設定パネルはボタンを押したときだけ開きます。

共通Dockでは、初回は下辺の「ツール」にホバーまたはタップすると、カメラなどと並んで「Teachable Machine」ボタンが現れます。Dockの設定で表示位置を上・下・左・右から選べ、自動的に隠す設定も端末に保存されます。「Teachable Machine」ボタンを押して4つの計算方式を選びます。設定パネルを開いている間はDockを表示したままにし、カメラやDock設定のボタンへ切り替えると計算方式のパネルを閉じます。

現在のモデルを解放して再生し直す際に、新しい方式を適用します。再生位置は先頭へ戻ります。まだ作品を開いていない場合は、次に作品を再生するときに適用します。
設定画面には最後に選ばれた実際のバックエンドと、代替方式へ切り替わったかも表示します。

| 表示               | 設定値   | 選択順序                             |
| ------------------ | -------- | ------------------------------------ |
| Auto（自動・推奨） | `auto`   | WebGPU → WebGL → WASM → CPU          |
| WebGPU             | `webgpu` | WebGPUを先に試し、失敗したら他方式へ |
| WASM               | `wasm`   | WASMを先に試し、失敗したら他方式へ   |
| JavaScript（CPU）  | `cpu`    | CPUを先に試し、失敗したら他方式へ    |

WebGLはAutoの候補と開発者APIの `webgl` 指定として利用できます。

`localStorage` の `kamishibai.recognition.computeMode` に、同じ配信元・同じブラウザの端末設定として保存します。SB3や台本の内容は書き換えません。保存が拒否される環境ではセッション内の設定として利用します。

## 開発者の指定

`createDsl4TurboWarpRuntimeHost` および `createDsl4PlatformAssetSession` に、共通ランタイムの `compute` と `computeMode` を渡せます。両方を `createDsl4TMPlatform` からTeachable Machine compositionへ伝達します。

```js
const host = await createDsl4TurboWarpRuntimeHost({
  // Include the usual runtime, project, tmPoseRuntime, and setLoading options.
  ...hostOptions,
  compute: globalThis.tmCompute,
  computeMode: 'wasm',
});
```

直接アダプターを利用する場合も同じ設定です。

```js
const platform = createDsl4TMPlatform({
  runtime: projectTMRuntime,
  compute: globalThis.tmCompute,
  computeMode: 'webgpu',
});
```

利用者設定の読み出しには `createDsl4ComputePreferences({initialMode: 'auto', globalObject: globalThis})` を利用できます。有効な保存値があれば初期値に優先します。下位APIの明示指定が自動的に利用者設定へ上書きされることはありません。

TensorFlow.jsの計算方式はページ内で共有されます。モデルを保持している間に `tmCompute.select()` を直接呼ばないでください。標準UIは既存の再生し直し処理へ接続し、旧モデルの解放後に新しいモデルを読み込みます。

## 配布とモデル

`teachable-machine.js` は必要なライブラリを外部から取得する軽量版です。「JavaScript CPU専用版」という意味ではありません。内包版のWebGPU/WASMファイルの違いは初期設定であり、両方とも他のバックエンドへ切り替えられます。

モデルデータはライブラリとは別です。kamishibaiの既存のPoseNet descriptorと学習済みモデルのSB3内包経路を維持します。台本がリモート素材を指定する場合は、その素材の取得に通信が必要です。

## 検証と切り戻し

設定・アダプター・host境界の単体テストに加え、次のコマンドで実モデルのWebGPU/WASM/CPU認識と設定保存を確認します。Chromeを起動し、テスト用カメラ映像を使います。テスト開始時に公開モデルを取得し、その後のブラウザ実行はローカル配信だけで行います。

```sh
TEACHABLE_MACHINE_HEADED=1 TEACHABLE_MACHINE_REQUIRE_WEBGPU=1 pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/dsl4-teachable-machine-compute-chromium.test.ts
```

環境に応じて `CHROME_BIN` を指定してください。実行結果は `tmp/teachable-machine-validation/report.json` に記録します。
方式を戻す場合は設定を `auto` にして再生し直します。移行自体を戻す場合は本変更をrevertし、package/lockfileと生成された統合拡張を同時に復元します。
