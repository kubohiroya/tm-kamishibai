import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import test from 'node:test';

import {
  patchTurboWarpPackagerScratchRenderReadbackContext,
  turboWarpPackagerScratchRenderContract,
} from '../src/builder/turbowarp-packager-scratch-render.js';

const require = createRequire(import.meta.url);
const packagerEntry = require.resolve('@turbowarp/packager');
const packagerScaffoldingDirectory = path.resolve(path.dirname(packagerEntry), 'scaffolding');
const readbackContext = 'getContext("2d")';
const optimizedReadbackContext = 'getContext("2d",{willReadFrequently:!0})';

function count(source, token) {
  return source.split(token).length - 1;
}

test('pins the reviewed Packager and scratch-render contract', () => {
  assert.deepEqual(turboWarpPackagerScratchRenderContract, {
    packagerPackage: '@turbowarp/packager',
    packagerVersion: '3.13.0',
    upstreamRepository: 'TurboWarp/scratch-render',
    upstreamBaseCommit: 'a67f7c9c07d459582c227d4fd3fae8f59d8fc9ce',
    upstreamPullRequest: 21,
    fixedRepository: 'kubohiroya/scratch-render',
    fixedCommit: '1fa6cc7d23e12aabf8db16e8e3ce400538f44165',
    readbackCanvases: ['Silhouette.updateCanvas', 'TextBubbleSkin.canvas'],
  });
});

for (const filename of ['scaffolding-min.js', 'scaffolding-full.js']) {
  test(`patches only the silhouette readback context in Packager ${filename}`, async () => {
    const sourceBytes = new Uint8Array(
      await readFile(path.join(packagerScaffoldingDirectory, filename)),
    );
    const source = new TextDecoder().decode(sourceBytes);
    const patched = new TextDecoder().decode(
      patchTurboWarpPackagerScratchRenderReadbackContext(sourceBytes),
    );

    assert.equal(count(patched, optimizedReadbackContext), 2);
    assert.equal(count(patched, readbackContext), count(source, readbackContext) - 2);
    assert.equal(patched.replaceAll(optimizedReadbackContext, readbackContext), source);
    assert.throws(
      () => patchTurboWarpPackagerScratchRenderReadbackContext(new TextEncoder().encode(patched)),
      /K4-PACKAGER-READBACK-TEMPLATE-001/u,
    );
  });
}

test('rejects unrelated Packager HTML instead of applying a broad canvas patch', () => {
  const unrelated = new TextEncoder().encode(
    '<script>document.createElement("canvas").getContext("2d")</script>',
  );
  assert.throws(
    () => patchTurboWarpPackagerScratchRenderReadbackContext(unrelated),
    /K4-PACKAGER-READBACK-TEMPLATE-001/u,
  );
});
