# scratch-render / TMPose Canvas2D readback対応 詳細報告

更新日: 2026-08-16

追跡Issue: [#564](https://github.com/kubohiroya/tmpose-kamishibai/issues/564)、
[#601](https://github.com/kubohiroya/tmpose-kamishibai/issues/601)

Upstream PR: [TurboWarp/scratch-render #21](https://github.com/TurboWarp/scratch-render/pull/21)

## 要旨

DSL 4.0 Web版で観測したCanvas2D警告には、所有者が異なる2経路があります。

1. scratch-renderの`Silhouette.unlazy()`が、SVG／bitmap picking用の共有canvasを繰り返し
   `getImageData()`する経路。
2. TMPoseが所有するcamera canvasを、Teachable Machine／TensorFlow.jsの`fromPixels()`が読む経路。

2026-08-16時点の`tmpose-kamishibai` main `6e620a3`は、renderer経路をscratch-render fork
`c69318a6c8d43439fc35fa9e403bf6d2781fdaee`、camera経路を
`@kubohiroya/turbowarp-tmpose@1.10.1`へ分離しています。どちらもcanvas所有者が、そのcanvasの
最初の2D context作成時に`{willReadFrequently: true}`を渡します。KamishibaiはCanvas prototypeや
Consoleを全体patchしません。

この指定によって、Chromiumの既知の警告条件から外れる仕組みは成立します。ただし、速度向上は確認できず、
Chrome 151の縮小benchmarkでは約22.4%遅い結果でした。警告解消をperformance optimizationとして扱っては
いけません。

また、Silhouette-onlyへscopeを縮小した現行mainでは、patchの一意性と全回帰検証は成功していますが、
実Chromiumでwarning countを改めて採取する専用gateは現在の4.x testに残っていません。以前の警告0件は
SilhouetteとTextBubbleの2-context版で得た値です。Silhouetteの変更自体は同じなので解消継続を推論できますが、
Issue #564を閉じる最終証拠としては現行成果物で警告0件を再計測する必要があります。

## 現在の状態

| 対象                         | 2026-08-16時点の状態                    | 判断                                              |
| ---------------------------- | --------------------------------------- | ------------------------------------------------- |
| `tmpose-kamishibai` main     | `6e620a3`、PR #610/#612/#614統合済み    | rc.6 candidate source                             |
| direct scratch-render        | fork `c69318a`を固定                    | Silhouette一件だけ変更                            |
| Packager                     | `@turbowarp/packager@3.13.0`            | 内蔵旧runtimeをbuild時に一件だけpatch             |
| TMPose                       | npm `1.10.1`                            | camera canvas所有者側で初期化                     |
| TurboWarp/scratch-render #21 | Open、CI成功、mergeable、head `c69318a` | upstream未統合                                    |
| tmpose-kamishibai #564       | Reopened                                | 現行成果物のwarning gateとupstream判断待ち        |
| tmpose-kamishibai #601       | Open                                    | TMPose 1.10.1でcamera warningを再観測する必要あり |

## 警告が発生する仕組み

Chromiumの`getImageData()`実装はcontext単位でreadback回数を数えます。参照したChromium sourceでは、
2回目のreadback時にcontext作成属性の`willReadFrequently`が**未指定**なら、次の警告をConsoleへ追加します。

```text
Canvas2D: Multiple readback operations using getImageData are faster with the
willReadFrequently attribute set to true.
```

同じ実装は、未指定のaccelerated canvasについて、readbackが一定条件に達するとGPU accelerationを無効化して
CPUへfallbackします。

HTML Standardで`willReadFrequently`は既定`false`のcontext作成optionであり、`true`ならuser agentは
readback向けにcanvasを最適化できます。一般にはsoftware backingを選びやすくなり、GPU→CPU readbackを
避けられる可能性があります。一方、多くの描画操作はaccelerated canvasの方が高速です。

重要なのは、`getContext('2d', options)`のoptionsがcontextの**初回作成時**に決まることです。同じcanvasへ
後から`getContext('2d', {willReadFrequently: true})`を呼んでも、既存contextとその作成属性は置き換わりません。
したがって、実際のcanvas所有者が他の処理より先に指定する必要があります。

## 現行修正が警告条件を外す仕組み

### scratch-render / Silhouette

`Silhouette.unlazy()`は一枚の共有canvasをresizeし、lazy imageを`drawImage()`した後、全領域を
`getImageData()`します。現行forkはこのcontextの作成だけを次へ変更します。

```diff
-const ctx = canvas.getContext('2d');
+const ctx = canvas.getContext('2d', {willReadFrequently: true});
```

共有canvasの最初のcontextが明示的にreadback用となるため、Chromiumの警告分岐で「未指定」に該当しません。
TextBubble canvasは`measureText()`と描画だけを行い、`getImageData()`しないため対象外です。

### TurboWarp Packager 3.13.0

Packager 3.13.0のscaffoldingには修正前scratch-renderが埋め込まれています。現行builderは
`Silhouette.unlazy()`のminified関数全体をversion固定patternで照合し、その中の
`getContext("2d")`一件だけを`getContext("2d",{willReadFrequently:!0})`へ置換します。

- 対象関数が正確に一件でなければbuildを失敗させる。
- 既に置換済み、または無関係なHTMLへは適用しない。
- patched outputを元のtokenへ戻すと入力とbyte同値になることをtestする。

このfail-closed境界により、全canvasを文字列置換するpatchやCanvas prototype monkey patchを避けています。

### TMPose / camera

TMPose 1.10.1はTeachable Machine `Webcam.setup()`でcamera canvasが作られた直後、`play()`と最初のframeより前に
次を実行します。

```js
canvas.getContext('2d', {willReadFrequently: true});
```

その後のWebcam描画とTensorFlow.js `fromPixels()`は同じcanvas／contextを使うため、camera canvasの作成属性を
下流から補修せずにreadback用途として確定できます。contextを取得できない場合は推論開始前にfail closedします。

## 検証済み事項と未検証事項

### 検証済み

- upstream PR #21のdiffはSilhouette一件、1追加・1削除で、CI `build`が成功。
- mainはscratch-render `c69318a`とTMPose `1.10.1`を固定。
- Packager Plain HTML／zip-one-asset生成物に最適化contextが一件だけ含まれるcontract testが成功。
- 無関係なPackager HTML、複数一致、再適用はfail closed。
- PR #610の`pnpm verify:full`が成功（1,160 unit/integration、53 browser component、13 Chromium E2E、
  site build、package smoke）。
- 旧2-context版の実Chromiumでscratch-render由来の警告0件。
- 旧2-context版の2,000 picks中央値は`1.0 ms → 1.0 ms`で同値。
- Silhouette縮小benchmarkはChrome 149で同値、Chrome 151でhintありが約22.4%遅い。

### 未検証

- 現行Silhouette-only rc.6成果物でのscratch-render警告件数。
- TMPose 1.10.1を組み込んだ現行rc.6 camera loopでの`fromPixels()`警告件数。
- headful Chrome、複数GPU、低電力端末、異なるSVG size分布でのdraw／readback／消費電力。
- 上流PR #21のmaintainer判断と正式releaseへの収録。

## 考えられるリスク

| リスク               | 内容                                                                                             | 緩和策                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 描画性能低下         | software backingが選ばれると`drawImage()`などが遅くなり得る。Chrome 151の縮小測定では約22.4%遅い | 対象をreadbackするcanvasだけに限定し、headful/GPU条件を追加計測     |
| CPU・電力・memory    | GPU readbackは減っても、CPU描画、memory帯域、電力が増える可能性がある                            | 長時間作品と低電力端末で計測し、budget超過時はrollback              |
| browser差            | optionは標準だが最適化方法はuser agent任意。警告自体もChromium固有                               | Chromeだけで一般化せず、WebKit/Firefoxの表示・pick回帰を維持        |
| 初回取得順序         | 別コードが先にcontextを作ると、後からoptionを渡しても属性を変更できない                          | canvas所有者が生成直後に初期化し、起動順のcontract testを保持       |
| scope漏れ            | 別canvasの`getImageData()`警告はこの修正では消えない                                             | stackごとに所有者を分離し、全体monkey patchや文字列抑制をしない     |
| Packager patchの脆さ | minified template変更でpatternが一致しなくなる                                                   | version固定・exactly-one照合でbuildを止め、Packager更新時に明示更新 |
| fork固定の保守負担   | upstream未統合のcommit pinは更新追随やsecurity fixを複雑にする                                   | upstream判断後に公式commit/releaseへ移行し、fork pinを恒久化しない  |
| 誤った成功判定       | 警告が消えても高速化やuser-visible改善を意味しない                                               | warning count、描画correctness、latency、CPU/電力を別々に評価       |
| 将来の実装変更       | Chromiumのwarning条件やcanvas backend選択が変わり得る                                            | browser versionを記録した回帰測定と明示的rollback先を維持           |

## 判断

現行修正は責務境界として妥当です。Silhouetteの共有readback canvasはscratch-render、camera canvasはTMPoseが
所有し、どちらも初回context作成時に用途を宣言します。TextBubble、他のcanvas、Console APIへ変更を広げません。

ただし、現時点で「現行rc.6の警告が0件」と完了宣言する証拠は不足しています。次の順で完了させます。

1. 現行Silhouette-only成果物でSVG／bitmap pickを繰り返し、ChromiumのRendering warningをCDPで採取する。
2. TMPose 1.10.1のcamera loopで`fromPixels()`警告を別に採取する。
3. warning 0、表示／pick、pose prediction、latency、CPUの結果を#564／#601へ分けて記録する。
4. upstream PR #21の判断後、公式commitへ移行するかfork pinをrollbackする。

warning gateで失敗した場合、全体patchへ拡張せずcall stackから新しいcanvas所有者を特定します。性能budgetを
超える場合は、警告解消よりuser-visible performanceを優先してhintを取り下げ、既知diagnosticとして扱います。

## ロールバック

### scratch-render

1. direct dependencyを検証済みupstream base
   `a67f7c9c07d459582c227d4fd3fae8f59d8fc9ce`へ戻す。
2. `patchTurboWarpPackagerScratchRenderReadbackContext()`と呼出箇所を同時にrevertする。
3. rc.6候補とWeb成果物を新しいversionとして再生成・再検証する。

### TMPose

1. TMPoseを直前の検証済みversionへ戻す。
2. runtime bundleとrc候補を新しいversionとして再生成・再検証する。

どちらのrollbackでもCanvas／Console prototype monkey patchや警告文字列の抑制へfallbackしません。公開済みartifactを
同じversionで差し替えず、必要なら次のrcで修正します。

## 参照

- [TurboWarp/scratch-render PR #21](https://github.com/TurboWarp/scratch-render/pull/21)
- [tmpose-kamishibai PR #610](https://github.com/kubohiroya/tmpose-kamishibai/pull/610)
- [Issue #564](https://github.com/kubohiroya/tmpose-kamishibai/issues/564)
- [Issue #601](https://github.com/kubohiroya/tmpose-kamishibai/issues/601)
- [HTML Standard: Canvas settings](https://html.spec.whatwg.org/multipage/canvas.html#concept-canvas-will-read-frequently)
- [Chromium source: warningとGPU→CPU fallback](https://chromium.googlesource.com/chromium/src/+/fe487bfab3b23b7a107987b0a2f7b65222ae7ae0/third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc)
