import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'vitest';

import {packageName} from '../src/builder/constants.js';
import {dsl4PackagerEntrySourceRegistryName} from '../src/dsl4/packager-entry-source.js';

test('uses the turbowarp-kamishibai-app identity and keeps the legacy CLI alias', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(packageJson.name, '@kubohiroya/turbowarp-kamishibai-app');
  assert.equal(packageName, packageJson.name);
  assert.deepEqual(packageJson.bin, {
    'turbowarp-kamishibai': 'bin/turbowarp-kamishibai.mjs',
    'tm-kamishibai': 'bin/turbowarp-kamishibai.mjs',
  });
  assert.equal(
    packageJson.repository.url,
    'git+https://github.com/kubohiroya/turbowarp-kamishibai-app.git',
  );
  assert.equal(packageJson.homepage, 'https://kubohiroya.github.io/turbowarp-kamishibai-app/');
  assert.equal(
    dsl4PackagerEntrySourceRegistryName,
    '@kubohiroya/turbowarp-kamishibai-app/dsl4-packager-entry-source/v1',
  );
  for (const filename of [
    'dsl-4.schema.json',
    'dsl-4-asset-config.schema.json',
    'dsl-4-asset-lock.schema.json',
  ]) {
    const schema = JSON.parse(
      await readFile(new URL(`../schema/${filename}`, import.meta.url), 'utf8'),
    );
    assert.equal(
      schema.$id,
      `https://github.com/kubohiroya/turbowarp-kamishibai-app/schema/${filename}`,
    );
  }
});
