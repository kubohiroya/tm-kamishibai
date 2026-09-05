import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  dsl4BuiltInTransitionDefaults,
  dsl4CutTransition,
  dsl4FirstCrossfadeStoryPath,
  dsl4StoryUsesCrossfade,
  normalizeDsl4AudioTransition,
  normalizeDsl4VisualTransition,
  resolveDsl4TransitionDefaults,
} from '../src/dsl4/index.js';

test('keeps every built-in transition at cut for backward compatibility', () => {
  assert.deepEqual(dsl4BuiltInTransitionDefaults, {
    scene: {effect: 'cut'},
    backdrop: {effect: 'cut'},
    actorSkin: {effect: 'cut'},
    actorVisibility: {effect: 'cut'},
    bgm: {effect: 'cut'},
  });
  assert.deepEqual(resolveDsl4TransitionDefaults({}), dsl4BuiltInTransitionDefaults);
  assert.strictEqual(normalizeDsl4VisualTransition(0), dsl4CutTransition);
  assert.strictEqual(
    normalizeDsl4AudioTransition({effect: 'crossfade', seconds: 0}),
    dsl4CutTransition,
  );
});

test('normalizes visual and audio shorthand with independent defaults', () => {
  assert.deepEqual(normalizeDsl4VisualTransition(0.5), {
    effect: 'crossfade',
    seconds: 0.5,
    easing: 'easeInOut',
  });
  assert.deepEqual(normalizeDsl4AudioTransition(1.25), {
    effect: 'crossfade',
    seconds: 1.25,
    curve: 'equalPower',
  });
  assert.deepEqual(
    resolveDsl4TransitionDefaults({
      presentation: {transitions: {scene: 0.5, actorSkin: {effect: 'cut'}}},
      audio: {bgm: {transition: {effect: 'crossfade', seconds: 2, curve: 'linear'}}},
    }),
    {
      scene: {effect: 'crossfade', seconds: 0.5, easing: 'easeInOut'},
      backdrop: {effect: 'cut'},
      actorSkin: {effect: 'cut'},
      actorVisibility: {effect: 'cut'},
      bgm: {effect: 'crossfade', seconds: 2, curve: 'linear'},
    },
  );
});

test('rejects unsafe durations and detects crossfade syntax anywhere in a story', () => {
  for (const value of [-1, 60.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => normalizeDsl4VisualTransition(value), /finite number from 0 to 60/u);
  }
  assert.throws(
    () => normalizeDsl4AudioTransition({effect: 'crossfade', seconds: 1, easing: 'linear'}),
    /unknown property/u,
  );
  assert.equal(dsl4StoryUsesCrossfade({scenes: []}), false);
  assert.equal(
    dsl4StoryUsesCrossfade({
      scenes: [{actions: [{args: {transition: {effect: 'crossfade', seconds: 0.25}}}]}],
    }),
    true,
  );
  assert.equal(
    dsl4FirstCrossfadeStoryPath({
      scenes: [
        {
          id: 'scene/二',
          actions: [{args: {transition: {effect: 'crossfade', seconds: 0.25}}}],
        },
      ],
    }),
    '/scenes/scene~1二/actions/0/args/transition',
  );
});
