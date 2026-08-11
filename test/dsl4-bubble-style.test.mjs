import assert from 'node:assert/strict';
import test from 'node:test';

import {composeBubbleStyles} from '../src/dsl4/bubble-style.js';

test('recursively composes named bubble styles and replaces arrays as a whole', () => {
  const result = composeBubbleStyles(['hero', 'waiting'], {
    base: {
      text: {size: 24, color: 'black'},
      bubble: {fillColor: 'white'},
      frames: ['Base1', 'Base2'],
    },
    actor: {
      text: {color: 'brown'},
      bubble: {borderColor: 'brown'},
    },
    hero: {
      styles: ['base', 'actor'],
      text: {size: 30},
    },
    waiting: {frames: ['Next1', 'Next2']},
  });

  assert.deepEqual(result, {
    text: {size: 30, color: 'brown'},
    bubble: {fillColor: 'white', borderColor: 'brown'},
    frames: ['Next1', 'Next2'],
  });
});

test('rejects a recursive named bubble style composition', () => {
  assert.throws(
    () =>
      composeBubbleStyles(['style-a'], {
        'style-a': {styles: ['style-b']},
        'style-b': {styles: ['style-a']},
      }),
    (error) =>
      error.code === 'K4-RUNTIME-SPEECH-STYLE-001' &&
      error.message === 'Bubble style cycle: style-a -> style-b -> style-a',
  );
});

test('rejects an unavailable bubble style without returning a partial composition', () => {
  assert.throws(
    () => composeBubbleStyles(['base', 'missing'], {base: {text: {size: 24}}}),
    (error) => error.code === 'K4-RUNTIME-SPEECH-STYLE-001',
  );
});
