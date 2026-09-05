import assert from 'node:assert/strict';
import {test} from 'vitest';

import {resolveDsl4BuildSourceLimits} from '../src/builder/index.js';

test('uses one source limit for a single-source build', () => {
  assert.deepEqual(
    resolveDsl4BuildSourceLimits({
      sourceIncludesEnabled: false,
      maxSourceBytes: 1024,
    }),
    {
      maxSourceFileBytes: 1024,
      maxSourceGraphBytes: 1024,
      maxComposedSourceBytes: 1024,
      maxPackagedSourceBytes: 1024,
    },
  );
});

test('uses maxTotalSourceBytes for graph, composed, and packaged include boundaries', () => {
  assert.deepEqual(
    resolveDsl4BuildSourceLimits({
      sourceIncludesEnabled: true,
      maxSourceBytes: 1024,
      maxTotalSourceBytes: 4096,
    }),
    {
      maxSourceFileBytes: 1024,
      maxSourceGraphBytes: 4096,
      maxComposedSourceBytes: 4096,
      maxPackagedSourceBytes: 4096,
    },
  );
});

test('requires finite ordered include limits', () => {
  assert.throws(
    () =>
      resolveDsl4BuildSourceLimits({
        sourceIncludesEnabled: true,
        maxSourceBytes: 1024,
      }),
    /maxTotalSourceBytes/u,
  );
  assert.throws(
    () =>
      resolveDsl4BuildSourceLimits({
        sourceIncludesEnabled: true,
        maxSourceBytes: 1024,
        maxTotalSourceBytes: 1023,
      }),
    /greater than or equal/u,
  );
});
