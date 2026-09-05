import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4TurboWarpCrossfadePlatform} from '../src/dsl4/platform/index.js';
import {createTestTurboWarpRuntimeHost} from './helpers/turbowarp-runtime-host.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function manualScheduler() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    scheduler: {
      now: () => currentTime,
      setTimeout(callback, milliseconds) {
        const id = nextId++;
        timers.set(id, {callback, due: currentTime + milliseconds});
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    pendingCount: () => timers.size,
    advance(milliseconds) {
      const targetTime = currentTime + milliseconds;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.due <= targetTime)
          .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        currentTime = timer.due;
        timer.callback();
      }
      currentTime = targetTime;
    },
  };
}

function voiceFactory() {
  const created = [];
  return {
    created,
    async createAudioVoice(assetId, options) {
      const calls = [];
      const voice = {
        ended: new Promise(() => {}),
        setGain(value) {
          calls.push(['setGain', value]);
        },
        stop() {
          calls.push(['stop']);
        },
      };
      created.push({assetId, options, calls, voice});
      return voice;
    },
  };
}

test('uses Asset Manager voices for cut and equal-power BGM replacement', async () => {
  const clock = manualScheduler();
  const factory = voiceFactory();
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({renderer: {}}),
    scheduler: clock.scheduler,
    frameMilliseconds: 500,
    createAudioVoice: factory.createAudioVoice,
  });

  await platform.replaceBgm('Opening', {effect: 'cut'});
  assert.deepEqual(factory.created[0].options, {gain: 1});

  await platform.replaceBgm('Battle', {
    effect: 'crossfade',
    seconds: 1,
    curve: 'equalPower',
  });
  assert.deepEqual(factory.created[1].options, {gain: 0});
  assert.equal(clock.pendingCount(), 1);

  clock.advance(500);
  assert.ok(Math.abs(factory.created[0].calls.at(-1)[1] - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(factory.created[1].calls.at(-1)[1] - Math.SQRT1_2) < 1e-12);
  clock.advance(500);
  await Promise.resolve();

  assert.deepEqual(factory.created[0].calls.at(-1), ['stop']);
  assert.deepEqual(factory.created[1].calls.at(-1), ['setGain', 1]);
  assert.equal(clock.pendingCount(), 0);

  await platform.replaceBgm('Battle', {effect: 'cut'});
  assert.equal(factory.created.length, 2);
  platform.dispose();
  assert.deepEqual(factory.created[1].calls.at(-1), ['stop']);
});

test('keeps the outgoing BGM when creation of its replacement fails', async () => {
  const first = voiceFactory();
  let attempt = 0;
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({renderer: {}}),
    createAudioVoice(assetId, options) {
      attempt += 1;
      if (attempt === 2) throw new Error('decode failed');
      return first.createAudioVoice(assetId, options);
    },
  });

  await platform.replaceBgm('Opening', {effect: 'cut'});
  await assert.rejects(
    platform.replaceBgm('Broken', {effect: 'crossfade', seconds: 1}),
    /decode failed/u,
  );
  assert.deepEqual(first.created[0].calls, []);
  platform.dispose();
  assert.deepEqual(first.created[0].calls, [['stop']]);
});

test('accepts a Promise-compatible Asset Manager voice from another realm', async () => {
  const calls = [];
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({renderer: {}}),
    createAudioVoice() {
      return {
        ended: {then() {}},
        setGain(value) {
          calls.push(['setGain', value]);
        },
        stop() {
          calls.push(['stop']);
        },
      };
    },
  });

  await platform.replaceBgm('Opening', {effect: 'cut'});
  platform.dispose();
  assert.deepEqual(calls, [['stop']]);
});

test('crossfades a drawable with a noninteractive old-skin copy in the same layer group', async () => {
  const clock = manualScheduler();
  const calls = [];
  const renderer = {
    _groupOrdering: ['sprite'],
    _layerGroups: {sprite: {groupIndex: 0, drawListOffset: 0}},
    _drawList: [1],
    _allDrawables: {
      1: {
        skin: {id: 11},
        _position: [10, 20],
        _direction: 90,
        _scale: [100, 100],
        _visible: true,
      },
    },
    getDrawableOrder(id) {
      return this._drawList.indexOf(id);
    },
    createDrawable(group) {
      calls.push(['createDrawable', group]);
      this._drawList.push(2);
      return 2;
    },
    updateDrawableSkinId(id, skinId) {
      calls.push(['skin', id, skinId]);
    },
    updateDrawableProperties(id, properties) {
      calls.push(['properties', id, properties]);
    },
    markDrawableAsNoninteractive(id) {
      calls.push(['noninteractive', id]);
    },
    setDrawableOrder(id, order, group) {
      calls.push(['order', id, order, group]);
    },
    updateDrawableEffect(id, effect, value) {
      calls.push(['effect', id, effect, value]);
    },
    destroyDrawable(id, group) {
      calls.push(['destroyDrawable', id, group]);
      this._drawList = this._drawList.filter((candidate) => candidate !== id);
    },
  };
  const target = {
    drawableID: 1,
    visible: true,
    effects: {ghost: 20, color: 5},
    setEffect(effect, value) {
      calls.push(['targetEffect', effect, value]);
    },
  };
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({
      renderer,
      requestRedraw: () => calls.push(['redraw']),
    }),
    scheduler: clock.scheduler,
    frameMilliseconds: 500,
  });

  const pending = platform.crossfadeActorSkin(target, () => calls.push(['apply']), {
    effect: 'crossfade',
    seconds: 1,
    easing: 'linear',
  });
  await Promise.resolve();
  assert.ok(calls.some((call) => call[0] === 'order' && call[2] === 1));
  assert.deepEqual(calls.find((call) => call[0] === 'properties')[2], {
    position: [10, 20],
    direction: 90,
    scale: [100, 100],
    visible: true,
    ghost: 20,
    color: 5,
  });

  clock.advance(500);
  assert.deepEqual(calls.filter(([type]) => type === 'targetEffect').at(-1), [
    'targetEffect',
    'ghost',
    60,
  ]);
  assert.deepEqual(calls.filter(([type]) => type === 'effect').at(-1), ['effect', 2, 'ghost', 60]);
  clock.advance(500);
  await pending;

  assert.ok(calls.some((call) => call[0] === 'destroyDrawable'));
  assert.deepEqual(calls.filter(([type]) => type === 'targetEffect').at(-1), [
    'targetEffect',
    'ghost',
    20,
  ]);
});

test('cancels a drawable crossfade while the replacement is still applying', async () => {
  const clock = manualScheduler();
  const applying = deferred();
  const calls = [];
  const renderer = {
    _groupOrdering: ['sprite'],
    _layerGroups: {sprite: {groupIndex: 0, drawListOffset: 0}},
    _drawList: [1],
    _allDrawables: {
      1: {
        skin: {id: 11},
        _position: [0, 0],
        _direction: 90,
        _scale: [100, 100],
        _visible: true,
      },
    },
    getDrawableOrder(id) {
      return this._drawList.indexOf(id);
    },
    createDrawable() {
      this._drawList.push(2);
      return 2;
    },
    updateDrawableSkinId() {},
    updateDrawableProperties() {},
    setDrawableOrder() {},
    destroyDrawable(id) {
      calls.push(['destroyDrawable', id]);
      this._drawList = this._drawList.filter((candidate) => candidate !== id);
    },
  };
  const target = {
    drawableID: 1,
    visible: true,
    effects: {ghost: 0},
    setEffect(effect, value) {
      calls.push(['targetEffect', effect, value]);
    },
  };
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({renderer}),
    scheduler: clock.scheduler,
  });

  const pending = platform.crossfadeActorSkin(target, () => applying.promise, {
    effect: 'crossfade',
    seconds: 1,
  });
  platform.finishAll();
  applying.resolve();
  await pending;

  assert.deepEqual(renderer._drawList, [1]);
  assert.equal(clock.pendingCount(), 0);
  assert.deepEqual(calls, [
    ['targetEffect', 'ghost', 0],
    ['destroyDrawable', 2],
  ]);
});

test('aborts a drawable crossfade while the replacement is still applying', async () => {
  const applying = deferred();
  const controller = new AbortController();
  const destroyed = [];
  const renderer = {
    _groupOrdering: ['sprite'],
    _layerGroups: {sprite: {groupIndex: 0, drawListOffset: 0}},
    _drawList: [1],
    _allDrawables: {
      1: {
        skin: {id: 11},
        _position: [0, 0],
        _direction: 90,
        _scale: [100, 100],
        _visible: true,
      },
    },
    getDrawableOrder(id) {
      return this._drawList.indexOf(id);
    },
    createDrawable() {
      this._drawList.push(2);
      return 2;
    },
    updateDrawableSkinId() {},
    updateDrawableProperties() {},
    setDrawableOrder() {},
    destroyDrawable(id) {
      destroyed.push(id);
    },
  };
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({renderer}),
  });
  const pending = platform.crossfadeActorSkin(
    {drawableID: 1, visible: true, effects: {}, setEffect() {}},
    () => applying.promise,
    {effect: 'crossfade', seconds: 1},
    controller.signal,
  );

  controller.abort();
  applying.resolve();

  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.deepEqual(destroyed, [2]);
});

test('captures and releases one scene frame around the committed destination', async () => {
  const clock = manualScheduler();
  const calls = [];
  const canvas = {width: 960, height: 720};
  const renderer = {
    canvas,
    _groupOrdering: ['sprite'],
    createBitmapSkin(bitmap, resolution) {
      calls.push(['createBitmapSkin', bitmap.id, resolution]);
      return 9;
    },
    destroySkin(id) {
      calls.push(['destroySkin', id]);
    },
    createDrawable(group) {
      calls.push(['createDrawable', group]);
      return 3;
    },
    updateDrawableSkinId(id, skinId) {
      calls.push(['skin', id, skinId]);
    },
    getNativeSize() {
      return [480, 360];
    },
    updateDrawableProperties(id, properties) {
      calls.push(['properties', id, properties]);
    },
    markDrawableAsNoninteractive(id) {
      calls.push(['noninteractive', id]);
    },
    setDrawableOrder(id, order, group) {
      calls.push(['order', id, order, group]);
    },
    updateDrawableEffect(id, effect, value) {
      calls.push(['effect', id, effect, value]);
    },
    destroyDrawable(id, group) {
      calls.push(['destroyDrawable', id, group]);
    },
  };
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({
      renderer,
      requestRedraw: () => calls.push(['redraw']),
    }),
    scheduler: clock.scheduler,
    frameMilliseconds: 500,
    async createImageBitmap(input) {
      assert.strictEqual(input, canvas);
      return {id: 'frame', close: () => calls.push(['bitmap.close'])};
    },
  });

  const operation = await platform.createSceneCrossfade({
    effect: 'crossfade',
    seconds: 1,
    easing: 'linear',
  });
  const pending = operation.start();
  clock.advance(500);
  assert.deepEqual(calls.filter(([type]) => type === 'effect').at(-1), ['effect', 3, 'ghost', 50]);
  clock.advance(500);
  await pending;

  assert.ok(calls.some((call) => call[0] === 'bitmap.close'));
  assert.ok(calls.some((call) => call[0] === 'destroyDrawable'));
  assert.ok(calls.some((call) => call[0] === 'destroySkin'));
  assert.deepEqual(calls.find((call) => call[0] === 'properties')[2].scale, [50, 50]);
});

test('releases scene capture resources when drawable setup fails', async () => {
  const calls = [];
  const bitmap = {close: () => calls.push('bitmap.close')};
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({
      renderer: {
        canvas: {width: 480, height: 360},
        _groupOrdering: ['sprite'],
        createBitmapSkin() {
          return 9;
        },
        createDrawable() {
          return 3;
        },
        updateDrawableSkinId() {
          throw new Error('drawable setup failed');
        },
        destroyDrawable(id, group) {
          calls.push(['destroyDrawable', id, group]);
        },
        destroySkin(id) {
          calls.push(['destroySkin', id]);
        },
      },
    }),
    async createImageBitmap() {
      return bitmap;
    },
  });

  await assert.rejects(
    platform.createSceneCrossfade({effect: 'crossfade', seconds: 1}),
    /drawable setup failed/u,
  );
  assert.deepEqual(calls, ['bitmap.close', ['destroyDrawable', 3, 'sprite'], ['destroySkin', 9]]);
});

test('does not allocate scene capture resources after disposal', async () => {
  const capture = deferred();
  const calls = [];
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({
      renderer: {
        canvas: {width: 480, height: 360},
        _groupOrdering: ['sprite'],
        createBitmapSkin() {
          calls.push('createBitmapSkin');
          return 9;
        },
        createDrawable() {
          calls.push('createDrawable');
          return 3;
        },
      },
    }),
    createImageBitmap() {
      return capture.promise;
    },
  });

  const pending = platform.createSceneCrossfade({effect: 'crossfade', seconds: 1});
  platform.dispose();
  capture.resolve({close: () => calls.push('bitmap.close')});

  await assert.rejects(pending, /disposed/u);
  assert.deepEqual(calls, ['bitmap.close']);
});
