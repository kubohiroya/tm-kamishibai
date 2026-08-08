import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4BubblePlatform} from '../src/dsl4/platform/index.js';

test('maps DSL 4.0 bubble styles into one host-owned Bubble composition', async () => {
  const definitions = [];
  const composition = {
    defineStyle(style) {
      definitions.push(style);
    },
    async show() {},
    async releaseAll() {},
  };
  const calls = [];
  const platform = createDsl4BubblePlatform({
    runtime: {renderer: {}},
    storyDocument: {
      kind: 'StoryDocument',
      version: '4.0',
      bubbleStyles: {
        dialogue: {
          textStyle: 'dialogue-text',
          placement: 'up-right',
          visualStyle: 'WAVY',
          characterIntervalSeconds: 0.05,
          portrait: {base: 'Face'},
          advanceIndicator: {frames: ['Next1', 'Next2'], frameIntervalSeconds: 0.1},
        },
      },
    },
    assetManager: {id: 'assets'},
    svgText: {id: 'text'},
    createComposition(runtime, options) {
      calls.push([runtime, options]);
      return composition;
    },
  });

  assert.equal(platform.composition, composition);
  assert.deepEqual(definitions, [
    {name: '__dsl4_default__', textStyle: 'default', visualStyle: 'NORMAL'},
    {name: '__dsl4_default_think__', textStyle: 'default', visualStyle: 'THINKING'},
    {
      name: 'dialogue',
      textStyle: 'dialogue-text',
      placement: 'up-right',
      visualStyle: 'WAVY',
      portrait: {base: 'Face'},
      advanceIndicator: {frames: ['Next1', 'Next2'], frameIntervalSeconds: 0.1},
    },
  ]);
  assert.deepEqual(calls[0], [
    {renderer: {}},
    {assetManager: {id: 'assets'}, svgText: {id: 'text'}},
  ]);
  await platform.releaseAll();
});
