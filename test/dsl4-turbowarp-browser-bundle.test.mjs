import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'vitest';

import {
  buildDsl4TurboWarpBrowserBundle,
  dsl4TurboWarpBrowserBundleMaximumBytes,
} from '../src/builder/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('TurboWarp browser bundle translates pinned webpack loader imports into one bounded module', async () => {
  const bytes = await buildDsl4TurboWarpBrowserBundle({
    entryPoint: path.join(repositoryRoot, 'src/dsl4/browser-turbowarp-platform.js'),
  });
  assert.ok(bytes.byteLength > 1_000_000);
  assert.ok(bytes.byteLength < 24 * 1024 * 1024);
  const bundle = new TextDecoder().decode(bytes);
  for (const unresolved of [
    'base64-loader!',
    'raw-loader!',
    'ify-loader!',
    'worker-loader?name=',
    'tw-load-script-as-plain-text!',
  ]) {
    assert.equal(bundle.includes(unresolved), false, unresolved);
  }
  assert.match(bundle, /External extension workers are disabled in DSL 4\.0 local preview/u);
});

test('production browser preview entry bundles the authenticated client and pinned stage runtime', async () => {
  const bytes = await buildDsl4TurboWarpBrowserBundle({
    entryPoint: path.join(repositoryRoot, 'src/builder/dsl4-local-preview-browser-entry.js'),
  });
  assert.ok(bytes.byteLength > 1_000_000);
  assert.ok(bytes.byteLength < 24 * 1024 * 1024);
  const bundle = new TextDecoder().decode(bytes);
  assert.match(bundle, /story\.k4\.yml/u);
  assert.match(bundle, /The local preview launch token is missing or invalid/u);
  assert.match(bundle, /TurboWarp project stage/u);
});

test('TurboWarp browser bundle rejects unbounded and relative inputs before build', async () => {
  await assert.rejects(
    buildDsl4TurboWarpBrowserBundle({entryPoint: 'relative.js'}),
    /entryPoint must be an absolute filesystem path/u,
  );
  await assert.rejects(
    buildDsl4TurboWarpBrowserBundle({
      entryPoint: path.join(repositoryRoot, 'src/dsl4/browser-turbowarp-platform.js'),
      maxBundleBytes: dsl4TurboWarpBrowserBundleMaximumBytes + 1,
    }),
    /maxBundleBytes must be <=/u,
  );
});
