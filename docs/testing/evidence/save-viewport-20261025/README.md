# 保存・viewportのChromium検証記録

2026-10-25〜26に実施。最終確認は2026-10-26（JST）。`results.json`は実VM・scratch-render・native HTMLVideoElement・実IndexedDBを使う`test/e2e/dsl4-save-viewport-chromium.test.ts`の結果。

縦横×contain/coverの4条件で各28項目（計112項目）。さらにページ再読込後のfresh windowで、slotの読戻し、動画2領域とvariablesの復元、動画再生・解放を確認した。`userGesture:false`を保持し、音声付きの候補のnative autoplay拒否も検証する。ブラウザの観測を人の実聴報告として扱わない。

別の`dsl4-publication-layout-chromium.test.ts`も成功し、保存バーとstageの配置・resize後の入力を確認した。Firefoxはメジャーリリース時のみ、Safariは対象外。

公開済みnpm/SB3/Pagesは変更していない。ローカル`verify:pr`は211ファイル・2037テスト成功。公開済みrc.56のSB3 SHA-256は`ac738a213c49dd5347edd129cbda29ec0d053da31d7882478b6b951df62f66e5`と照合した。
