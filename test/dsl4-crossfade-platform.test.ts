import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4TurboWarpCrossfadePlatform} from '../src/dsl4/platform/index.js';
import {createTestTurboWarpRuntimeHost} from './helpers/turbowarp-runtime-host.ts';
import {deferred} from './helpers/async-test-helpers.ts';
import {requireDefined, requireNumber, requireRecord} from './helpers/require-value.ts';
import {thrown} from './helpers/thrown-error.ts';

/** One recorded renderer or voice call: the operation name, or it with the arguments it got. */
type PlatformCall = unknown[] | string;

/** Read the arguments of one recorded call, which the cases push as a positional list. */
function callArguments(call: PlatformCall | undefined, description: string): unknown[] {
  const recorded = requireDefined(call, description);
  if (typeof recorded === 'string') {
    throw new TypeError(`Expected ${description} to carry arguments, got ${recorded}`);
  }
  return recorded;
}

/**
 * The image bitmap a scene capture closes.
 *
 * The platform declares the DOM `ImageBitmap` it is handed; these cases only ever close theirs,
 * which is the behaviour under test.
 */
function capturedBitmap(bitmap: {close: () => unknown; id?: string}): ImageBitmap {
  return bitmap as unknown as ImageBitmap;
}

function manualScheduler() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map<number, {callback: () => void; due: number}>();
  return {
    scheduler: {
      now: () => currentTime,
      setTimeout(callback: () => void, milliseconds: number) {
        const id = nextId++;
        timers.set(id, {callback, due: currentTime + milliseconds});
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
    },
    pendingCount: () => timers.size,
    advance(milliseconds: number) {
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
  const created: {assetId: unknown; options: unknown; calls: PlatformCall[]; voice: unknown}[] = [];
  return {
    created,
    async createAudioVoice(assetId: unknown, options: unknown) {
      const calls: PlatformCall[] = [];
      const voice = {
        ended: new Promise(() => {}),
        setGain(value: number) {
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

test('fades the BGM out over the requested seconds before stopping the voice', async () => {
  const clock = manualScheduler();
  const factory = voiceFactory();
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({renderer: {}}),
    scheduler: clock.scheduler,
    frameMilliseconds: 500,
    createAudioVoice: factory.createAudioVoice,
  });

  await platform.replaceBgm('Opening', {effect: 'cut'});
  const opening = requireDefined(factory.created[0], 'created voice 0');
  assert.deepEqual(opening.options, {gain: 1});

  const stopping = platform.stopBgm({seconds: 1});
  assert.equal(clock.pendingCount(), 1);

  clock.advance(500);
  assert.ok(
    Math.abs(
      requireNumber(
        callArguments(requireDefined(opening.calls.at(-1), 'its last call'), 'its last call')[1],
        'its gain',
      ) - 0.5,
    ) < 1e-12,
  );
  assert.equal(
    opening.calls.some((call) => call[0] === 'stop'),
    false,
  );

  clock.advance(500);
  await stopping;
  assert.deepEqual(opening.calls.at(-1), ['stop']);
});

test('stops the BGM immediately without a fade and ignores a stop with no BGM', async () => {
  const clock = manualScheduler();
  const factory = voiceFactory();
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({renderer: {}}),
    scheduler: clock.scheduler,
    frameMilliseconds: 500,
    createAudioVoice: factory.createAudioVoice,
  });

  // Stopping with nothing playing is a no-op so a scene can end the same way either way.
  await platform.stopBgm();
  assert.equal(factory.created.length, 0);

  await platform.replaceBgm('Opening', {effect: 'cut'});
  await platform.stopBgm();
  assert.deepEqual(requireDefined(factory.created[0], 'created voice 0').calls.at(-1), ['stop']);
  assert.equal(clock.pendingCount(), 0);
});

test('ramps the BGM volume from its current gain and applies it instantly without seconds', async () => {
  const clock = manualScheduler();
  const factory = voiceFactory();
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({renderer: {}}),
    scheduler: clock.scheduler,
    frameMilliseconds: 500,
    createAudioVoice: factory.createAudioVoice,
  });

  // `volume` is the author-facing 0-100 scale and reaches the voice as a 0-1 gain.
  await platform.replaceBgm('Opening', {effect: 'cut'}, {volume: 50});
  const opening = requireDefined(factory.created[0], 'created voice 0');
  assert.deepEqual(opening.options, {gain: 0.5});

  await platform.setBgmVolume({volume: 100});
  assert.deepEqual(opening.calls.at(-1), ['setGain', 1]);

  const ramping = platform.setBgmVolume({volume: 0, seconds: 1});
  clock.advance(500);
  assert.ok(
    Math.abs(
      requireNumber(
        callArguments(requireDefined(opening.calls.at(-1), 'its last call'), 'its last call')[1],
        'its gain',
      ) - 0.5,
    ) < 1e-12,
  );
  clock.advance(500);
  await ramping;
  assert.deepEqual(opening.calls.at(-1), ['setGain', 0]);
});

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
  assert.deepEqual(requireDefined(factory.created[0], 'created voice 0').options, {gain: 1});

  await platform.replaceBgm('Battle', {
    effect: 'crossfade',
    seconds: 1,
    curve: 'equalPower',
  });
  assert.deepEqual(requireDefined(factory.created[1], 'created voice 1').options, {gain: 0});
  assert.equal(clock.pendingCount(), 1);

  clock.advance(500);
  assert.ok(
    Math.abs(
      requireNumber(
        callArguments(
          requireDefined(factory.created[0], 'created voice 0').calls.at(-1),
          'its last call',
        )[1],
        'its gain',
      ) - Math.SQRT1_2,
    ) < 1e-12,
  );
  assert.ok(
    Math.abs(
      requireNumber(
        callArguments(
          requireDefined(factory.created[1], 'created voice 1').calls.at(-1),
          'its last call',
        )[1],
        'its gain',
      ) - Math.SQRT1_2,
    ) < 1e-12,
  );
  clock.advance(500);
  await Promise.resolve();

  assert.deepEqual(requireDefined(factory.created[0], 'created voice 0').calls.at(-1), ['stop']);
  assert.deepEqual(requireDefined(factory.created[1], 'created voice 1').calls.at(-1), [
    'setGain',
    1,
  ]);
  assert.equal(clock.pendingCount(), 0);

  await platform.replaceBgm('Battle', {effect: 'cut'});
  assert.equal(factory.created.length, 2);
  platform.dispose();
  assert.deepEqual(requireDefined(factory.created[1], 'created voice 1').calls.at(-1), ['stop']);
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
  assert.deepEqual(requireDefined(first.created[0], 'created voice 0').calls, []);
  platform.dispose();
  assert.deepEqual(requireDefined(first.created[0], 'created voice 0').calls, [['stop']]);
});

test('accepts a Promise-compatible Asset Manager voice from another realm', async () => {
  const calls: PlatformCall[] = [];
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({renderer: {}}),
    createAudioVoice() {
      return {
        ended: {then() {}},
        setGain(value: number) {
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
  const calls: PlatformCall[] = [];
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
    getDrawableOrder(id: number) {
      return this._drawList.indexOf(id);
    },
    createDrawable(group: string) {
      calls.push(['createDrawable', group]);
      this._drawList.push(2);
      return 2;
    },
    updateDrawableSkinId(id: number, skinId: number) {
      calls.push(['skin', id, skinId]);
    },
    updateDrawableProperties(id: number, properties: unknown) {
      calls.push(['properties', id, properties]);
    },
    markDrawableAsNoninteractive(id: number) {
      calls.push(['noninteractive', id]);
    },
    setDrawableOrder(id: number, order: number, group: string) {
      calls.push(['order', id, order, group]);
    },
    updateDrawableEffect(id: number, effect: string, value: number) {
      calls.push(['effect', id, effect, value]);
    },
    destroyDrawable(id: number, group: string) {
      calls.push(['destroyDrawable', id, group]);
      this._drawList = this._drawList.filter((candidate) => candidate !== id);
    },
  };
  const target = {
    drawableID: 1,
    visible: true,
    effects: {ghost: 20, color: 5},
    setEffect(effect: string, value: number) {
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
  assert.deepEqual(
    callArguments(
      calls.find((call) => call[0] === 'properties'),
      'the properties call',
    )[2],
    {
      position: [10, 20],
      direction: 90,
      scale: [100, 100],
      visible: true,
      ghost: 20,
      color: 5,
    },
  );

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
  const applying = deferred<void>();
  const calls: PlatformCall[] = [];
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
    getDrawableOrder(id: number) {
      return this._drawList.indexOf(id);
    },
    createDrawable() {
      this._drawList.push(2);
      return 2;
    },
    updateDrawableSkinId() {},
    updateDrawableProperties() {},
    setDrawableOrder() {},
    destroyDrawable(id: number) {
      calls.push(['destroyDrawable', id]);
      this._drawList = this._drawList.filter((candidate) => candidate !== id);
    },
  };
  const target = {
    drawableID: 1,
    visible: true,
    effects: {ghost: 0},
    setEffect(effect: string, value: number) {
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
  const applying = deferred<void>();
  const controller = new AbortController();
  const destroyed: unknown[] = [];
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
    getDrawableOrder(id: number) {
      return this._drawList.indexOf(id);
    },
    createDrawable() {
      this._drawList.push(2);
      return 2;
    },
    updateDrawableSkinId() {},
    updateDrawableProperties() {},
    setDrawableOrder() {},
    destroyDrawable(id: number) {
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

  await assert.rejects(pending, (error) => thrown(error).name === 'AbortError');
  assert.deepEqual(destroyed, [2]);
});

test('captures and releases one scene frame around the committed destination', async () => {
  const clock = manualScheduler();
  const calls: PlatformCall[] = [];
  const canvas = {width: 960, height: 720};
  const renderer = {
    canvas,
    _groupOrdering: ['sprite'],
    createBitmapSkin(bitmap: {id: string}, resolution: number) {
      calls.push(['createBitmapSkin', bitmap.id, resolution]);
      return 9;
    },
    destroySkin(id: number) {
      calls.push(['destroySkin', id]);
    },
    createDrawable(group: string) {
      calls.push(['createDrawable', group]);
      return 3;
    },
    updateDrawableSkinId(id: number, skinId: number) {
      calls.push(['skin', id, skinId]);
    },
    getNativeSize() {
      return [480, 360];
    },
    updateDrawableProperties(id: number, properties: unknown) {
      calls.push(['properties', id, properties]);
    },
    markDrawableAsNoninteractive(id: number) {
      calls.push(['noninteractive', id]);
    },
    setDrawableOrder(id: number, order: number, group: string) {
      calls.push(['order', id, order, group]);
    },
    updateDrawableEffect(id: number, effect: string, value: number) {
      calls.push(['effect', id, effect, value]);
    },
    destroyDrawable(id: number, group: string) {
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
    async createImageBitmap(input: HTMLCanvasElement) {
      assert.strictEqual(input, canvas);
      return capturedBitmap({id: 'frame', close: () => calls.push(['bitmap.close'])});
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
  assert.deepEqual(
    requireRecord(
      callArguments(
        calls.find((call) => call[0] === 'properties'),
        'the properties call',
      )[2],
      'its properties',
    ).scale,
    [50, 50],
  );
});

test('releases scene capture resources when drawable setup fails', async () => {
  const calls: PlatformCall[] = [];
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
        destroyDrawable(id: number, group: string) {
          calls.push(['destroyDrawable', id, group]);
        },
        destroySkin(id: number) {
          calls.push(['destroySkin', id]);
        },
      },
    }),
    async createImageBitmap() {
      return capturedBitmap(bitmap);
    },
  });

  await assert.rejects(
    platform.createSceneCrossfade({effect: 'crossfade', seconds: 1}),
    /drawable setup failed/u,
  );
  assert.deepEqual(calls, ['bitmap.close', ['destroyDrawable', 3, 'sprite'], ['destroySkin', 9]]);
});

test('does not allocate scene capture resources after disposal', async () => {
  const capture = deferred<ImageBitmap>();
  const calls: PlatformCall[] = [];
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
  capture.resolve(capturedBitmap({close: () => calls.push('bitmap.close')}));

  await assert.rejects(pending, /disposed/u);
  assert.deepEqual(calls, ['bitmap.close']);
});
