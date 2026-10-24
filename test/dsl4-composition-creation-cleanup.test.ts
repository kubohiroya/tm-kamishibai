import assert from 'node:assert/strict';
import {test} from 'vitest';
import {createDsl4TMPlatform} from '../src/dsl4/platform/tm-model-adapter.js';
import {createDsl4SvgTextPlatform} from '../src/dsl4/platform/svg-text-action-port.js';
import {createDsl4BubblePlatform} from '../src/dsl4/platform/bubble-platform.js';
import {creationCleanup} from './helpers/creation-cleanup.ts';

for (const platform of ['TM', 'SVG text', 'Bubble'])
  for (const asynchronous of [false, true])
    test(`${platform} initialization retains returned composition after cleanup failure (async: ${asynchronous})`, async () => {
      let calls = 0;
      const releaseError = new Error('release failed');
      const composition = {
        releaseAll() {
          if (++calls === 1) {
            if (asynchronous) return Promise.reject(releaseError);
            throw releaseError;
          }
        },
      };
      const storyDocument = {kind: 'StoryDocument', version: '4.0', scenes: [], textStyles: {}};
      let caught: unknown;
      try {
        if (platform === 'TM')
          createDsl4TMPlatform({runtime: {}, createComposition: () => composition});
        if (platform === 'SVG text')
          createDsl4SvgTextPlatform({
            enabled: true,
            runtime: {},
            storyDocument,
            resolveActor: () => ({}),
            createComposition: () => composition,
          });
        if (platform === 'Bubble')
          createDsl4BubblePlatform({
            runtime: {},
            storyDocument,
            assetManager: {},
            textCapability: {},
            createComposition: () => composition,
          });
        assert.fail('invalid composition must reject');
      } catch (error) {
        caught = error;
      }
      const cleanup = creationCleanup(caught);
      assert.equal(calls, 1, 'sync factories start cleanup immediately');
      await assert.rejects(
        cleanup.completion!,
        (error) => error instanceof AggregateError && error.errors.includes(releaseError),
      );
      assert.match(((caught as Error).cause as Error).message, /composition must provide/u);
      const retry = cleanup.dispose();
      assert.equal(retry, cleanup.dispose());
      await retry;
      assert.equal(calls, 2);
      assert.equal(cleanup.hasPendingCleanup(), false);
    });

test('Bubble style initialization failure retains a fully validated composition for retry', async () => {
  const primary = new Error('style failed');
  let calls = 0;
  let caught: unknown;
  try {
    createDsl4BubblePlatform({
      runtime: {},
      storyDocument: {version: '4.0'},
      assetManager: {},
      textCapability: {},
      createComposition: () => ({
        defineStyle() {
          throw primary;
        },
        show() {},
        releaseAll() {
          if (++calls === 1) throw new Error('release failed');
        },
      }),
    });
  } catch (error) {
    caught = error;
  }
  const cleanup = creationCleanup(caught);
  await assert.rejects(cleanup.completion!, AggregateError);
  assert.equal((caught as Error).cause, primary);
  await cleanup.dispose();
  assert.equal(calls, 2);
});
