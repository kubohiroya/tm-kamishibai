import assert from 'node:assert/strict';
import {test} from 'vitest';

import {prepareTurboWarpExtensionPrelude} from '../scripts/sb3/turbowarp-extension-bundle.ts';

test('rejects a prelude that is not a classic script', () => {
  assert.throws(
    () => prepareTurboWarpExtensionPrelude("import {tf} from 'tfjs';\ntf.setBackend('cpu');"),
    /not a valid classic script/u,
  );
  assert.throws(
    () => prepareTurboWarpExtensionPrelude('export const tf = {};'),
    /not a valid classic script/u,
  );
});

test('terminates a prelude so the wrapper is never read as a call', () => {
  // The wrapper that follows starts with `(`, so an unterminated final expression would swallow it.
  assert.equal(
    prepareTurboWarpExtensionPrelude('globalThis.tf = createRuntime()'),
    'globalThis.tf = createRuntime();',
  );
  assert.equal(
    prepareTurboWarpExtensionPrelude('globalThis.tf = createRuntime();\n'),
    'globalThis.tf = createRuntime();',
  );
  assert.equal(prepareTurboWarpExtensionPrelude('   \n  '), '');
});
