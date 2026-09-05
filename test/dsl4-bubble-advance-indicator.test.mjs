import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4BubbleAdvanceIndicatorPresenter} from '../src/dsl4/platform/index.js';

function manualScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    scheduler: {
      setTimeout(callback, milliseconds) {
        const id = nextId++;
        timers.set(id, {callback, due: now + milliseconds});
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    pendingCount: () => timers.size,
    advance(milliseconds) {
      now += milliseconds;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.due <= now)
        .sort((left, right) => left[1].due - right[1].due);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

function fixture() {
  const draws = [];
  const context = {
    save() {},
    restore() {},
    drawImage(image, x, y, width, height) {
      draws.push({src: image.src, x, y, width, height});
    },
  };
  const skin = {
    _style: {maxLineWidth: 20, minWidth: 10, padding: 2, lineHeight: 16, strokeWidth: 4},
    _text: 'AB',
    _lines: [],
    _textAreaSize: {width: 0, height: 0},
    _size: [0, 0],
    _textDirty: true,
    _textureDirty: true,
    _canvas: {getContext: () => context},
    measurementProvider: {measureText: (text) => text.length * 10},
    emitWasAltered() {},
    _reflowLines() {
      this._lines = [this._text];
      this._textAreaSize = {width: 24, height: 20};
      this._size = [28, 36];
      this._textDirty = false;
    },
    _renderTextBubble() {
      if (this._textDirty) this._reflowLines();
    },
  };
  const target = {
    onTargetVisualChange() {},
    getCustomState: () => ({skinId: 1}),
  };
  const runtime = {
    renderer: {_allSkins: [null, skin]},
    requestRedraw() {},
  };
  return {draws, runtime, skin, target};
}

test('loops image asset frames at the text end and restores the native bubble renderer', () => {
  const view = fixture();
  const clock = manualScheduler();
  const originalReflow = view.skin._reflowLines;
  const originalRender = view.skin._renderTextBubble;
  const presenter = createDsl4BubbleAdvanceIndicatorPresenter({
    runtime: view.runtime,
    scheduler: clock.scheduler,
    getAssetResource(assetId) {
      return {kind: 'image', objectUrl: `blob:${assetId}`};
    },
    createImage: () => ({complete: true, naturalWidth: 20, naturalHeight: 10, src: ''}),
  });
  const operation = presenter.create(view.target, {
    frames: ['Next1', 'Next2'],
    frameIntervalSeconds: 0.1,
  });

  operation.start();
  view.skin._renderTextBubble(1);
  assert.deepEqual(view.skin._lines, ['AB', '']);
  assert.equal(view.draws[0].src, 'blob:Next1');
  assert.equal(clock.pendingCount(), 1);

  clock.advance(100);
  view.skin._renderTextBubble(1);
  assert.equal(view.draws[1].src, 'blob:Next2');

  operation.stop();
  assert.strictEqual(view.skin._reflowLines, originalReflow);
  assert.strictEqual(view.skin._renderTextBubble, originalRender);
  assert.equal(clock.pendingCount(), 0);
  presenter.dispose();
});

test('fails closed for missing image resources and disposes active timers', () => {
  const view = fixture();
  const clock = manualScheduler();
  const presenter = createDsl4BubbleAdvanceIndicatorPresenter({
    runtime: view.runtime,
    scheduler: clock.scheduler,
    getAssetResource: () => null,
    createImage: () => ({complete: true, naturalWidth: 1, naturalHeight: 1, src: ''}),
  });
  assert.throws(
    () =>
      presenter.create(view.target, {
        frames: ['Missing1', 'Missing2'],
        frameIntervalSeconds: 0.1,
      }),
    /image is unavailable/u,
  );

  const working = createDsl4BubbleAdvanceIndicatorPresenter({
    runtime: view.runtime,
    scheduler: clock.scheduler,
    getAssetResource: (assetId) => ({kind: 'image', objectUrl: `blob:${assetId}`}),
    createImage: () => ({complete: true, naturalWidth: 1, naturalHeight: 1, src: ''}),
  });
  working.create(view.target, {frames: ['Next1', 'Next2'], frameIntervalSeconds: 0.1}).start();
  assert.equal(clock.pendingCount(), 1);
  working.dispose();
  assert.equal(clock.pendingCount(), 0);
});
