import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'vitest';

import {packageName} from '../src/builder/constants.js';
import {dsl4PackagerEntrySourceRegistryName} from '../src/dsl4/packager-entry-source.js';

test('renames the npm identity without changing CLI, repository, or runtime contracts', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(packageJson.name, '@kubohiroya/turbowarp-kamishibai-app');
  assert.equal(packageName, packageJson.name);
  assert.deepEqual(packageJson.bin, {'tm-kamishibai': 'bin/tm-kamishibai.mjs'});
  assert.equal(packageJson.repository.url, 'git+https://github.com/kubohiroya/tm-kamishibai.git');
  assert.equal(packageJson.homepage, 'https://kubohiroya.github.io/tm-kamishibai/');
  assert.equal(
    dsl4PackagerEntrySourceRegistryName,
    '@kubohiroya/tm-kamishibai/dsl4-packager-entry-source/v1',
  );
  for (const filename of [
    'dsl-4.schema.json',
    'dsl-4-asset-config.schema.json',
    'dsl-4-asset-lock.schema.json',
  ]) {
    const schema = JSON.parse(
      await readFile(new URL(`../schema/${filename}`, import.meta.url), 'utf8'),
    );
    assert.equal(schema.$id, `https://github.com/kubohiroya/tm-kamishibai/schema/${filename}`);
  }
});
