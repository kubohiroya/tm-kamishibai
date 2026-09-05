/* global document, ImageBitmap */

import {
  dsl4StandardProductionFeatureFlags,
  resolveDsl4FeatureFlags,
} from '../../../dist/dsl4/feature-flags.js';
import {createDsl4TurboWarpCrossfadePlatform} from '../../../dist/dsl4/platform/turbowarp-crossfade-platform.js';
import {createTurboWarpRuntimeHost} from '../../../node_modules/@kubohiroya/turbowarp-runtime-host/dist/index.js';

const calls = [];
const voices = [];
const canvas = document.querySelector('#stage');
const context = canvas.getContext('2d');
context.fillStyle = '#112244';
context.fillRect(0, 0, canvas.width, canvas.height);

let nextDrawableId = 2;
const renderer = {
  canvas,
  _groupOrdering: ['sprite'],
  _layerGroups: {sprite: {groupIndex: 0, drawListOffset: 0}},
  _drawList: [10, 1],
  _allDrawables: {
    1: {
      skin: {id: 11},
      _position: [20, 30],
      _direction: 90,
      _scale: [100, 100],
      _visible: true,
    },
    10: {
      skin: {id: 12},
      _position: [0, 0],
      _direction: 90,
      _scale: [100, 100],
      _visible: true,
    },
  },
  getDrawableOrder(id) {
    return this._drawList.indexOf(id);
  },
  createDrawable(group) {
    const id = nextDrawableId++;
    this._drawList.push(id);
    calls.push(['createDrawable', id, group]);
    return id;
  },
  destroyDrawable(id, group) {
    this._drawList = this._drawList.filter((candidate) => candidate !== id);
    calls.push(['destroyDrawable', id, group]);
  },
  updateDrawableSkinId(id, skinId) {
    calls.push(['skin', id, skinId]);
  },
  updateDrawableProperties(id, properties) {
    calls.push(['properties', id, properties]);
  },
  updateDrawableEffect(id, effect, value) {
    calls.push(['effect', id, effect, value]);
  },
  markDrawableAsNoninteractive(id) {
    calls.push(['noninteractive', id]);
  },
  setDrawableOrder(id, order, group) {
    calls.push(['order', id, order, group]);
  },
  createBitmapSkin(bitmap, resolution) {
    calls.push([
      'createBitmapSkin',
      bitmap instanceof ImageBitmap,
      bitmap.width,
      bitmap.height,
      resolution,
    ]);
    return 91;
  },
  destroySkin(id) {
    calls.push(['destroySkin', id]);
  },
  getNativeSize() {
    return [480, 360];
  },
};

const actor = {
  id: 'Hero',
  isStage: false,
  drawableID: 1,
  visible: true,
  effects: {ghost: 10},
  setEffect(effect, value) {
    this.effects[effect] = value;
    calls.push(['actorEffect', effect, value]);
  },
};

const stage = {
  id: 'Stage',
  isStage: true,
  drawableID: 10,
  visible: true,
  effects: {ghost: 0},
  setEffect(effect, value) {
    this.effects[effect] = value;
    calls.push(['stageEffect', effect, value]);
  },
};

const runtimeHost = createTurboWarpRuntimeHost({
  runtime: {
    renderer,
    targets: [stage, actor],
    requestRedraw() {
      calls.push(['redraw']);
    },
    on() {},
    startHats: () => [],
    getTargetForStage: () => stage,
  },
});

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

try {
  const flags = resolveDsl4FeatureFlags(dsl4StandardProductionFeatureFlags);
  const platform = createDsl4TurboWarpCrossfadePlatform({
    runtimeHost,
    frameMilliseconds: 5,
    createAudioVoice(assetId, options) {
      const voiceCalls = [];
      const voice = {
        ended: new Promise(() => {}),
        setGain(value) {
          voiceCalls.push(['setGain', value]);
        },
        stop() {
          voiceCalls.push(['stop']);
        },
      };
      voices.push({assetId, options, calls: voiceCalls});
      return voice;
    },
  });

  let backdropApplied = 0;
  await platform.crossfadeStage(
    () => {
      backdropApplied += 1;
    },
    {effect: 'crossfade', seconds: 0.03, easing: 'linear'},
  );

  let actorApplied = 0;
  await platform.crossfadeActorSkin(
    actor,
    () => {
      actorApplied += 1;
    },
    {effect: 'crossfade', seconds: 0.03, easing: 'linear'},
  );

  const scene = await platform.createSceneCrossfade({
    effect: 'crossfade',
    seconds: 0.03,
    easing: 'linear',
  });
  await scene.start();

  await platform.replaceBgm('Opening', {effect: 'cut'});
  await platform.replaceBgm('Ending', {
    effect: 'crossfade',
    seconds: 0.03,
    curve: 'equalPower',
  });
  await wait(60);
  platform.dispose();

  const bitmapCall = calls.find(([type]) => type === 'createBitmapSkin');
  globalThis.dsl4CrossfadeBrowserFixture = {
    ready: true,
    ok: true,
    flags: {
      runtime: flags.dsl4Runtime,
      crossfade: flags.dsl4CrossfadeTransitions,
    },
    backdropApplied,
    stageGhost: stage.effects.ghost,
    actorApplied,
    actorGhost: actor.effects.ghost,
    bitmap: bitmapCall?.slice(1),
    destroyedSkins: calls.filter(([type]) => type === 'destroySkin').map((call) => call[1]),
    createdDrawables: calls.filter(([type]) => type === 'createDrawable').length,
    destroyedDrawables: calls.filter(([type]) => type === 'destroyDrawable').length,
    noninteractiveDrawables: calls.filter(([type]) => type === 'noninteractive').length,
    voices,
  };
} catch (error) {
  globalThis.dsl4CrossfadeBrowserFixture = {
    ready: true,
    ok: false,
    error: String(error?.stack ?? error),
  };
}
