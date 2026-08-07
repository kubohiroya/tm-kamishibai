import assert from 'node:assert/strict';
import test from 'node:test';

import {ESLint} from 'eslint';

const projectRoot = new URL('../', import.meta.url);
const expectedRules = ['eqeqeq', 'no-undef', 'no-unused-vars'];
const firstPartyFiles = [
  'app/extensions/kubohiroyaweblink.js',
  'bin/tmpose-kamishibai.mjs',
  'eslint.config.mjs',
  'scripts/build-site.mjs',
  'scripts/download-catalog.mjs',
  'scripts/sb3/downloadable-releases.mjs',
  'site/site-shell.js',
  'src/builder/index.js',
  'test/turbowarp-vm.test.mjs',
];
const vendoredExtensions = [
  'app/extensions/kubohiroyaassetmanager.js',
  'app/extensions/kubohiroyaasyncinput.js',
  'app/extensions/kubohiroyaruntimeexpression.js',
  'app/extensions/kubohiroyatextlines.js',
  'app/extensions/text.js',
  'app/extensions/tmpose.js',
];

test('applies static quality rules to every first-party code area', async () => {
  const eslint = new ESLint({cwd: new URL('.', projectRoot).pathname});
  for (const filename of firstPartyFiles) {
    const config = await eslint.calculateConfigForFile(filename);
    for (const rule of expectedRules) {
      assert.equal(config.rules[rule][0], 2, `${rule} is not enabled for ${filename}`);
    }
  }
});

test('excludes immutable synchronized artifacts from local linting', async () => {
  const eslint = new ESLint({cwd: new URL('.', projectRoot).pathname});
  for (const filename of vendoredExtensions) {
    assert.equal(await eslint.isPathIgnored(filename), true, `${filename} must remain vendored`);
  }
  assert.equal(
    await eslint.isPathIgnored('release-sources/3.2.3/app/extensions/kubohiroyaassetmanager.js'),
    true,
    'Immutable release snapshots must remain excluded from current-source linting.',
  );
  assert.equal(await eslint.isPathIgnored('app/extensions/kubohiroyaweblink.js'), false);
});
