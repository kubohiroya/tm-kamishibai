# scratch-render Silhouette readback microbenchmark

更新日: 2026-08-16

追跡: [tmpose-kamishibai #564](https://github.com/kubohiroya/tmpose-kamishibai/issues/564) / [TurboWarp/scratch-render #21](https://github.com/TurboWarp/scratch-render/pull/21)

## 結論

`willReadFrequently: true` による速度向上は確認できませんでした。

- Chrome 149 の測定は、既定contextとhintありcontextがともに `26.6 ms / 100回` でした。
- Chrome 151で独立processを3回実行した再測定は、既定contextが `64.1 ms / 100回`、
  hintありが `78.5 ms / 100回` でした。
- Chrome 151の再測定ではhintありが約22.4%遅く、速度改善の根拠にはできません。

確認できた別の効果は、readbackするcontextの作成時に利用目的を明示することで、Chromiumの
`getImageData()` readback警告条件から外れることです。警告が消える仕組みと性能特性は別です。
詳細は
[scratch-render-readback-report.md](./scratch-render-readback-report.md)
に記録します。

## 現行実装との関係

2026-08-16時点の `tmpose-kamishibai` main `6e620a3` は、次を固定しています。

- direct `scratch-render`: fork commit `c69318a6c8d43439fc35fa9e403bf6d2781fdaee`
- TurboWarp Packager: `3.13.0`
- Packager内蔵runtime: build時にSilhouetteのcontext一件だけをfail-closedで置換
- TMPose: `1.10.1`。camera canvasの初回context作成はTMPose側が所有

このbenchmarkが測るのはscratch-renderのSilhouette相当処理だけです。TMPose camera、TensorFlow.js
`fromPixels()`、WebGL upload、sprite pick全体は測っていません。

## 対象処理

benchmarkは、`SVGSkin.createMIP()`から渡されるcanvasを`Silhouette.unlazy()`が読む経路を縮小して
再現します。

1. 480×360のsource canvasを用意する。
2. variantごとに1枚のdestination canvasと1個の2D contextを再利用する。
3. destination canvasを480×360へresizeする。
4. `clearRect()`、`drawImage()`、全領域の`getImageData()`を順に実行する。
5. 上記を1 batchあたり100回繰り返す。

比較するvariantは次の2つです。

```js
canvas.getContext('2d');
canvas.getContext('2d', {willReadFrequently: true});
```

## 測定方法

- 1 roundにつき、1 batchのwarm-up後に11 batchesを測定する。
- roundの値は11 batchesの中央値とする。
- 10 roundsを実行し、variantの実行順をroundごとに交互にする。
- 1 processの値は10個のround中央値の中央値とする。
- Chrome 151の最終値は、独立した3 processの中央値とする。
- 表示値は小数第1位へ丸める。

## 環境

### Chrome 149

| 項目    | 値                             |
| ------- | ------------------------------ |
| Browser | Chrome 149.0.7827.55, headless |
| OS      | macOS                          |
| Canvas  | 480×360                        |
| 集計    | 10 alternating roundsの中央値  |

この測定は上流PRコメントへ記録した要約値です。raw round値は保存されていないため、Chrome 151の
再測定とは独立した結果として扱います。

### Chrome 151

| 項目         | 値                                             |
| ------------ | ---------------------------------------------- |
| Browser      | Google Chrome 151.0.7922.138, `--headless=new` |
| OS           | macOS 27.0 (26A5406e), arm64                   |
| CPU / memory | Apple M1 Max / 64 GiB                          |
| Canvas       | 480×360                                        |
| source       | gradientを描画したHTML canvas                  |

## 結果

### Chrome 149

| Variant                    | ms / 100回 | 既定context比 |
| -------------------------- | ---------: | ------------: |
| 既定context                |       26.6 |          1.00 |
| `willReadFrequently: true` |       26.6 |          1.00 |

### Chrome 151

|    Process | 既定context (ms / 100回) | `willReadFrequently` (ms / 100回) |     比率 |
| ---------: | -----------------------: | --------------------------------: | -------: |
|          1 |                     63.7 |                              78.0 |     1.23 |
|          2 |                     64.3 |                              78.5 |     1.22 |
|          3 |                     64.1 |                              78.7 |     1.23 |
| **中央値** |                 **64.1** |                          **78.5** | **1.22** |

この環境とworkloadではhintありが約22.4%遅い結果でした。HTML Standardは、hintによりreadbackに
有利なsoftware canvasが選ばれ得る一方、多くの描画操作はaccelerated canvasの方が高速になり得ると
説明しています。

### Chrome 151 raw round medians

単位はすべて `ms / 100回` です。値は小数第1位へ丸めています。

```json
{
  "process1": {
    "default": [65.0, 65.3, 64.4, 63.1, 66.1, 63.3, 63.3, 63.8, 63.5, 62.6],
    "willReadFrequently": [79.3, 77.1, 78.1, 76.5, 81.0, 77.0, 78.5, 78.6, 77.9, 77.7]
  },
  "process2": {
    "default": [65.7, 64.5, 64.3, 63.8, 66.2, 63.1, 64.2, 63.0, 64.4, 62.3],
    "willReadFrequently": [78.9, 79.3, 78.0, 75.0, 81.7, 75.7, 79.8, 77.6, 82.2, 77.7]
  },
  "process3": {
    "default": [66.5, 65.3, 65.0, 63.5, 66.2, 64.3, 63.9, 61.3, 63.2, 61.8],
    "willReadFrequently": [80.8, 80.2, 77.8, 76.4, 80.6, 76.9, 79.3, 78.0, 77.4, 79.3]
  }
}
```

## 再現コード

次の内容をHTMLとして保存し、同じChrome binary、headless/headful mode、machineで比較します。

```html
<!doctype html>
<meta charset="utf-8" />
<pre id="result">running</pre>
<script>
  'use strict';

  const WIDTH = 480;
  const HEIGHT = 360;
  const ITERATIONS = 100;
  const BATCHES = 11;
  const ROUNDS = 10;

  const source = document.createElement('canvas');
  source.width = WIDTH;
  source.height = HEIGHT;
  const sourceContext = source.getContext('2d');
  const gradient = sourceContext.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, '#f33');
  gradient.addColorStop(0.5, '#3f3');
  gradient.addColorStop(1, '#33f');
  sourceContext.fillStyle = gradient;
  sourceContext.fillRect(0, 0, WIDTH, HEIGHT);

  const createCase = (willReadFrequently) => {
    const canvas = document.createElement('canvas');
    const context = willReadFrequently
      ? canvas.getContext('2d', {willReadFrequently: true})
      : canvas.getContext('2d');
    return {canvas, context};
  };

  const cases = {
    default: createCase(false),
    willReadFrequently: createCase(true),
  };
  let checksum = 0;

  const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  };

  const runBatch = ({canvas, context}) => {
    const start = performance.now();
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.drawImage(source, 0, 0, WIDTH, HEIGHT);
      checksum ^= context.getImageData(0, 0, WIDTH, HEIGHT).data[0];
    }
    return performance.now() - start;
  };

  const runRound = (testCase) => {
    runBatch(testCase);
    return median(Array.from({length: BATCHES}, () => runBatch(testCase)));
  };

  const roundMedians = {default: [], willReadFrequently: []};
  for (let round = 0; round < ROUNDS; round += 1) {
    const order =
      round % 2 === 0 ? ['default', 'willReadFrequently'] : ['willReadFrequently', 'default'];
    for (const name of order) roundMedians[name].push(runRound(cases[name]));
  }

  document.getElementById('result').textContent = JSON.stringify(
    {
      userAgent: navigator.userAgent,
      workload: {
        width: WIDTH,
        height: HEIGHT,
        iterationsPerBatch: ITERATIONS,
        measuredBatchesPerRound: BATCHES,
        alternatingRounds: ROUNDS,
      },
      defaultMsPer100: median(roundMedians.default),
      willReadFrequentlyMsPer100: median(roundMedians.willReadFrequently),
      defaultRoundMedians: roundMedians.default,
      willReadFrequentlyRoundMedians: roundMedians.willReadFrequently,
      checksum,
    },
    null,
    2,
  );
</script>
```

## 解釈上の制約とリスク

- `willReadFrequently`は速度を保証せず、user agentへのhintです。
- software backingが選ばれるとreadbackは有利でも、`drawImage()`などの描画、CPU使用量、消費電力が
  悪化する可能性があります。
- 結果はChrome version、GPU/CPU backend、headless/headful、OS、canvas sizeで変わります。
- benchmarkはSilhouette相当のCanvas2D部分だけを測り、WebGL upload、pick全体、GC、実作品のskin
  size分布を含みません。
- Chromeは指定なしcontextをreadback回数に応じてGPUからCPUへ切り替えることがあります。warm-up後の
  比較は初回readback latencyや切替costを分離していません。
- 「Chromium警告が0件」と「処理が高速」は独立した受け入れ基準です。
- 以前のdownstream 2,000 picks中央値 `1.0 ms → 1.0 ms` もend-to-endの速度改善を示しません。

## 参照

- [TurboWarp/scratch-render PR #21](https://github.com/TurboWarp/scratch-render/pull/21)
- [HTML Standard: Canvas settings](https://html.spec.whatwg.org/multipage/canvas.html#concept-canvas-will-read-frequently)
- [Chromiumのreadback warningとfallback処理](https://chromium.googlesource.com/chromium/src/+/fe487bfab3b23b7a107987b0a2f7b65222ae7ae0/third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc)
